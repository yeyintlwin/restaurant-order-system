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
  created_at AS "createdAt"
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
       SET phone          = COALESCE($3, phone),
           opening_hours  = COALESCE($4, opening_hours),
           receipt_footer = COALESCE($5, receipt_footer)
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
  return shop;
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

async function updateShopDayToDay(scope, shopId, changes) {
  const { rows } = await tenantQuery(scope, UPDATE_DAY_TO_DAY, [
    shopId,
    changes.phone ?? null,
    changes.openingHours ?? null,
    changes.receiptFooter ?? null
  ]);
  return rows.length === 0 ? null : rows[0];
}

module.exports = { listShops, getShop, createShop, updateShop, updateShopDayToDay };
