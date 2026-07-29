"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const APP_ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIR = path.join(APP_ROOT, "migrations");
const TEMPLATE_DATABASE_NAME = "core_api_test_template";

// db/migrate.js owns 4264071001. This is its neighbour, so the harness's
// maintenance-database mutations never contend with a real migration run.
const MAINTENANCE_LOCK_ID = 4264071002;

// FK-safe order, and deliberately NO CASCADE: when Phase 2 adds menu_items this
// statement fails loudly instead of leaving a table silently un-reset.
const FIXTURE_TABLES = [
  "audit_events",
  "terminal_tokens",
  "terminal_pairing_codes",
  "terminals",
  "user_sessions",
  "user_shops",
  "shop_tables",
  "shops",
  "users",
  "companies"
];

const TRUNCATE_STATEMENT = `TRUNCATE ${FIXTURE_TABLES.join(", ")} RESTART IDENTITY`;

const MISSING_URL_MESSAGE = [
  "CORE_API_TEST_DATABASE_URL is not set, so the database-backed suites cannot run.",
  "This is a hard failure on purpose: a silently skipped tenant-isolation suite is",
  "worse than a red one.",
  "",
  "  export CORE_API_TEST_DATABASE_URL=postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres",
  "  $env:CORE_API_TEST_DATABASE_URL = 'postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'",
  "",
  "No local server yet? (see apps/core-api/README.md)",
  "  docker run -d --name core-db-dev -e POSTGRES_USER=core_api_owner \\",
  "    -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=core \\",
  "    -p 127.0.0.1:5433:5432 postgres:16-alpine",
  "",
  "If you genuinely have no Postgres, CORE_API_SKIP_DB_TESTS=1 turns these suites",
  "into VISIBLE TAP skips and makes pretest a no-op. CI never sets it."
].join("\n");

function requireTestDatabaseUrl(env = process.env) {
  const url = env.CORE_API_TEST_DATABASE_URL;
  if (typeof url !== "string" || url.length === 0) throw new Error(MISSING_URL_MESSAGE);
  return url;
}

function skipDatabaseTests(env = process.env) {
  return env.CORE_API_SKIP_DB_TESTS === "1" ? "CORE_API_SKIP_DB_TESTS=1" : false;
}

function databaseNameFor(testFilePath) {
  // path.relative yields backslashes on win32. Normalise before hashing or the
  // same file maps to two different databases on two different machines.
  const relative = path.relative(APP_ROOT, testFilePath).split(path.sep).join("/");
  const digest = crypto.createHash("sha256").update(relative).digest("hex").slice(0, 12);
  return `core_api_t_${digest}`;
}

function maintenanceDsn(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

// The requires sit here rather than at the top on purpose: everything above this
// line is pure and loads with no `pg` installed.
const fs = require("node:fs");
const { Client, Pool } = require("pg");
const { runMigrations } = require("../db/migrate");

function migrationChecksums(directory = MIGRATIONS_DIR) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((filename) => {
      // Same CRLF normalisation as db/migrate.js. Duplicated on purpose: if the two
      // ever disagree the template rebuilds on every run AND S6 goes red -- both loud.
      const raw = fs.readFileSync(path.join(directory, filename));
      const normalised = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
      return { filename, checksum: crypto.createHash("sha256").update(normalised).digest("hex") };
    });
}

function isTemplateStale(diskChecksums, ledgerRows) {
  const key = (rows) => rows.map((row) => `${row.filename}:${row.checksum}`).sort().join("|");
  return key(diskChecksums) !== key(ledgerRows);
}

