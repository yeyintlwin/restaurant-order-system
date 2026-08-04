"use strict";

// PRE_TENANT_REASON: a failed login, a redeemed reset link and a swept token all
// have to be recorded before -- or without -- any company_id existing. This is
// one of the nine files source-structure.test.js rule C4 sanctions to call
// withUnscopedConnection, and the path is pinned by that allowlist.
const PRE_TENANT_REASON =
  "audit rows are written for anonymous and system actors, which have no tenant scope";

const { withUnscopedConnection } = require("../../db");
const { assertAuditEvent } = require("../../lib/audit-vocabulary");

// Append only. Nothing in the service updates or deletes an audit row; the
// nightly sweep deletes by retention window and nothing else.
const INSERT = `
  INSERT INTO audit_events
    (company_id, shop_id, actor_kind, actor_user_id, actor_terminal_id, actor_label,
     action, outcome, target_kind, target_id, source_ip, detail)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
  RETURNING id
`;

// Returns audit_events.id as a STRING, not a number: the column is bigint and
// node-postgres hands those back as strings rather than silently losing
// precision past 2^53. Nothing reads it today; a later caller doing arithmetic
// or `=== someNumber` against it would be surprised.
async function appendAuditEvent(event) {
  // Vocabulary first: an undeclared action, actor kind, outcome or detail key
  // must fail as a programming error here rather than as a 23514 check
  // violation inside somebody else's transaction.
  assertAuditEvent(event);

  const {
    companyId = null,
    shopId = null,
    actorKind,
    actorUserId = null,
    actorTerminalId = null,
    actorLabel = null,
    action,
    outcome,
    targetKind = null,
    targetId = null,
    sourceIp = null,
    detail = {}
  } = event;

  // The handle is named `connection`, NOT `client`, and that is load-bearing.
  // withUnscopedConnection yields a narrow { query } handle rather than a pg
  // Client, and rule C2 ("no raw pool/client query outside db/") matches the
  // literal text /\b(?:pool|client)\.query\s*\(/ across every scanned file. A
  // rename back to `client` here turns C2 red -- which is the rule working as
  // designed: it cannot tell a sanctioned pre-tenant handle from a repository
  // that got hold of a real connection and skipped the tenant predicate.
  // db/health.js names it `connection` for the same reason.
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(INSERT, [
      companyId,
      shopId,
      actorKind,
      actorUserId,
      actorTerminalId,
      actorLabel,
      action,
      outcome,
      targetKind,
      targetId,
      sourceIp,
      JSON.stringify(detail)
    ]);
    return rows[0].id;
  });
}

module.exports = { appendAuditEvent, PRE_TENANT_REASON };
