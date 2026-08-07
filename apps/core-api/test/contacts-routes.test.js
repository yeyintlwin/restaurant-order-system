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
require("../http/routes/contacts");

const ORIGIN = "https://api.yeyintlwin.com";
const COOKIE = `${SESSION_COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAA`;
const HASH = `scrypt$N=32768,r=8,p=1$${"c".repeat(22)}$${"k".repeat(43)}`;
const SESSION_ID = "aaaaaaaa-0008-4000-8000-0000000000c1";

// Two companies, because the platform owner reads across both and everybody else
// must not. The second one exists to be absent from four of the five answers.
const CO_A = "aaaaaaaa-0001-4000-8000-0000000000c1";
const CO_B = "aaaaaaaa-0001-4000-8000-0000000000c2";
const SHOP_A1 = "aaaaaaaa-0002-4000-8000-0000000000c1";
const SHOP_A2 = "aaaaaaaa-0002-4000-8000-0000000000c2";
const SHOP_B1 = "aaaaaaaa-0002-4000-8000-0000000000c3";

const OPERATOR = "aaaaaaaa-0003-4000-8000-0000000000c0";
const OPERATOR_TWO = "aaaaaaaa-0003-4000-8000-0000000000c9";
const CEO_A = "aaaaaaaa-0003-4000-8000-0000000000c1";
const MGR_A1 = "aaaaaaaa-0003-4000-8000-0000000000c2";
const MGR_A2 = "aaaaaaaa-0003-4000-8000-0000000000c3";
const STAFF_A1 = "aaaaaaaa-0003-4000-8000-0000000000c4";
const STAFF_A2 = "aaaaaaaa-0003-4000-8000-0000000000c5";
const CEO_B = "aaaaaaaa-0003-4000-8000-0000000000c6";
const MGR_B1 = "aaaaaaaa-0003-4000-8000-0000000000c7";

const PLATFORM_SCOPE = createScope({ kind: "platform", userId: OPERATOR, sessionId: SESSION_ID });

function tenantScope(role, userId, shopIds) {
  const input = { kind: "tenant", userId, sessionId: SESSION_ID, companyId: CO_A, role, shopIds };
  if (role === "company_admin" || role === "platform_admin") input.administeredShopIds = shopIds;
  return createScope(input);
}

function harness(scope, userId, role) {
  return {
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
    sessions: {
      resolveSession: async () => ({
        sessionId: SESSION_ID, userId, role,
        companyId: scope.kind === "platform" ? null : CO_A,
        actingCompanyId: scope.kind === "platform" ? null : CO_A,
        email: "someone@example.test", displayName: "Someone",
        mustChangePassword: false, status: "active",
        companyStatus: scope.kind === "platform" ? null : "active"
      }),
      renewSession: async () => null
    },
    scopes: { materialiseScope: async () => scope },
    appendAuditEvent: async () => "1",
    // The REAL repositories. Stubbing them would leave the three statements that
    // decide who can see whom untested, and those statements ARE this feature.
    users: require("../repositories/auth/users"),
    tenantUsers: require("../repositories/users"),
    platformContacts: require("../repositories/platform/contacts")
  };
}

