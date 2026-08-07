"use strict";

// The platform owner's contact directory: every company's CEO, and every shop's
// manager, across all tenants.
//
// It lives here because it is the one shape that legitimately has no company_id in
// it -- the whole point is that it spans companies -- and repositories/platform/ is
// the only directory allowed to say so. Everything below runs through the seam, so
// the absence of a tenant predicate is a declared property of this file rather than
// an omission somebody has to notice.
//
// WHY THESE TWO ROLES AND NO OTHERS. The platform owner fits the branches out:
// screens on the tables, printed codes, a terminal that stops pairing. When
// something is wrong they ring the person standing in the shop, or the person who
// answers for the company. Staff are neither, and no statement here returns one --
// §2.1 of the console design still holds for everybody except these two.

const { dangerouslyQueryAcrossTenants } = require("./query");

// ONE statement, not two, because the console draws one list and a UNION keeps the
// ordering in the database rather than in a merge on the client. `where` is what
// places the person: a CEO is placed by their company, a manager by their shop.
//
// Active only, in every sense the word has here -- a suspended person cannot answer
// and a suspended company has nobody to answer for. This list is "who can I ring",
// and somebody who cannot sign in is not on it.
const LIST = {
  sql: `
    SELECT u.id,
           u.display_name AS "displayName",
           'company_admin' AS role,
           u.phone,
           u.email,
           c.name AS "companyName",
           NULL::text AS "shopName"
      FROM users u
      JOIN companies c ON c.id = u.company_id
     WHERE u.role = 'company_admin'
       AND u.status = 'active'
       AND c.status = 'active'

    UNION ALL

    SELECT u.id,
           u.display_name AS "displayName",
           'shop_manager' AS role,
           u.phone,
           u.email,
           c.name AS "companyName",
           s.name AS "shopName"
      FROM users u
      JOIN user_shops us ON us.user_id = u.id
      JOIN shops s ON s.id = us.shop_id
      JOIN companies c ON c.id = s.company_id
     WHERE u.role = 'shop_manager'
       AND u.status = 'active'
       AND s.status = 'active'
       AND c.status = 'active'

     ORDER BY "companyName", role, "shopName" NULLS FIRST, "displayName"
     LIMIT $1
  `
};

// A manager who runs two shops appears twice, once per shop, and that is the honest
// rendering: the list is of PLACES that need somebody, and the same person answers
// for both. Collapsing them into one row would hide that Insein has cover.
async function listContactsAcrossTenants(scope, options = {}) {
  const { limit = 500 } = options;
  const { rows } = await dangerouslyQueryAcrossTenants(scope, LIST, [limit]);
  return rows;
}

module.exports = { listContactsAcrossTenants };
