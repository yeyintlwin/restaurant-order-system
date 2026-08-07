"use strict";

// The people inside one company. TENANT-scoped, so every statement goes through
// the ordinary choke point and cannot reach another company's rows.
//
// NOT repositories/auth/users.js. That one is pre-tenant -- it answers "who is
// signing in" before any company exists, which is why it is on C4's allowlist.
// This one only ever runs for somebody who is already inside a company, and holds
// no connection of its own.

const { tenantQuery } = require("../db");

const CONFLICTS = Object.freeze({ users_email_key: "email_unavailable" });

// shopIds is aggregated in SQL rather than assembled in JavaScript, and the
// COALESCE is the whole reason: array_agg over zero rows returns NULL, and a NULL
// arriving where a caller expects a list is how "assigned to nothing" becomes
// "assigned to everything" one careless line later.
const COLUMNS = `
  u.id,
  u.email,
  u.display_name AS "displayName",
  u.phone,
  u.role,
  u.status,
  u.language,
  u.must_change_password AS "mustChangePassword",
  u.last_login_at AS "lastLoginAt",
  u.created_at AS "createdAt",
  COALESCE(
    (SELECT array_agg(us.shop_id ORDER BY us.shop_id) FROM user_shops us WHERE us.user_id = u.id),
    '{}'
  ) AS "shopIds"
`;

// Containment for a shop_manager is an EXISTS semi-join and never an INNER JOIN.
// Spec §6.2 says why in one line: a JOIN duplicates a user assigned to two of the
// caller's shops and then silently truncates the page at LIMIT. It also pins
// u.role = 'staff', because a manager administers staff and not their peers.
const LIST_ADMINISTERED = {
  sql: `
    SELECT ${COLUMNS} FROM users u
     WHERE u.company_id = $1
       AND ($2::text IS NULL OR u.role = $2)
       AND ($3::text IS NULL OR u.status = $3)
     ORDER BY u.display_name, u.id
     LIMIT $4
  `,
  shopScoped: false
};

const LIST_CONTAINED = {
  sql: `
    SELECT ${COLUMNS} FROM users u
     WHERE u.company_id = $1
       AND u.role = 'staff'
       AND EXISTS (SELECT 1 FROM user_shops us WHERE us.user_id = u.id AND us.shop_id = ANY($2::uuid[]))
       AND ($3::text IS NULL OR u.status = $3)
     ORDER BY u.display_name, u.id
     LIMIT $4
  `,
  shopScoped: false
};

const GET_ADMINISTERED = {
  sql: `SELECT ${COLUMNS} FROM users u WHERE u.company_id = $1 AND u.id = $2`,
  shopScoped: false
};

const GET_CONTAINED = {
  sql: `
    SELECT ${COLUMNS} FROM users u
     WHERE u.company_id = $1 AND u.id = $2 AND u.role = 'staff'
       AND EXISTS (SELECT 1 FROM user_shops us WHERE us.user_id = u.id AND us.shop_id = ANY($3::uuid[]))
  `,
  shopScoped: false
};

// YOURSELF. Reading your own record is not administration, and containment is the
// wrong question to ask about it: GET_CONTAINED pins u.role = 'staff' -- correctly,
// because a manager administers staff and not their peers -- and a manager is not
// staff, so a manager asking for their own row got the same 404 as one asking for a
// stranger's. Account settings could not be drawn at all.
//
// Still inside the tenant: company_id is the helper's, so this reads one row of one
// company and the id is the caller's own, taken from the scope rather than the path.
const GET_SELF = {
  sql: `SELECT ${COLUMNS} FROM users u WHERE u.company_id = $1 AND u.id = $2`,
  shopScoped: false
};

// company_id is injected by the helper. role arrives from the route, which has
// already proved it is strictly below the caller's.
const INSERT = {
  sql: `
    INSERT INTO users (role, email, display_name, phone, language, password_hash,
                       must_change_password, created_by_user_id)
    VALUES ($2, lower(btrim($3)), $4, $5, $6, $7, true, $8)
    RETURNING id
  `,
  shopScoped: false,
  conflicts: CONFLICTS
};

