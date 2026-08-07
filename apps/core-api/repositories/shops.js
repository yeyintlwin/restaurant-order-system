"use strict";

// The shop record: a place inside one company.
//
// TENANT-scoped, unlike repositories/platform/*. shops carries company_id, so
// every statement here goes through the ordinary choke point and the helper binds
// the scope's company to $1. A platform admin reaches these by SELECTING a company
// first -- which is exactly what §5.4 means by "from that point they drive the
// ordinary tenant repositories under an ordinary tenant scope".
//
// So there is nothing special about this file, and that is the point: opening a
// branch moved to the platform owner in the CONSOLE, and the isolation guarantee
// underneath did not move with it.

const { tenantQuery } = require("../db");

const CONFLICTS = Object.freeze({
  shops_company_name_active_key: "shop_name_taken",
  shops_company_slug_key: "shop_slug_taken"
});

// run_by_owner is the third answer to "who manages this shop": no manager yet,
// the owner runs it, or a person does. The person lives in user_shops, so this
// column cannot be checked against them in SQL -- the invariant that a shop must
// not be BOTH owner-run and assigned belongs here, in setRunByOwner below.
const COLUMNS = `
  id,
  name,
  slug,
  address,
  time_zone AS "timeZone",
  business_day_rollover_hour AS "businessDayRolloverHour",
  currency,
  language,
  phone,
  opening_hours AS "openingHours",
  receipt_footer AS "receiptFooter",
  run_by_owner AS "runByOwner",
  status,
  created_at AS "createdAt",
  -- Counted, never stored, for the same reason the company's counts are: the tables
  -- ARE the count, and a column beside them is a second copy that is right until
  -- somebody adds a table without updating it.
  --
  -- Keyed on shop_id ALONE, and that is not an omission. A shop id belongs to exactly
  -- one company, and the row being counted for has already been through the tenant
  -- predicate, so repeating the tenant column here would add nothing -- while naming
  -- it inside an INSERT's RETURNING is refused outright. The helper reads the whole
  -- statement as text, comments included, and cannot tell a subquery from a caller
  -- trying to pick their own tenant. That is why this paragraph does not spell the
  -- column out either: it would fail the same check, from a comment.
  (SELECT count(*) FROM shop_tables t WHERE t.shop_id = shops.id)::int AS "tableCount",
  -- WHO RUNS IT AND HOW MANY WORK HERE, as an id and a number.
  --
  -- The console used to derive both by scanning the user list it had already
  -- fetched, and that list stops at a hundred people. Past that, a manager whose row
  -- fell off the end made their shop read "No manager yet" -- which raises the amber
  -- "until you appoint one, that shop is yours to run" banner and hands the CEO the
  -- day-to-day fields for a shop somebody else is running. A derivation that depends
  -- on which hundred rows came back is not a derivation.
  --
  -- An ID and a COUNT, never a name or an address. A platform admin acting inside a
  -- company reads this row, and §6 of the console design is built on their never
  -- seeing a person in it. A uuid names nobody; the console looks the name up in the
  -- user list it is allowed to hold.
  (SELECT u.id FROM users u
     JOIN user_shops us ON us.user_id = u.id
    WHERE us.shop_id = shops.id AND u.role = 'shop_manager' AND u.status = 'active'
    ORDER BY u.created_at, u.id LIMIT 1) AS "managerUserId",
  -- Active only, because the column is answering "how many people work here" and a
  -- suspended account cannot take an order.
  (SELECT count(*) FROM users u
     JOIN user_shops us ON us.user_id = u.id
    WHERE us.shop_id = shops.id AND u.role = 'staff' AND u.status = 'active')::int AS "staffCount"
`;

// ?status is honoured for an administering scope only. A shop_manager or staff
// member is driven by the ACTIVE-only shopIds their scope carries, so
// ?status=suspended returns [] for them rather than 403 -- the difference between
// "you may not ask" and "there is nothing there", and only one of those is true.
// EVERY descriptor here declares shopScoped:false, and that is not a shortcut.
//
// The helper's shop predicate is literally /shop_id = ANY($2)/ -- it is built for
// the CHILDREN of a shop, where the foreign key is called shop_id. On the shops
// table itself that column is `id`, so the helper would refuse the SQL. This is the
// one table in the schema where "the shop id" is the primary key.
//
// So containment is written out here and the id set is bound as an ordinary
// caller parameter. The company predicate is still the helper's, which is the half
// that matters: no statement in this file can read another company's shops however
// the containment below is edited.
const LIST_ADMINISTERED = {
  sql: `
    SELECT ${COLUMNS} FROM shops
     WHERE company_id = $1
       AND ($2::text IS NULL OR status = $2)
     ORDER BY name, id
     LIMIT $3
  `,
  shopScoped: false
};

