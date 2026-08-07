"use strict";

// Platform administrators: the only peers the API can create.
//
// Spec §6.2 calls POST /api/platform/admins "the sole route in the system that
// creates a peer, and an explicit named exception to 'nobody creates at or above
// their own role'". It is justified because scripts/create-platform-admin.js is
// monotonic -- it refuses once a platform.admin_created row exists -- so a platform
// with one administrator would otherwise have no second recovery path at all, and
// §9.1 of the console design records the day that cost somebody raw SQL on the box.
//
// A platform admin is a users row with company_id NULL, guarded by
// users_platform_admin_has_no_company. Every statement here therefore pins
// `company_id IS NULL AND role = 'platform_admin'` rather than trusting the id: an
// id belonging to a company_admin must read as "not found" here, not as a tenant
// user this file is willing to edit.

const { dangerouslyQueryAcrossTenants } = require("./query");

// users_email_key is UNCONDITIONAL -- email is identity, and freeing a suspended
// user's address would let a second row shadow the first in the login lookup.
const CONFLICTS = Object.freeze({ users_email_key: "email_unavailable" });

const IS_PLATFORM_ADMIN = `company_id IS NULL AND role = 'platform_admin'`;

const COLUMNS = `
  id,
  email,
  display_name AS "displayName",
  phone,
  status,
  must_change_password AS "mustChangePassword",
  last_login_at AS "lastLoginAt",
  created_at AS "createdAt"
`;

// ?status and ?email (exact match), then keyset pagination on (email, id). email
// is unique, so the id tiebreak is belt to that braces -- and it costs nothing.
const LIST = {
  sql: `
    SELECT ${COLUMNS}
      FROM users
     WHERE ${IS_PLATFORM_ADMIN}
       AND ($1::text IS NULL OR status = $1)
       AND ($2::text IS NULL OR email = lower(btrim($2)))
       AND ($3::text IS NULL OR (email, id::text) > ($3, $4))
     ORDER BY email, id
     LIMIT $5
  `
};

const GET = { sql: `SELECT ${COLUMNS} FROM users WHERE id = $1 AND ${IS_PLATFORM_ADMIN}` };

// must_change_password true, always: the creator reads a generated password out to
// the new administrator, so it is known to two people until they change it.
const INSERT = {
  sql: `
    INSERT INTO users (company_id, role, email, display_name, phone, password_hash, must_change_password, created_by_user_id)
    VALUES (NULL, 'platform_admin', lower(btrim($1)), $2, $3, $4, true, $5)
    RETURNING ${COLUMNS}
  `,
  conflicts: CONFLICTS
};

// role is NOT patchable here or anywhere (§6.2). Neither is email: it is the
// sign-in name, and changing it is a different, audited operation.
const UPDATE = {
  sql: `
    UPDATE users
       SET display_name = COALESCE($2, display_name),
           phone        = COALESCE($3, phone),
           status       = COALESCE($4, status)
     WHERE id = $1 AND ${IS_PLATFORM_ADMIN}
    RETURNING ${COLUMNS}
  `
};

// The count that decides whether a suspension is allowed, taken FOR UPDATE so two
// concurrent suspensions cannot both read "two active" and both proceed. Without
// the lock this is a textbook race whose result is a platform nobody can sign in
// to -- and §9.1 says there is no recovery path above that.
const COUNT_ACTIVE_FOR_UPDATE = {
  sql: `SELECT id FROM users WHERE ${IS_PLATFORM_ADMIN} AND status = 'active' FOR UPDATE`
};

// A new password AND a cleared lockout, because the remedy that actually helps a
// locked-out operator is a working password (§6.2: "there is no separate unlock
// route"). sessions_valid_from is bumped so every existing session dies with the
// old password.
const RESET_PASSWORD = {
  sql: `
    UPDATE users
       SET password_hash        = $2,
           must_change_password = true,
           failed_login_count   = 0,
           locked_until         = NULL,
           sessions_valid_from  = now()
     WHERE id = $1 AND ${IS_PLATFORM_ADMIN}
    RETURNING ${COLUMNS}
  `
};

async function listPlatformAdmins(scope, options = {}) {
  const { status = null, email = null, limit = 50, cursor = null } = options;
  const { rows } = await dangerouslyQueryAcrossTenants(scope, LIST, [
    status,
    email,
    cursor === null ? null : cursor.email,
    cursor === null ? null : cursor.id,
    limit
  ]);
  return rows;
}

async function getPlatformAdmin(scope, userId) {
  const { rows } = await dangerouslyQueryAcrossTenants(scope, GET, [userId]);
  return rows.length === 0 ? null : rows[0];
}

async function createPlatformAdmin(scope, input) {
  if (typeof input.passwordHash !== "string" || !input.passwordHash.startsWith("scrypt$")) {
    throw new Error("createPlatformAdmin requires a PHC string from lib/password.js");
  }
  const { rows } = await dangerouslyQueryAcrossTenants(scope, INSERT, [
    input.email,
    input.displayName,
    input.phone ?? null,
    input.passwordHash,
    input.createdByUserId
  ]);
  return rows[0];
}

// Returns null for "no such platform admin", or the string "last_platform_admin"
// when the change would suspend the last active one. Two distinguishable refusals
// rather than a throw, because the route answers them with different statuses --
// 404 and 409 -- and a repository that threw would make the route parse a message.
async function updatePlatformAdmin(scope, userId, changes) {
  if (changes.status === "suspended") {
    const { rows } = await dangerouslyQueryAcrossTenants(scope, COUNT_ACTIVE_FOR_UPDATE, []);
    const active = rows.map((row) => row.id);
    // The subject counts only if they are currently active; suspending an already
    // suspended administrator is a no-op, not a lockout.
    if (active.length <= 1 && active.includes(userId)) return "last_platform_admin";
  }
  const { rows } = await dangerouslyQueryAcrossTenants(scope, UPDATE, [
    userId,
    changes.displayName ?? null,
    changes.phone ?? null,
    changes.status ?? null
  ]);
  return rows.length === 0 ? null : rows[0];
}

async function resetPlatformAdminPassword(scope, userId, passwordHash) {
  if (typeof passwordHash !== "string" || !passwordHash.startsWith("scrypt$")) {
    throw new Error("resetPlatformAdminPassword requires a PHC string from lib/password.js");
  }
  const { rows } = await dangerouslyQueryAcrossTenants(scope, RESET_PASSWORD, [userId, passwordHash]);
  return rows.length === 0 ? null : rows[0];
}

module.exports = {
  listPlatformAdmins,
  getPlatformAdmin,
  createPlatformAdmin,
  updatePlatformAdmin,
  resetPlatformAdminPassword
};
