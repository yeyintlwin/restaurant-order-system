const assert = require("node:assert/strict");
const test = require("node:test");
const { start } = require("../server");

const CONFIG = Object.freeze({
  port: 0,
  host: "127.0.0.1",
  nodeEnv: "test",
  databaseUrl: "postgres://core_api_app:app-secret@127.0.0.1:5433/core",
  databaseMigrationUrl: "postgres://core_api_owner:owner-secret@127.0.0.1:5433/core",
  databaseAppPassword: "app-secret",
  dbPoolMax: 12,
  scryptSlots: 2
});

// A stand-in for the pool checkout. Recording its identity is how the test pins runMigrations'
// CLIENT-FIRST signature: an implementation that passed a single options object would put an
// object with no `id` in position one and this string would not match.
function migrationClient(calls) {
  return { id: "migration-client", release: () => calls.push("release:migration-client") };
}

function collaborators(calls, overrides = {}) {
  return {
    config: CONFIG,
    env: {}, // a throwaway environment, so loadDotEnv cannot touch the real process.env
    migrationsDir: "/tmp/core-api-migrations",
    log: () => {},
    openMigrationPool: (options) => calls.push(`openMigrationPool:${options.connectionString}`),
    acquireMigrationClient: async () => {
      calls.push("acquireMigrationClient");
      return migrationClient(calls);
    },
    closeMigrationPool: async () => calls.push("closeMigrationPool"),
    runMigrations: async (client, options) => {
      calls.push(`runMigrations:${client.id}:${options.directory}:${options.appRolePassword}`);
    },
    openRuntimePool: (options) => calls.push(`openRuntimePool:${options.connectionString}:${options.max}`),
    waitForDatabase: async (options) => calls.push(`wait:${options.attempts}x${options.delayMs}`),
    countActivePlatformAdmins: async () => {
      calls.push("countActivePlatformAdmins");
      return 1;
    },
    checkReadiness: async () => ({ database: "ready", migrations: "current" }),
    listen: async (app, port, host) => {
      calls.push(`listen:${host}:${port}`);
      return { app, port, host };
    },
    ...overrides
  };
}

test("start() migrates on a dedicated client, closes that pool, then opens the runtime pool and listens", async () => {
  const calls = [];

  const result = await start(collaborators(calls));

  assert.deepEqual(calls, [
    `openMigrationPool:${CONFIG.databaseMigrationUrl}`,
    "acquireMigrationClient",
    "runMigrations:migration-client:/tmp/core-api-migrations:app-secret",
    "release:migration-client",
    "closeMigrationPool",
    `openRuntimePool:${CONFIG.databaseUrl}:12`,
    "wait:10x1000",
    "countActivePlatformAdmins",
    "listen:127.0.0.1:0"
  ]);
  assert.equal(result.port, 0);
});

test("a failed migration means the port never opens, and the client is still released", async () => {
  const calls = [];

  await assert.rejects(
    start(
      collaborators(calls, {
        runMigrations: async () => {
          throw new Error("0002_add_menu.sql is pending");
        }
      })
    ),
    /0002_add_menu\.sql is pending/
  );

  assert.deepEqual(calls, [
    `openMigrationPool:${CONFIG.databaseMigrationUrl}`,
    "acquireMigrationClient",
    "release:migration-client",
    "closeMigrationPool"
  ]);
});

test("a database that never comes up means the port never opens", async () => {
  const calls = [];

  await assert.rejects(
    start(
      collaborators(calls, {
        waitForDatabase: async () => {
          throw new Error("database did not accept connections after 10 attempts");
        }
      })
    ),
    /did not accept connections/
  );

  assert.equal(calls.includes("listen:127.0.0.1:0"), false, "nothing after the readiness wait may run");
  assert.equal(calls.at(-1), `openRuntimePool:${CONFIG.databaseUrl}:12`);
});

test("an empty platform_admin set warns and still listens", async () => {
  // The ONE deliberate exception to this repository's refuse-to-start convention, and
  // it is forced by mechanism rather than chosen: spec 9.10 runs the bootstrap CLI
  // through `docker compose exec`, so the container must already be up. Refusing here
  // would make the platform unbootstrappable -- the admin needs the container and the
  // container would need the admin.
  const calls = [];
  const lines = [];

  await start(
    collaborators(calls, {
      countActivePlatformAdmins: async () => {
        calls.push("countActivePlatformAdmins");
        return 0;
      },
      log: (line) => lines.push(line)
    })
  );

  assert.ok(lines.some((line) => /platform administrator/i.test(line)));
  assert.equal(calls.at(-1), "listen:127.0.0.1:0");
});

test("a failed platform-admin count warns and still listens", async () => {
  // It runs after waitForDatabase, so a throw here means the database went away in
  // the gap. Turning that into a refusal to listen would fail the deploy's 90-second
  // readiness gate AFTER the migration applied -- the failure shape spec 9.5 spends a
  // page designing away.
  const calls = [];
  const lines = [];

  await start(
    collaborators(calls, {
      countActivePlatformAdmins: async () => {
        throw new Error("terminating connection due to administrator command");
      },
      log: (line) => lines.push(line)
    })
  );

  assert.ok(lines.some((line) => /count platform administrators/i.test(line)));
  assert.equal(calls.at(-1), "listen:127.0.0.1:0");
});

const { fatal } = require("../server");

test("fatal() logs the message, closes the pools, then really exits 1", async () => {
  const calls = [];

  await fatal(new Error("DATABASE_URL is required"), {
    logError: (message) => calls.push(`log:${message}`),
    closeAllPools: async () => calls.push("close"),
    exit: (code) => calls.push(`exit:${code}`)
  });

  assert.deepEqual(calls, ["log:DATABASE_URL is required", "close", "exit:1"]);
});

test("fatal() exits even when closing the pools throws", async () => {
  const calls = [];

  await fatal(new Error("boom"), {
    logError: () => {},
    closeAllPools: async () => {
      throw new Error("pool already ended");
    },
    exit: (code) => calls.push(`exit:${code}`)
  });

  assert.deepEqual(calls, ["exit:1"], "an open pg.Pool keeps the loop alive forever — process.exit is not optional");
});

test("fatal() logs a bare thrown string without touching .message", async () => {
  const calls = [];

  await fatal("a bare string, not an Error", {
    logError: (message) => calls.push(message),
    closeAllPools: async () => {},
    exit: () => {}
  });

  assert.deepEqual(calls, ["a bare string, not an Error"]);
});
