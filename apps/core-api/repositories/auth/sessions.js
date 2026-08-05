"use strict";

// PRE_TENANT_REASON: a session is resolved in order to DISCOVER the tenant, so
// there is no company_id to bind when this runs. One of the nine files rule C4
// sanctions to call withUnscopedConnection.
const PRE_TENANT_REASON = "sessions are resolved before any tenant scope exists";

const { withUnscopedConnection } = require("../../db");

// make_interval(secs => $n) rather than string concatenation into an interval
// literal: the value comes from config and a concatenated interval is one typo
// away from being a SQL fragment.
const INSERT_SESSION = `
  INSERT INTO user_sessions (user_id, token_hash, expires_at, absolute_expires_at)
  VALUES ($1, $2, now() + make_interval(secs => $3), now() + make_interval(secs => $4))
  RETURNING id,
            expires_at          AS "expiresAt",
            absolute_expires_at AS "absoluteExpiresAt"
`;

async function createSession({ userId, tokenHash, idleSeconds, absoluteSeconds }) {
  if (!Buffer.isBuffer(tokenHash) || tokenHash.length !== 32) {
    // The column is bytea CHECK (octet_length = 32). Binding the RAW token by
    // mistake would raise "invalid input syntax for type bytea" -- loud -- but a
    // hex STRING would bind cleanly and match zero rows forever, so the shape is
    // asserted here where the failure names the caller.
    throw new Error("createSession requires a 32-byte Buffer from lib/tokens.js hashToken()");
  }
  if (!Number.isInteger(idleSeconds) || !Number.isInteger(absoluteSeconds) || absoluteSeconds <= idleSeconds) {
    throw new Error("createSession requires integer idleSeconds < absoluteSeconds");
  }
  // `connection`, never `client` -- see the note in repositories/auth/users.js.
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(INSERT_SESSION, [userId, tokenHash, idleSeconds, absoluteSeconds]);
    return rows[0];
  });
}

// READ-ONLY, and spec 6.3.5 step 5 says so: resolution happens before the
// must_change_password gate, before the Origin gate and before authorization, so a
// write here would mean a rejected request had already extended a session. Step 14
// owns the write.
//
// THE ACTING COMPANY IS RETURNED, NOT FILTERED. A suspended acting company is
// 409 acting_company_suspended (6.3.2), because the remedy is a state change via
// POST /api/admin/scope; refusing it here would sign the platform admin out and
// leave them no way to clear the selection they are stuck in.
//
// The OWN company is filtered, because a suspended company's users have no
// remedy available to themselves.
const RESOLVE_SESSION = `
  SELECT s.id                   AS "sessionId",
         s.user_id              AS "userId",
         s.acting_company_id    AS "actingCompanyId",
         s.expires_at           AS "expiresAt",
         s.absolute_expires_at  AS "absoluteExpiresAt",
         s.last_seen_at         AS "lastSeenAt",
         u.email,
         u.display_name         AS "displayName",
         u.role,
         u.company_id           AS "companyId",
         u.must_change_password AS "mustChangePassword",
         acting.status          AS "actingCompanyStatus"
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN companies own    ON own.id = u.company_id
    LEFT JOIN companies acting ON acting.id = s.acting_company_id
   WHERE s.token_hash = $1
     AND s.expires_at > now()
     AND s.absolute_expires_at > now()
     AND s.created_at >= u.sessions_valid_from
     AND u.status = 'active'
     AND (u.company_id IS NULL OR own.status = 'active')
`;

async function resolveSession(tokenHash) {
  if (!Buffer.isBuffer(tokenHash) || tokenHash.length !== 32) return null;
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(RESOLVE_SESSION, [tokenHash]);
    return rows.length === 0 ? null : rows[0];
  });
}

// THE CLAMP IS THE STATEMENT'S JOB, not the caller's.
// user_sessions_idle_within_absolute is CHECK (expires_at <= absolute_expires_at),
// and 0001_init.sql's own comment says the CHECK is the backstop rather than the
// clamp: an unclamped bump raises 23514 for the whole final idle window of every
// session -- the last eight hours of every seven-day session, every time.
//
// The 60-second throttle is in the WHERE clause rather than in JavaScript so that
// two concurrent requests cannot both decide they are the one allowed to renew.
// Zero rows is the ordinary case, not an error.
const RENEW_SESSION = `
  UPDATE user_sessions
     SET expires_at   = LEAST(now() + make_interval(secs => $2), absolute_expires_at),
         last_seen_at = now(),
         last_seen_ip = $3
   WHERE id = $1
     AND last_seen_at < now() - make_interval(secs => $4)
  RETURNING expires_at AS "expiresAt", absolute_expires_at AS "absoluteExpiresAt"
`;

async function renewSession({ sessionId, idleSeconds, lastSeenIp = null, throttleSeconds = 60 }) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(RENEW_SESSION, [sessionId, idleSeconds, lastSeenIp, throttleSeconds]);
    return rows.length === 0 ? null : rows[0];
  });
}

async function deleteSession(sessionId) {
  return withUnscopedConnection(async (connection) => {
    const { rowCount } = await connection.query("DELETE FROM user_sessions WHERE id = $1", [sessionId]);
    return rowCount;
  });
}

// The count is returned because auth.logout_all declares revokedSessionCount in
// its detail, and 6.2 puts it in the response body.
async function deleteAllSessionsForUser(userId) {
  return withUnscopedConnection(async (connection) => {
    const { rowCount } = await connection.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
    return rowCount;
  });
}

// Read BEFORE the write, and separately, because 6.2 distinguishes 404 not_found
// (unknown company) from 409 company_suspended, and one zero-row UPDATE cannot
// produce both. The race -- the company is suspended between this read and the
// write -- is one request wide and self-correcting: the resolver reports
// actingCompanyStatus on the very next request and every tenant route answers
// 409 acting_company_suspended.
//
// This is a cross-tenant READ by an unscoped platform admin, and it deliberately
// does NOT go through repositories/platform/. dangerouslyQueryAcrossTenants is
// C5-scoped to that directory and C6 budgets its exports at ten; selecting an
// acting company is scope MATERIALISATION, which is this file's job, and it reads
// one row by primary key rather than querying across tenants.
async function findCompanyForScopeSelection(companyId) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query("SELECT id, status FROM companies WHERE id = $1", [companyId]);
    return rows.length === 0 ? null : rows[0];
  });
}

async function setActingCompany(sessionId, companyId) {
  return withUnscopedConnection(async (connection) => {
    const { rowCount } = await connection.query(
      "UPDATE user_sessions SET acting_company_id = $2 WHERE id = $1",
      [sessionId, companyId]
    );
    return rowCount;
  });
}

module.exports = {
  PRE_TENANT_REASON,
  createSession,
  resolveSession,
  renewSession,
  deleteSession,
  deleteAllSessionsForUser,
  findCompanyForScopeSelection,
  setActingCompany
};
