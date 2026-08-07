"use strict";

// PURE (spec 8.8, Tier 1): no requires at all, so C9 and C14 are satisfied by
// construction.
//
// Spec 5.4: "privilege rules live in one module, unit-tested by name", and spec 6.2
// names that module lib/authorization.js. This is the ALIAS half and nothing else.
// Plan 2c adds the rank lattice, shop containment and the self-modification rules to
// THIS file -- which is why it is not called lib/role-aliases.js.

// Spec 5.4's table. The membership that is easy to get wrong and impossible to see
// afterwards is platform_admin's, because it appears twice with opposite answers:
//
//   - An UNSCOPED platform admin is admitted by `platform` and by NOTHING else. They
//     are not in any list below, because they have no tenant role at all; scope.kind
//     is the whole answer for them.
//   - A SCOPED platform admin materialises role 'platform_admin' at rank 3 and IS in
//     three of the lists -- and deliberately not in `platform`, whose entire meaning
//     is "has not chosen a company".
// A FIFTH alias, added by the admin-console work, and it is the only one that
// NARROWS rather than widens. Every other alias here answers "who is senior
// enough"; this one answers "who is the operator" -- and the company's own admin
// is deliberately not in it.
//
// The console design moved opening a branch from the CEO to the platform owner:
// fitting one out is tables, e-paper screens and printed QR codes, and a CEO had
// no way to do any of it. So the shop RECORD is the operator's and the manager
// slot on it is the CEO's, and `companyAdmin` cannot express that -- it admits
// both, which is exactly the distinction the change is about.
//
// It is the mirror of `platform`: same person, opposite scope state. `platform`
// means "has not chosen a company"; this means "has chosen one, and is acting
// inside it". Together they cover a platform admin's whole world, and neither
// admits a tenant role.
//
// Adding an alias to make a route REACHABLE would be the wrong repair, and this is
// not that: it makes a route reachable by strictly fewer people than the existing
// alias would have.
const TENANT_ALIAS_MEMBERS = Object.freeze({
  platform: Object.freeze([]),
  platformScoped: Object.freeze(["platform_admin"]),
  companyAdmin: Object.freeze(["company_admin", "platform_admin"]),
  manager: Object.freeze(["shop_manager", "company_admin", "platform_admin"]),
  anyUser: Object.freeze(["staff", "shop_manager", "company_admin", "platform_admin"])
});

// THROWS on a malformed declaration rather than returning false, and the direction
// matters. Returning false would turn a typo'd alias into a route nobody can reach,
// which is diagnosed as a permissions bug for a week; returning true would be the
// other thing. route() already refuses an unknown alias at registration, so reaching
// either throw means the two lists have drifted.
function permits(scope, roles) {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error("permits(): a route with auth:'user' must declare a non-empty roles array");
  }
  for (const alias of roles) {
    if (!Object.prototype.hasOwnProperty.call(TENANT_ALIAS_MEMBERS, alias)) {
      throw new Error(`permits(): unknown role alias ${JSON.stringify(alias)}`);
    }
  }
  if (scope.kind === "platform") return roles.includes("platform");
  return roles.some((alias) => TENANT_ALIAS_MEMBERS[alias].includes(scope.role));
}

module.exports = { TENANT_ALIAS_MEMBERS, permits };
