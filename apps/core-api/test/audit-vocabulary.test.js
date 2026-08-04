"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { AUDIT_ACTIONS, assertAuditEvent } = require("../lib/audit-vocabulary");

// The regex on audit_events.action in 0001_init.sql. Every declared action must
// satisfy it, or the row is rejected at write time rather than at review time.
const DDL_ACTION_SHAPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

test("every action satisfies the DDL's shape and length limit", () => {
  const names = Object.keys(AUDIT_ACTIONS);
  assert.ok(names.length >= 5, `only ${names.length} actions declared`);
  for (const name of names) {
    assert.match(name, DDL_ACTION_SHAPE, `${name} does not match the audit_events CHECK`);
    assert.ok(name.length <= 64, `${name} exceeds the 64-character limit`);
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
  // it here means the failure is a test, not a 500 in production.
  const banned = ["password", "token", "code", "secret", "cookie",
                  "authorization", "token_hash", "code_hash",
                  "password_hash", "session", "sid"];
  for (const [action, entry] of Object.entries(AUDIT_ACTIONS)) {
    for (const key of entry.detail) {
      assert.ok(!banned.includes(key), `${action} declares the credential-shaped key ${key}`);
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
