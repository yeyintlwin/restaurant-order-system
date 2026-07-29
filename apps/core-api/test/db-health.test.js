const assert = require("node:assert/strict");
const test = require("node:test");

const {
  probeReadiness,
  checkReadiness,
  waitForDatabase,
  connectWithRetry,
  isRetryableConnectionError,
  fatalConnectionMessage,
  READINESS_STATEMENT_TIMEOUT_MS
} = require("../db/health");

function pgError(code) {
  const error = new Error(`simulated ${code}`);
  error.code = code;
  return error;
}

test("only transient connection failures are retryable", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "57P03"]) {
    assert.equal(isRetryableConnectionError(pgError(code)), true, code);
  }
  for (const code of ["28P01", "28000", "3D000", "42P01", undefined]) {
    assert.equal(isRetryableConnectionError(pgError(code)), false, String(code));
  }
  assert.equal(isRetryableConnectionError(null), false);
});

test("connectWithRetry returns the first success without sleeping", async () => {
  let calls = 0;
  const value = await connectWithRetry(
    async () => {
      calls += 1;
      return "connected";
    },
    { sleep: async () => assert.fail("must not sleep on success") }
  );
  assert.equal(value, "connected");
  assert.equal(calls, 1);
});

test("connectWithRetry recovers from a database that is still starting", async () => {
  // 57P03 is "the database system is starting up" — exactly what compose
  // produces when core-api wins the race against core-db's first initdb.
  let calls = 0;
  const delays = [];
  const value = await connectWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw pgError("57P03");
      return "connected";
    },
    { sleep: async (ms) => delays.push(ms) }
  );
  assert.equal(value, "connected");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("the retry is bounded at ten attempts one second apart", async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(
    () =>
      connectWithRetry(
        async () => {
          calls += 1;
          throw pgError("ECONNREFUSED");
        },
        { sleep: async (ms) => delays.push(ms) }
      ),
    /ECONNREFUSED/
  );
  assert.equal(calls, 10);
  assert.deepEqual(delays, new Array(9).fill(1000));
});

test("a rejected password fails immediately and names the rotation runbook", async () => {
  // Retrying a wrong password for ten seconds buries a deterministic failure
  // behind a timeout, and the operator reads it as "the database is down".
  let calls = 0;
  await assert.rejects(
    () =>
      connectWithRetry(
        async () => {
          calls += 1;
          throw pgError("28P01");
        },
        { variableName: "DATABASE_MIGRATION_URL", sleep: async () => assert.fail("must not sleep") }
      ),
    (error) => {
      assert.equal(
        error.message,
        'DATABASE_MIGRATION_URL was rejected by the server (28P01). If you rotated POSTGRES_PASSWORD, the running cluster still holds the old value — see apps/core-api/README.md "Rotating database passwords".'
      );
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("a missing database and a refused role are fatal too", async () => {
  assert.match(
    fatalConnectionMessage(pgError("28000"), "DATABASE_URL"),
    /^DATABASE_URL was rejected by the server \(28000\)/
  );
  assert.match(fatalConnectionMessage(pgError("3D000"), "DATABASE_URL"), /names a database that does not exist/);
  assert.equal(fatalConnectionMessage(pgError("ECONNREFUSED"), "DATABASE_URL"), null);
  assert.equal(fatalConnectionMessage(null, "DATABASE_URL"), null);

  let calls = 0;
  await assert.rejects(
    () =>
      connectWithRetry(
        async () => {
          calls += 1;
          throw pgError("3D000");
        },
        { sleep: async () => assert.fail("must not sleep") }
      ),
    /names a database that does not exist/
  );
  assert.equal(calls, 1);
});

test("an error that is neither transient nor named is raised as it is", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      connectWithRetry(
        async () => {
          calls += 1;
          throw pgError("42P01");
        },
        { sleep: async () => assert.fail("must not sleep") }
      ),
    /simulated 42P01/
  );
  assert.equal(calls, 1);
});

test("readiness reports a closed vocabulary, never an exception", async () => {
  // No runtime pool is open in this process, so this exercises the path the
  // deploy gate hits when core-db is gone. The word is for the request log; the
  // client still gets the ordinary opaque 503 envelope.
  assert.equal(await probeReadiness(), "unreachable");
  assert.equal(READINESS_STATEMENT_TIMEOUT_MS, 2000);
});

test("waitForDatabase really goes through the pool, and does not retry a closed one", async () => {
  // "the runtime pool is not open" carries no .code, so it is not retryable —
  // which is the proof that waitForDatabase is wired to withUnscopedConnection
  // and not to some injected stand-in.
  await assert.rejects(() => waitForDatabase({ attempts: 2, delayMs: 1 }), /runtime pool is not open/);
});

const path = require("node:path");
const { before, after, describe } = require("node:test");
const { openRuntimePool, closeAllPools } = require("../db");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

test("with no database the verdict is unreachable/pending and nothing throws", async () => {
  // /health/ready must answer, always. A probe that rejects turns a database
  // outage into an unhandled rejection inside the request pipeline.
  assert.deepEqual(await checkReadiness({ migrationsDir: MIGRATIONS_DIR }), {
    database: "unreachable",
    migrations: "pending"
  });
});

let healthDb;

describe("readiness against a real database", { skip: skipDatabaseTests() }, () => {
  before(async () => {
    healthDb = await cloneTemplate(__filename);
    openRuntimePool({ connectionString: healthDb.connectionString, max: 2 });
  });

  after(async () => {
    await closeAllPools();
    await healthDb.end();
  });

  test("a fully migrated database reports ready and current", async () => {
    assert.equal(await probeReadiness(), "ready");
    assert.deepEqual(await checkReadiness({ migrationsDir: MIGRATIONS_DIR }), {
      database: "ready",
      migrations: "current"
    });
    await waitForDatabase({ attempts: 2, delayMs: 1 });
  });

  test("an edited history reports checksum_mismatch while the database stays ready", async () => {
    // The two halves are independent on purpose: "the database answers but the
    // schema is not the one this image expects" is the state the deploy gate
    // exists to catch, and it is invisible if the probe returns one word.
    await healthDb.unscoped("UPDATE schema_migrations SET checksum = decode(repeat('00', 32), 'hex')");
    assert.deepEqual(await checkReadiness({ migrationsDir: MIGRATIONS_DIR }), {
      database: "ready",
      migrations: "checksum_mismatch"
    });
  });

  test("an empty ledger reports pending", async () => {
    await healthDb.unscoped("DELETE FROM schema_migrations");
    assert.deepEqual(await checkReadiness({ migrationsDir: MIGRATIONS_DIR }), {
      database: "ready",
      migrations: "pending"
    });
  });
});