const ASSIGN = {
  sql: `INSERT INTO user_shops (user_id, shop_id) VALUES ($2, $3)`,
  shopScoped: false
};

const UNASSIGN_ALL = {
  sql: `DELETE FROM user_shops WHERE company_id = $1 AND user_id = $2`,
  shopScoped: false
};

// email is absent on purpose: it is the sign-in name, and changing it is a
// different, separately audited operation. So is the password.
const UPDATE = {
  sql: `
    UPDATE users
       SET display_name = COALESCE($3, display_name),
           phone        = COALESCE($4, phone),
           role         = COALESCE($5, role),
           status       = COALESCE($6, status),
           language     = CASE WHEN $7::boolean THEN $8 ELSE language END,
           sessions_valid_from = CASE WHEN $6 = 'suspended' THEN now() ELSE sessions_valid_from END
     WHERE company_id = $1 AND id = $2
    RETURNING id
  `,
  shopScoped: false
};

const RESET_PASSWORD = {
  sql: `
    UPDATE users
       SET password_hash        = $3,
           must_change_password = true,
           failed_login_count   = 0,
           locked_until         = NULL,
           sessions_valid_from  = now()
     WHERE company_id = $1 AND id = $2
    RETURNING id
  `,
  shopScoped: false
};

function administers(scope) {
  return scope.administeredShopIds !== undefined;
}

async function listUsers(scope, options = {}) {
  const { role = null, status = null, limit = 100 } = options;
  const { rows } = administers(scope)
    ? await tenantQuery(scope, LIST_ADMINISTERED, [role, status, limit])
    : await tenantQuery(scope, LIST_CONTAINED, [scope.shopIds, status, limit]);
  return rows;
}

// ---------------------------------------------------------------------------
// The contact directory
// ---------------------------------------------------------------------------
//
// A DIFFERENT QUESTION FROM listUsers, and the difference is the point. listUsers
// answers "who may I administer" -- it is the Staff screen, and it is bounded by the
// lattice. This answers "who may I ring", which reaches UPWARDS as well: a manager
// needs their CEO's number and cannot administer them.
//
// So the two must not share a statement. Widening containment to cover this would
// hand a manager an edit button on their own CEO.
//
// Every row is a contact card: name, role, number, and the shops that place them.
const CONTACT_COLUMNS = `
  u.id,
  u.display_name AS "displayName",
  u.role,
  u.phone,
  u.email,
  COALESCE(
    (SELECT array_agg(s.name ORDER BY s.name)
       FROM user_shops us JOIN shops s ON s.id = us.shop_id
      WHERE us.user_id = u.id),
    '{}'
  ) AS "shopNames"
`;

// A CEO reaches everybody in their company. They answer for all of them, and the
// Staff screen already lists the same people -- this adds the numbers, not the reach.
const CONTACTS_FOR_COMPANY_ADMIN = {
  sql: `
    SELECT ${CONTACT_COLUMNS} FROM users u
     WHERE u.company_id = $1
       AND u.status = 'active'
       AND u.id <> $2
     ORDER BY u.role, u.display_name, u.id
     LIMIT $3
  `,
  shopScoped: false
};

// A manager reaches their CEO -- upwards, which containment does not do -- and the
// staff of the shops they run. Not other managers: §2's table says so, and a manager
// at another branch is somebody the CEO coordinates.
const CONTACTS_FOR_MANAGER = {
  sql: `
    SELECT ${CONTACT_COLUMNS} FROM users u
     WHERE u.company_id = $1
       AND u.status = 'active'
       AND u.id <> $3
       AND (
         u.role = 'company_admin'
         OR (u.role = 'staff'
             AND EXISTS (SELECT 1 FROM user_shops us
                          WHERE us.user_id = u.id AND us.shop_id = ANY($2::uuid[])))
       )
     ORDER BY u.role, u.display_name, u.id
     LIMIT $4
  `,
  shopScoped: false
};

