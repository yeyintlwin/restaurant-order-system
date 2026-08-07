"use strict";

// PRE_TENANT_REASON: the login lookup runs before any company_id exists -- the
// tenant is DISCOVERED by it. One of the nine files source-structure.test.js rule
// C4 sanctions to call withUnscopedConnection, and the path is pinned by that
// allowlist.
const PRE_TENANT_REASON =
  "the login lookup and the bootstrap insert run before any tenant scope exists";

const { withUnscopedConnection } = require("../../db");
// The bootstrap writes its own audit row INSIDE its transaction (see
// bootstrapPlatformAdmin below), so it needs the vocabulary check without needing
// repositories/auth/audit.js's writer, which would open a second connection.
// lib/ is Tier 1 and this require is legal from anywhere.
const { assertAuditEvent } = require("../../lib/audit-vocabulary");

// One read, and it returns the two SUSPENSION facts alongside the hash. Splitting
// them into a second query would make "unknown email" and "suspended company"
// take measurably different times on the one path spec 5.1 requires to be
// indistinguishable.
//
// LEFT JOIN, not JOIN: users_platform_admin_has_no_company makes company_id NULL
// for every platform admin, and an inner join would return zero rows for exactly
// the account that can repair the platform.
const SELECT_FOR_LOGIN = `
  SELECT u.id,
         u.email,
         u.display_name          AS "displayName",
         u.role,
         u.company_id            AS "companyId",
         u.password_hash         AS "passwordHash",
         u.must_change_password  AS "mustChangePassword",
         u.status,
         u.locked_until          AS "lockedUntil",
         u.failed_login_count    AS "failedLoginCount",
         c.status                AS "companyStatus",
         c.name                  AS "companyName",
         c.slug                  AS "companySlug"
    FROM users u
    LEFT JOIN companies c ON c.id = u.company_id
   WHERE u.email = lower(btrim($1))
`;

// The folding is done in SQL rather than in JavaScript because the CHECK on
// users.email is written in SQL: `email = lower(btrim(email))`. Two different
// implementations of "fold an address" is how a user ends up unable to sign in
// with the address an administrator typed.
async function findByEmailForLogin(email) {
  if (typeof email !== "string" || email.trim() === "") return null;
  // The handle is named `connection`, NOT `client`, and that is load-bearing:
  // withUnscopedConnection yields a narrow { query } handle rather than a pg
  // Client, and rule C2 matches the literal text /\b(?:pool|client)\.query\s*\(/
  // across every scanned file outside db/. A rename turns C2 red while this
  // module's own tests stay green.
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(SELECT_FOR_LOGIN, [email]);
    return rows.length === 0 ? null : rows[0];
  });
}

const SELECT_BY_ID = `
  SELECT u.id,
         u.email,
         u.display_name          AS "displayName",
         u.role,
         u.company_id            AS "companyId",
         u.password_hash         AS "passwordHash",
         u.must_change_password  AS "mustChangePassword",
         u.status,
         c.status                AS "companyStatus",
         c.name                  AS "companyName",
         c.slug                  AS "companySlug"
    FROM users u
    LEFT JOIN companies c ON c.id = u.company_id
   WHERE u.id = $1
`;

async function findById(userId) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(SELECT_BY_ID, [userId]);
    return rows.length === 0 ? null : rows[0];
  });
}

// ONE STATEMENT, so the read-modify-write cannot interleave. Two concurrent wrong
// passwords must produce count 2, not count 1 twice -- and a SELECT-then-UPDATE
// pair on the unauthenticated path is exactly where that race is reachable on
// demand.
//
// THE EXPONENT IS CLAMPED BEFORE THE CAST. power(2, n) is a double, and
// power(2, 31)::int raises 22003 numeric_value_out_of_range -- INSIDE the login
// path, so a 500 where a 401 belongs, reachable by anyone willing to spend
// thirty-one wrong passwords. LEAST() after the cast is too late; the cast is what
// raises. Clamping the exponent at 10 is arbitrary only in the sense that any
// value >= 4 gives 2^n > 15 and the outer LEAST decides.
const BUMP_FAILED_LOGIN = `
  UPDATE users
     SET failed_login_count = failed_login_count + 1,
         locked_until = CASE
           WHEN failed_login_count + 1 < 3 THEN NULL
           ELSE now() + make_interval(
                  mins => LEAST(power(2, LEAST(failed_login_count + 1 - 3, 10))::int, 15))
         END,
         updated_at = now()
   WHERE id = $1
  RETURNING failed_login_count AS "failedLoginCount", locked_until AS "lockedUntil"
`;

async function recordFailedLogin(userId) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(BUMP_FAILED_LOGIN, [userId]);
    return rows.length === 0 ? null : rows[0];
  });
}

