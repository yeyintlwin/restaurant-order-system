"use strict";

const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");

const { createScope, assertPlatformScope } = require("../db/scope");
const {
  assertPlatformStatement,
  withPlatformScope,
  platformQuery,
  withTenantScope,
  openRuntimePool,
  closeAllPools
} = require("../db");
const { dangerouslyQueryAcrossTenants } = require("../repositories/platform/query");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");

const PLATFORM = createScope({
  kind: "platform",
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  sessionId: "aaaaaaaa-0000-4000-8000-000000000002"
});

const TENANT = createScope({
  kind: "tenant",
  userId: "aaaaaaaa-0000-4000-8000-000000000003",
  sessionId: "aaaaaaaa-0000-4000-8000-000000000004",
  companyId: "aaaaaaaa-0000-4000-8000-000000000005",
  role: "company_admin",
  shopIds: [],
  administeredShopIds: []
});

// --- the scope assertion (pure) --------------------------------------------

test("assertPlatformScope takes only a stamped platform scope", () => {
  assert.equal(assertPlatformScope(PLATFORM), PLATFORM);

  // The one that matters. A plain object with the right shape is exactly what a
  // handler forwarding something from a request body would produce, and without
  // the stamp it would open the cross-tenant door.
  assert.throws(
    () => assertPlatformScope({ kind: "platform", userId: "x", sessionId: "y" }),
    /not produced by createScope/
  );
  // Spread copies the stamp -- that is deliberate, and it is what lets this file
  // build a stamped-but-wrong scope and prove the OTHER clauses bite.
  assert.throws(() => assertPlatformScope({ ...TENANT }), /tenant scope cannot drive a cross-tenant query/);
  assert.throws(() => assertPlatformScope(null), /platform scope is required/);
  assert.throws(() => assertPlatformScope("platform"), /platform scope is required/);
});

// --- the write restriction (pure) ------------------------------------------

test("assertPlatformStatement lets any read through", () => {
  // Reads stay open on purpose: a platform admin legitimately reads across
  // tenants. The console's Companies screen counts every company's shops and
  // tables, so a SELECT naming a tenant table is the FEATURE, not a leak.
  for (const sql of [
    "SELECT * FROM companies",
    "SELECT count(*) FROM shops WHERE company_id = $1",
    "  select c.id, count(s.id) from companies c left join shops s on s.company_id = c.id group by c.id",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    // A row lock is a READ, and the word UPDATE in it is not a verb. The first
    // version failed closed here and refused the exact statement that makes the
    // last-platform-admin check race-free.
    "SELECT id FROM users WHERE role = 'platform_admin' FOR UPDATE",
    "SELECT id FROM companies FOR NO KEY UPDATE",
    "SELECT id FROM companies FOR SHARE"
  ]) {
    assert.doesNotThrow(() => assertPlatformStatement(sql), sql);
  }
});

test("assertPlatformStatement refuses a write to a tenant table", () => {
  // This is the half that would be missing if the seam were built from the spec
  // sentence alone. A hatch that can only READ widely is bounded by what the role
  // already sees; one that can WRITE widely edits another company's rows with no
  // company_id anywhere in the statement.
  for (const sql of [
    "DELETE FROM shop_tables WHERE id = $1",
    "INSERT INTO user_shops (user_id, shop_id, company_id) VALUES ($1, $2, $3)",
    "insert into terminals (id) values ($1)"
  ]) {
    assert.throws(() => assertPlatformStatement(sql), /not a platform-owned table/, sql);
  }
});

test("assertPlatformStatement allows writes to the four platform-owned tables", () => {
  for (const sql of [
    "INSERT INTO companies (name, slug) VALUES ($1, $2)",
    "UPDATE companies SET status = $1 WHERE id = $2",
    "UPDATE users SET status = $1 WHERE id = $2",
    "INSERT INTO audit_events (action) VALUES ($1)",
    // The fourth table, and the one column it is here for. A branch's mark is set
    // from a screen where the platform owner is inside no company at all.
    "UPDATE shops SET logo_key = $1 WHERE id = $2",
    // Schema-qualified and quoted are ordinary ways to write an ordinary
    // statement. The first version of the guard refused both, and a guard that
    // refuses legitimate SQL teaches people to route around it.
    "INSERT INTO public.companies (name) VALUES ($1)",
    'INSERT INTO "companies" (name) VALUES ($1)'
  ]) {
    assert.doesNotThrow(() => assertPlatformStatement(sql), sql);
  }
});