// A member of staff reaches the manager of their shop, and nobody else in the
// company. Their CEO is two levels up and is not who they call about a shift.
const CONTACTS_FOR_STAFF = {
  sql: `
    SELECT ${CONTACT_COLUMNS} FROM users u
     WHERE u.company_id = $1
       AND u.status = 'active'
       AND u.id <> $3
       AND u.role = 'shop_manager'
       AND EXISTS (SELECT 1 FROM user_shops us
                    WHERE us.user_id = u.id AND us.shop_id = ANY($2::uuid[]))
     ORDER BY u.display_name, u.id
     LIMIT $4
  `,
  shopScoped: false
};

// Keyed on the scope's own role rather than on a caller-supplied argument: which
// list you get is not a parameter of the request.
async function listContacts(scope, options = {}) {
  const { limit = 200 } = options;
  if (scope.role === "company_admin" || scope.role === "platform_admin") {
    const { rows } = await tenantQuery(scope, CONTACTS_FOR_COMPANY_ADMIN, [scope.userId, limit]);
    return rows;
  }
  if (scope.role === "shop_manager") {
    const { rows } = await tenantQuery(scope, CONTACTS_FOR_MANAGER, [
      scope.shopIds, scope.userId, limit
    ]);
    return rows;
  }
  const { rows } = await tenantQuery(scope, CONTACTS_FOR_STAFF, [
    scope.shopIds, scope.userId, limit
  ]);
  return rows;
}

async function getUser(scope, userId) {
  // Yourself first, and before either containment rule. Everybody can read their own
  // record whatever their role is -- it is what Account settings draws -- and neither
  // rule below would let a manager or a member of staff do it.
  if (userId === scope.userId) {
    const { rows } = await tenantQuery(scope, GET_SELF, [userId]);
    return rows.length === 0 ? null : rows[0];
  }
  const { rows } = administers(scope)
    ? await tenantQuery(scope, GET_ADMINISTERED, [userId])
    : await tenantQuery(scope, GET_CONTAINED, [userId, scope.shopIds]);
  return rows.length === 0 ? null : rows[0];
}

// Creates the row AND its assignments, inside the caller's transaction. A staff
// member with no assignment reaches nothing and is invisible to every
// shop_manager -- so a half-written create is a person nobody can find or fix.
async function createUser(scope, input) {
  const { rows } = await tenantQuery(scope, INSERT, [
    input.role,
    input.email,
    input.displayName,
    input.phone ?? null,
    input.language ?? null,
    input.passwordHash,
    input.createdByUserId
  ]);
  const id = rows[0].id;
  for (const shopId of input.shopIds || []) {
    await tenantQuery(scope, ASSIGN, [id, shopId]);
  }
  return getUser(scope, id);
}

// `language` is passed as a PAIR -- a present flag and a value -- because null is
// a meaningful language ("follow my shop") and COALESCE cannot tell it from
// "absent". Every other field can, so every other field uses COALESCE.
async function updateUser(scope, userId, changes) {
  const { rows } = await tenantQuery(scope, UPDATE, [
    userId,
    changes.displayName ?? null,
    changes.phone ?? null,
    changes.role ?? null,
    changes.status ?? null,
    Object.prototype.hasOwnProperty.call(changes, "language"),
    changes.language ?? null
  ]);
  if (rows.length === 0) return null;
  if (Array.isArray(changes.shopIds)) {
    // Full-set replacement, which is why §6.2 keeps it companyAdmin-only: combined
    // with a shop_manager's partial visibility it is a silent-data-loss shape.
    await tenantQuery(scope, UNASSIGN_ALL, [userId]);
    for (const shopId of changes.shopIds) {
      await tenantQuery(scope, ASSIGN, [userId, shopId]);
    }
  }
  return getUser(scope, userId);
}

async function resetUserPassword(scope, userId, passwordHash) {
  if (typeof passwordHash !== "string" || !passwordHash.startsWith("scrypt$")) {
    throw new Error("resetUserPassword requires a PHC string from lib/password.js");
  }
  const { rows } = await tenantQuery(scope, RESET_PASSWORD, [userId, passwordHash]);
  return rows.length === 0 ? null : getUser(scope, userId);
}

module.exports = {
  listContacts, listUsers, getUser, createUser, updateUser, resetUserPassword };
