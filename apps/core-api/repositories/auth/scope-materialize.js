"use strict";

// PRE_TENANT_REASON: this is the code that PRODUCES the tenant scope, so by
// definition it runs before one exists. One of the nine files rule C4 sanctions to
// call withUnscopedConnection.
const PRE_TENANT_REASON = "this module materialises the scope every tenant query then binds";

const { withUnscopedConnection } = require("../../db");
const { createScope } = require("../../db/scope");

// COALESCE(..., '{}') is not defensive style, it is the fix for a privilege
// ESCALATION: array_agg over zero rows returns NULL, and a scope carrying
// shopIds: null is byte-identical to one that means "all shops" in every
// hand-written predicate. db/scope.js refuses null independently; both are needed,
// because this one keeps the value out of the object and that one keeps a wrong
// object out of the SQL.
//
// ORDER BY inside the aggregate: the me-document echoes shopIds, and an unordered
// array_agg makes a response body that differs between two identical requests.
const COMPANY_SHOPS = `
  SELECT COALESCE(array_agg(id ORDER BY id) FILTER (WHERE status = 'active'), '{}') AS "activeShopIds",
         COALESCE(array_agg(id ORDER BY id), '{}')                                  AS "administeredShopIds"
    FROM shops
   WHERE company_id = $1
`;

// An EXISTS-free straight join is correct here because user_shops is unique on
// (user_id, shop_id) -- 0001 makes it the primary key -- so no duplicate can be
// produced. The EXISTS semi-join spec 6.2 demands is for the USER LIST route,
// where the join is on the other side.
const ASSIGNED_SHOPS = `
  SELECT COALESCE(array_agg(sh.id ORDER BY sh.id), '{}') AS "activeShopIds"
    FROM user_shops us
    JOIN shops sh ON sh.id = us.shop_id
   WHERE us.user_id = $1
     AND us.company_id = $2
     AND sh.status = 'active'
`;

const ADMINISTERED_ROLES = ["platform_admin", "company_admin"];

// Spec 5.4's table, and every branch of it. The one thing that is easy to get
// wrong and impossible to see afterwards: acting_company_id is a PLATFORM-ADMIN
// lever. A tenant user whose session somehow carries one must stay in their own
// company, or a bug in a future route becomes a tenant crossing.
async function materialiseScope({ userId, sessionId, role, companyId, actingCompanyId }) {
  if (role === "platform_admin") {
    if (actingCompanyId === null || actingCompanyId === undefined) {
      // Reaches only platform routes. 6.3.2: a tenant route answers
      // 409 scope_required, never 403 -- the remedy is a state change.
      return createScope({ kind: "platform", userId, sessionId });
    }
    const { activeShopIds, administeredShopIds } = await readCompanyShops(actingCompanyId);
    return createScope({
      kind: "tenant",
      userId,
      sessionId,
      companyId: actingCompanyId,
      // Rank 3, above company_admin, so the rank lattice does the work and no
      // fifth role alias is needed. auditCrossTenant is set by db/scope.js itself
      // for this role.
      role: "platform_admin",
      shopIds: activeShopIds,
      administeredShopIds
    });
  }

  if (ADMINISTERED_ROLES.includes(role)) {
    const { activeShopIds, administeredShopIds } = await readCompanyShops(companyId);
    return createScope({ kind: "tenant", userId, sessionId, companyId, role, shopIds: activeShopIds, administeredShopIds });
  }

  // shop_manager and staff: driven by user_shops, active shops only, and NO
  // administeredShopIds at all -- db/scope.js throws if one is supplied, which is
  // what stops a suspended shop from staying visible to its manager.
  const activeShopIds = await readAssignedShops(userId, companyId);
  return createScope({ kind: "tenant", userId, sessionId, companyId, role, shopIds: activeShopIds });
}

// `connection`, never `client` -- see the note in repositories/auth/users.js.
async function readCompanyShops(companyId) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(COMPANY_SHOPS, [companyId]);
    return rows[0];
  });
}

async function readAssignedShops(userId, companyId) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(ASSIGNED_SHOPS, [userId, companyId]);
    return rows[0].activeShopIds;
  });
}

module.exports = { PRE_TENANT_REASON, materialiseScope };
