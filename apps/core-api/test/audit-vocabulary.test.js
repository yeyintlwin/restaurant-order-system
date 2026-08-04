"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { AUDIT_ACTIONS, assertAuditEvent } = require("../lib/audit-vocabulary");

// ---------------------------------------------------------------------------
// The DDL, PARSED rather than retyped.
//
// This file's whole claim is that it mirrors audit_events, and it used to mirror
// two of the five constraints an entry can violate: the action shape and the
// 64-character limit. actorKinds, outcomes and targetKind were declared per
// entry, consumed by assertAuditEvent as its own authority, and checked against
// nothing -- so assertAuditEvent would cheerfully accept an event using the very
// list that was wrong, and the INSERT would raise 23514 at runtime, on the
// failed-login path, whose audit row is the only evidence the attempt happened.
//
// Deriving also DELETES a hand copy: the banned-key list below was eleven keys
// in the same order as 0001_init.sql, which is exactly what a hand copy looks
// like right up until the moment it is not.
//
// Parsing is stable by construction here: 0001_init.sql is applied with its
// checksum recorded and can never be edited, so the mirrored side cannot move.
// What moves is the vocabulary, and that is the side these assertions grade.
const DDL = fs
  .readFileSync(path.join(__dirname, "..", "migrations", "0001_init.sql"), "utf8")
  .replace(/\r\n/g, "\n");

