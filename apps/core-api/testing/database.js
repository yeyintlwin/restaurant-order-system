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
  maintenanceDsn
};
