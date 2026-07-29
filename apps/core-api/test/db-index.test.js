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

const { createScope } = require("../db/scope");
const { buildTenantStatement } = require("../db/index");

const COMPANY_A = "aaaaaaaa-0000-4000-8000-000000000001";
const COMPANY_B = "bbbbbbbb-0000-4000-8000-000000000001";
const SHOP_A1 = "aaaaaaaa-0000-4000-8000-000000000011";
const SHOP_A3 = "aaaaaaaa-0000-4000-8000-000000000013";
const A_ADMIN = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

function adminScope() {
  return createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "company_admin",
    shopIds: [SHOP_A1],
    administeredShopIds: [SHOP_A1, SHOP_A3]
  });
}

function managerScope() {
  return createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "shop_manager",
    shopIds: [SHOP_A1]
  });
}

test("a read binds company_id itself and starts caller parameters at $2", () => {
  // Binding two leading parameters unconditionally would break every statement
  // that references only $1: Postgres derives the parameter count from the
  // highest $n in the text.
  assert.deepEqual(
    buildTenantStatement(adminScope(), { sql: "SELECT id FROM shops WHERE company_id = $1", shopScoped: false }),
    { text: "SELECT id FROM shops WHERE company_id = $1", values: [COMPANY_A] }
  );
  assert.deepEqual(
    buildTenantStatement(
      adminScope(),
      { sql: "SELECT id FROM shops WHERE company_id = $1 AND status = $2", shopScoped: false },
      ["active"]
    ),
    { text: "SELECT id FROM shops WHERE company_id = $1 AND status = $2", values: [COMPANY_A, "active"] }
  );
});

test("shopScoped chooses between the two scope-derived sets and nothing else", () => {
  const sql = "SELECT id FROM shop_tables WHERE company_id = $1 AND shop_id = ANY($2)";

  assert.deepEqual(buildTenantStatement(adminScope(), { sql, shopScoped: "active" }).values, [COMPANY_A, [SHOP_A1]]);
  assert.deepEqual(buildTenantStatement(adminScope(), { sql, shopScoped: "administered" }).values, [
    COMPANY_A,
    [SHOP_A1, SHOP_A3]
  ]);
  // A manager has no status-independent set; asking for one is a throw, never a
  // NULL that widens the query.
  assert.throws(
    () => buildTenantStatement(managerScope(), { sql, shopScoped: "administered" }),
    /carries no administeredShopIds/
  );
});

test("shopScoped is a closed vocabulary with no default", () => {
  const sql = "SELECT id FROM shop_tables WHERE company_id = $1 AND shop_id = ANY($2)";
  assert.throws(() => buildTenantStatement(adminScope(), { sql }), /shopScoped/);
  assert.throws(() => buildTenantStatement(adminScope(), { sql, shopScoped: true }), /shopScoped/);
  assert.throws(() => buildTenantStatement(adminScope(), { sql, shopScoped: "all" }), /shopScoped/);
  assert.throws(() => buildTenantStatement(adminScope(), { sql, shopScoped: [SHOP_A1] }), /shopScoped/);
});

test("the declared predicate and the SQL must agree in both directions", () => {
  assert.throws(
    () => buildTenantStatement(adminScope(), { sql: "SELECT id FROM shops", shopScoped: false }),
    /must filter on company_id = \$1/
  );
  assert.throws(
    () =>
      buildTenantStatement(adminScope(), {
        sql: "SELECT id FROM shop_tables WHERE company_id = $1",
        shopScoped: "active"
      }),
    /requires the SQL to filter on shop_id = ANY\(\$2\)/
  );
  assert.throws(
    () =>
      buildTenantStatement(adminScope(), {
        sql: "SELECT id FROM shop_tables WHERE company_id = $1 AND shop_id = ANY($2)",
        shopScoped: false
      }),
    /requires shopScoped/
  );
});

test("company_id may never be bound to a caller parameter or a literal", () => {
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "SELECT id FROM shops WHERE company_id = $2", shopScoped: false },
        [COMPANY_B]
      ),
    /company_id may only be compared to \$1/
  );
  assert.throws(
    () =>
      buildTenantStatement(adminScope(), {
        sql: "SELECT id FROM shops WHERE company_id = 'aaaaaaaa-0000-4000-8000-000000000001'",
        shopScoped: false
      }),
    /company_id may only be compared to \$1/
  );
});

test("a composite join on company_id is still allowed", () => {
  // Rejecting every second mention of company_id would ban the strongest join
  // the schema supports, so the rule is about what it is compared TO.
  const sql =
    "SELECT t.id FROM terminals t JOIN shops s ON s.id = t.shop_id AND s.company_id = t.company_id WHERE t.company_id = $1";
  assert.deepEqual(buildTenantStatement(adminScope(), { sql, shopScoped: false }).values, [COMPANY_A]);
});

test("an INSERT may not name company_id at all; the helper injects it", () => {
  // Requiring only that it APPEAR is not enough: a helper reused between a
  // platform route and a tenant invite route would let a company_admin who
  // learned another company's uuid create a company_admin row inside it.
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "INSERT INTO shop_tables (company_id, shop_id, label) VALUES ($1, $2, $3)", shopScoped: false },
        [COMPANY_B, SHOP_A1, "T1"]
      ),
    /an INSERT may not name company_id/
  );

  assert.deepEqual(
    buildTenantStatement(
      adminScope(),
      { sql: "INSERT INTO shop_tables (shop_id, label) VALUES ($2, $3) RETURNING id", shopScoped: false },
      [SHOP_A1, "T1"]
    ),
    {
      text: "INSERT INTO shop_tables (company_id, shop_id, label) VALUES ($1, $2, $3) RETURNING id",
      values: [COMPANY_A, SHOP_A1, "T1"]
    }
  );
});

