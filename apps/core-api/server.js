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
const { createSemaphore } = require("./lib/semaphore");
const { createRateLimiter } = require("./lib/rate-limit");
const sessionsRepository = require("./repositories/auth/sessions");
const scopesRepository = require("./repositories/auth/scope-materialize");
const usersRepository = require("./repositories/auth/users");
const shopsRepository = require("./repositories/shops");
const tenantUsersRepository = require("./repositories/users");
const companiesRepository = require("./repositories/platform/companies");
const platformAuditRepository = require("./repositories/platform/audit");
const tenantAuditRepository = require("./repositories/audit");
const platformAdminsRepository = require("./repositories/platform/admins");
const platformContactsRepository = require("./repositories/platform/contacts");

// Route modules register themselves with route() at require time. server.js is the one place
// that pulls them in; route-auth.test.js asserts this list matches http/routes/ exactly, so a
// module that exists but is never required cannot ship as a silently unserved route.
require("./http/routes/health");
require("./http/routes/table-displays");
require("./http/routes/auth");
require("./http/routes/companies");
require("./http/routes/shops");
require("./http/routes/users");
require("./http/routes/platform-admins");
require("./http/routes/contacts");

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
  // Hoisted so the boot warning and createApp's access log write through ONE logger.
  // The default is byte-for-byte what createApp falls back to when deps.log is
  // undefined, so passing it below changes nothing about a normal boot.
  const logLine = options.log || ((line) => process.stdout.write(`${line}\n`));

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

  // Spec §9.10's one deliberate exception to refuse-to-start, and it is forced rather
  // than chosen: the bootstrap CLI runs through `docker compose exec`, so the
  // container must be up before the first admin can exist. Refusing here is a
  // deadlock -- the admin needs the container and the container would need the admin.
  //
  // Wrapped, because a throw would turn a transient database blip in the gap after
  // waitForDatabase into a process that never listens, which fails the deploy's
  // 90-second readiness gate AFTER the migration applied.
  const countAdmins = options.countActivePlatformAdmins || usersRepository.countActivePlatformAdmins;
  try {
    if ((await countAdmins()) === 0) {
      logLine(
        "WARNING: no active platform administrator exists. Create one with: " +
          "docker compose exec core-api node apps/core-api/scripts/create-platform-admin.js <email>"
      );
    }
  } catch (error) {
    logLine("WARNING: could not count platform administrators; continuing to listen");
  }

  // Spec §11.7: this is the only place in the repository that builds an e-paper client, and
  // epaper/hub-client.js is the only file that requires the SDK. Built AFTER the database is
  // up so an unconfigured hub can never delay the readiness gate -- it is a plain object
  // that opens no socket until a request arrives.
  const app = createApp({
    checkReadiness: readiness,
    log: logLine,
    tableDisplay:
      options.tableDisplay ||
      createEpaperHubClient({ hubUrl: config.epaperHubUrl, apiKey: config.epaperApiKey }),
    tableDisplayServiceToken: config.tableDisplayServiceToken,
    appendAuditEvent: options.appendAuditEvent || appendAuditEvent,
    trustedProxyHops: config.trustedProxyHops,
    apiPublicOrigin: config.apiPublicOrigin,
    sessionIdleSeconds: config.sessionIdleSeconds,
    sessionAbsoluteSeconds: config.sessionAbsoluteSeconds,
    loginRatePerMinute: config.loginRatePerMinute,
    loginTimeBudgetMs: config.loginTimeBudgetMs,
    passwordAbuseThreshold: config.passwordAbuseThreshold,
    adminMintRatePer10min: config.adminMintRatePer10min,
    pairingMintRatePer10min: config.pairingMintRatePer10min,
    pairRatePerMinute: config.pairRatePerMinute,
    rotateRatePerHour: config.rotateRatePerHour,
    // Date.now is injected HERE rather than read inside lib/, which is what keeps
    // lib/rate-limit.js Tier 1 and every window boundary unit-testable.
    rateLimiter: options.rateLimiter || createRateLimiter({ now: Date.now }),
    // Spec 5.1: SCRYPT_SLOTS concurrent hashes with a queue depth of 4x, shedding
    // 503 rather than queueing -- "a lengthening queue converts a CPU limit into a
    // timeout storm". ONE semaphore for the whole process: two would be two limits.
    scryptSemaphore: options.scryptSemaphore || createSemaphore({ slots: config.scryptSlots }),
    users: options.users || usersRepository,
    sessions: options.sessions || sessionsRepository,
    scopes: options.scopes || scopesRepository,
    // Whole MODULE objects, not loose functions: every handler reads them as
    // deps.companies.listCompanies(...), matching users/sessions/scopes above.
    shops: options.shops || shopsRepository,
    // NOT deps.users: that name is taken by the PRE-TENANT repository the login
    // path uses, and the two answer different questions about the word "user".
    tenantUsers: options.tenantUsers || tenantUsersRepository,
    companies: options.companies || companiesRepository,
    platformAdmins: options.platformAdmins || platformAdminsRepository,
    platformContacts: options.platformContacts || platformContactsRepository,
    platformAudit: options.platformAudit || platformAuditRepository,
    // The THIRD audit writer. deps.appendAuditEvent opens its own connection and
    // cannot see a row created in the caller's still-open transaction, which is
    // exactly what every tenant route that audits what it just wrote needs.
    tenantAudit: options.tenantAudit || tenantAuditRepository
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
