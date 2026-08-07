// PURE (Tier 1). No database, no filesystem, no network, no clock.
//
// A scope is the materialised answer to "who is calling and what may they
// touch", derived from the credential and never from a request. There is no
// "null means all" sentinel anywhere in this file: every tenant scope carries a
// real uuid[] of shop ids, because the two ways that rule has been broken in
// review are both fail-OPEN.

// Module-private on purpose: nothing outside this file can mint the stamp, so
// assertTenantScope() can tell a scope from a plain object that looks like one.
// It is an own ENUMERABLE symbol, so `{ ...scope }` copies it — which is what
// lets a test build a stamped-but-broken scope and prove the assertions bite.
const SCOPE_STAMP = Symbol("core-api.scope");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ROLES = ["platform_admin", "company_admin", "shop_manager", "staff"];
// The two roles whose world includes suspended shops.
const ADMINISTERED_ROLES = ["platform_admin", "company_admin"];
const TERMINAL_KINDS = ["kitchen_display", "cashier_counter", "epaper_hub"];

function requireUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`createScope: ${label} must be a uuid (got ${JSON.stringify(value ?? null)})`);
  }
  return value;
}

// COALESCE(array_agg(...), '{}') in JavaScript. Absent means empty, never "all".
function requireUuidArray(value, label) {
  if (value === null || value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new Error(`createScope: ${label} must be an array of uuids (got ${JSON.stringify(value)})`);
  }
  return Object.freeze(value.map((entry, index) => requireUuid(entry, `${label}[${index}]`)));
}

function createPlatformScope(input) {
  return Object.freeze({
    [SCOPE_STAMP]: true,
    kind: "platform",
    userId: requireUuid(input.userId, "userId"),
    sessionId: requireUuid(input.sessionId, "sessionId")
  });
}

function createTenantScope(input) {
  const role = input.role;
  if (!TENANT_ROLES.includes(role)) {
    throw new Error(`createScope: unknown role ${JSON.stringify(role ?? null)}`);
  }

  const scope = {
    [SCOPE_STAMP]: true,
    kind: "tenant",
    userId: requireUuid(input.userId, "userId"),
    sessionId: requireUuid(input.sessionId, "sessionId"),
    companyId: requireUuid(input.companyId, "companyId"),
    role,
    shopIds: requireUuidArray(input.shopIds, "shopIds")
  };

  if (ADMINISTERED_ROLES.includes(role)) {
    scope.administeredShopIds = requireUuidArray(input.administeredShopIds, "administeredShopIds");
  } else if (input.administeredShopIds !== undefined) {
    throw new Error(`createScope: a ${role} scope carries no administeredShopIds`);
  }

  // A platform admin acting inside a company is still crossing a tenant
  // boundary, and the audit trail has to say so.
  if (role === "platform_admin") scope.auditCrossTenant = true;

  return Object.freeze(scope);
}

function createTerminalScope(input) {
  if (!TERMINAL_KINDS.includes(input.terminalKind)) {
    throw new Error(`createScope: unknown terminalKind ${JSON.stringify(input.terminalKind ?? null)}`);
  }
  return Object.freeze({
    [SCOPE_STAMP]: true,
    kind: "terminal",
    companyId: requireUuid(input.companyId, "companyId"),
    shopIds: Object.freeze([requireUuid(input.shopId, "shopId")]),
    terminalId: requireUuid(input.terminalId, "terminalId"),
    terminalKind: input.terminalKind,
    tokenId: requireUuid(input.tokenId, "tokenId")
  });
}

function createScope(input) {
  if (input === null || typeof input !== "object") {
    throw new Error("createScope requires an object");
  }
  switch (input.kind) {
    case "platform":
      return createPlatformScope(input);
    case "tenant":
      return createTenantScope(input);
    case "terminal":
      return createTerminalScope(input);
    default:
      throw new Error(`createScope: unknown scope kind ${JSON.stringify(input.kind ?? null)}`);
  }
}

// The last gate before any SQL is bound. Every condition here is a failure mode
// that has actually appeared in review, and every one of them fails OPEN if it
// is missing — which is why this is a throw and never a default.
function assertTenantScope(scope) {
  if (scope === null || typeof scope !== "object") {
    throw new Error("tenant scope is required");
  }
  if (scope[SCOPE_STAMP] !== true) {
    throw new Error("tenant scope was not produced by createScope()");
  }
  if (scope.kind === "platform") {
    throw new Error("a platform scope cannot drive a tenant query; select a company first");
  }
  if (typeof scope.companyId !== "string" || scope.companyId === "") {
    throw new Error("tenant scope is missing companyId");
  }
  if (!Array.isArray(scope.shopIds)) {
    throw new Error("tenant scope is missing shopIds; an absent set is [], never null");
  }
  if (ADMINISTERED_ROLES.includes(scope.role) && !Array.isArray(scope.administeredShopIds)) {
    throw new Error(`a ${scope.role} scope is missing administeredShopIds`);
  }
  return scope;
}

// The mirror of assertTenantScope, and the reason spec §5.4 insists the
// cross-tenant entry point takes a scope parameter at all: "a version taking
// no scope would be structurally incapable of checking anything."
//
// The stamp check is the load-bearing one. Without it any object literal with
// kind:"platform" opens the cross-tenant door, and the shape is trivially
// reachable from a request body a handler forwarded without thinking.
function assertPlatformScope(scope) {
  if (scope === null || typeof scope !== "object") {
    throw new Error("platform scope is required");
  }
  if (scope[SCOPE_STAMP] !== true) {
    throw new Error("platform scope was not produced by createScope()");
  }
  if (scope.kind !== "platform") {
    throw new Error(
      `a ${scope.kind} scope cannot drive a cross-tenant query; this is the platform seam`
    );
  }
  return scope;
}

module.exports = { createScope, assertTenantScope, assertPlatformScope };