// Spec 5.7: "reset to zero on any successful login. A correct password therefore
// always eventually works." Without the clear, a user who is locked out and then
// signs in during a gap stays one failure away from a 15-minute lock forever.
const CLEAR_FAILED_LOGIN = `
  UPDATE users
     SET failed_login_count = 0,
         locked_until = NULL,
         last_login_at = now(),
         updated_at = now()
   WHERE id = $1
`;

async function recordSuccessfulLogin(userId) {
  await withUnscopedConnection(async (connection) => {
    await connection.query(CLEAR_FAILED_LOGIN, [userId]);
  });
}

// sessions_valid_from is bumped HERE and nowhere else on this path. Spec 5.2 makes
// it the bulk-invalidation lever and the resolver requires
// user_sessions.created_at >= it, so revocation is a fail-closed UPDATE that
// cannot miss a row -- which is the property a DELETE over user_sessions does not
// have, because a session created between the DELETE and the COMMIT survives it.
//
// failed_login_count and locked_until are DELIBERATELY NOT TOUCHED here. Spec
// 5.8(a)/6.3.7(a): those columns belong to the unauthenticated login credential,
// and writing them from the authenticated password route lets a stolen session
// drive the legitimate owner's login lockout.
const WRITE_PASSWORD = `
  UPDATE users
     SET password_hash = $2,
         must_change_password = $3,
         sessions_valid_from = now(),
         updated_at = now()
   WHERE id = $1
`;

async function writePasswordHash(userId, passwordHash, { mustChangePassword } = {}) {
  if (typeof passwordHash !== "string" || !passwordHash.startsWith("scrypt$")) {
    throw new Error("writePasswordHash requires a PHC string from lib/password.js");
  }
  if (typeof mustChangePassword !== "boolean") {
    throw new Error("writePasswordHash requires an explicit mustChangePassword");
  }
  await withUnscopedConnection(async (connection) => {
    await connection.query(WRITE_PASSWORD, [userId, passwordHash, mustChangePassword]);
  });
}

// The THIRD writer of sessions_valid_from. Spec 5.2 names all three -- password
// change, suspension, and "sign out everywhere" -- and writePasswordHash owns the
// first. This one exists because a DELETE over user_sessions is not a revocation:
// a session created between the DELETE and the response survives it, and the whole
// point of this route is that nothing survives it.
//
// failed_login_count and locked_until are DELIBERATELY NOT TOUCHED. They belong to
// the unauthenticated login credential (spec 5.8(a)); signing out everywhere is not
// a failed login and must not push anybody toward a lockout.
const BUMP_SESSIONS_VALID_FROM = `
  UPDATE users
     SET sessions_valid_from = now(),
         updated_at = now()
   WHERE id = $1
`;

async function bumpSessionsValidFrom(userId) {
  // `connection`, never `client` -- see the note at the top of this file.
  await withUnscopedConnection(async (connection) => {
    await connection.query(BUMP_SESSIONS_VALID_FROM, [userId]);
  });
}

// ---------------------------------------------------------------------------
// THE BOOTSTRAP. One transaction, an advisory lock, and a MONOTONIC guard.
// ---------------------------------------------------------------------------
//
// Spec 5.6, 9.10 and -- most precisely -- 12's acceptance checkbox: "a second run
// with a different address exits NON-ZERO; DELETE the platform_admin row and re-run
// -- still non-zero (the audit_events guard is monotonic, not current-state)".
//
// WHY MONOTONIC RATHER THAN "does a platform_admin already exist". design.md:714 and
// :855 make this function's monotonicity the load-bearing justification for
// POST /api/platform/admins being the ONE route in the system permitted to create a
// peer. A current-state guard is defeated by a DELETE, so anyone who can remove a row
// could mint platform admins without limit -- and Plan 2c would inherit an escalation
// exception whose premise had quietly gone.
//
// WHY ONE TRANSACTION. pg_advisory_xact_lock is transaction-scoped, so the lock, the
// guard read, the INSERT and the audit write must share a transaction or the lock
// bounds nothing. It also means the guard cannot be left disarmed by a crash between
// the user row and its audit row -- which is exactly what calling appendAuditEvent()
// afterwards would risk, because that function opens its OWN connection.
//
// WHY THE AUDIT INSERT IS WRITTEN OUT HERE rather than delegated: same reason. The
// VOCABULARY check is not skipped -- assertAuditEvent() is called first, so an
// undeclared action still fails as a programming error rather than as a 23514.
//
// NAMED bootstrapPlatformAdmin, not createPlatformAdmin, and the difference is
// load-bearing: source-structure.test.js rule C6 budgets repositories/platform/ at
// exactly ten exported functions and `createPlatformAdmin` is one of them, arriving
// in Plan 2c with POST /api/platform/admins. Two functions with one name in two
// exempt zones is the kind of collision that gets "fixed" by widening C6.

