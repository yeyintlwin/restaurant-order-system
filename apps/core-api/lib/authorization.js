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

// ---------------------------------------------------------------------------
// The rank lattice
// ---------------------------------------------------------------------------
// Spec §5.4: "An actor may only create or modify a user STRICTLY BELOW its own
// role. Left to prose, the consequence is a shop_manager POSTing
// { role: 'company_admin' }: every constraint is satisfied, the response carries
// the one-time password, and they own the company."
//
// Strictly below, not below-or-equal, and the difference is the whole rule. A
// company_admin creating another company_admin is how one account quietly becomes
// two, and neither can be told from the other afterwards. The ONE sanctioned
// exception in the whole service is POST /api/platform/admins, which §6.2 names
// out loud and justifies: the bootstrap CLI is monotonic, so a platform with one
// administrator would otherwise have no second recovery path.
const RANKS = Object.freeze({ staff: 0, shop_manager: 1, company_admin: 2, platform_admin: 3 });

function rankOf(role) {
  if (!Object.prototype.hasOwnProperty.call(RANKS, role)) {
    // A throw, not a -1. An unknown role scoring below everything would make every
    // comparison below answer "yes, you may" -- the failure direction that hands a
    // typo the keys.
    throw new Error(`rankOf(): unknown role ${JSON.stringify(role ?? null)}`);
  }
  return RANKS[role];
}

// Applies to CREATE and to MODIFY, and to the role a modification would leave
// behind. A promotion is checked twice on purpose: rank must be strictly below
// BEFORE and AFTER, or a company_admin promotes somebody to company_admin by
// editing a staff row they were allowed to touch.
function mayActOnRole(actorRole, targetRole) {
  return rankOf(actorRole) > rankOf(targetRole);
}

// What a person may change about THEMSELVES, and it depends on the role, because a
// name means different things at different levels.
//
// §7A.3 makes the console language a per-person setting, so everybody has that one: a
// list without it would mean filing a request to change what language you read.
//
// A MEMBER OF STAFF HAS ONLY THAT ONE. Their name is how the manager knows who took
// an order and their phone is how the manager reaches them on a shift -- both are
// facts the manager entered and relies on. A waiter who renames themselves does not
// break their own screen, they break the records of the person above them, and that
// person cannot see that it happened. Everyone from a shop manager up keeps their
// name and their number, because for them those are their own contact details rather
// than somebody else's roster.
//
// What stays out for EVERYBODY is the rest of the point. `email` is your sign-in name,
// and a person who can change it can lock the person above them out of reaching them.
// `role`, `status` and `shopIds` are somebody else's decision about you, and a route
// that let you patch your own role would make the lattice above decorative.
const SELF_PATCHABLE_FIELDS = Object.freeze({
  staff: Object.freeze(["language"]),
  shop_manager: Object.freeze(["displayName", "phone", "language"]),
  company_admin: Object.freeze(["displayName", "phone", "language"]),
  platform_admin: Object.freeze(["displayName", "phone", "language"])
});

// rankOf THROWS on a role this file does not know, and that is the behaviour wanted
// here too: an unrecognised role must not fall through to the longest list.
function selfPatchableFields(role) {
  rankOf(role);
  return SELF_PATCHABLE_FIELDS[role];
}

function permitsSelfPatch(fields, role) {
  const allowed = selfPatchableFields(role);
  return fields.every((field) => allowed.includes(field));
}

module.exports = {
  TENANT_ALIAS_MEMBERS,
  permits,
  RANKS,
  rankOf,
  mayActOnRole,
  SELF_PATCHABLE_FIELDS,
  selfPatchableFields,
  permitsSelfPatch
};
