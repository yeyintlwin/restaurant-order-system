// The ONLY file in the service that may require("pg"), and it never exports a
// Pool. Everything else goes through db/index.js, which is what makes "one
// statement, one connection, one transaction, one company_id" enforceable.
// Structural test C1 asserts this file is the entire require("pg") caller set.
const { Pool } = require("pg");

// Named in pg_stat_activity, so an operator can tell a stuck migration from a
// stuck request without guessing.
const RUNTIME_APPLICATION_NAME = "core-api";
const MIGRATION_APPLICATION_NAME = "core-api-migrate";

let runtimePool = null;
let migrationPool = null;

function requireDsn(connectionString, caller) {
  if (typeof connectionString !== "string" || connectionString === "") {
    throw new Error(`${caller} requires a non-empty connectionString`);
  }
  return connectionString;
}

function openRuntimePool(options) {
  if (runtimePool !== null) throw new Error("the runtime pool is already open");
  const connectionString = requireDsn(options && options.connectionString, "openRuntimePool");
  const max = options.max;
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`openRuntimePool requires an integer max >= 1 (got ${String(max)})`);
  }

  runtimePool = new Pool({
    connectionString,
    max,
    application_name: RUNTIME_APPLICATION_NAME,
    // A checkout that cannot be satisfied must fail rather than queue forever;
    // the caller turns that into 503, which is a truthful answer.
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000
  });
  // A pg Pool emits 'error' for a client that dies while idle. Unhandled, that
  // event is an uncaught exception that kills the process every time Postgres
  // restarts underneath us.
  runtimePool.on("error", (error) => {
    console.error(`core-api: idle database client error (${error.code || error.message})`);
  });
}

function isRuntimePoolOpen() {
  return runtimePool !== null;
}

async function acquireRuntimeClient() {
  if (runtimePool === null) throw new Error("the runtime pool is not open");
  return runtimePool.connect();
}

// The connection-leak guard reads this: a repository that throws without
// releasing is a slow production death no functional assertion notices.
function runtimePoolStats() {
  if (runtimePool === null) return { totalCount: 0, idleCount: 0, waitingCount: 0 };
  return {
    totalCount: runtimePool.totalCount,
    idleCount: runtimePool.idleCount,
    waitingCount: runtimePool.waitingCount
  };
}

function openMigrationPool(options) {
  if (migrationPool !== null) throw new Error("the migration pool is already open");
  const connectionString = requireDsn(options && options.connectionString, "openMigrationPool");
  // max: 1 because the runner holds a SESSION-level advisory lock; a second
  // connection would not hold it and could apply files behind the first.
  migrationPool = new Pool({
    connectionString,
    max: 1,
    application_name: MIGRATION_APPLICATION_NAME,
    connectionTimeoutMillis: 2000
  });
  migrationPool.on("error", (error) => {
    console.error(`core-api: idle migration client error (${error.code || error.message})`);
  });
}

async function acquireMigrationClient() {
  if (migrationPool === null) throw new Error("the migration pool is not open");
  return migrationPool.connect();
}

async function closeMigrationPool() {
  if (migrationPool === null) return;
  const closing = migrationPool;
  migrationPool = null;
  await closing.end();
}

async function closeAllPools() {
  await closeMigrationPool();
  if (runtimePool === null) return;
  const closing = runtimePool;
  runtimePool = null;
  await closing.end();
}

module.exports = {
  openRuntimePool,
  isRuntimePoolOpen,
  acquireRuntimeClient,
  runtimePoolStats,
  openMigrationPool,
  acquireMigrationClient,
  closeMigrationPool,
  closeAllPools
};
