"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { TENANT_ALIAS_MEMBERS, permits } = require("../lib/authorization");
const { ROLE_ALIASES } = require("../http/router");

const platform = { kind: "platform", userId: "u", sessionId: "s" };
const tenant = (role) => ({ kind: "tenant", role, userId: "u", sessionId: "s", companyId: "c", shopIds: [] });

test("the alias NAMES and the alias MEMBERSHIPS are the same four", () => {
  // Two files hold two halves of one fact: router.js rejects an unknown alias at
  // registration, lib/authorization.js decides admission. A fifth added to one and
  // not the other is a route that boots and admits nobody.
  assert.deepEqual(Object.keys(TENANT_ALIAS_MEMBERS).sort(), [...ROLE_ALIASES].sort());
});

test("an UNSCOPED platform admin is admitted by `platform` and by nothing else", () => {
  // Their scope carries no companyId, so a tenant route reached by them would have no
  // company to bind. 6.3.2 answers that with 409 scope_required -- a state to change,
  // not a permission to grant -- which only works if the gate lets them nowhere near it.
  assert.equal(permits(platform, ["platform"]), true);
  assert.equal(permits(platform, ["companyAdmin"]), false);
  assert.equal(permits(platform, ["manager"]), false);
  assert.equal(permits(platform, ["anyUser"]), false);
});

test("a SCOPED platform admin is admitted everywhere EXCEPT `platform`", () => {
  // Rank 3, above company_admin, so the lattice does the work (spec 5.4) -- and NOT by
  // `platform`, whose whole meaning is "has not chosen a company". This pair is what
  // makes the documented tenant bootstrap executable: select scope, then create the
  // company's first company_admin through the ordinary user route.
  const scoped = tenant("platform_admin");
  assert.equal(permits(scoped, ["platform"]), false);
  assert.equal(permits(scoped, ["companyAdmin"]), true);
  assert.equal(permits(scoped, ["manager"]), true);
  assert.equal(permits(scoped, ["anyUser"]), true);
});

test("the other three roles match spec 5.4's table exactly", () => {
  assert.deepEqual(
    ["company_admin", "shop_manager", "staff"].map((role) =>
      ["platform", "companyAdmin", "manager", "anyUser"].filter((alias) => permits(tenant(role), [alias]))
    ),
    [
      ["companyAdmin", "manager", "anyUser"],
      ["manager", "anyUser"],
      ["anyUser"]
    ]
  );
});

test("a declaration that is empty or names an unknown alias throws rather than admitting", () => {
  // Fail loud, never fail open. A gate that returned false for an unknown alias would
  // turn a typo into a route nobody can reach, which is diagnosed as a permissions bug
  // for a week; a gate that returned true would be the other thing.
  assert.throws(() => permits(tenant("staff"), []), /non-empty roles array/);
  assert.throws(() => permits(tenant("staff"), ["superuser"]), /unknown role alias/);
});
