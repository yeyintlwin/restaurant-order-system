const assert = require("node:assert/strict");
const test = require("node:test");

const { createScope, assertTenantScope } = require("../db/scope");

const P_ADMIN = "11111111-1111-4111-8111-111111111111";
const A_ADMIN = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const COMPANY_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SHOP_A1 = "aaaaaaaa-0000-4000-8000-000000000011";
const SHOP_A3 = "aaaaaaaa-0000-4000-8000-000000000013";
const TERMINAL = "cccccccc-0000-4000-8000-000000000001";
const TOKEN = "dddddddd-0000-4000-8000-000000000001";

// Object.entries drops symbol keys, which is what lets a whole-scope comparison
// ignore the private stamp without making the stamp non-enumerable.
function plain(scope) {
  return Object.fromEntries(Object.entries(scope));
}

test("an unscoped platform admin gets a platform scope and nothing tenant-shaped", () => {
  const scope = createScope({ kind: "platform", userId: P_ADMIN, sessionId: SESSION });

  assert.deepEqual(plain(scope), { kind: "platform", userId: P_ADMIN, sessionId: SESSION });
  assert.equal(scope.companyId, undefined);
  assert.equal(scope.shopIds, undefined);
});

test("a scoped platform admin materialises rank-3 tenant keys", () => {
  const scope = createScope({
    kind: "tenant",
    userId: P_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "platform_admin",
    shopIds: [SHOP_A1],
    administeredShopIds: [SHOP_A1, SHOP_A3]
  });

  assert.equal(scope.role, "platform_admin");
  assert.deepEqual(scope.shopIds, [SHOP_A1]);
  assert.deepEqual(scope.administeredShopIds, [SHOP_A1, SHOP_A3]);
  assert.equal(scope.auditCrossTenant, true);
});

test("a company admin carries administeredShopIds; a manager and staff carry none", () => {
  // administeredShopIds is what makes suspension reversible: a suspended shop
  // vanishes from its manager's world while staying reachable by the admin who
  // has to un-suspend it.
  const admin = createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "company_admin",
    shopIds: [SHOP_A1],
    administeredShopIds: [SHOP_A1, SHOP_A3]
  });
  assert.deepEqual(admin.administeredShopIds, [SHOP_A1, SHOP_A3]);
  assert.equal(admin.auditCrossTenant, undefined);

  const manager = createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "shop_manager",
    shopIds: [SHOP_A1]
  });
  assert.equal("administeredShopIds" in manager, false);

  assert.throws(
    () =>
      createScope({
        kind: "tenant",
        userId: A_ADMIN,
        sessionId: SESSION,
        companyId: COMPANY_A,
        role: "staff",
        shopIds: [SHOP_A1],
        administeredShopIds: [SHOP_A1]
      }),
    /a staff scope carries no administeredShopIds/
  );
});

test("an empty assignment set is a real empty array, never null and never undefined", () => {
  // array_agg over zero rows returns NULL. Coalescing it here as well as in SQL
  // is what stops a just-revoked staff user getting a company-admin-shaped scope:
  // otherwise revocation escalates privilege.
  for (const supplied of [[], null, undefined]) {
    const scope = createScope({
      kind: "tenant",
      userId: A_ADMIN,
      sessionId: SESSION,
      companyId: COMPANY_A,
      role: "staff",
      shopIds: supplied
    });
    assert.ok(Array.isArray(scope.shopIds), `shopIds for ${JSON.stringify(supplied)}`);
    assert.deepEqual(scope.shopIds, []);
  }
});

test("a terminal scope turns the singular shopId into a one-element shopIds", () => {
  // The singular->plural conversion happens exactly here. A scope carrying
  // shopId alone leaves scope.shopIds undefined, `?? null` binds $2 = NULL, and
  // a correctly paired kitchen tablet at shop A1 is served shop A2's data.
  const scope = createScope({
    kind: "terminal",
    companyId: COMPANY_A,
    shopId: SHOP_A1,
    terminalId: TERMINAL,
    terminalKind: "kitchen_display",
    tokenId: TOKEN
  });

  assert.deepEqual(plain(scope), {
    kind: "terminal",
    companyId: COMPANY_A,
    shopIds: [SHOP_A1],
    terminalId: TERMINAL,
    terminalKind: "kitchen_display",
    tokenId: TOKEN
  });
  assert.equal(scope.userId, undefined);
});

