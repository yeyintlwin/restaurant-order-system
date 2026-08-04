"use strict";

// PURE (Tier 1). No requires at all.
//
// Spec 5.9's closed vocabulary. It exists so that roughly twenty-five action
// strings are not invented at implementation time, and so that
// audit_events_detail_no_credentials is protecting a set somebody chose rather
// than whatever a handler happened to pass.
//
// Two consumers must agree on this table: repositories/auth/audit.js, which
// refuses to write an undeclared action, and Plan 2b's boot-time route check
// (spec 8.5 rule 4), where route() asserts every non-GET route's declared
// `audit` value is a member. Two copies would disagree the first time somebody
// adds an action.
//
// This slice declares only the actions its own routes emit. Plan 2b and 2c add
// theirs; the sorted-order test keeps each addition a readable diff.

function entry(actorKinds, outcomes, targetKind, detail) {
  return Object.freeze({
    actorKinds: Object.freeze(actorKinds),
    outcomes: Object.freeze(outcomes),
    targetKind,
    detail: Object.freeze(detail)
  });
}

const AUDIT_ACTIONS = Object.freeze({
  // system, because the sweeper writes it, and the actor arc CHECK requires
  // both actor id columns NULL for 'system'.
  "auth.email_send_failed": entry(["system"], ["failure"], "user", ["purpose", "attempts"]),
  // anonymous: the caller presented a mailed token, not a session.
  "auth.email_verified": entry(["anonymous"], ["success"], "user", []),
  "auth.email_verify_requested": entry(["user"], ["success"], "user", []),
  "auth.password_reset_completed": entry(["anonymous"], ["success"], "user", []),
  // The one row whose target is CONDITIONAL. When the probed address matches no
  // row there is no user to name, and audit_events_target_pair requires
  // (target_kind IS NULL) = (target_id IS NULL) -- so both are NULL and the
  // address survives only in detail.email.
  "auth.password_reset_requested": entry(["anonymous"], ["success", "failure"], "user", ["email"])
});

function assertAuditEvent(event) {
  const { action, actorKind, outcome, detail } = event;

  const declared = Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, action)
    ? AUDIT_ACTIONS[action]
    : null;
  if (declared === null) {
    throw new Error(`audit: "${String(action)}" is not in the audit vocabulary`);
  }
  if (!declared.actorKinds.includes(actorKind)) {
    throw new Error(
      `audit: ${action} actorKind "${String(actorKind)}" is not permitted (expected ${declared.actorKinds.join(
        " | "
      )})`
    );
  }
  if (!declared.outcomes.includes(outcome)) {
    throw new Error(
      `audit: ${action} outcome "${String(outcome)}" is not permitted (expected ${declared.outcomes.join(
        " | "
      )})`
    );
  }

  for (const [key, value] of Object.entries(detail || {})) {
    if (!declared.detail.includes(key)) {
      throw new Error(`audit: ${action} detail key "${key}" is not declared`);
    }
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      throw new Error(`audit: ${action} detail.${key} must be a scalar, not ${typeof value}`);
    }
  }

  return declared;
}

module.exports = { AUDIT_ACTIONS, assertAuditEvent };
