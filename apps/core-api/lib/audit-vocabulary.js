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
  "auth.login": entry(["user"], ["success"], "user", []),
  // No target and no detail beyond the probed address. actor_kind 'anonymous'
  // because nobody authenticated -- audit_events_actor_arc then requires BOTH
  // actor id columns NULL, which is exactly right for a failed sign-in.
  "auth.login_failed": entry(["anonymous"], ["failure"], null, ["email"]),
  "auth.logout": entry(["user"], ["success"], "user", []),
  "auth.logout_all": entry(["user"], ["success"], "user", ["revokedSessionCount"]),
  "auth.password_changed": entry(["user"], ["success"], "user", []),
  "auth.password_reset_completed": entry(["anonymous"], ["success"], "user", []),
  // The one row whose target is CONDITIONAL. When the probed address matches no
  // row there is no user to name, and audit_events_target_pair requires
  // (target_kind IS NULL) = (target_id IS NULL) -- so both are NULL and the
  // address survives only in detail.email.
  "auth.password_reset_requested": entry(["anonymous"], ["success", "failure"], "user", ["email"]),
  // Sorted position, not appended: Object.keys returns insertion order and the
  // vocabulary test asserts it is sorted, so where these two sit in the literal IS
  // what keeps the next addition a readable diff.
  //
  // *Amended by Plan 2c:* spec 5.9 declares detail ["name"] here. `slug` is added
  // because 0003_admin_console.sql made a company's URL name a thing somebody
  // CHOOSES -- it is globally unique, it goes in every address the company is
  // reached by, and "who set /sakura, and when" is precisely the question an audit
  // trail is kept for. The name alone cannot answer it.
  "company.created": entry(["user"], ["success"], "company", ["name", "slug"]),
  // success ONLY. A PATCH that 404s or 409s writes no row -- assertAuditEvent
  // refuses the outcome, and a refusal inside the failure path would turn a 404
  // into a 500. scope.selected declares 'failure' because a platform admin probing
  // company ids is worth recording; a rename that lost a race is not.
  "company.updated": entry(["user"], ["success"], "company", ["name", "slug", "status"]),
  // 'system' as well as 'user': scripts/create-platform-admin.js is the CLI that
  // writes the FIRST one, and there is no authenticated actor at that moment.
  // POST /api/platform/admins (Plan 2c) writes it as 'user'.
  "platform.admin_created": entry(["user", "system"], ["success"], "user", ["email"]),
  "platform.admin_password_reset": entry(["user"], ["success"], "user", []),
  "platform.admin_updated": entry(["user"], ["success"], "user", ["status"]),
  // Clearing a selection names no company, so both target columns are NULL --
  // the same conditional-target shape auth.password_reset_requested carries.
  "scope.cleared": entry(["user"], ["success"], null, []),
  // 'failure' is declared because 6.2 lists 404 not_found and 409 company_suspended
  // on this route, and a platform admin probing company ids is worth a row.
  "scope.selected": entry(["user"], ["success", "failure"], "company", []),
  // The console design moved opening a branch to the platform owner, so this is
  // written by an actor whose scope carries auditCrossTenant -- a platform admin
  // inside somebody else's company. company_id is the company the branch belongs
  // to, which is what makes "everything done inside this company" a query.
  "shop.created": entry(["user"], ["success"], "shop", ["name", "slug", "timeZone", "tableCount"]),
  // The CEO's one job on a shop. detail names the three states this route can
  // leave behind -- a person, the owner, or nobody -- and who was displaced.
  // detail names WHICH of the three moved, never their values: a receipt footer
  // is free text and a 365-day retention window is not the place for it.
  "shop.day_to_day_updated": entry(["user"], ["success"], "shop", ["fields"]),
  "shop.manager_changed": entry(["user"], ["success"], "shop", ["managerUserId", "runByOwner", "replacedUserId"]),
  "shop.updated": entry(["user"], ["success"], "shop", ["name", "slug", "status"]),
  // 'system', and the arc is what settles it rather than taste. audit_events_actor_arc
  // requires actor_user_id NOT NULL for 'user' and actor_terminal_id NOT NULL for
  // 'terminal'; POST /api/terminal/table-displays/:tableNumber authenticates a CONFIGURED
  // SERVICE TOKEN, which references neither row -- apps/customer-order has no terminals
  // row until Phase 3 pairs it. 'system' is the arc's both-NULL branch, and it is the
  // honest one of the two: the caller presented a credential, so it is not 'anonymous'.
  // Phase 3 changes this to ["terminal"] in the same commit that mints the terminal.
  //
  // detail carries the STATUS and nothing else. The ordering URL is the visit token, and
  // `url` is not on audit_events_detail_no_credentials' banned-key list -- so the only
  // thing keeping a live table credential out of a 365-day retention window is this list
  // being short on purpose.
  "table_display.updated": entry(["system"], ["success", "failure"], "table_display", ["status"]),
  // The CEO and the manager both write these; the lattice in lib/authorization.js
  // is what decides which of them may, and it is checked before the row is made.
  "user.created": entry(["user"], ["success"], "user", ["email", "role"]),
  "user.password_change_abuse": entry(["user"], ["failure"], "user", ["consecutiveFailures"]),
  "user.password_reset": entry(["user"], ["success"], "user", []),
  "user.updated": entry(["user"], ["success"], "user", ["role", "status"])
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

  // audit_events_actor_arc, mirrored. Without this the constraint is reached
  // instead, and a 23514 inside somebody else's transaction is a 500 where a
  // programming error belongs. It is also the check most likely to fire: an
  // action declaring actorKinds ["user"] obliges every caller to pass
  // actorUserId, and nothing else reminds them.
  const actorUserId = event.actorUserId ?? null;
  const actorTerminalId = event.actorTerminalId ?? null;
  const expectedIdColumn = { user: actorUserId, terminal: actorTerminalId }[actorKind];
  if (expectedIdColumn === null) {
    throw new Error(`audit: ${action} actorKind "${actorKind}" requires actor${actorKind === "user" ? "User" : "Terminal"}Id`);
  }
  if (expectedIdColumn === undefined && (actorUserId !== null || actorTerminalId !== null)) {
    throw new Error(`audit: ${action} actorKind "${actorKind}" must carry neither actorUserId nor actorTerminalId`);
  }

  // audit_events_target_pair: (target_kind IS NULL) = (target_id IS NULL).
  const targetKind = event.targetKind ?? null;
  const targetId = event.targetId ?? null;
  if ((targetKind === null) !== (targetId === null)) {
    throw new Error(`audit: ${action} targetKind and targetId must be set together or not at all`);
  }
  // And the table's fourth column stops being dead data. entry() declares a
  // targetKind per action; before this, nothing read it, so a reader of the
  // vocabulary saw a constraint that was never enforced.
  if (targetKind !== null && targetKind !== declared.targetKind) {
    throw new Error(
      `audit: ${action} targetKind "${targetKind}" is not the declared "${String(declared.targetKind)}"`
    );
  }

  return declared;
}

module.exports = { AUDIT_ACTIONS, assertAuditEvent };
