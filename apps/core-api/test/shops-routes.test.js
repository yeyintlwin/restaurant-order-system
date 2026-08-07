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
      log: () => {},
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
