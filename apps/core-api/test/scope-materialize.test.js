"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const { seedTwoTenant, IDS } = require("../testing/fixtures/two-tenant");
const { openRuntimePool, closeAllPools } = require("../db");
const { assertTenantScope } = require("../db/scope");
const { materialiseScope } = require("../repositories/auth/scope-materialize");

const skip = skipDatabaseTests();
let db;

const SESSION = IDS.sessionAAdmin;

test("setup", { skip }, async () => {
  db = await cloneTemplate(__filename);
  await db.resetFixtures();
  await seedTwoTenant(db);
  await openRuntimePool({ connectionString: db.connectionString, max: 4 });
});

test("an unscoped platform admin gets a platform scope and reaches no tenant query", { skip }, async () => {
  const scope = await materialiseScope({
    userId: IDS.userPlatformAdmin, sessionId: IDS.sessionPlatformUnscoped,
    role: "platform_admin", companyId: null, actingCompanyId: null
  });

  assert.equal(scope.kind, "platform");
  assert.equal(scope.userId, IDS.userPlatformAdmin);
  // 5.4: "there is no if (scope.kind === 'platform') skip the filter inside any
  // tenant repository". db/scope.js's assertTenantScope is the gate that makes it
  // structural rather than a promise.
  assert.throws(() => assertTenantScope(scope), /platform scope cannot drive a tenant query/);
});

test("a SCOPED platform admin materialises role platform_admin and auditCrossTenant", { skip }, async () => {
  // 5.4: "a scoped platform_admin materialises role: 'platform_admin' -- rank 3,
  // above company_admin -- so the rank lattice does the work and no alias needs a
  // special case." That is what makes the documented tenant bootstrap possible:
  // create the company's first company_admin through the ordinary users route.
  const scope = await materialiseScope({
    userId: IDS.userPlatformAdmin, sessionId: IDS.sessionPlatformInA,
    role: "platform_admin", companyId: null, actingCompanyId: IDS.companyA
  });

  assert.equal(scope.kind, "tenant");
  assert.equal(scope.role, "platform_admin");
  assert.equal(scope.companyId, IDS.companyA);
  assert.equal(scope.auditCrossTenant, true);
  assert.deepEqual([...scope.shopIds].sort(), [IDS.shopA1, IDS.shopA2].sort());
  assert.deepEqual([...scope.administeredShopIds].sort(), [IDS.shopA1, IDS.shopA2, IDS.shopA3].sort());
  assert.doesNotThrow(() => assertTenantScope(scope));
});

test("administeredShopIds is what makes suspension REVERSIBLE", { skip }, async () => {
  // Shop A3 is seeded suspended. 5.4: it "must disappear from its manager's world
  // while staying reachable by the company admin who has to un-suspend it."
  const admin = await materialiseScope({
    userId: IDS.userAAdmin, sessionId: SESSION,
    role: "company_admin", companyId: IDS.companyA, actingCompanyId: IDS.companyA
  });
  assert.equal(admin.shopIds.includes(IDS.shopA3), false);
  assert.equal(admin.administeredShopIds.includes(IDS.shopA3), true);
});

test("a shop_manager sees only ASSIGNED and ACTIVE shops, and carries no administered set", { skip }, async () => {
  // A-manager is assigned to A1 (active) and A3 (suspended).
  const scope = await materialiseScope({
    userId: IDS.userAManager, sessionId: IDS.sessionAManager,
    role: "shop_manager", companyId: IDS.companyA, actingCompanyId: null
  });

  assert.deepEqual(scope.shopIds, [IDS.shopA1]);
  assert.equal("administeredShopIds" in scope, false);
});

test("a staff user with zero assignments gets [], never null", { skip }, async () => {
  // The fixture's whole reason for A-unassigned: array_agg over zero rows returns
  // NULL, and without COALESCE(..., '{}') that scope is byte-identical to a
  // company admin's -- revocation ESCALATING privilege.
  const scope = await materialiseScope({
    userId: IDS.userAUnassigned, sessionId: IDS.sessionAUnassigned,
    role: "staff", companyId: IDS.companyA, actingCompanyId: null
  });
  assert.deepEqual(scope.shopIds, []);
  assert.equal(Object.isFrozen(scope.shopIds), true);
});

test("a tenant user's own company wins over any acting_company_id on their session", { skip }, async () => {
  // acting_company_id is a platform-admin lever. A row set on a tenant user's
  // session -- by a bug, or by a future route -- must not move them into another
  // company. This is the one place that could go wrong silently and cross a tenant
  // boundary, so it is asserted rather than assumed.
  await db.unscoped("UPDATE user_sessions SET acting_company_id = $1 WHERE id = $2", [
    IDS.companyA, IDS.sessionBAdmin
  ]);
  const scope = await materialiseScope({
    userId: IDS.userBAdmin, sessionId: IDS.sessionBAdmin,
    role: "company_admin", companyId: IDS.companyB, actingCompanyId: IDS.companyA
  });
  assert.equal(scope.companyId, IDS.companyB);
  assert.deepEqual(scope.shopIds, [IDS.shopB1]);
});

test("shop ids come back in a stable order", { skip }, async () => {
  // Not cosmetic: the me-document echoes shopIds, and an unordered array_agg makes
  // a response body that changes between identical requests -- which is a flaky
  // assertion in every suite downstream of this one.
  const a = await materialiseScope({
    userId: IDS.userAAdmin, sessionId: SESSION,
    role: "company_admin", companyId: IDS.companyA, actingCompanyId: IDS.companyA
  });
  const b = await materialiseScope({
    userId: IDS.userAAdmin, sessionId: SESSION,
    role: "company_admin", companyId: IDS.companyA, actingCompanyId: IDS.companyA
  });
  assert.deepEqual(a.shopIds, b.shopIds);
  assert.deepEqual([...a.shopIds], [...a.shopIds].sort());
});

test("teardown", { skip }, async () => {
  await closeAllPools();
  await db.drop();
});
