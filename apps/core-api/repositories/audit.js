"use strict";

// The TENANT audit writer -- the third of the three, and the one spec §5.4 named
// when it said the split exists "so the tenant writer can satisfy Mode 6 (must throw
// on a platform scope) and Mode 2 (company_id must equal A)".
//
// The three differ in exactly one way, and it is the way that matters:
//
//   repositories/auth/audit.js opens its OWN connection (withUnscopedConnection),
//   because a failed login has no transaction to join -- there is no company, and
//   often no user.
//
//   repositories/platform/audit.js joins the caller's open PLATFORM transaction.
//
//   This one joins the caller's open TENANT transaction, and company_id is injected
//   by the choke point rather than bound, so an audit row can only ever be written
//   against the company whose scope produced it.
//
// WHY IT HAD TO EXIST. Opening a branch creates the shop and audits it in one
// transaction. The pre-tenant writer takes a DIFFERENT connection out of the pool,
// so the shop -- still uncommitted -- is invisible to it, and
// audit_events_shop_id_company_id_fkey fails. The route answered 500 and no branch
// could be opened at all. Every tenant route that audits a row it created in the
// same transaction has this shape; this is the writer for all of them.

const { tenantQuery } = require("../db");
const { assertAuditEvent } = require("../lib/audit-vocabulary");

// Append only. Nothing in the service updates or deletes an audit row.
//
// company_id is ABSENT from the column list on purpose: tenantQuery injects it and
// refuses any INSERT that names it. That refusal is the guarantee -- there is no
// spelling of this statement that writes an audit row into another company.
//
// The placeholders therefore start at $2. $1 is the injected company, and the helper
// refuses an INSERT that uses it -- which is what keeps this file from being able to
// choose its own tenant even by accident.
const INSERT = {
  sql: `
    INSERT INTO audit_events
      (shop_id, actor_kind, actor_user_id, actor_terminal_id, actor_label,
       action, outcome, target_kind, target_id, source_ip, detail)
    VALUES ($2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
    RETURNING id
  `,
  // The shop id is the audited row's, not a containment predicate. An INSERT has no
  // rows to filter, and the scope's shop list is not the question being asked: a CEO
  // audits a shop they administer rather than one they are assigned to.
  shopScoped: false
};

// Returns audit_events.id as a STRING: the column is bigint and node-postgres hands
// those back as strings rather than silently losing precision past 2^53.
async function appendTenantAuditEvent(scope, event) {
  // Vocabulary first, so an undeclared action fails as a programming error rather
  // than as a 23514 inside the caller's transaction -- which would roll back the row
  // beside it and present as a 500 with the audit line looking innocent.
  assertAuditEvent(event);

  const {
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

  const { rows } = await tenantQuery(scope, INSERT, [
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

module.exports = { appendTenantAuditEvent };
