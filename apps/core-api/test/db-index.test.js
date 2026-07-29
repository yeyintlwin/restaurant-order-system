const assert = require("node:assert/strict");
const test = require("node:test");

const pool = require("../db/pool");

// A DSN that is never dialled: pg's Pool constructor opens no socket until a
// client is requested, so these cases need no database.
const UNUSED_DSN = "postgres://core_api_app:pw@127.0.0.1:5432/core_api_unused";

test("db/pool.js exports functions only, never a Pool", () => {
  // Handing a Pool out is how pool.query() spreads: one connection per call,
  // so a later SET app.company_id and its SELECT land on different backends.
  for (const [name, value] of Object.entries(pool)) {
    assert.equal(typeof value, "function", `${name} must be a function`);
  }
  assert.equal(pool.Pool, undefined);
});

test("the runtime pool validates its arguments and refuses to open twice", async () => {
  assert.equal(pool.isRuntimePoolOpen(), false);
  assert.deepEqual(pool.runtimePoolStats(), { totalCount: 0, idleCount: 0, waitingCount: 0 });

  assert.throws(() => pool.openRuntimePool({ connectionString: "", max: 4 }), /connectionString/);
  assert.throws(() => pool.openRuntimePool({ connectionString: UNUSED_DSN, max: 0 }), /max/);
  assert.throws(() => pool.openRuntimePool({ connectionString: UNUSED_DSN, max: 2.5 }), /max/);

  pool.openRuntimePool({ connectionString: UNUSED_DSN, max: 4 });
  assert.equal(pool.isRuntimePoolOpen(), true);
  assert.throws(() => pool.openRuntimePool({ connectionString: UNUSED_DSN, max: 4 }), /already open/);

  await pool.closeAllPools();
  assert.equal(pool.isRuntimePoolOpen(), false);
});

test("acquiring from a closed pool is an error, not a hang", async () => {
  await assert.rejects(() => pool.acquireRuntimeClient(), /runtime pool is not open/);
  await assert.rejects(() => pool.acquireMigrationClient(), /migration pool is not open/);
});

test("the migration pool opens separately and closes independently", async () => {
  // It is max:1 and ended before listen(): an idle owner-role connection held
  // for the process lifetime is a standing capability with no user.
  pool.openMigrationPool({ connectionString: UNUSED_DSN });
  assert.throws(() => pool.openMigrationPool({ connectionString: UNUSED_DSN }), /already open/);
  await pool.closeMigrationPool();
  pool.openMigrationPool({ connectionString: UNUSED_DSN });
  await pool.closeAllPools();
});

test("closing an unopened pool is a no-op, so the fatal-exit path cannot throw", async () => {
  await pool.closeAllPools();
  await pool.closeMigrationPool();
});