const LIST_ASSIGNED = {
  sql: `
    SELECT ${COLUMNS} FROM shops
     WHERE company_id = $1
       AND id = ANY($2::uuid[])
     ORDER BY name, id
     LIMIT $3
  `,
  shopScoped: false
};

// Resolved against administeredShopIds for an administering scope (status
// independent, so a suspended shop stays reachable by the people who can
// un-suspend it) and against the active-only shopIds for everybody else.
const GET_SCOPED = {
  sql: `SELECT ${COLUMNS} FROM shops WHERE company_id = $1 AND id = $2 AND id = ANY($3::uuid[])`,
  shopScoped: false
};

// An administering scope reads any shop in its own company, including one it has
// no assignment row for -- which is every shop, for a company_admin or a platform
// admin acting inside the company.
const GET_ADMINISTERED = {
  sql: `SELECT ${COLUMNS} FROM shops WHERE company_id = $1 AND id = $2`,
  shopScoped: false
};

// company_id is NOT named here: the helper injects the column and the scope's
// value, and naming it would be refused. That is what makes "a shop cannot be
// created in another company" a property of the seam rather than of this SQL.
const INSERT = {
  sql: `
    INSERT INTO shops (name, slug, address, time_zone, business_day_rollover_hour,
                       currency, language, created_by_user_id)
    VALUES ($2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING ${COLUMNS}
  `,
  shopScoped: false,
  conflicts: CONFLICTS
};

// Every field the PLATFORM owner owns. The manager slot is not here and never
// will be: it is a user_shops row, a different resource with a different owner.
const UPDATE = {
  sql: `
    UPDATE shops
       SET name                       = COALESCE($3, name),
           slug                       = COALESCE($4, slug),
           address                    = COALESCE($5, address),
           time_zone                  = COALESCE($6, time_zone),
           business_day_rollover_hour = COALESCE($7, business_day_rollover_hour),
           currency                   = COALESCE($8, currency),
           language                   = COALESCE($9, language),
           status                     = COALESCE($10, status)
     WHERE company_id = $1 AND id = $2
    RETURNING ${COLUMNS}
  `,
  shopScoped: false,
  conflicts: CONFLICTS
};

// The day-to-day three, owned by whoever RUNS the shop rather than by whoever
// opened it. Separate statement, because the two sets of fields have two
// different owners and merging them would mean one route deciding which half of
// its body the caller was allowed to send.
const UPDATE_DAY_TO_DAY = {
  sql: `
    UPDATE shops
       SET phone          = CASE WHEN $3::boolean THEN $4 ELSE phone END,
           opening_hours  = CASE WHEN $5::boolean THEN $6 ELSE opening_hours END,
           receipt_footer = CASE WHEN $7::boolean THEN $8 ELSE receipt_footer END
     WHERE company_id = $1 AND id = $2
    RETURNING ${COLUMNS}
  `,
  shopScoped: false
};

// §4A.2: "the number is not a statistic. Entering 12 creates Table 1 through
// Table 12, each a real record that can carry its own QR code."
//
// ONE ROW per statement, in a loop inside the caller's transaction, because the
// tenant helper accepts INSERT INTO <table> (<columns>) VALUES (...) and nothing
// else -- an INSERT ... SELECT generate_series is refused. That refusal is the
// helper doing its job: the shape it accepts is the shape it can inject company_id
// into and prove it did. Twelve statements in one transaction is the price, and
// spec §6.2 already says "twelve tables is twelve POSTs" about the tables route,
// so nobody is surprised by the arithmetic.
//
// The label CHECK is ^[A-Z0-9][A-Z0-9 -]{0,7}$, so a plain number is legal, and
// 200 is the most the console offers.
const INSERT_TABLE = {
  sql: `INSERT INTO shop_tables (shop_id, label, created_by_user_id) VALUES ($2, $3, $4)`,
  shopScoped: false
};

