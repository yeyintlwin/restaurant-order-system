"use strict";

// GET /api/admin/contacts -- who you can ring, and how.
//
// A DIFFERENT QUESTION FROM /api/admin/users, and the difference is the reason this
// is its own route. That one answers "who may I administer": it is bounded by the
// rank lattice, and everything it returns is something you can edit. This one
// answers "who may I reach", which goes UPWARDS as well -- a manager needs their
// CEO's number and a CEO needs the platform's, and neither can administer the other.
//
// Sharing a route would have meant widening containment to cover the upward half,
// which is how a manager ends up with an edit button on their own CEO.
//
// The reach, from §2.5 of the console design:
//
//   Platform owner   every company's CEO, every shop's manager
//   CEO              the platform operators, their managers, their staff
//   Manager          the platform operators, their CEO, their own shops' staff
//   Staff            the manager of their shop, and NOBODY else -- not the platform,
//                    not their CEO
//
// It is deliberately not symmetric. Staff reach one person because one person is
// who they call about a shift; the platform owner reaches no staff at all, because
// nothing about their job involves one.

const { route } = require("../router");
const { sendJson } = require("../respond");
const { withTenantScope, withPlatformScope } = require("../../db");

const ROLE_LABEL = Object.freeze({
  platform_admin: "Platform",
  company_admin: "Owner",
  shop_manager: "Manager",
  staff: "Staff"
});

// One shape for every kind of contact, whichever of the three reads produced it, so
// the console draws one list rather than three. `where` is what places the person --
// a branch name, a company name, or nothing at all for somebody who is above both.
function card({ id, displayName, role, phone, email, where }) {
  return {
    id,
    displayName,
    role,
    // The label rather than the raw role, because the console is not the only thing
    // that will read this and "shop_manager" is not a word anybody says.
    roleLabel: ROLE_LABEL[role] || role,
    phone: phone ?? null,
    email: email ?? null,
    where: where || null
  };
}

// The platform operators, read by everybody below them. A platform admin does not
// get this list: they ARE it, and their own peers live on the Platform admins screen.
async function platformContacts(deps) {
  const rows = await deps.users.listPlatformContacts();
  return rows.map((row) =>
    card({ ...row, role: "platform_admin", where: null })
  );
}

route(
  "GET",
  "/api/admin/contacts",
  // BOTH aliases, and that is the whole point of the screen: everybody has one.
  // `platform` admits the unscoped platform admin, `anyUser` admits everyone else
  // down to a member of staff, whose console is a dashboard, their account and this.
  { auth: "user", roles: ["platform", "anyUser"], sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const scope = req.core.scope;

    if (scope.kind === "platform") {
      const rows = await withPlatformScope(scope, () =>
        deps.platformContacts.listContactsAcrossTenants(scope)
      );
      sendJson(res, 200, {
        contacts: rows.map((row) =>
          card({
            ...row,
            // A CEO is placed by their company, a manager by their branch -- and the
            // company name goes on the manager too, because two chains can both have
            // a Bogyoke and the platform owner is looking at all of them at once.
            where: row.shopName ? `${row.companyName} · ${row.shopName}` : row.companyName
          })
        )
      });
      return;
    }

    // A CEO and a manager get two reads: the operators above the whole platform,
    // and the people beside them in their own company. The first is pre-tenant by
    // construction -- a platform admin has no company_id, so no tenant-scoped
    // statement could ever return one.
    //
    // A MEMBER OF STAFF GETS ONLY THE SECOND, and it returns exactly one person.
    // Their manager is who they ring about a shift; the people who run the platform
    // are three levels away and are not a waiter's problem to solve. Everything they
    // would call about, the manager escalates.
    const wantsOperators = scope.role !== "staff";
    const [operators, colleagues] = await Promise.all([
      wantsOperators ? platformContacts(deps) : [],
      withTenantScope(scope, () => deps.tenantUsers.listContacts(scope))
    ]);

    sendJson(res, 200, {
      contacts: [
        ...operators,
        ...colleagues.map((row) =>
          card({ ...row, where: (row.shopNames || []).join(", ") })
        )
      ]
    });
  }
);
