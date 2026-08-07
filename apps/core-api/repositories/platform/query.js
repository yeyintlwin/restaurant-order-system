"use strict";

// Spec §5.4 names this file and this export: repositories/platform/ holds only
// genuinely cross-tenant operations, and it reaches the database through
// dangerouslyQueryAcrossTenants(scope, sql, params) -- "**with** a scope
// parameter, throwing unless the scope is symbol-stamped and kind === 'platform'.
// A version taking no scope would be structurally incapable of checking anything."
//
// The name is the documentation. Every other repository in this service reaches
// the database through a helper that REFUSES to run without a company_id; this one
// is the sanctioned way around that, and it is spelled so that nobody adds a call
// to it without noticing what they are doing. Grep for it to find the entire
// cross-tenant surface of the API.
//
// The primitives live in db/index.js rather than here. That is not an accident of
// layering: db/ is the one directory allowed to hold a raw connection (structural
// rules C2 and C4), and implementing the seam here would mean widening an
// allowlist whose own comment says adding a file to it "is therefore always the
// wrong repair". So this file is the NAME and the guarantee; db/index.js is the
// mechanism.
//
// What the mechanism enforces, and why the second half matters more than the first:
//   1. a stamped scope with kind === 'platform' -- the unscoped platform admin is
//      the only actor who has one;
//   2. a WRITE may only touch companies, users or audit_events. Reads stay open,
//      because a platform admin legitimately reads across tenants: the console's
//      Companies screen counts every company's shops and tables. Writes do not. A
//      platform admin changing something INSIDE a company selects that company and
//      drives the ordinary tenant repositories under an ordinary tenant scope,
//      which is what §5.4 says and what keeps the tenant choke point on the path
//      that mutates tenant rows.

const { platformQuery } = require("../../db");

// ONE export, and it is the one §5.4 names. withPlatformScope is deliberately not
// re-exported here: a repository in this directory takes it from db/index.js the
// same way every repositories/auth/* file takes withUnscopedConnection, and
// structural rule C6 budgets this directory's exports by name -- a convenience
// re-export would spend one of those on a function that already has a home.
//
// `descriptor` is { sql, conflicts }, exactly the shape tenantQuery takes minus
// shopScoped, so an INSERT that races another can name its constraint and get a
// declared 409 instead of a raw 23505 reaching the error tail as a 500.
async function dangerouslyQueryAcrossTenants(scope, descriptor, params = []) {
  return platformQuery(scope, descriptor, params);
}

module.exports = { dangerouslyQueryAcrossTenants };