// A fixed, arbitrary key. It only has to be distinct from db/migrate.js's
// 4264071001; nothing else in the service takes an advisory lock.
const BOOTSTRAP_LOCK_KEY = 4264071002;

const BOOTSTRAP_ALREADY_RUN = `
  SELECT 1 FROM audit_events WHERE action = 'platform.admin_created' LIMIT 1
`;

// ON CONFLICT DO NOTHING, so a repeated address is zero rows rather than a 23505 the
// CLI would have to translate. users_email_key is UNCONDITIONAL (email is identity,
// and freeing a suspended user's address would let a second row shadow the first in
// the login lookup), so it is the only conflict reachable.
const INSERT_PLATFORM_ADMIN = `
  INSERT INTO users (company_id, role, email, display_name, password_hash, must_change_password)
  VALUES (NULL, 'platform_admin', lower(btrim($1)), $2, $3, false)
  ON CONFLICT DO NOTHING
  RETURNING id, email, display_name AS "displayName"
`;

const INSERT_BOOTSTRAP_AUDIT = `
  INSERT INTO audit_events (actor_kind, actor_label, action, outcome, target_kind, target_id, detail)
  VALUES ('system', 'create-platform-admin', 'platform.admin_created', 'success', 'user', $1, $2::jsonb)
`;

// Returns { created, reason }. Two distinguishable refusals, because the operator's
// next move differs: "already_bootstrapped" means use scripts/set-password.js,
// "email_taken" means pick another address.
async function bootstrapPlatformAdmin({ email, displayName, passwordHash }) {
  if (typeof passwordHash !== "string" || !passwordHash.startsWith("scrypt$")) {
    throw new Error("bootstrapPlatformAdmin requires a PHC string from lib/password.js");
  }
  // The vocabulary check, run BEFORE the transaction opens so an undeclared action is
  // a programming error at the call site rather than a 23514 inside a rollback.
  assertAuditEvent({
    actorKind: "system",
    actorLabel: "create-platform-admin",
    action: "platform.admin_created",
    outcome: "success",
    targetKind: "user",
    // A stand-in: the real id is not known until the INSERT returns, and
    // assertAuditEvent only checks that the pair is set together.
    targetId: "pending",
    detail: { email }
  });

  // `connection`, never `client` -- see the note at the top of this file.
  return withUnscopedConnection(async (connection) => {
    await connection.query("BEGIN");
    try {
      // Transaction-scoped, so it is released by the COMMIT or the ROLLBACK below and
      // cannot be orphaned by a killed CLI the way a session lock can.
      await connection.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK_KEY]);

      const guard = await connection.query(BOOTSTRAP_ALREADY_RUN, []);
      if (guard.rows.length > 0) {
        await connection.query("ROLLBACK");
        return { created: null, reason: "already_bootstrapped" };
      }

      const inserted = await connection.query(INSERT_PLATFORM_ADMIN, [email, displayName, passwordHash]);
      if (inserted.rows.length === 0) {
        await connection.query("ROLLBACK");
        return { created: null, reason: "email_taken" };
      }

      const created = inserted.rows[0];
      await connection.query(INSERT_BOOTSTRAP_AUDIT, [created.id, JSON.stringify({ email: created.email })]);
      await connection.query("COMMIT");
      return { created, reason: null };
    } catch (error) {
      try {
        await connection.query("ROLLBACK");
      } catch {
        // The connection is already gone; releasing it is all that is left, and
        // withUnscopedConnection's own finally does that.
      }
      throw error;
    }
  });
}

// Read by server.js at boot to WARN, never to refuse. Spec 9.10: the bootstrap CLI
// runs through `docker compose exec`, so the container must already be up -- which
// makes "no platform admin exists" the one deliberate exception to this repo's
// refuse-to-start convention. Refusing here would make the platform unbootstrappable.
const COUNT_ACTIVE_PLATFORM_ADMINS = `
  SELECT count(*)::int AS count FROM users WHERE role = 'platform_admin' AND status = 'active'
`;

async function countActivePlatformAdmins() {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(COUNT_ACTIVE_PLATFORM_ADMINS, []);
    return rows[0].count;
  });
}

module.exports = {
  PRE_TENANT_REASON,
  findByEmailForLogin,
  findById,
  recordFailedLogin,
  recordSuccessfulLogin,
  writePasswordHash,
  bumpSessionsValidFrom,
  bootstrapPlatformAdmin,
  countActivePlatformAdmins
};
