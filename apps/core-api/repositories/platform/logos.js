"use strict";

// Attaching a mark to a company or to a branch, and taking the old one off the disk
// when nothing points at it any more.
//
// IT LIVES UNDER repositories/platform/ FOR ONE REASON, and it is the same reason
// twice. A logo key is the SHA-256 of the file, so the same picture uploaded for two
// different companies is ONE file with ONE name -- which means "is this file still
// needed" is a question about every company and every shop on the platform, not about
// one tenant's rows. A tenant-scoped statement cannot ask it, and a tenant-scoped
// statement that guessed would delete a file another company is still showing.
//
// The write is here for the matching reason: the platform owner sets a branch's logo
// from the Companies screen, where they are above every company and inside none, so
// there is no company_id to scope the UPDATE by. `shops` is on the seam's writable
// list for this file and this column alone -- everything else about a shop still goes
// through the tenant choke point, and db/index.js says so beside the list.

const { dangerouslyQueryAcrossTenants } = require("./query");

// One column, one id. The narrowing the table-level guard cannot express.
const SET_COMPANY_LOGO = {
  sql: `UPDATE companies SET logo_key = $2 WHERE id = $1 RETURNING logo_key`
};

const SET_SHOP_LOGO = {
  sql: `UPDATE shops SET logo_key = $2 WHERE id = $1 RETURNING logo_key`
};

// Read back the key a record is wearing BEFORE it is replaced, so the caller has
// something to try to delete afterwards. Returns undefined for a row that is not
// there, which the route turns into a 404 without a second read.
const GET_COMPANY_LOGO = { sql: `SELECT logo_key AS "logoKey" FROM companies WHERE id = $1` };
const GET_SHOP_LOGO = { sql: `SELECT logo_key AS "logoKey", company_id AS "companyId" FROM shops WHERE id = $1` };

// THE WHOLE POINT OF THE FILE. EXISTS rather than a count: the question is "is there
// at least one", the answer stops at the first row, and a count would invite somebody
// to store it. LIMIT 1 inside each branch for the same reason.
const IS_REFERENCED = {
  sql: `
    SELECT EXISTS (SELECT 1 FROM companies WHERE logo_key = $1 LIMIT 1)
        OR EXISTS (SELECT 1 FROM shops     WHERE logo_key = $1 LIMIT 1) AS "used"
  `
};

async function getCompanyLogo(scope, companyId) {
  const { rows } = await dangerouslyQueryAcrossTenants(scope, GET_COMPANY_LOGO, [companyId]);
  return rows.length === 0 ? null : rows[0];
}

async function getShopLogo(scope, shopId) {
  const { rows } = await dangerouslyQueryAcrossTenants(scope, GET_SHOP_LOGO, [shopId]);
  return rows.length === 0 ? null : rows[0];
}

async function setCompanyLogo(scope, companyId, key) {
  const { rows } = await dangerouslyQueryAcrossTenants(scope, SET_COMPANY_LOGO, [companyId, key]);
  return rows.length === 0 ? null : rows[0].logoKey;
}

async function setShopLogo(scope, shopId, key) {
  const { rows } = await dangerouslyQueryAcrossTenants(scope, SET_SHOP_LOGO, [shopId, key]);
  return rows.length === 0 ? null : rows[0].logoKey;
}

// Asked AFTER the new key is committed, never before. The order is what makes this
// safe: if the answer is "nobody", nobody can start pointing at it either, because
// the only way to acquire a key is to upload bytes that hash to it -- and doing that
// writes the file back before any row could name it.
async function isReferenced(scope, key) {
  const { rows } = await dangerouslyQueryAcrossTenants(scope, IS_REFERENCED, [key]);
  return rows[0].used === true;
}

module.exports = {
  getCompanyLogo,
  getShopLogo,
  setCompanyLogo,
  setShopLogo,
  isReferenced
};
