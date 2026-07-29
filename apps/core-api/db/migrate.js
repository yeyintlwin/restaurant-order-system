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
const LOCK_WAIT_MS = 60000;
const LOCK_RETRY_MS = 1000;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function readLedgerIfPresent(client) {
  const present = await client.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present"
  );
  if (present.rows[0].present !== true) return new Map();
  return readLedger(client);
}

// The readiness half of GET /health/ready. Unlike runMigrations this RETURNS its
// verdict: a probe that throws on 'pending' cannot report 'pending'. A ledger row
// with no file on disk is deliberately NOT a verdict here either -- it is the
// rolled-back-image case, which the runner only warns about.
async function migrationsStatus(client, directory) {
  const ledger = await readLedgerIfPresent(client);
  const files = readMigrationFiles(directory);
  let pending = false;
  for (const file of files) {
    const appliedChecksum = ledger.get(file.filename);
    if (!appliedChecksum) {
      pending = true;
      continue;
    }
    // Mismatch outranks pending: it means history was edited, which is the more
    // serious signal and the one an operator must see first.
    if (!appliedChecksum.equals(file.checksum)) return "checksum_mismatch";
  }
  return pending ? "pending" : "current";
}

// pg_try_advisory_lock in a bounded loop rather than the blocking
// pg_advisory_lock: a blocking call against an orphaned lock (a cancelled ssh
// heredoc leaves one) hangs the container forever with one log line, and
// `restart: unless-stopped` never fires. $1::bigint is explicit because the
// function is overloaded and an untyped parameter is a resolution risk.
async function acquireMigrationLock(client, waitMs, now, wait) {
  const deadline = now() + waitMs;
  for (;;) {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [MIGRATION_ADVISORY_LOCK_KEY]
    );
    if (rows[0].locked === true) return;
    if (now() >= deadline) {
      throw new Error(
        `another instance is migrating: advisory lock ${MIGRATION_ADVISORY_LOCK_KEY} ` +
        `was still held after ${waitMs} ms`
      );
    }
    await wait(LOCK_RETRY_MS);
  }
}

async function applyMigration(client, file, now) {
  const startedAt = now();
  // The explicit BEGIN is what makes the file's own SET LOCAL lock_timeout and
  // SET LOCAL statement_timeout mean anything -- SET LOCAL outside a transaction
  // block is ignored.
  await client.query("BEGIN");
  try {
    // ONE string, NO bound parameters. node-postgres uses the simple query
    // protocol only when nothing is bound, and that is the only protocol that
    // accepts several statements -- so the file is never split on semicolons,
    // which would cut the dollar-quoted bodies in 0001_init.sql in half. Bind
    // even one parameter alongside the file text and it switches to the extended
    // protocol, which raises "cannot insert multiple commands into a prepared
    // statement"; that is why the ledger INSERT is a second, separate call.
    await client.query(file.sql);
    await client.query(
      "INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)",
      [file.filename, file.checksum, Math.max(0, Math.round(now() - startedAt))]
    );
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw new Error(`migration ${file.filename} failed and was rolled back: ${error.message}`);
  }
  return Math.max(0, Math.round(now() - startedAt));
}

function checksumMismatchMessage(file, appliedChecksum) {
  return [
    `checksum mismatch for ${file.filename}`,
    `  applied: ${appliedChecksum.toString("hex")}`,
    `  on disk: ${file.checksum.toString("hex")}`,
    "An already-applied migration was edited. Never edit an applied migration -- add",
    "the next numbered file instead. Locally, run: npm --prefix apps/core-api run db:reset"
  ].join("\n");
}