test("an UPDATE may not assign company_id", () => {
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "UPDATE users SET company_id = $2 WHERE company_id = $1 AND id = $3", shopScoped: false },
        [COMPANY_B, A_ADMIN]
      ),
    /company_id may only be compared to \$1/
  );
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "UPDATE users SET company_id = $1, status = $2 WHERE company_id = $1 AND id = $3", shopScoped: false },
        ["suspended", A_ADMIN]
      ),
    /an UPDATE may not assign company_id/
  );
  assert.deepEqual(
    buildTenantStatement(
      adminScope(),
      { sql: "UPDATE shops SET name = $2 WHERE company_id = $1 AND id = $3", shopScoped: false },
      ["Renamed", SHOP_A1]
    ).values,
    [COMPANY_A, "Renamed", SHOP_A1]
  );
});

test("an INSERT reserves $1, takes no shop predicate, and must be a single VALUES row", () => {
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "INSERT INTO shop_tables (shop_id) VALUES ($1)", shopScoped: false },
        [SHOP_A1]
      ),
    /\$1 is reserved for company_id/
  );
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "INSERT INTO shop_tables (shop_id, label) VALUES ($2, $3)", shopScoped: "active" },
        [SHOP_A1, "T1"]
      ),
    /an INSERT cannot declare shopScoped/
  );
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "INSERT INTO shop_tables (shop_id, label) VALUES ($2, $3), ($2, $4)", shopScoped: false },
        [SHOP_A1, "T1", "T2"]
      ),
    /single VALUES row/
  );
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "INSERT INTO shop_tables SELECT $2, $3", shopScoped: false },
        [SHOP_A1, "T1"]
      ),
    /INSERT INTO <table> \(<columns>\) VALUES/
  );
});

test("the bound parameter count must match the highest placeholder", () => {
  // This is the "bind message supplies 2 parameters, but prepared statement
  // requires 1" failure, caught before the driver ever sees it.
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "SELECT id FROM shops WHERE company_id = $1", shopScoped: false },
        ["active"]
      ),
    /uses \$1 but 2 values are bound/
  );
  assert.throws(
    () =>
      buildTenantStatement(adminScope(), {
        sql: "SELECT id FROM shops WHERE company_id = $1 AND status = $2",
        shopScoped: false
      }),
    /uses \$2 but 1 value is bound/
  );
});

test("a shop predicate the descriptor does not declare is left alone", () => {
  // shopScoped:false plus a caller-bound shop_id = $2 is a REAL query shape.
  // Rejecting it here would hide the containment bug behind a descriptor error
  // instead of letting the isolation suite catch it where it lives.
  assert.deepEqual(
    buildTenantStatement(
      managerScope(),
      { sql: "SELECT id FROM terminals WHERE company_id = $1 AND shop_id = $2", shopScoped: false },
      [SHOP_A3]
    ).values,
    [COMPANY_A, SHOP_A3]
  );
});

test("buildTenantStatement refuses a bad scope, a bad descriptor and bad params", () => {
  const descriptor = { sql: "SELECT id FROM shops WHERE company_id = $1", shopScoped: false };
  assert.throws(() => buildTenantStatement({ companyId: COMPANY_A }, descriptor), /was not produced by createScope/);
  assert.throws(() => buildTenantStatement(adminScope(), null), /requires a descriptor object/);
  assert.throws(() => buildTenantStatement(adminScope(), { sql: "  ", shopScoped: false }), /requires sql/);
  assert.throws(() => buildTenantStatement(adminScope(), descriptor, "active"), /params must be an array/);
});

const dbSeam = require("../db/index");
const { withTenantScope, tenantQuery, withUnscopedConnection } = dbSeam;

test("tenantQuery outside a transaction is an error, not a fresh connection", async () => {
  await assert.rejects(
    () => tenantQuery(adminScope(), { sql: "SELECT id FROM shops WHERE company_id = $1", shopScoped: false }),
    /must run inside withTenantScope/
  );
});

test("the seam refuses a bad scope and a non-function body before touching the pool", async () => {
  // Every one of these must fail without checking out a client: the pool is
  // closed in this process, so a client checkout would reject with the wrong
  // message and hide the real assertion.
  await assert.rejects(() => withTenantScope({ companyId: COMPANY_A }, async () => null), /was not produced by createScope/);
  await assert.rejects(() => withTenantScope(adminScope(), "not a function"), /withTenantScope requires a function/);
  await assert.rejects(() => withUnscopedConnection("not a function"), /withUnscopedConnection requires a function/);
});

test("db/index.js is the seam: it re-exports every db/pool.js function by identity", () => {
  // Spec 3.2 rule 1: everything outside db/ goes through db/index.js. Without
  // these, server.js would have to require("./db/pool") directly, which is the
  // exact reach-past this rule exists to forbid.
  assert.deepEqual(Object.keys(dbSeam).sort(), [
    "acquireMigrationClient",
    "acquireRuntimeClient",
    "buildTenantStatement",
    "closeAllPools",
    "closeMigrationPool",
    "isRuntimePoolOpen",
    "openMigrationPool",
    "openRuntimePool",
    "runtimePoolStats",
    "tenantQuery",
    "withTenantScope",
    "withUnscopedConnection"
  ]);
  for (const name of Object.keys(pool)) {
    assert.equal(dbSeam[name], pool[name], `${name} must be the same function object as db/pool.js's`);
  }
});
