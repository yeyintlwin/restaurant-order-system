"use strict";

// The PLATFORM audit writer, split from repositories/auth/audit.js exactly as
// spec §5.4's file map says -- "so the tenant writer can satisfy Mode 6 (must
// throw on a platform scope) and Mode 2 (company_id must equal A)".
//
// The split is not tidiness. The two writers differ in the one way that matters:
//
//   repositories/auth/audit.js opens its OWN connection (withUnscopedConnection),
//   because a failed login has no transaction to join -- there is no company, and
//   often no user.
//
//   This one joins the caller's OPEN platform transaction. A company row and the
//   row saying who created it commit together or not at all. Written the other way
//   -- its own connection, like the pre-tenant writer -- a rolled-back INSERT would
//   leave an audit row claiming a company that does not exist, and the trail would
//   be lying in the one direction nobody checks.
//
// It therefore takes a scope, and refuses to run outside withPlatformScope,
// because platformQuery does.

const { assertAuditEvent } = require("../../lib/audit-vocabulary");
const { dangerouslyQueryAcrossTenants } = require("./query");

// Append only, and identical in shape to the pre-tenant writer's. company_id is
// bound like any other column here rather than injected by the helper, which is
// the whole difference between this seam and tenantQuery.
const INSERT = {
  sql: `
    INSERT INTO audit_events
      (company_id, shop_id, actor_kind, actor_user_id, actor_terminal_id, actor_label,
       action, outcome, target_kind, target_id, source_ip, detail)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
    RETURNING id
  `
};

// Returns audit_events.id as a STRING: the column is bigint and node-postgres
// hands those back as strings rather than silently losing precision past 2^53.
async function appendPlatformAuditEvent(scope, event) {
  // Vocabulary first, so an undeclared action fails as a programming error rather
  // than as a 23514 inside the caller's transaction -- which would roll back the
  // company insert beside it and present as a 500.
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

  const { rows } = await dangerouslyQueryAcrossTenants(scope, INSERT, [
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
}

module.exports = { appendPlatformAuditEvent };
