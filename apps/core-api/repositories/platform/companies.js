"use strict";

// The tenant list, read and written by the only actor who is above all of them.
//
// Every function here takes a platform scope and runs through the seam, so the
// absence of company_id is a declared property of this file rather than an
// omission somebody has to notice in review.
//
// Rows are shaped in SQL, never in JavaScript: every non-snake_case column is
// aliased AS "camelCase" in the query text. There is no mapper layer anywhere in
// this codebase and adding one here would be the first.

const { dangerouslyQueryAcrossTenants } = require("./query");

// Both unique indexes 0003 created, mapped to the two codes the vocabulary gained
// with them. err.constraint is an internal lookup key and is never serialised --
// which is what keeps _key strings out of every response and lets the DDL be
// renamed without changing the API.
const CONFLICTS = Object.freeze({
  companies_slug_key: "company_slug_taken",
  companies_name_active_key: "company_name_taken"
});

// The console's Companies screen prints a shop count and a table count per row,
// and §6.1 of the console design is explicit that those figures are "summed from
// its shops, never typed". So they are summed HERE, in the statement that reads
// the company, rather than stored on it -- there is no second copy to drift.
//
// Two LEFT JOINs would multiply: three shops each with twelve tables would report
// thirty-six shops. Scalar subqueries keep the two counts independent, and at this
// cardinality that is also the faster plan.
// The CEO rides along for the same reason the counts do: the Companies screen prints
// them, and the alternative is the console selecting a scope per row just to read one
// name. It is the ONE person a platform admin may see inside a company -- they appoint
// them -- so this is the boundary being honoured rather than crossed.
//
// Both subqueries are ORDER BY created_at, id LIMIT 1 rather than bare: nothing stops a
// company holding two active company_admins during a handover, and an unordered LIMIT 1
// would let the name and the email come from different people.
// One subquery per column, all three ordered identically. The repetition is the
// point: a bare LIMIT 1 in each would let the id, the name and the address come from
// three different people the moment a handover puts two active CEOs in a company.
const CEO = (self) => ["id", "display_name", "email"]
  .map(
    (column, index) => `
  (SELECT u.${column} FROM users u
    WHERE u.company_id = ${self} AND u.role = 'company_admin' AND u.status = 'active'
    ORDER BY u.created_at, u.id LIMIT 1) AS "${["ceoId", "ceoName", "ceoEmail"][index]}"`
  )
  .join(",");

const SELECT_COLUMNS = `
  c.id,
  c.name,
  c.slug,
  c.status,
  c.created_at AS "createdAt",
  (SELECT count(*) FROM shops s WHERE s.company_id = c.id)::int AS "shopCount",
  (SELECT count(*) FROM shop_tables t WHERE t.company_id = c.id)::int AS "tableCount",
  ${CEO("c.id")}
`;

// ?status= active | suspended | all, defaulting to all (spec §6.2). Keyset
// pagination on (name, id): a stable ORDER BY that OFFSET could not give, and the
// id tiebreak is what stops a page boundary landing inside two companies that
// share a name.
const LIST = {
  sql: `
    SELECT ${SELECT_COLUMNS}
      FROM companies c
     WHERE ($1::text IS NULL OR c.status = $1)
       AND ($2::text IS NULL OR (c.name, c.id::text) > ($2, $3))
     ORDER BY c.name, c.id
     LIMIT $4
  `
};

const GET = { sql: `SELECT ${SELECT_COLUMNS} FROM companies c WHERE c.id = $1` };

const INSERT = {
  sql: `
    INSERT INTO companies (name, slug, created_by_user_id)
    VALUES ($1, $2, $3)
    RETURNING id, name, slug, status, created_at AS "createdAt",
              0::int AS "shopCount", 0::int AS "tableCount",
              -- A company one statement old has nobody in it yet. Spelling that out
              -- as NULL keeps the created document the same shape as every read of
              -- it, so the console has one row shape rather than two.
              NULL::uuid AS "ceoId", NULL::text AS "ceoName", NULL::text AS "ceoEmail"
  `,
  conflicts: CONFLICTS
};

// COALESCE so an absent key means "do not change" without the caller having to
// build the SET list. A PATCH body distinguishes absent from null (the route does
// that), so by the time a value reaches here, null means "leave it".
const UPDATE = {
  sql: `
    UPDATE companies
       SET name   = COALESCE($2, name),
           slug   = COALESCE($3, slug),
           status = COALESCE($4, status)
     WHERE id = $1
    RETURNING id, name, slug, status, created_at AS "createdAt",
              (SELECT count(*) FROM shops s WHERE s.company_id = companies.id)::int AS "shopCount",
              (SELECT count(*) FROM shop_tables t WHERE t.company_id = companies.id)::int AS "tableCount",
              ${CEO("companies.id")}
  `,
  conflicts: CONFLICTS
};

async function listCompanies(scope, options = {}) {
  const { status = null, limit = 50, cursor = null } = options;
  const { rows } = await dangerouslyQueryAcrossTenants(scope, LIST, [
    status,
    cursor === null ? null : cursor.name,
    cursor === null ? null : cursor.id,
    limit
  ]);
  return rows;
}

async function getCompany(scope, companyId) {
  const { rows } = await dangerouslyQueryAcrossTenants(scope, GET, [companyId]);
  return rows.length === 0 ? null : rows[0];
}

async function createCompany(scope, input) {
  const { rows } = await dangerouslyQueryAcrossTenants(scope, INSERT, [
    input.name,
    input.slug,
    input.createdByUserId
  ]);
  return rows[0];
}

// null for "no such company", so the route can answer 404 without a second read.
// A zero-row UPDATE and a missing row are the same thing here: there is no
// containment to distinguish "not yours" from "not there", because a platform
// admin owns all of them.
async function updateCompany(scope, companyId, changes) {
  const { rows } = await dangerouslyQueryAcrossTenants(scope, UPDATE, [
    companyId,
    changes.name ?? null,
    changes.slug ?? null,
    changes.status ?? null
  ]);
  return rows.length === 0 ? null : rows[0];
}

module.exports = { listCompanies, getCompany, createCompany, updateCompany };