async function withMaintenanceClient(connectionString, fn) {
  const client = new Client({ connectionString, application_name: "core-api-test-harness" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withMaintenanceLock(fn) {
  const url = requireTestDatabaseUrl();
  return withMaintenanceClient(url, async (client) => {
    // Session-level, and held across CHECK + REBUILD + CLONE rather than just the
    // rebuild: CREATE DATABASE ... TEMPLATE t fails with "source database is being
    // accessed by other users" if any sibling test process is connected to t.
    await client.query("SELECT pg_advisory_lock($1)", [MAINTENANCE_LOCK_ID]);
    try {
      return await fn(client, url);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MAINTENANCE_LOCK_ID]);
    }
  });
}

// Takes no advisory lock and reads no environment: scripts/reset-database.js
// calls it against an operator-supplied DSN that has nothing to do with the
// test harness. Owning the DROP/CREATE mechanics here is what keeps every
// `*.query(` call in this service inside db/ and testing/ (rule C2).
async function recreateDatabase(maintenanceConnectionString, databaseName) {
  await withMaintenanceClient(maintenanceConnectionString, async (client) => {
    // WITH (FORCE) needs PostgreSQL >= 13; the runner asserts >= 14 and compose
    // pins postgres:16-alpine. It is what makes a re-run RECLAIM the name rather
    // than hang on a connection a crashed previous run left behind.
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${databaseName}"`);
  });
}

async function readTemplateLedger(url) {
  try {
    return await withMaintenanceClient(maintenanceDsn(url, TEMPLATE_DATABASE_NAME), (client) =>
      client
        .query("SELECT filename, encode(checksum, 'hex') AS checksum FROM schema_migrations")
        .then((result) => result.rows)
    );
  } catch {
    // No template, or a template with no ledger table. Either way: stale.
    return null;
  }
}

async function ensureTemplate(client, url) {
  const disk = migrationChecksums();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    TEMPLATE_DATABASE_NAME
  ]);

  if (exists.rowCount === 1) {
    const ledger = await readTemplateLedger(url);
    if (ledger && !isTemplateStale(disk, ledger)) return;
  }

  await client.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE_NAME}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${TEMPLATE_DATABASE_NAME}"`);

  // The PRODUCTION runner, on its own connection to the template database --
  // never psql -f, never a schema dump. 0001_init.sql has a dollar-quoted
  // CREATE FUNCTION and a dollar-quoted DO block, so a shortcut here means the
  // one rule most likely to be violated is the one rule never exercised. Every
  // `npm test` is therefore also a migration-runner test. runMigrations takes an
  // already-connected client FIRST; passing it an options object instead throws
  // "runMigrations requires options.directory" before touching the database.
  await withMaintenanceClient(maintenanceDsn(url, TEMPLATE_DATABASE_NAME), (conn) =>
    runMigrations(conn, {
      directory: MIGRATIONS_DIR,
      log: { info() {}, warn: console.warn }
    })
  );
}

function attach(url, name) {
  const connectionString = maintenanceDsn(url, name);
  const pool = new Pool({ connectionString, max: 4, application_name: `core-api-test:${name}` });

  return {
    name,
    connectionString,
    // Deliberately bypasses the repositories: no legitimate scope can create rows in
    // two tenants, which is exactly what a two-tenant fixture must do.
    unscoped: (text, params) => pool.query(text, params),
    // A DEDICATED backend the caller owns and must end(). Not a pool checkout:
    // two checkouts from one pool are not guaranteed to be two sessions.
    connect: async () => {
      const client = new Client({
        connectionString,
        application_name: `core-api-test-session:${name}`
      });
      await client.connect();
      return client;
    },
    resetFixtures: () => pool.query(TRUNCATE_STATEMENT),
    end: () => pool.end(),
    drop: async () => {
      await pool.end();
      await withMaintenanceLock((client) =>
        client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      );
    }
  };
}

async function ensureTemplateDatabase() {
  await withMaintenanceLock((client, url) => ensureTemplate(client, url));
}

async function cloneTemplate(testFilePath) {
  const name = databaseNameFor(testFilePath);
  const url = await withMaintenanceLock(async (client, connectionString) => {
    await ensureTemplate(client, connectionString);
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE_NAME}"`);
    return connectionString;
  });
  return attach(url, name);
}

async function createEmptyDatabase(label) {
  const digest = crypto.createHash("sha256").update(String(label)).digest("hex").slice(0, 12);
  const name = `core_api_e_${digest}`;
  const url = await withMaintenanceLock(async (client, connectionString) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
    return connectionString;
  });
  return attach(url, name);
}

module.exports = {
  APP_ROOT,
  MIGRATIONS_DIR,
  TEMPLATE_DATABASE_NAME,
  MAINTENANCE_LOCK_ID,
  FIXTURE_TABLES,
  TRUNCATE_STATEMENT,
  requireTestDatabaseUrl,
  skipDatabaseTests,
  databaseNameFor,
  maintenanceDsn,
  migrationChecksums,
  isTemplateStale,
  withMaintenanceClient,
  recreateDatabase,
  ensureTemplateDatabase,
  cloneTemplate,
  createEmptyDatabase
};