async function readLedger(client) {
  const { rows } = await client.query("SELECT filename, checksum FROM schema_migrations");
  return new Map(rows.map((row) => [row.filename, Buffer.from(row.checksum)]));
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
  const check = settings.check === true;
  const now = settings.now || Date.now;
  const wait = settings.sleep || sleep;
  const waitMs = settings.lockWaitMs === undefined ? LOCK_WAIT_MS : settings.lockWaitMs;

  await assertServerVersion(client);
  await ensureAppRole(client, settings.appRolePassword);
  await client.query(SCHEMA_MIGRATIONS_DDL);
  // Called OUTSIDE the try, so a failed acquisition never unlocks a lock this
  // session does not hold.
  await acquireMigrationLock(client, waitMs, now, wait);
  try {
    const files = readMigrationFiles(settings.directory);
    const ledger = await readLedger(client);
    const applied = [];
    const skipped = [];

    for (const file of files) {
      const digest = file.checksum.toString("hex").slice(0, 12);
      const appliedChecksum = ledger.get(file.filename);
      if (appliedChecksum) {
        // Fatal, with no --force and no skip variable: db:reset is the only
        // sanctioned answer locally, and against a database with real rows there
        // is deliberately no escape at all.
        if (!appliedChecksum.equals(file.checksum)) {
          throw new Error(checksumMismatchMessage(file, appliedChecksum));
        }
        log.info(`migration ${file.filename} sha256:${digest} already applied`);
        skipped.push(file.filename);
        continue;
      }
      if (check) {
        log.info(`migration ${file.filename} sha256:${digest} PENDING (check mode, not applied)`);
        continue;
      }
      const durationMs = await applyMigration(client, file, now);
      log.info(`migration ${file.filename} sha256:${digest} applied in ${durationMs} ms`);
      applied.push(file.filename);
    }

    const finalLedger = await readLedger(client);
    const onDisk = new Set(files.map((file) => file.filename));
    const missingFiles = [...finalLedger.keys()].filter((name) => !onDisk.has(name)).sort();
    const pending = files
      .map((file) => file.filename)
      .filter((name) => !finalLedger.has(name));

    // WARNING, never fatal: a rolled-back image is the only recovery lever on a
    // push-to-main pipeline with no staging tier, and it always looks like this.
    for (const filename of missingFiles) {
      log.warn(
        `WARNING: schema_migrations has a row for ${filename} but the file is not on ` +
        "disk. This is what a rolled-back image looks like; continuing."
      );
    }
    // check: true needs no separate code path -- it suppresses the apply, and this
    // reconciliation then finds the file pending and throws, which is the exit 1
    // that CI wants.
    if (pending.length > 0) {
      throw new Error(
        `pending migration(s) never applied: ${pending.join(", ")}; ` +
        "the database schema is older than this code"
      );
    }
    return { applied, skipped, missingFiles, checked: check };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
    } catch {}
  }
}

module.exports = {
  MIGRATION_ADVISORY_LOCK_KEY,
  MIGRATION_FILENAME_PATTERN,
  MINIMUM_SERVER_VERSION_NUM,
  SCHEMA_MIGRATIONS_DDL,
  checksumOf,
  migrationsStatus,
  normaliseSql,
  readMigrationFiles,
  runMigrations
};

if (require.main === module) {
  // Required here rather than at the top of the file so the pure helpers above
  // stay loadable (and unit-testable) without pg or a validated environment.
  const { loadDotEnv } = require("../env-file");
  const { startupConfiguration } = require("../config");
  const { openMigrationPool, acquireMigrationClient, closeMigrationPool } = require("./index");

  const main = async () => {
    // Same two lines start() runs, so `npm run migrate` and `npm start` read one
    // environment and cannot disagree about which database they are pointed at.
    loadDotEnv();
    const config = startupConfiguration(process.env);
    openMigrationPool({ connectionString: config.databaseMigrationUrl });
    const client = await acquireMigrationClient();
    try {
      const result = await runMigrations(client, {
        directory: path.join(__dirname, "..", "migrations"),
        appRolePassword: config.databaseAppPassword,
        check: process.argv.includes("--check")
      });
      console.log(
        `migrations: ${result.applied.length} applied, ${result.skipped.length} already applied` +
        (result.checked ? " (check mode, nothing was applied)" : "")
      );
    } finally {
      client.release();
      // Swallowed so a close failure cannot mask the real error on its way out.
      await closeMigrationPool().catch(() => {});
    }
  };

  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