test("every scope and every array inside it is frozen", () => {
  const scope = createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "company_admin",
    shopIds: [SHOP_A1],
    administeredShopIds: [SHOP_A1]
  });

  assert.ok(Object.isFrozen(scope));
  assert.ok(Object.isFrozen(scope.shopIds));
  assert.ok(Object.isFrozen(scope.administeredShopIds));
  assert.throws(() => scope.shopIds.push(SHOP_A3), TypeError);
});

test("createScope rejects malformed input instead of emitting a half-scope", () => {
  assert.throws(() => createScope(null), /createScope requires an object/);
  assert.throws(() => createScope({ kind: "everything" }), /unknown scope kind "everything"/);
  assert.throws(() => createScope({ kind: "platform", userId: "nope", sessionId: SESSION }), /userId must be a uuid/);
  assert.throws(
    () =>
      createScope({
        kind: "tenant",
        userId: A_ADMIN,
        sessionId: SESSION,
        companyId: COMPANY_A,
        role: "owner",
        shopIds: []
      }),
    /unknown role "owner"/
  );
  assert.throws(
    () =>
      createScope({
        kind: "tenant",
        userId: A_ADMIN,
        sessionId: SESSION,
        companyId: COMPANY_A,
        role: "staff",
        shopIds: SHOP_A1
      }),
    /shopIds must be an array of uuids/
  );
  assert.throws(
    () =>
      createScope({
        kind: "tenant",
        userId: A_ADMIN,
        sessionId: SESSION,
        companyId: COMPANY_A,
        role: "staff",
        shopIds: [SHOP_A1, "not-a-uuid"]
      }),
    /shopIds\[1\] must be a uuid/
  );
  assert.throws(
    () =>
      createScope({
        kind: "terminal",
        companyId: COMPANY_A,
        shopId: SHOP_A1,
        terminalId: TERMINAL,
        terminalKind: "printer",
        tokenId: TOKEN
      }),
    /unknown terminalKind "printer"/
  );
});

function tenantScope(overrides = {}) {
  return createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "shop_manager",
    shopIds: [SHOP_A1],
    ...overrides
  });
}

test("assertTenantScope returns the scope it was given", () => {
  const scope = tenantScope();
  assert.equal(assertTenantScope(scope), scope);
  assert.equal(
    assertTenantScope(
      createScope({
        kind: "terminal",
        companyId: COMPANY_A,
        shopId: SHOP_A1,
        terminalId: TERMINAL,
        terminalKind: "kitchen_display",
        tokenId: TOKEN
      })
    ).kind,
    "terminal"
  );
});

test("an unstamped look-alike is refused", () => {
  // A plain object with every right key is exactly what a well-meaning
  // refactor produces, and it is the shape that lets a caller choose its own
  // company id.
  const forged = {
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "shop_manager",
    shopIds: [SHOP_A1]
  };
  assert.throws(() => assertTenantScope(forged), /was not produced by createScope/);
  assert.throws(() => assertTenantScope(null), /tenant scope is required/);
  assert.throws(() => assertTenantScope("company-a"), /tenant scope is required/);
});

test("a stamped scope with shopIds removed is refused", () => {
  // Spreading copies the private symbol, so this really is a stamped object —
  // which is the only way to prove the shopIds check is not dead code.
  const broken = { ...tenantScope() };
  delete broken.shopIds;
  assert.throws(() => assertTenantScope(broken), /is missing shopIds/);

  const nulled = { ...tenantScope(), shopIds: null };
  assert.throws(() => assertTenantScope(nulled), /is missing shopIds/);
});

test("a company admin or scoped platform admin without administeredShopIds is refused", () => {
  const admin = { ...tenantScope({ role: "company_admin", administeredShopIds: [SHOP_A1] }) };
  delete admin.administeredShopIds;
  assert.throws(() => assertTenantScope(admin), /is missing administeredShopIds/);

  const platform = { ...tenantScope({ role: "platform_admin", administeredShopIds: [SHOP_A1] }) };
  delete platform.administeredShopIds;
  assert.throws(() => assertTenantScope(platform), /is missing administeredShopIds/);
});

test("a platform scope cannot drive a tenant query", () => {
  const scope = createScope({ kind: "platform", userId: P_ADMIN, sessionId: SESSION });
  assert.throws(() => assertTenantScope(scope), /select a company first/);
});

test("a stamped scope with no companyId is refused", () => {
  const broken = { ...tenantScope() };
  delete broken.companyId;
  assert.throws(() => assertTenantScope(broken), /is missing companyId/);
});