// An administering scope carries administeredShopIds; a manager or staff member
// does not. That absence is the discriminator, and it is checked with
// `=== undefined` rather than truthiness because [] is a real, meaningful value:
// a manager with no assignments sees nothing, and must never see everything.
function administers(scope) {
  return scope.administeredShopIds !== undefined;
}

async function listShops(scope, options = {}) {
  const { status = null, limit = 100 } = options;
  const { rows } = administers(scope)
    ? await tenantQuery(scope, LIST_ADMINISTERED, [status, limit])
    : await tenantQuery(scope, LIST_ASSIGNED, [scope.shopIds, limit]);
  return rows;
}

async function getShop(scope, shopId) {
  const { rows } = administers(scope)
    ? await tenantQuery(scope, GET_ADMINISTERED, [shopId])
    : await tenantQuery(scope, GET_SCOPED, [shopId, scope.shopIds]);
  return rows.length === 0 ? null : rows[0];
}

// Creates the shop AND its tables. The caller is inside withTenantScope, so both
// land in one transaction: a branch with a table count that created no tables
// would be a lie told by the number the operator typed.
async function createShop(scope, input) {
  const { rows } = await tenantQuery(scope, INSERT, [
    input.name,
    input.slug,
    input.address ?? null,
    input.timeZone,
    input.businessDayRolloverHour,
    input.currency,
    input.language,
    input.createdByUserId
  ]);
  const shop = rows[0];
  for (let number = 1; number <= input.tableCount; number += 1) {
    await tenantQuery(scope, INSERT_TABLE, [shop.id, String(number), input.createdByUserId]);
  }
  // The INSERT's RETURNING ran BEFORE the tables existed, so its count is zero and
  // would tell the caller their twelve tables were not made. Corrected from the
  // number that made them rather than by a second read: they are in this
  // transaction, so nothing else could have changed it.
  // Same reason as tableCount: the RETURNING ran before the tables existed. A brand
  // new branch has nobody in it, and those two zeros are facts rather than defaults.
  return { ...shop, tableCount: input.tableCount, managerUserId: null, staffCount: 0 };
}

async function updateShop(scope, shopId, changes) {
  const { rows } = await tenantQuery(scope, UPDATE, [
    shopId,
    changes.name ?? null,
    changes.slug ?? null,
    changes.address ?? null,
    changes.timeZone ?? null,
    changes.businessDayRolloverHour ?? null,
    changes.currency ?? null,
    changes.language ?? null,
    changes.status ?? null
  ]);
  return rows.length === 0 ? null : rows[0];
}

// A present-flag beside each value, because null carries two meanings here and one
// argument cannot hold both: absent means "leave it", and present-null means "erase
// it". COALESCE could only express the first, so nothing could ever be cleared.
async function updateShopDayToDay(scope, shopId, changes) {
  const { rows } = await tenantQuery(scope, UPDATE_DAY_TO_DAY, [
    shopId,
    changes.setPhone === true,
    changes.phone ?? null,
    changes.setOpeningHours === true,
    changes.openingHours ?? null,
    changes.setReceiptFooter === true,
    changes.receiptFooter ?? null
  ]);
  return rows.length === 0 ? null : rows[0];
}

// ---------------------------------------------------------------------------
// The manager slot
// ---------------------------------------------------------------------------
// A shop's manager is NOT a column. It is the user_shops row whose user carries
// role 'shop_manager' -- which is what lets one person hold two shops (two rows)
// without anything being stored twice, and what makes "which shops does this
// person run" a query rather than a field that can go stale.
//
// "One manager per shop" is therefore not a database constraint and cannot be:
// user_shops has no role column, and users.role is a property of the person, not
// of the assignment. It is an invariant of setShopManager below -- the old
// assignment is removed in the same transaction as the new one, so the shop is
// never left holding two.

const FIND_MANAGER = {
  sql: `
    SELECT u.id, u.display_name AS "displayName", u.email, u.status
      FROM user_shops us
      JOIN users u ON u.id = us.user_id AND u.company_id = us.company_id
     WHERE us.company_id = $1 AND us.shop_id = $2 AND u.role = 'shop_manager'
  `,
  shopScoped: false
};

