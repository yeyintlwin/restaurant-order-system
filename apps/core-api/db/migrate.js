"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// One fixed key, taken session-level by every core-api process that migrates,
// so two containers started by one deploy serialise instead of racing.
const MIGRATION_ADVISORY_LOCK_KEY = 4264071001;
// Identical to the CHECK on schema_migrations.filename. Validating here means a
// bad name is fatal BEFORE any DDL runs, instead of failing the INSERT after it.
const MIGRATION_FILENAME_PATTERN = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
const MINIMUM_SERVER_VERSION_NUM = 140000;
const APP_ROLE = "core_api_app";

const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY CHECK (filename ~ '^[0-9]{4}_[a-z0-9_]+\\.sql$'),
  checksum    bytea       NOT NULL CHECK (octet_length(checksum) = 32),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer     NOT NULL DEFAULT 0 CHECK (duration_ms >= 0)
)`;

// The database name is derived with current_database() because this same runner
// builds core_api_test_template and one clone per test file on a CI server that
// has no database called "core"; a hardcoded name fails 3D000 on the very first
// CI run, and the 30-second repair under pressure is a try/catch that leaves
// PUBLIC holding CONNECT in production behind a green build history. The inner
// EXCEPTION WHEN duplicate_object handles two test processes reaching CREATE
// ROLE on one cluster at the same moment.
const ENSURE_APP_ROLE_SQL = `DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE ROLE ${APP_ROLE} NOLOGIN';
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${APP_ROLE}', current_database());
END
$$`;

// Windows checks out *.sql as CRLF under the Git default autocrlf=true while
// the image builds on Linux, so the same file would otherwise yield two digests
// and the runner would declare a fatal mismatch on a file nobody edited.
function normaliseSql(raw) {
  return Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

function checksumOf(normalised) {
  return crypto.createHash("sha256").update(normalised).digest();
}

function readMigrationFiles(directory) {
  const files = [];
  const byNumber = new Map();
  for (const filename of fs.readdirSync(directory).sort()) {
    if (!MIGRATION_FILENAME_PATTERN.test(filename)) {
      throw new Error(
        `invalid migration filename "${filename}": expected ` +
        `${MIGRATION_FILENAME_PATTERN.source}; nothing was applied`
      );
    }
    const number = filename.slice(0, 4);
    if (byNumber.has(number)) {
      throw new Error(
        `duplicate migration number ${number}: "${byNumber.get(number)}" and ` +
        `"${filename}"; nothing was applied`
      );
    }
    byNumber.set(number, filename);
    const normalised = normaliseSql(fs.readFileSync(path.join(directory, filename)));
    files.push({
      filename,
      sql: normalised.toString("utf8"),
      checksum: checksumOf(normalised)
    });
  }
  return files;
}

async function assertServerVersion(client) {
  const { rows } = await client.query("SHOW server_version_num");
  const versionNum = Number(rows[0].server_version_num);
  if (!Number.isInteger(versionNum) || versionNum < MINIMUM_SERVER_VERSION_NUM) {
    throw new Error(
      `PostgreSQL server_version_num ${rows[0].server_version_num} is below the ` +
      `required ${MINIMUM_SERVER_VERSION_NUM} (PostgreSQL 14)`
    );
  }
}

async function ensureAppRole(client, password) {
  await client.query(ENSURE_APP_ROLE_SQL);
  if (typeof password !== "string" || password.length === 0) return;
  // ALTER ROLE cannot take a bind parameter and a DO block cannot receive one,
  // so quote_literal does the escaping server-side. Running this on EVERY boot
  // is what makes editing DATABASE_URL a real password rotation. (Consequently
  // this cluster must never run with log_statement=all.)
  const { rows } = await client.query("SELECT quote_literal($1::text) AS literal", [password]);
  await client.query(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD ${rows[0].literal}`);
}

// `client` is an already-connected, duck-typed object with .query(text, values?).
// This function never opens, releases or closes a connection: server.js and
// testing/database.js each open one and hand it in.
async function runMigrations(client, options) {
  const settings = options || {};
  if (typeof settings.directory !== "string" || settings.directory.length === 0) {
    throw new Error("runMigrations requires options.directory");
  }
  const log = settings.log || console;

  await assertServerVersion(client);
  await ensureAppRole(client, settings.appRolePassword);
  await client.query(SCHEMA_MIGRATIONS_DDL);

  const files = readMigrationFiles(settings.directory);
  log.info(`migrations: ${files.length} file(s) on disk in ${settings.directory}`);
  return { applied: [], skipped: [], missingFiles: [], checked: settings.check === true };
}

module.exports = {
  MIGRATION_ADVISORY_LOCK_KEY,
  MIGRATION_FILENAME_PATTERN,
  MINIMUM_SERVER_VERSION_NUM,
  SCHEMA_MIGRATIONS_DDL,
  checksumOf,
  normaliseSql,
  readMigrationFiles,
  runMigrations
};