test("assertPlatformStatement refuses a write hidden in a common table expression", () => {
  // The hole the first version had, and the reason the scan is global rather than
  // anchored at the start. Every one of these is a SELECT to a guard that reads
  // only the leading verb, and a write to a tenant table to Postgres -- through the
  // one hatch that is allowed to ignore company_id.
  for (const sql of [
    "WITH x AS (SELECT 1) UPDATE shop_tables SET label = $1",
    "WITH d AS (DELETE FROM shop_tables RETURNING id) SELECT * FROM d",
    "WITH n AS (INSERT INTO user_shops (user_id) VALUES ($1) RETURNING 1) SELECT * FROM n",
    // A legal platform write in the outer statement does not license a tenant
    // write in the CTE: EVERY target is checked, not just the first one found.
    "WITH d AS (DELETE FROM terminals RETURNING id) INSERT INTO companies (name) SELECT id FROM d"
  ]) {
    assert.throws(() => assertPlatformStatement(sql), /not a platform-owned table/, sql);
  }
});

test("assertPlatformStatement refuses a write whose table it cannot identify", () => {
  // Fail closed. An unparseable write is not waved through on the grounds that the
  // regex did not understand it.
  assert.throws(() => assertPlatformStatement("UPDATE /* sneaky */ SET x = 1"), /cannot identify the table/);
});

// --- the transaction seam ---------------------------------------------------

test("platformQuery refuses to run outside withPlatformScope", async () => {
  await assert.rejects(
    () => platformQuery(PLATFORM, { sql: "SELECT 1" }),
    /must run inside withPlatformScope/
  );
});

test("withPlatformScope refuses a tenant scope", async () => {
  await assert.rejects(
    () => withPlatformScope(TENANT, async () => 1),
    /tenant scope cannot drive a cross-tenant query/
  );
});

describe("the platform seam against a real database", { skip: skipDatabaseTests() }, () => {
  let db;

  before(async () => {
    db = await cloneTemplate(__filename);
    openRuntimePool({ connectionString: db.connectionString, max: 4 });
  });
  after(async () => {
    await closeAllPools();
    await db.drop();
  });

  test("refuses to nest inside a tenant transaction", async () => {
    // A transaction holding both a company_id and a claim to be above all of them
    // is refused rather than resolved: whichever answer it gave would be wrong for
    // half the statements inside it.
    await assert.rejects(
      () => withTenantScope(TENANT, async () => withPlatformScope(PLATFORM, async () => 1)),
      /cannot open inside a tenant transaction/
    );
  });

  test("reads and writes, and a named constraint becomes a declared code", async () => {
    await db.resetFixtures();

    const created = await withPlatformScope(PLATFORM, async () => {
      const { rows } = await dangerouslyQueryAcrossTenants(
        PLATFORM,
        {
          sql: "INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id, name, slug",
          conflicts: { companies_slug_key: "company_slug_taken" }
        },
        ["Sakura Kitchen", "sakura"]
      );
      return rows[0];
    });
    assert.equal(created.slug, "sakura");

    // A constraint named in `conflicts` becomes a declared 409 rather than a raw
    // 23505 reaching the error tail as a 500.
    await assert.rejects(
      () =>
        withPlatformScope(PLATFORM, () =>
          dangerouslyQueryAcrossTenants(
            PLATFORM,
            {
              sql: "INSERT INTO companies (name, slug) VALUES ($1, $2)",
              conflicts: { companies_slug_key: "company_slug_taken" }
            },
            ["Another Name", "sakura"]
          )
        ),
      (error) => error.status === 409 && error.code === "company_slug_taken"
    );
  });

  test("the callback is one transaction, and a throw rolls all of it back", async () => {
    await db.resetFixtures();
    await assert.rejects(
      () =>
        withPlatformScope(PLATFORM, async () => {
          await dangerouslyQueryAcrossTenants(
            PLATFORM,
            { sql: "INSERT INTO companies (name, slug) VALUES ($1, $2)" },
            ["Rolled Back", "rolled-back"]
          );
          throw new Error("boom");
        }),
      /boom/
    );
    const { rows } = await db.unscoped("SELECT slug FROM companies");
    assert.deepEqual(rows, []);
  });

  test("counts its placeholders", async () => {
    // Same rule tenantQuery enforces, and the same reason: a $2 with nothing bound
    // is a runtime error from Postgres that reads as a driver problem.
    await assert.rejects(
      () => withPlatformScope(PLATFORM, () => platformQuery(PLATFORM, { sql: "SELECT $1, $2" }, ["one"])),
      /uses \$2 but 1 value is bound/
    );
  });
});
