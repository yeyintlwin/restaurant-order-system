"use strict";

const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");

const { closeAllPools, openRuntimePool } = require("../db");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const { appendAuditEvent } = require("../repositories/auth/audit");

describe("the pre-tenant audit writer", { skip: skipDatabaseTests() }, () => {
  let database;

  before(async () => {
    database = await cloneTemplate(__filename);
    // appendAuditEvent reaches the database through withUnscopedConnection,
    // which checks out of the runtime pool. Point that pool at the clone.
    openRuntimePool({ connectionString: database.connectionString, max: 4 });
  });

  after(async () => {
    await closeAllPools();
    if (database) await database.drop();
  });

  test("writes an anonymous failure with no tenant and no target", async () => {
    await appendAuditEvent({
      action: "auth.password_reset_requested",
      actorKind: "anonymous",
      outcome: "failure",
      sourceIp: "203.0.113.9",
      detail: { email: "nobody@example.test" }
    });

    const { rows } = await database.unscoped(
      "SELECT * FROM audit_events WHERE action = 'auth.password_reset_requested'"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].company_id, null);
    assert.equal(rows[0].actor_user_id, null);
    assert.equal(rows[0].target_kind, null);
    assert.equal(rows[0].target_id, null);
    assert.equal(rows[0].source_ip, "203.0.113.9");
    assert.deepEqual(rows[0].detail, { email: "nobody@example.test" });
  });

  test("a null source_ip is written, not omitted", async () => {
    // The untrusted derivation is fail-SOFT for the audit row: a missing
    // address is honest, and a wrong one is not.
    await appendAuditEvent({
      action: "auth.password_reset_requested",
      actorKind: "anonymous",
      outcome: "failure",
      sourceIp: null,
      detail: { email: "nulled@example.test" }
    });

    const { rows } = await database.unscoped(
      "SELECT source_ip FROM audit_events WHERE detail->>'email' = 'nulled@example.test'"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_ip, null);
  });

  test("an undeclared action is refused before it reaches the database", async () => {
    await assert.rejects(
      () => appendAuditEvent({ action: "auth.invented", actorKind: "anonymous", outcome: "success" }),
      /is not in the audit vocabulary/
    );
    const { rows } = await database.unscoped("SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.invented'");
    assert.equal(rows[0].n, 0);
  });

  test("a nested detail value is refused before the flat-object CHECK sees it", async () => {
    await assert.rejects(
      () =>
        appendAuditEvent({
          action: "auth.password_reset_requested",
          actorKind: "anonymous",
          outcome: "failure",
          detail: { email: { smuggled: "password" } }
        }),
      /must be a scalar/
    );
  });

  test("the actor arc is satisfied for a user actor", async () => {
    const { rows: users } = await database.unscoped(
      `INSERT INTO users (company_id, role, email, display_name, password_hash)
       VALUES (NULL, 'platform_admin', 'audit-actor@example.test', 'Audit Actor',
               'scrypt$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
       RETURNING id`
    );

    await appendAuditEvent({
      action: "auth.email_verify_requested",
      actorKind: "user",
      actorUserId: users[0].id,
      actorLabel: "audit-actor@example.test",
      outcome: "success",
      targetKind: "user",
      targetId: users[0].id
    });

    const { rows } = await database.unscoped(
      "SELECT * FROM audit_events WHERE action = 'auth.email_verify_requested'"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_user_id, users[0].id);
    assert.equal(rows[0].actor_label, "audit-actor@example.test");
    assert.equal(rows[0].target_kind, "user");
  });

  test("a system actor writes with both actor id columns null", async () => {
    // The only declared actorKind with no test in the plan, and the one Plan 2d's
    // expiry sweeper will call. audit_events_actor_arc requires BOTH actor id
    // columns null for 'system', so this is the arc's other branch -- the 'user'
    // test above only exercises the branch that sets one.
    await appendAuditEvent({
      action: "auth.email_send_failed",
      actorKind: "system",
      outcome: "failure",
      targetKind: "user",
      targetId: "00000000-0000-0000-0000-000000000000",
      detail: { purpose: "password_reset", attempts: 5 }
    });

    const { rows } = await database.unscoped(
      "SELECT * FROM audit_events WHERE action = 'auth.email_send_failed'"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_user_id, null);
    assert.equal(rows[0].actor_terminal_id, null);
    assert.equal(rows[0].company_id, null);
    // attempts survives as a JSON number, not a string -- the flat-scalar rule
    // permits numbers and a caller reading it back should get one.
    assert.deepEqual(rows[0].detail, { purpose: "password_reset", attempts: 5 });
  });
});