// Anchored to `<column> text`, the COLUMN DEFINITION, so that the
// `actor_kind IN ('system', 'anonymous')` inside audit_events_actor_arc a few
// lines below cannot be mistaken for the column's own closed set. An unanchored
// match would in fact return the right four values today -- but only because the
// column definition happens to come first in the file, which is an ordering
// coincidence rather than a property anyone stated. The anchor makes it a
// property; the count in the parser self-test is what would catch it if it were
// ever wrong, since the lookalike parses to two members and would otherwise slip
// past the anti-vacuity floor below.
function ddlClosedSet(column) {
  const match = DDL.match(
    new RegExp(`${column}\\s+text\\b[\\s\\S]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`)
  );
  assert.ok(match, `0001_init.sql no longer declares a closed set for ${column}`);
  const values = (match[1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
  // Anti-vacuity. A parse that silently yielded [] would make every membership
  // assertion below pass for any input at all -- the C9 failure mode, in a file
  // that reads SQL instead of walking a directory.
  assert.ok(values.length >= 2, `${column}'s closed set parsed as ${JSON.stringify(values)}`);
  return values;
}

function ddlRegex(column) {
  const match = DDL.match(new RegExp(`${column}\\s*~\\s*'([^']*)'`));
  assert.ok(match, `0001_init.sql no longer constrains ${column} with a regex`);
  return new RegExp(match[1]);
}

const DDL_ACTOR_KINDS = ddlClosedSet("actor_kind");
const DDL_OUTCOMES = ddlClosedSet("outcome");
const DDL_ACTION_SHAPE = ddlRegex("action");
const DDL_TARGET_KIND_SHAPE = ddlRegex("target_kind");

const DDL_ACTION_MAX = (() => {
  const match = DDL.match(/length\(action\)\s*<=\s*(\d+)/);
  assert.ok(match, "0001_init.sql no longer caps length(action)");
  return Number(match[1]);
})();

const DDL_BANNED_DETAIL_KEYS = (() => {
  const match = DDL.match(/detail\s*\?\|\s*array\[([\s\S]*?)\]/);
  assert.ok(match, "0001_init.sql no longer declares audit_events_detail_no_credentials");
  const keys = (match[1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
  assert.ok(keys.length >= 5, `the banned-key list parsed as ${JSON.stringify(keys)}`);
  return keys;
})();

test("the DDL parse aimed at the right constraints", () => {
  // A self-test of the PARSER, not a second mirror of the schema. Everything
  // above derives its authority from a regex over SQL, and a regex that quietly
  // matched the wrong constraint would produce a permitted set that is merely
  // WRONG rather than empty -- which the anti-vacuity floor in ddlClosedSet
  // cannot see. The counts are what distinguish the column's own CHECK from the
  // lookalike inside audit_events_actor_arc, which parses to two members.
  assert.equal(DDL_ACTOR_KINDS.length, 4, `parsed actor kinds: ${DDL_ACTOR_KINDS}`);
  assert.ok(DDL_ACTOR_KINDS.includes("anonymous") && DDL_ACTOR_KINDS.includes("user"));
  assert.equal(DDL_OUTCOMES.length, 2, `parsed outcomes: ${DDL_OUTCOMES}`);
  assert.equal(DDL_ACTION_MAX, 64);
  assert.equal(DDL_BANNED_DETAIL_KEYS.length, 11);

  // The two derived regexes really are anchored patterns, not something that
  // matches everything.
  assert.match("auth.email_verified", DDL_ACTION_SHAPE);
  assert.doesNotMatch("Auth.Email Verified", DDL_ACTION_SHAPE);
  assert.match("user", DDL_TARGET_KIND_SHAPE);
  assert.doesNotMatch("User Account", DDL_TARGET_KIND_SHAPE);
});

test("every action satisfies the DDL's shape and length limit", () => {
  const names = Object.keys(AUDIT_ACTIONS);
  assert.ok(names.length >= 5, `only ${names.length} actions declared`);
  for (const name of names) {
    assert.match(name, DDL_ACTION_SHAPE, `${name} does not match the audit_events CHECK`);
    assert.ok(
      name.length <= DDL_ACTION_MAX,
      `${name} exceeds the ${DDL_ACTION_MAX}-character limit`
    );
  }
});

test("every declared actor kind, outcome and target kind is one the DDL accepts", () => {
  // The three fields entry() declares that nothing used to check. assertAuditEvent
  // treats these lists as its own authority, so a wrong member is not caught on
  // the way in -- it is caught by Postgres, as a 23514 on audit_events_actor_arc
  // or the outcome CHECK, inside somebody else's transaction.
  //
  // The realistic mistake is not exotic: 'platform_admin' is a users.role literal
  // used throughout this codebase and reads exactly like an actor kind, and an
  // outcome like 'locked' is the natural third state for a login attempt. Both
  // pass every other assertion in this file.
  for (const [action, entry] of Object.entries(AUDIT_ACTIONS)) {
    for (const kind of entry.actorKinds) {
      assert.ok(
        DDL_ACTOR_KINDS.includes(kind),
        `${action} declares actor kind "${kind}", which audit_events rejects (expected one of ${DDL_ACTOR_KINDS})`
      );
    }
    for (const outcome of entry.outcomes) {
      assert.ok(
        DDL_OUTCOMES.includes(outcome),
        `${action} declares outcome "${outcome}", which audit_events rejects (expected one of ${DDL_OUTCOMES})`
      );
    }
    if (entry.targetKind !== null && entry.targetKind !== undefined) {
      assert.match(
        entry.targetKind,
        DDL_TARGET_KIND_SHAPE,
        `${action} declares target kind "${entry.targetKind}", which audit_events rejects`
      );
    }
    assert.ok(entry.actorKinds.length >= 1, `${action} declares no actor kind`);
    assert.ok(entry.outcomes.length >= 1, `${action} declares no outcome`);
  }
});

test("the vocabulary is sorted, so a diff adding one is readable", () => {
  const names = Object.keys(AUDIT_ACTIONS);
  assert.deepEqual(names, [...names].sort());
});

test("the five identity-slice actions are declared", () => {
  for (const action of [
    "auth.email_send_failed",
    "auth.email_verified",
    "auth.email_verify_requested",
    "auth.password_reset_completed",
    "auth.password_reset_requested"
  ]) {
    assert.ok(AUDIT_ACTIONS[action], `${action} is not declared`);
  }
});

test("no declared detail key is credential-shaped", () => {
  // audit_events_detail_no_credentials rejects these at the database. Catching
  // it here means the failure is a test, not a 500 in production. The list is
  // read OUT of that constraint rather than copied from it, so adding a twelfth
  // banned key in a later migration cannot leave this test grading the old set.
  for (const [action, entry] of Object.entries(AUDIT_ACTIONS)) {
    for (const key of entry.detail) {
      assert.ok(
        !DDL_BANNED_DETAIL_KEYS.includes(key),
        `${action} declares the credential-shaped key ${key}`
      );
    }
  }
});

test("assertAuditEvent accepts a well-formed event", () => {
  assert.doesNotThrow(() =>
    assertAuditEvent({
      action: "auth.password_reset_requested",
      actorKind: "anonymous",
      outcome: "failure",
      detail: { email: "nobody@example.test" }
    })
  );
});

test("assertAuditEvent rejects an undeclared action", () => {
  assert.throws(
    () => assertAuditEvent({ action: "auth.invented", actorKind: "user", outcome: "success" }),
    /is not in the audit vocabulary/
  );
});

test("assertAuditEvent rejects an actor kind the action does not permit", () => {
  assert.throws(
    () => assertAuditEvent({ action: "auth.email_verify_requested", actorKind: "terminal", outcome: "success" }),
    /actorKind "terminal" is not permitted/
  );
});

test("assertAuditEvent rejects an outcome the action does not permit", () => {
  assert.throws(
    () => assertAuditEvent({ action: "auth.email_verified", actorKind: "anonymous", outcome: "failure" }),
    /outcome "failure" is not permitted/
  );
});

test("assertAuditEvent rejects an undeclared detail key", () => {
  assert.throws(
    () =>
      assertAuditEvent({
        action: "auth.email_verified",
        actorKind: "anonymous",
        outcome: "success",
        detail: { email: "someone@example.test" }
      }),
    /detail key "email" is not declared/
  );
});

test("assertAuditEvent rejects a non-scalar detail value", () => {
  // audit_events_detail_is_flat_object rejects it at the database; the jsonb ?
  // family inspects top-level keys only, so a nested object would smuggle a
  // password past the credential-name CHECK.
  assert.throws(
    () =>
      assertAuditEvent({
        action: "auth.password_reset_requested",
        actorKind: "anonymous",
        outcome: "failure",
        detail: { email: { nested: true } }
      }),
    /detail\.email must be a scalar/
  );
});

test("assertAuditEvent mirrors the actor arc, so it fails as a programming error not a 23514", () => {
  // Both branches of audit_events_actor_arc. Before this the constraint was
  // reached instead, and a check violation inside somebody else's transaction
  // surfaces as a 500 where a programming error belongs.
  assert.throws(
    () => assertAuditEvent({ action: "auth.email_verify_requested", actorKind: "user", outcome: "success" }),
    /requires actorUserId/
  );
  assert.throws(
    () =>
      assertAuditEvent({
        action: "auth.email_send_failed",
        actorKind: "system",
        outcome: "failure",
        actorUserId: "00000000-0000-0000-0000-000000000000"
      }),
    /must carry neither actorUserId nor actorTerminalId/
  );
});

test("assertAuditEvent mirrors the target pair and enforces the declared targetKind", () => {
  const base = { action: "auth.email_verified", actorKind: "anonymous", outcome: "success" };

  // audit_events_target_pair: set together or not at all.
  assert.throws(() => assertAuditEvent({ ...base, targetKind: "user" }), /set together or not at all/);
  assert.throws(() => assertAuditEvent({ ...base, targetId: "abc" }), /set together or not at all/);

  // And entry()'s targetKind stops being dead data. This was declared on every
  // action and read by nothing, so a reader saw a constraint that did not exist.
  assert.throws(
    () => assertAuditEvent({ ...base, targetKind: "company", targetId: "abc" }),
    /is not the declared "user"/
  );

  // The shapes the writer actually uses still pass.
  assert.doesNotThrow(() => assertAuditEvent({ ...base, targetKind: "user", targetId: "abc" }));
  assert.doesNotThrow(() => assertAuditEvent(base));
});
