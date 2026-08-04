"use strict";

const path = require("node:path");
const { startupConfiguration } = require("./config");
const { loadDotEnv } = require("./env-file");
const { runMigrations } = require("./db/migrate");
const {
  openRuntimePool,
  openMigrationPool,
  acquireMigrationClient,
  closeMigrationPool,
  closeAllPools
} = require("./db");
const { checkReadiness, waitForDatabase } = require("./db/health");
const { createApp } = require("./http/router");
const { createEpaperHubClient } = require("./epaper/hub-client");
const { appendAuditEvent } = require("./repositories/auth/audit");

// Route modules register themselves with route() at require time. server.js is the one place
// that pulls them in; route-auth.test.js asserts this list matches http/routes/ exactly, so a
// module that exists but is never required cannot ship as a silently unserved route.
require("./http/routes/health");
require("./http/routes/table-displays");

function listenServer(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

// Spec §3.1 and §9.4. The order is fixed and fails closed: load .env → validate configuration →
// migrate on a dedicated owner connection → close that pool → open the runtime pool → wait for
// the database → listen. Listening before migrating would serve a half-migrated schema to the
// deploy gate, which would then pass.
// Every collaborator is overridable so the ORDER can be asserted without a database.
async function start(options = {}) {
  const environment = options.env || process.env;
  // Default file is apps/core-api/.env, owned by env-file.js; never overrides a set name.
  loadDotEnv(undefined, environment);

  const config = options.config || startupConfiguration(environment);
  const migrationsDir = options.migrationsDir || path.join(__dirname, "migrations");

  const migrate = options.runMigrations || runMigrations;
  const openMigration = options.openMigrationPool || openMigrationPool;
  const acquireMigration = options.acquireMigrationClient || acquireMigrationClient;
  const closeMigration = options.closeMigrationPool || closeMigrationPool;
  const openRuntime = options.openRuntimePool || openRuntimePool;
  const waitForDb = options.waitForDatabase || waitForDatabase;
  const readiness = options.checkReadiness || (() => checkReadiness({ migrationsDir }));
  const listen = options.listen || listenServer;

  // §9.4 steps 2 and 10: a dedicated max:1 pool on the OWNER dsn, end()ed before listen, so the
  // process never keeps an idle DDL-capable connection alive for its whole lifetime.
  // runMigrations takes the CLIENT first because it holds a session-level advisory lock and a
  // BEGIN/COMMIT that must live on one backend — a pool cannot promise that.
  await openMigration({ connectionString: config.databaseMigrationUrl });
  const client = await acquireMigration();
  try {
    await migrate(client, { directory: migrationsDir, appRolePassword: config.databaseAppPassword });
  } finally {
    client.release();
    await closeMigration();
  }

  await openRuntime({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  await waitForDb({ attempts: 10, delayMs: 1000 });

  // Spec §11.7: this is the only place in the repository that builds an e-paper client, and
  // epaper/hub-client.js is the only file that requires the SDK. Built AFTER the database is
  // up so an unconfigured hub can never delay the readiness gate -- it is a plain object
  // that opens no socket until a request arrives.
  const app = createApp({
    checkReadiness: readiness,
    log: options.log,
    tableDisplay:
      options.tableDisplay ||
      createEpaperHubClient({ hubUrl: config.epaperHubUrl, apiKey: config.epaperApiKey }),
    tableDisplayServiceToken: config.tableDisplayServiceToken,
    appendAuditEvent: options.appendAuditEvent || appendAuditEvent,
    trustedProxyHops: config.trustedProxyHops
  });
  return listen(app, config.port, config.host);
}

// DEPARTURE from apps/customer-order/server.js:501-504, which sets process.exitCode = 1 and lets
// the loop drain. core-api cannot: by the time some checks fail an open pg.Pool keeps the loop
// alive forever, so the container would neither listen nor exit, restart: unless-stopped would
// never fire, and the failure would present as an indefinite hang with one log line.
async function fatal(error, options = {}) {
  const logError = options.logError || console.error;
  const close = options.closeAllPools || closeAllPools;
  const exit = options.exit || ((code) => process.exit(code));

  logError(error && error.message ? error.message : String(error));
  try {
    await close();
  } catch {
    // Closing is best effort; exiting is not.
  }
  exit(1);
}

module.exports = { createApp, start, fatal, listenServer };

if (require.main === module) {
  start()
    .then((server) => {
      const address = server.address();
      console.log(`core-api listening on http://${address.address}:${address.port}`);
    })
    .catch((error) => fatal(error));
}
