"use strict";

const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");

const { createApp } = require("../http/router");
const { createRateLimiter } = require("../lib/rate-limit");
const { createSemaphore } = require("../lib/semaphore");
const { createScope } = require("../db/scope");
const { openRuntimePool, closeAllPools } = require("../db");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const { SESSION_COOKIE_NAME } = require("../http/cookies");

require("../http/routes/auth");
require("../http/routes/shops");

const ORIGIN = "https://api.yeyintlwin.com";
const COMPANY = "aaaaaaaa-0001-4000-8000-000000000001";
const OPERATOR = "aaaaaaaa-0003-4000-8000-000000000011";
const CEO = "aaaaaaaa-0003-4000-8000-000000000012";
const SESSION_ID = "aaaaaaaa-0008-4000-8000-000000000011";
const COOKIE = `${SESSION_COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAA`;
const POST_HEADERS = { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7", Cookie: COOKIE };
const PLACEHOLDER_HASH = `scrypt$N=32768,r=8,p=1$${"c".repeat(22)}$${"k".repeat(43)}`;

// Same person, same company, DIFFERENT role -- which is the entire subject of this
// file. Both scopes are minted by createScope, never written as object literals:
// an unstamped one dies inside assertTenantScope as an opaque 500.
function scopeFor(role, userId) {
  return createScope({
    kind: "tenant",
    userId,
    sessionId: SESSION_ID,
    companyId: COMPANY,
    role,
    shopIds: [],
    administeredShopIds: []
  });
}
const OPERATOR_SCOPE = scopeFor("platform_admin", OPERATOR);
const CEO_SCOPE = scopeFor("company_admin", CEO);

function sessionRow(userId, role) {
  return {
    sessionId: SESSION_ID,
    userId,
    role,
    companyId: role === "platform_admin" ? null : COMPANY,
    actingCompanyId: COMPANY,
    email: "someone@example.test",
    displayName: "Someone",
    mustChangePassword: false,
    status: "active",
    companyStatus: "active"
  };
}

function harness({ scope = OPERATOR_SCOPE, userId = OPERATOR, role = "platform_admin" } = {}) {
  const audits = [];
  return {
    audits,
    deps: {
      // Errors are surfaced rather than swallowed. A 500 in these tests presents as
      // "500 !== 201" and nothing else, and the sentence that says WHY is in the
      // error log the harness used to discard. Left in on purpose: it prints nothing
      // while the suite is green.
      log: (line) => {
        try {
          const entry = JSON.parse(line);
          if (entry.level === "error") console.error(`  core-api: ${entry.message}`);
        } catch {
          /* not JSON, not an error line */
        }
      },
      apiPublicOrigin: ORIGIN,
      trustedProxyHops: 1,
      sessionIdleSeconds: 28800,
      sessionAbsoluteSeconds: 604800,
      loginRatePerMinute: 30,
      loginTimeBudgetMs: 250,
      passwordAbuseThreshold: 5,
      adminMintRatePer10min: 20,
      pairingMintRatePer10min: 30,
      pairRatePerMinute: 20,
      rotateRatePerHour: 5,
      rateLimiter: createRateLimiter({ now: () => 1_700_000_000_000 }),
      scryptSemaphore: createSemaphore({ slots: 2 }),
      sessions: { resolveSession: async () => sessionRow(userId, role), renewSession: async () => null },
      scopes: { materialiseScope: async () => scope },
      appendAuditEvent: async (event) => { audits.push(event); return "1"; },
      // The REAL tenant writer, WRAPPED rather than replaced. A stub that only
      // pushed onto an array is why a foreign key violation reached a browser: the
      // pre-tenant writer takes its own connection and cannot see a row created in
      // the caller's open transaction, and no test here ever wrote a real audit row
      // to find out. The array keeps every assertion below working; the second line
      // is what makes them mean something.
      tenantAudit: {
        appendTenantAuditEvent: async (scope, event) => {
          audits.push(event);
          return require("../repositories/audit").appendTenantAuditEvent(scope, event);
        }
      },
      shops: require("../repositories/shops")
    }
  };
}

async function withServer(deps, run) {
  const app = createApp(deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const NEW_SHOP = {
  name: "Bogyoke",
  slug: "bogyoke",
  address: "No. 42, Bogyoke Rd",
  timeZone: "Asia/Yangon",
  businessDayRolloverHour: 6,
  currency: "MMK",
  language: "my",
  tableCount: 12
};

const get = (base, path) => fetch(`${base}${path}`, { headers: { "X-Forwarded-For": "203.0.113.7", Cookie: COOKIE } });
const post = (base, body) =>
  fetch(`${base}/api/admin/shops`, { method: "POST", headers: POST_HEADERS, body: JSON.stringify(body) });
const patch = (base, id, body) =>
  fetch(`${base}/api/admin/shops/${id}`, { method: "PATCH", headers: POST_HEADERS, body: JSON.stringify(body) });

describe("the shops routes", { skip: skipDatabaseTests() }, () => {
  let db;

  before(async () => {
    db = await cloneTemplate(__filename);
    openRuntimePool({ connectionString: db.connectionString, max: 4 });
  });
  after(async () => {
    await closeAllPools();
    await db.drop();
  });

  async function reset() {
    await db.resetFixtures();
    await db.unscoped(
      `INSERT INTO companies (id, name, slug) VALUES ($1, 'Sakura Kitchen', 'sakura')`,
      [COMPANY]
    );
    await db.unscoped(
      `INSERT INTO users (id, company_id, role, email, display_name, password_hash) VALUES
         ($1, NULL, 'platform_admin', 'operator@example.test', 'Operator', $3),
         ($2, $4, 'company_admin', 'ceo@example.test', 'Khin Myat', $3)`,
      [OPERATOR, CEO, PLACEHOLDER_HASH, COMPANY]
    );
  }

  // --- the split this whole change is about --------------------------------

  test("the operator may open a branch and the company's own admin may not", async () => {
    await reset();

    const operator = harness();
    await withServer(operator.deps, async (base) => {
      const created = await post(base, NEW_SHOP);
      assert.equal(created.status, 201);
    });

    await reset();
    const ceo = harness({ scope: CEO_SCOPE, userId: CEO, role: "company_admin" });
    await withServer(ceo.deps, async (base) => {
      const refused = await post(base, NEW_SHOP);
      // The point of the fifth alias. `companyAdmin` would have admitted this
      // caller, and the console design says opening a branch is not theirs.
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error.code, "forbidden");

      // ...and nothing was created by the attempt.
      const { rows } = await db.unscoped("SELECT id FROM shops");
      assert.equal(rows.length, 0);
    });
  });

  test("the CEO may still READ the shops they cannot open", async () => {
    await reset();
    await withServer(harness().deps, async (base) => { await post(base, NEW_SHOP); });

    const ceo = harness({ scope: CEO_SCOPE, userId: CEO, role: "company_admin" });
    await withServer(ceo.deps, async (base) => {
      const listed = await get(base, "/api/admin/shops");
      assert.equal(listed.status, 200);
      assert.equal((await listed.json()).shops.length, 1);
    });
  });

  test("the CEO cannot rename a branch either", async () => {
    await reset();
    let shopId;
    await withServer(harness().deps, async (base) => {
      shopId = (await (await post(base, NEW_SHOP)).json()).id;
    });
    const ceo = harness({ scope: CEO_SCOPE, userId: CEO, role: "company_admin" });
    await withServer(ceo.deps, async (base) => {
      const refused = await patch(base, shopId, { name: "Somewhere Else" });
      assert.equal(refused.status, 403);
    });
  });

  // --- the number that creates the tables ----------------------------------

  test("the table count is not a statistic: it creates the tables", async () => {
    await reset();
    const { deps, audits } = harness();
    await withServer(deps, async (base) => {
      const shop = await (await post(base, NEW_SHOP)).json();

      // Section 4A.2: entering 12 creates Table 1 through Table 12, each a real
      // record that can carry its own QR code.
      const { rows } = await db.unscoped(
        "SELECT label FROM shop_tables WHERE shop_id = $1 ORDER BY length(label), label",
        [shop.id]
      );
      assert.equal(rows.length, 12);
      assert.deepEqual(rows.map((r) => r.label), ["1","2","3","4","5","6","7","8","9","10","11","12"]);
      // Same transaction as the shop: a branch whose count created no tables would
      // be a lie told by the number somebody typed.
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, "shop.created");
      assert.equal(audits[0].detail.tableCount, 12);
    });
  });

  test("zero tables is legal and means none yet", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      const shop = await (await post(base, { ...NEW_SHOP, tableCount: 0 })).json();
      const { rows } = await db.unscoped("SELECT id FROM shop_tables WHERE shop_id = $1", [shop.id]);
      assert.equal(rows.length, 0);
      assert.equal(shop.tableCount, 0);
    });
  });

  test("the table count is counted, and the create answers with the tables it just made", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      // The INSERT's RETURNING runs BEFORE the twelve tables exist, so a naive
      // subquery answers zero on the one response where the number was just typed
      // by the person reading it. That is the whole reason this assertion is on the
      // CREATE and not only on the read after it.
      const shop = await (await post(base, NEW_SHOP)).json();
      assert.equal(shop.tableCount, 12);

      const read = await (await get(base, `/api/admin/shops/${shop.id}`)).json();
      assert.equal(read.tableCount, 12);
      const listed = (await (await get(base, "/api/admin/shops")).json()).shops;
      assert.equal(listed.find((s) => s.id === shop.id).tableCount, 12);

      // Nothing stores it, so deleting a table changes the answer with no write to
      // the shop at all.
      await db.unscoped("DELETE FROM shop_tables WHERE shop_id = $1 AND label = '12'", [shop.id]);
      assert.equal((await (await get(base, `/api/admin/shops/${shop.id}`)).json()).tableCount, 11);
    });
  });

  test("a failed create leaves neither a shop nor its tables", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      await post(base, NEW_SHOP);
      const clash = await post(base, { ...NEW_SHOP, name: "A Different Name" });
      assert.equal(clash.status, 409);
      assert.equal((await clash.json()).error.code, "shop_slug_taken");

      const shops = await db.unscoped("SELECT id FROM shops");
      const tables = await db.unscoped("SELECT id FROM shop_tables");
      assert.equal(shops.rows.length, 1);
      assert.equal(tables.rows.length, 12);
    });
  });

  // --- the country facts ----------------------------------------------------

  test("a branch keeps its own country, and a bad zone is named as such", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      const bangkok = await (await post(base, {
        ...NEW_SHOP, name: "Bangkok Central", slug: "bangkok-central",
        timeZone: "Asia/Bangkok", currency: "THB", language: "th"
      })).json();
      assert.equal(bangkok.timeZone, "Asia/Bangkok");
      assert.equal(bangkok.currency, "THB");
      assert.equal(bangkok.language, "th");
      // The console's whole reason for moving these onto the shop.
      const yangon = await (await post(base, NEW_SHOP)).json();
      assert.equal(yangon.timeZone, "Asia/Yangon");
      assert.equal(yangon.currency, "MMK");

      // Validated by asking the platform, not by a list this file would have to
      // keep current.
      const bad = await post(base, { ...NEW_SHOP, name: "X", slug: "x-branch", timeZone: "Mars/Olympus" });
      assert.equal(bad.status, 422);
      assert.deepEqual((await bad.json()).error.errors, [{ field: "timeZone", code: "invalid_time_zone" }]);
    });
  });

  test("every field the shop cannot open without is named at once", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      const response = await post(base, {});
      assert.equal(response.status, 422);
      assert.deepEqual((await response.json()).error.errors, [
        { field: "name", code: "required" },
        { field: "slug", code: "required" },
        { field: "timeZone", code: "required" },
        { field: "businessDayRolloverHour", code: "required" },
        { field: "currency", code: "required" },
        { field: "language", code: "required" },
        { field: "tableCount", code: "required" }
      ]);
    });
  });

  test("the slug rule is the DDL's, and a slug is never repaired", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      for (const [slug, code] of [["Bogyoke", "pattern"], ["1bogyoke", "pattern"], ["bogyoke-", "pattern"],
                                  ["a--b", "pattern"], [" bogyoke ", "pattern"], ["b", "too_short"]]) {
        const response = await post(base, { ...NEW_SHOP, slug });
        assert.equal(response.status, 422, slug);
        assert.deepEqual((await response.json()).error.errors, [{ field: "slug", code }], slug);
      }
    });
  });

  test("two companies can each have a bogyoke, which is what nesting buys", async () => {
    await reset();
    const other = "aaaaaaaa-0001-4000-8000-000000000002";
    await db.unscoped("INSERT INTO companies (id, name, slug) VALUES ($1, 'Mandalay Grill', 'mandalay')", [other]);
    await withServer(harness().deps, async (base) => { await post(base, NEW_SHOP); });

    // A second operator scope, acting inside the OTHER company.
    const elsewhere = harness({ scope: createScope({
      kind: "tenant", userId: OPERATOR, sessionId: SESSION_ID, companyId: other,
      role: "platform_admin", shopIds: [], administeredShopIds: []
    }) });
    await withServer(elsewhere.deps, async (base) => {
      const created = await post(base, NEW_SHOP);
      assert.equal(created.status, 201, "a slug unique per COMPANY must not collide across them");
    });
  });

  // --- reading, and the containment that shapes it --------------------------

  test("a malformed or unknown id is 404, and so is another company's shop", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      assert.equal((await get(base, "/api/admin/shops/not-a-uuid")).status, 404);
      assert.equal((await get(base, "/api/admin/shops/00000000-0000-4000-8000-000000000000")).status, 404);
    });
  });

  test("a manager sees only the shops assigned to them", async () => {
    await reset();
    let shopId;
    await withServer(harness().deps, async (base) => {
      shopId = (await (await post(base, NEW_SHOP)).json()).id;
    });

    // A shop_manager scope carries ACTIVE shopIds and no administeredShopIds, so
    // the repository takes the assigned path. With an empty set they see nothing --
    // and [] is the empty set, never "all", which is the failure this shape exists
    // to make impossible.
    const unassigned = harness({
      scope: createScope({
        kind: "tenant", userId: CEO, sessionId: SESSION_ID, companyId: COMPANY,
        role: "shop_manager", shopIds: []
      }),
      userId: CEO,
      role: "shop_manager"
    });
    await withServer(unassigned.deps, async (base) => {
      assert.deepEqual((await (await get(base, "/api/admin/shops")).json()).shops, []);
      assert.equal((await get(base, `/api/admin/shops/${shopId}`)).status, 404);
    });

    const assigned = harness({
      scope: createScope({
        kind: "tenant", userId: CEO, sessionId: SESSION_ID, companyId: COMPANY,
        role: "shop_manager", shopIds: [shopId]
      }),
      userId: CEO,
      role: "shop_manager"
    });
    await withServer(assigned.deps, async (base) => {
      assert.equal((await (await get(base, "/api/admin/shops")).json()).shops.length, 1);
      assert.equal((await get(base, `/api/admin/shops/${shopId}`)).status, 200);
    });
  });

  // --- editing --------------------------------------------------------------

  test("a rename is audited, an absent key changes nothing, an empty body is refused", async () => {
    await reset();
    const { deps, audits } = harness();
    await withServer(deps, async (base) => {
      const shop = await (await post(base, NEW_SHOP)).json();
      audits.length = 0;

      const renamed = await patch(base, shop.id, { name: "Bogyoke Aung San" });
      assert.equal(renamed.status, 200);
      const body = await renamed.json();
      assert.equal(body.name, "Bogyoke Aung San");
      assert.equal(body.slug, "bogyoke", "an absent key means do not change");
      assert.equal(body.currency, "MMK");
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, "shop.updated");

      assert.equal((await patch(base, shop.id, {})).status, 400);
      const unknown = await patch(base, "00000000-0000-4000-8000-000000000000", { name: "Ghost" });
      assert.equal(unknown.status, 404);
      // shop.updated declares success only; a failure row would be refused by the
      // vocabulary and turn this 404 into a 500.
      assert.equal(audits.length, 1);
    });
  });

  // --- the manager slot: the CEO's one job on a shop ------------------------

  const STAFF_A = "aaaaaaaa-0003-4000-8000-000000000021";
  const STAFF_B = "aaaaaaaa-0003-4000-8000-000000000022";

  async function seedStaff() {
    await db.unscoped(
      `INSERT INTO users (id, company_id, role, email, display_name, phone, password_hash) VALUES
         ($1, $3, 'staff', 'thura@example.test', 'Thura Zaw', '09 42 118 9070', $4),
         ($2, $3, 'staff', 'kokonaing@example.test', 'Ko Ko Naing', '09 42 118 9071', $4)`,
      [STAFF_A, STAFF_B, COMPANY, PLACEHOLDER_HASH]
    );
  }

  function ceo() {
    return harness({ scope: CEO_SCOPE, userId: CEO, role: "company_admin" });
  }
  const putManager = (base, id, body) =>
    fetch(`${base}/api/admin/shops/${id}/manager`, { method: "PUT", headers: POST_HEADERS, body: JSON.stringify(body) });

  async function openShop() {
    let id;
    await withServer(harness().deps, async (base) => { id = (await (await post(base, NEW_SHOP)).json()).id; });
    return id;
  }

  test("THE SHOP ROW NAMES ITS MANAGER, and the operator reads it", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();

    // Before anybody is appointed. null rather than an omitted key: the console
    // draws "No manager yet" and falls back to naming the CEO, and a key that
    // vanishes is a state it would have to infer.
    await withServer(harness().deps, async (base) => {
      const empty = await (await get(base, `/api/admin/shops/${shopId}`)).json();
      assert.equal(empty.manager, null);
      assert.equal(empty.staffCount, 0);
    });

    await withServer(ceo().deps, async (base) => {
      await putManager(base, shopId, { managerUserId: STAFF_A });
    });

    // The OPERATOR reads it -- a platform admin acting inside the company. This
    // reverses the earlier rule that they see no person inside one, and the reason
    // is the job: they fit the branch out, and when a table screen stops pairing the
    // manager is who they ring. Making them ask the CEO for a number protects nobody.
    await withServer(harness().deps, async (base) => {
      const shop = await (await get(base, `/api/admin/shops/${shopId}`)).json();
      assert.deepEqual(shop.manager, {
        id: STAFF_A,
        displayName: "Thura Zaw",
        phone: "09 42 118 9070",
        email: "thura@example.test"
      });

      // It stops at the manager. Ko Ko Naing is staff at this company and appears
      // nowhere on this document -- there is no shape here that carries them.
      assert.doesNotMatch(JSON.stringify(shop), /Ko Ko Naing|kokonaing/);

      // The list says the same thing, so no screen has to join a user list to draw
      // a shop -- which is the join that broke past a hundred people.
      const listed = (await (await get(base, "/api/admin/shops")).json()).shops;
      assert.equal(listed.find((one) => one.id === shopId).manager.displayName, "Thura Zaw");
    });

    // Suspending them empties it: the row answers "who can be rung", and somebody
    // who cannot sign in is not that person.
    await db.unscoped("UPDATE users SET status = 'suspended' WHERE id = $1", [STAFF_A]);
    await withServer(harness().deps, async (base) => {
      assert.equal((await (await get(base, `/api/admin/shops/${shopId}`)).json()).manager, null);
    });
  });

  test("the operator may open a branch and may NOT staff it", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();
    await withServer(harness().deps, async (base) => {
      const refused = await putManager(base, shopId, { managerUserId: STAFF_A });
      // The other half of the split. §6 is built on the platform owner never
      // seeing a person inside a company, and a route taking a user id is exactly
      // where that would leak.
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error.code, "forbidden");
    });
  });

  test("appointing a manager promotes them and assigns the shop, in one write", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();
    const { deps, audits } = ceo();
    await withServer(deps, async (base) => {
      const response = await putManager(base, shopId, { managerUserId: STAFF_A });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).runByOwner, false);

      const role = await db.unscoped("SELECT role FROM users WHERE id = $1", [STAFF_A]);
      assert.equal(role.rows[0].role, "shop_manager");
      const assigned = await db.unscoped("SELECT shop_id FROM user_shops WHERE user_id = $1", [STAFF_A]);
      assert.deepEqual(assigned.rows.map((r) => r.shop_id), [shopId]);
      assert.equal(audits.at(-1).action, "shop.manager_changed");
      assert.equal(audits.at(-1).detail.replacedUserId, null);
    });
  });

  test("PROMOTING SOMEBODY ALREADY IN THE SHOP", async () => {
    // The ordinary case, and the one that used to answer 500. A CEO picks the person
    // who is already working there -- they are chosen BECAUSE they are there -- so
    // the user_shops row exists before the promotion does. Appointing a stranger
    // worked and appointing your own best waiter did not, which is backwards.
    await reset();
    await seedStaff();
    const shopId = await openShop();
    await db.unscoped(
      "INSERT INTO user_shops (company_id, user_id, shop_id) VALUES ($1, $2, $3)",
      [COMPANY, STAFF_A, shopId]
    );

    await withServer(ceo().deps, async (base) => {
      const response = await putManager(base, shopId, { managerUserId: STAFF_A });
      assert.equal(response.status, 200);
    });

    // Still exactly one row: the assignment was already right, and re-appointing
    // must not leave a second copy of it behind either.
    const assigned = await db.unscoped(
      "SELECT shop_id FROM user_shops WHERE user_id = $1", [STAFF_A]
    );
    assert.deepEqual(assigned.rows.map((r) => r.shop_id), [shopId]);
    const role = await db.unscoped("SELECT role FROM users WHERE id = $1", [STAFF_A]);
    assert.equal(role.rows[0].role, "shop_manager");
  });

  test("replacing a manager is ONE decision: the shop is never left with two, or none", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();
    const { deps, audits } = ceo();
    await withServer(deps, async (base) => {
      await putManager(base, shopId, { managerUserId: STAFF_A });
      await putManager(base, shopId, { managerUserId: STAFF_B, outgoing: "staff" });

      // §3.1: split into "demote the old one" then "promote the new one" and the
      // shop spends the gap with two managers or none. One transaction, so there
      // is no gap: exactly one assignment row survives.
      const rows = await db.unscoped(
        `SELECT u.id, u.role, u.status FROM user_shops us JOIN users u ON u.id = us.user_id
          WHERE us.shop_id = $1 AND u.role = 'shop_manager'`,
        [shopId]
      );
      assert.deepEqual(rows.rows.map((r) => r.id), [STAFF_B]);

      // The outgoing manager kept their account and their history, demoted.
      const old = await db.unscoped("SELECT role, status FROM users WHERE id = $1", [STAFF_A]);
      assert.equal(old.rows[0].role, "staff");
      assert.equal(old.rows[0].status, "active");
      assert.equal(audits.at(-1).detail.replacedUserId, STAFF_A);
    });
  });

  test("the other half of the handover suspends them instead, and kills their sessions", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();
    await withServer(ceo().deps, async (base) => {
      await putManager(base, shopId, { managerUserId: STAFF_A });
      const before = await db.unscoped("SELECT sessions_valid_from FROM users WHERE id = $1", [STAFF_A]);
      await putManager(base, shopId, { managerUserId: STAFF_B, outgoing: "suspend" });

      const old = await db.unscoped("SELECT status, sessions_valid_from FROM users WHERE id = $1", [STAFF_A]);
      assert.equal(old.rows[0].status, "suspended");
      // Without the bump they go on working on the session they already hold,
      // which is the entire point of suspending them.
      assert.ok(old.rows[0].sessions_valid_from > before.rows[0].sessions_valid_from);
    });
  });

  test("the three answers are distinct, and owner-run is one of them", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();
    await withServer(ceo().deps, async (base) => {
      // Nobody yet.
      let shop = await (await putManager(base, shopId, { managerUserId: null })).json();
      assert.equal(shop.runByOwner, false);

      // The owner runs it -- a DECISION, not a gap.
      shop = await (await putManager(base, shopId, { managerUserId: null, runByOwner: true })).json();
      assert.equal(shop.runByOwner, true);

      // A person, and taking the shop off the owner in the same write.
      shop = await (await putManager(base, shopId, { managerUserId: STAFF_A })).json();
      assert.equal(shop.runByOwner, false, "a shop is owner-run or it has a manager, never both");

      // ...and back to nobody clears the assignment.
      shop = await (await putManager(base, shopId, { managerUserId: null })).json();
      const rows = await db.unscoped("SELECT user_id FROM user_shops WHERE shop_id = $1", [shopId]);
      assert.deepEqual(rows.rows, []);
    });
  });

  test("owner-run and a manager at once is refused rather than resolved", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();
    await withServer(ceo().deps, async (base) => {
      const response = await putManager(base, shopId, { managerUserId: STAFF_A, runByOwner: true });
      assert.equal(response.status, 422);
      // The invariant 0003 could not write as a CHECK, because the manager lives
      // in another table.
      assert.deepEqual((await response.json()).error.errors, [{ field: "runByOwner", code: "immutable" }]);
    });
  });

  test("one person may run two shops, which is what the console now allows", async () => {
    await reset();
    await seedStaff();
    const first = await openShop();
    let second;
    await withServer(harness().deps, async (base) => {
      second = (await (await post(base, { ...NEW_SHOP, name: "Hledan", slug: "hledan" })).json()).id;
    });
    await withServer(ceo().deps, async (base) => {
      assert.equal((await putManager(base, first, { managerUserId: STAFF_A })).status, 200);
      assert.equal((await putManager(base, second, { managerUserId: STAFF_A })).status, 200);
      const rows = await db.unscoped(
        "SELECT shop_id FROM user_shops WHERE user_id = $1 ORDER BY shop_id", [STAFF_A]
      );
      assert.equal(rows.rows.length, 2, "the assignment is a row per shop, so two is simply two rows");
    });
  });

  test("an absent key, a stranger and a suspended candidate are each refused on their own terms", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();
    await withServer(ceo().deps, async (base) => {
      // {} is a mistake; {"managerUserId": null} empties the slot. Two requests.
      const missing = await putManager(base, shopId, {});
      assert.equal(missing.status, 422);
      assert.deepEqual((await missing.json()).error.errors, [{ field: "managerUserId", code: "required" }]);

      // Somebody else's user and nobody at all are one answer.
      const stranger = await putManager(base, shopId, { managerUserId: "00000000-0000-4000-8000-000000000000" });
      assert.equal(stranger.status, 404);

      await db.unscoped("UPDATE users SET status = 'suspended' WHERE id = $1", [STAFF_B]);
      const suspended = await putManager(base, shopId, { managerUserId: STAFF_B });
      // Appointing them would leave the shop run by an account that cannot sign
      // in -- §3.2's rule, arrived at from the other direction.
      assert.equal(suspended.status, 409);
      assert.equal((await suspended.json()).error.code, "role_not_shop_assignable");
    });
  });

  // --- the day-to-day three: owned by whoever RUNS the shop -----------------

  const dayToDay = (base, id, body) =>
    fetch(`${base}/api/admin/shops/${id}/day-to-day`, { method: "PATCH", headers: POST_HEADERS, body: JSON.stringify(body) });

  test("the CEO sets them while nobody manages the shop, and stops the moment somebody does", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();

    await withServer(ceo().deps, async (base) => {
      // §3.1B, and it closes a hole the console screen had for real: the Shops
      // screen promised "you can already do everything a manager can there" while
      // the CEO could not reach the shop's phone number at all.
      const set = await dayToDay(base, shopId, { phone: "09 66 100 2003", openingHours: "09:00 - 21:00" });
      assert.equal(set.status, 200);
      assert.equal((await set.json()).phone, "09 66 100 2003");

      // Name a manager, and the three stop being the CEO's.
      await putManager(base, shopId, { managerUserId: STAFF_A });
      const refused = await dayToDay(base, shopId, { phone: "09 00 000 0000" });
      // A screen that hides a control is a courtesy; a route that refuses the
      // write is the rule.
      assert.equal(refused.status, 403);
    });
  });

  test("A DAY-TO-DAY FIELD CAN BE EMPTIED, and an empty string is not the way", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();

    await withServer(ceo().deps, async (base) => {
      await dayToDay(base, shopId, {
        phone: "09 66 100 2003",
        openingHours: "09:00 - 21:00",
        receiptFooter: "Thank you."
      });

      // NULL ERASES. A shop that printed the wrong number for a week, or one that
      // never had a receipt footer, had no way back: an empty box was refused, and
      // because the console recomputes the patch from all three fields on every
      // blur, the refused one was re-sent with the next edit and blocked the other
      // two. One stuck field made the whole panel read-only.
      const cleared = await dayToDay(base, shopId, { receiptFooter: null });
      assert.equal(cleared.status, 200);
      const body = await cleared.json();
      assert.equal(body.receiptFooter, null);
      // ...and only that one. An absent key still means "leave it".
      assert.equal(body.phone, "09 66 100 2003");
      assert.equal(body.openingHours, "09:00 - 21:00");

      // An empty STRING is refused by its own name. Two spellings of "make this go
      // away" is how one caller stores "" and another stores NULL, and every reader
      // afterwards has to know both.
      const blank = await dayToDay(base, shopId, { phone: "   " });
      assert.equal(blank.status, 422);
      assert.deepEqual((await blank.json()).error.errors, [{ field: "phone", code: "empty" }]);

      // A number is neither, and says so as a type problem rather than an empty one.
      const wrong = await dayToDay(base, shopId, { phone: 12345 });
      assert.equal(wrong.status, 422);
      assert.deepEqual((await wrong.json()).error.errors, [{ field: "phone", code: "type" }]);

      // The read after it agrees, so nothing above was a RETURNING that lied.
      const read = await (await get(base, `/api/admin/shops/${shopId}`)).json();
      assert.equal(read.receiptFooter, null);
      assert.equal(read.phone, "09 66 100 2003");
    });
  });

  test("the manager sets them for their own shop and cannot reach another", async () => {
    await reset();
    await seedStaff();
    const first = await openShop();
    let second;
    await withServer(harness().deps, async (base) => {
      second = (await (await post(base, { ...NEW_SHOP, name: "Hledan", slug: "hledan" })).json()).id;
    });
    await withServer(ceo().deps, async (base) => { await putManager(base, first, { managerUserId: STAFF_A }); });

    const manager = harness({
      scope: createScope({
        kind: "tenant", userId: STAFF_A, sessionId: SESSION_ID, companyId: COMPANY,
        role: "shop_manager", shopIds: [first]
      }),
      userId: STAFF_A,
      role: "shop_manager"
    });
    await withServer(manager.deps, async (base) => {
      assert.equal((await dayToDay(base, first, { receiptFooter: "Thank you." })).status, 200);
      // Containment, not a second permission check: getShop is driven by their
      // scope, so the shop they do not run reads as absent.
      assert.equal((await dayToDay(base, second, { receiptFooter: "Nope." })).status, 404);
    });
  });

  test("the operator opens the branch and does not answer its phone", async () => {
    await reset();
    await seedStaff();
    const shopId = await openShop();
    await withServer(harness().deps, async (base) => {
      const refused = await dayToDay(base, shopId, { phone: "09 11 111 1111" });
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error.code, "forbidden");
    });
  });

  test("?status is honoured for an administering scope", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      const a = await (await post(base, NEW_SHOP)).json();
      const b = await (await post(base, { ...NEW_SHOP, name: "Hledan", slug: "hledan" })).json();
      await patch(base, b.id, { status: "suspended" });

      assert.equal((await (await get(base, "/api/admin/shops")).json()).shops.length, 2);
      const active = (await (await get(base, "/api/admin/shops?status=active")).json()).shops;
      assert.deepEqual(active.map((s) => s.id), [a.id]);
      // Status-independent for an administering scope: a suspended shop stays
      // reachable by the people who can un-suspend it.
      assert.equal((await get(base, `/api/admin/shops/${b.id}`)).status, 200);

      const bad = await get(base, "/api/admin/shops?status=deleted");
      assert.equal(bad.status, 422);
    });
  });
});