async function withServer(deps, run) {
  const app = createApp(deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const contacts = async (base) => {
  const response = await fetch(`${base}/api/admin/contacts`, {
    headers: { "X-Forwarded-For": "203.0.113.7", Cookie: COOKIE }
  });
  assert.equal(response.status, 200);
  return (await response.json()).contacts;
};

const names = (list) => list.map((one) => one.displayName).sort();

describe("the contact directory", { skip: skipDatabaseTests() }, () => {
  let db;

  before(async () => {
    db = await cloneTemplate(__filename);
    openRuntimePool({ connectionString: db.connectionString, max: 4 });
    await seed();
  });
  after(async () => {
    await closeAllPools();
    await db.drop();
  });

  async function seed() {
    await db.resetFixtures();
    await db.unscoped(
      `INSERT INTO companies (id, name, slug) VALUES ($1, 'Golden Duck', 'golden-duck'), ($2, 'Shwe Cafe', 'shwe-cafe')`,
      [CO_A, CO_B]
    );
    await db.unscoped(
      `INSERT INTO shops (id, company_id, name, slug, time_zone, business_day_rollover_hour, currency, language) VALUES
         ($1, $4, 'Insein', 'insein', 'Asia/Yangon', 6, 'MMK', 'my'),
         ($2, $4, 'Hledan', 'hledan', 'Asia/Yangon', 6, 'MMK', 'my'),
         ($3, $5, 'Kamayut', 'kamayut', 'Asia/Yangon', 6, 'MMK', 'my')`,
      [SHOP_A1, SHOP_A2, SHOP_B1, CO_A, CO_B]
    );
    await db.unscoped(
      `INSERT INTO users (id, company_id, role, email, display_name, phone, password_hash) VALUES
         ($1,  NULL, 'platform_admin', 'op@example.test',    'Ye Yint Lwin', '09 77 000 0000', $10),
         ($9,  NULL, 'platform_admin', 'op2@example.test',   'Hussam',       '09 77 000 0001', $10),
         ($2,  $11,  'company_admin',  'ceoa@example.test',  'Su Su Hlaing', '09 42 118 9030', $10),
         ($3,  $11,  'shop_manager',   'mgr1@example.test',  'Thura Zaw',    '09 42 118 9070', $10),
         ($4,  $11,  'shop_manager',   'mgr2@example.test',  'Aye Aye Mon',  '09 42 118 9071', $10),
         ($5,  $11,  'staff',          'st1@example.test',   'Min Min',      '09 42 118 9060', $10),
         ($6,  $11,  'staff',          'st2@example.test',   'Hnin Wai',     '09 42 118 9061', $10),
         ($7,  $12,  'company_admin',  'ceob@example.test',  'Nay Lin',      '09 42 118 9090', $10),
         ($8,  $12,  'shop_manager',   'mgrb@example.test',  'Moe Thu',      '09 42 118 9091', $10)`,
      [OPERATOR, CEO_A, MGR_A1, MGR_A2, STAFF_A1, STAFF_A2, CEO_B, MGR_B1, OPERATOR_TWO, HASH, CO_A, CO_B]
    );
    await db.unscoped(
      `INSERT INTO user_shops (company_id, user_id, shop_id) VALUES
         ($1, $3, $5), ($1, $4, $6), ($1, $7, $5), ($1, $8, $6), ($2, $9, $10)`,
      [CO_A, CO_B, MGR_A1, MGR_A2, SHOP_A1, SHOP_A2, STAFF_A1, STAFF_A2, MGR_B1, SHOP_B1]
    );
  }

  test("THE PLATFORM OWNER reaches every CEO and every manager, and no staff at all", async () => {
    await withServer(harness(PLATFORM_SCOPE, OPERATOR, "platform_admin"), async (base) => {
      const list = await contacts(base);
      assert.deepEqual(names(list), ["Aye Aye Mon", "Moe Thu", "Nay Lin", "Su Su Hlaing", "Thura Zaw"]);

      // ACROSS companies -- that is the whole reason this half goes through the
      // platform seam. Both chains are in one list.
      assert.deepEqual(
        [...new Set(list.map((one) => one.where.split(" · ")[0]))].sort(),
        ["Golden Duck", "Shwe Cafe"]
      );

      // A branch name alone is not enough: two chains can both have a Bogyoke, and
      // the platform owner is looking at all of them at once.
      const thura = list.find((one) => one.displayName === "Thura Zaw");
      assert.equal(thura.where, "Golden Duck · Insein");
      assert.equal(thura.phone, "09 42 118 9070");
      assert.equal(thura.roleLabel, "Manager");
      assert.equal(list.find((one) => one.displayName === "Su Su Hlaing").where, "Golden Duck");

      // §2.1 still holds for everybody else. Nothing in this shape returns a waiter.
      assert.doesNotMatch(JSON.stringify(list), /Min Min|Hnin Wai/);
      // And they are not in their own directory -- their peers live on the Platform
      // admins screen, which is a different question with different buttons.
      assert.doesNotMatch(JSON.stringify(list), /Ye Yint Lwin|Hussam/);
    });
  });

  test("A CEO reaches the platform, their managers and their staff -- and nobody in another company", async () => {
    const scope = tenantScope("company_admin", CEO_A, [SHOP_A1, SHOP_A2]);
    await withServer(harness(scope, CEO_A, "company_admin"), async (base) => {
      const list = await contacts(base);
      assert.deepEqual(names(list), [
        "Aye Aye Mon", "Hnin Wai", "Hussam", "Min Min", "Thura Zaw", "Ye Yint Lwin"
      ]);

      // Upwards, which is the half /api/admin/users cannot do: a CEO cannot
      // administer a platform admin and still has to be able to ring one.
      const operator = list.find((one) => one.displayName === "Ye Yint Lwin");
      assert.equal(operator.roleLabel, "Platform");
      assert.equal(operator.phone, "09 77 000 0000");
      assert.equal(operator.where, null);

      // The tenant half is placed by the branches the person works in.
      assert.equal(list.find((one) => one.displayName === "Thura Zaw").where, "Insein");
      // Themselves excluded: a directory listing you is a row you would ring yourself on.
      assert.doesNotMatch(JSON.stringify(list), /Su Su Hlaing/);
      // The other company is invisible, which is the tenant predicate doing its job.
      assert.doesNotMatch(JSON.stringify(list), /Nay Lin|Moe Thu/);
    });
  });

  test("A MANAGER reaches upwards to their CEO, and down to their own shop's staff only", async () => {
    // Thura runs Insein. Hnin Wai works at Hledan, under a different manager.
    const scope = tenantScope("shop_manager", MGR_A1, [SHOP_A1]);
    await withServer(harness(scope, MGR_A1, "shop_manager"), async (base) => {
      const list = await contacts(base);
      assert.deepEqual(names(list), ["Hussam", "Min Min", "Su Su Hlaing", "Ye Yint Lwin"]);

      // The CEO is ABOVE them. Containment on /api/admin/users cannot return this
      // row, and widening it to try would hand a manager an edit button on their boss.
      assert.equal(list.find((one) => one.displayName === "Su Su Hlaing").roleLabel, "Owner");

      // Another branch's staff are not theirs to ring, and neither is the manager
      // who runs that branch -- §2's table gives a manager no peers.
      assert.doesNotMatch(JSON.stringify(list), /Hnin Wai|Aye Aye Mon/);
    });
  });

  test("A MEMBER OF STAFF reaches their manager, and that is the entire list", async () => {
    const scope = tenantScope("staff", STAFF_A1, [SHOP_A1]);
    await withServer(harness(scope, STAFF_A1, "staff"), async (base) => {
      const list = await contacts(base);
      // ONE PERSON. The manager of their shop, and that is the whole directory.
      assert.deepEqual(names(list), ["Thura Zaw"]);

      // Not their CEO, not the manager of the other branch, and not the people who
      // run the platform either. A waiter rings the person on their shift;
      // everything past that, the manager escalates.
      assert.doesNotMatch(JSON.stringify(list), /Su Su Hlaing|Aye Aye Mon|Hnin Wai/);
      assert.doesNotMatch(JSON.stringify(list), /Ye Yint Lwin|Hussam/);
    });
  });

  test("a suspended person is nobody to ring, at either level", async () => {
    await db.unscoped("UPDATE users SET status = 'suspended' WHERE id = $1", [OPERATOR_TWO]);
    await db.unscoped("UPDATE users SET status = 'suspended' WHERE id = $1", [MGR_A2]);

    const scope = tenantScope("company_admin", CEO_A, [SHOP_A1, SHOP_A2]);
    await withServer(harness(scope, CEO_A, "company_admin"), async (base) => {
      const list = await contacts(base);
      // The list answers "who can I ring about this", and somebody who cannot sign
      // in is not that person -- at the platform level or inside the company.
      assert.doesNotMatch(JSON.stringify(list), /Hussam|Aye Aye Mon/);
      // The one who is still active is still there, so the filter is on STATUS and
      // not on the read having failed.
      assert.ok(names(list).includes("Ye Yint Lwin"));
    });

    await db.unscoped("UPDATE users SET status = 'active' WHERE id IN ($1, $2)", [OPERATOR_TWO, MGR_A2]);
  });

  test("a manager who runs two shops is one row per shop for the platform owner", async () => {
    // Aye Aye Mon takes Insein as well: the arrangement §3.0 exists to allow.
    await db.unscoped(
      "INSERT INTO user_shops (company_id, user_id, shop_id) VALUES ($1, $2, $3)",
      [CO_A, MGR_A2, SHOP_A1]
    );
    await withServer(harness(PLATFORM_SCOPE, OPERATOR, "platform_admin"), async (base) => {
      const list = await contacts(base);
      const hers = list.filter((one) => one.displayName === "Aye Aye Mon");
      // TWO rows, and that is the honest rendering: the list is of PLACES that need
      // somebody, and collapsing them would hide that Insein has cover.
      assert.deepEqual(hers.map((one) => one.where).sort(), [
        "Golden Duck · Hledan",
        "Golden Duck · Insein"
      ]);
    });
    await db.unscoped("DELETE FROM user_shops WHERE user_id = $1 AND shop_id = $2", [MGR_A2, SHOP_A1]);
  });
});