// The candidate must already be a member of this company. Reading them first is
// what turns "no such user" and "somebody else's user" into one 404 instead of a
// foreign-key violation surfacing as a 500.
const FIND_MEMBER = {
  sql: `SELECT id, display_name AS "displayName", role, status FROM users WHERE company_id = $1 AND id = $2`,
  shopScoped: false
};

const UNASSIGN = {
  sql: `DELETE FROM user_shops WHERE company_id = $1 AND shop_id = $2 AND user_id = $3`,
  shopScoped: false
};

// company_id is injected by the helper, so it is absent here on purpose.
// ON CONFLICT DO NOTHING, and it is the ordinary case rather than a defensive
// flourish. The person a CEO promotes to manager is usually the one already working
// in that shop -- they are chosen BECAUSE they are there -- so the assignment row
// exists before the promotion does. Without this, appointing your own best waiter
// answers 500 and appointing a stranger works, which is precisely backwards.
const ASSIGN = {
  sql: `INSERT INTO user_shops (user_id, shop_id) VALUES ($2, $3) ON CONFLICT DO NOTHING`,
  shopScoped: false
};

const SET_ROLE = {
  sql: `UPDATE users SET role = $3 WHERE company_id = $1 AND id = $2 RETURNING id`,
  shopScoped: false
};

// sessions_valid_from is bumped with the suspension, or the person keeps working
// on the session they already hold -- which is the whole point of suspending them.
const SUSPEND = {
  sql: `
    UPDATE users SET status = 'suspended', sessions_valid_from = now()
     WHERE company_id = $1 AND id = $2 RETURNING id
  `,
  shopScoped: false
};

const SET_RUN_BY_OWNER = {
  sql: `UPDATE shops SET run_by_owner = $3 WHERE company_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
  shopScoped: false
};

async function getShopManager(scope, shopId) {
  const { rows } = await tenantQuery(scope, FIND_MANAGER, [shopId]);
  return rows.length === 0 ? null : rows[0];
}

async function findCompanyMember(scope, userId) {
  const { rows } = await tenantQuery(scope, FIND_MEMBER, [userId]);
  return rows.length === 0 ? null : rows[0];
}

/* The one write that changes who runs a shop, and it is one write on purpose.
 *
 * §3.1 of the console design: "Split into 'demote the old one' then 'promote the
 * new one', the shop spends the gap with two managers or none." Everything below
 * happens inside the caller's transaction, so there is no gap to spend.
 *
 * `outgoing` decides what happens to the person being replaced -- "staff" keeps
 * them at the shop, "suspend" takes their access away. It is ignored when nobody
 * is being replaced.
 *
 * Returns the shop row, so the caller never has to re-read it.
 */
async function setShopManager(scope, shopId, { managerUserId, runByOwner, outgoing }) {
  const current = await getShopManager(scope, shopId);

  if (current !== null && current.id !== managerUserId) {
    await tenantQuery(scope, UNASSIGN, [shopId, current.id]);
    if (outgoing === "suspend") {
      await tenantQuery(scope, SUSPEND, [current.id]);
    } else {
      // Demoted rather than removed: they still work here, and every order they
      // ever took still points at this account.
      await tenantQuery(scope, SET_ROLE, [current.id, "staff"]);
    }
  }

  if (managerUserId !== null && (current === null || current.id !== managerUserId)) {
    await tenantQuery(scope, SET_ROLE, [managerUserId, "shop_manager"]);
    await tenantQuery(scope, ASSIGN, [managerUserId, shopId]);
  }

  // A shop is owner-run or it has a manager, never both. The migration could not
  // express that -- the manager lives in another table -- so it is enforced here,
  // where both halves are visible in one transaction.
  const { rows } = await tenantQuery(scope, SET_RUN_BY_OWNER, [
    shopId,
    managerUserId === null ? runByOwner === true : false
  ]);
  return rows.length === 0 ? null : rows[0];
}

module.exports = {
  listShops,
  getShop,
  createShop,
  updateShop,
  updateShopDayToDay,
  getShopManager,
  findCompanyMember,
  setShopManager
};
