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
const { mayActOnRole, rankOf, permitsSelfPatch, selfPatchableFields, SELF_PATCHABLE_FIELDS } = require("../lib/authorization");

require("../http/routes/auth");
require("../http/routes/users");

const ORIGIN = "https://api.yeyintlwin.com";
const COMPANY = "aaaaaaaa-0001-4000-8000-000000000001";
const OTHER_COMPANY = "aaaaaaaa-0001-4000-8000-000000000002";
const CEO = "aaaaaaaa-0003-4000-8000-000000000031";
const MANAGER = "aaaaaaaa-0003-4000-8000-000000000032";
const STAFF = "aaaaaaaa-0003-4000-8000-000000000033";
const SHOP_A = "aaaaaaaa-0002-4000-8000-000000000031";
const SHOP_B = "aaaaaaaa-0002-4000-8000-000000000032";
const SESSION_ID = "aaaaaaaa-0008-4000-8000-000000000031";
const COOKIE = `${SESSION_COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAA`;
const POST_HEADERS = { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7", Cookie: COOKIE };
const HASH = `scrypt$N=32768,r=8,p=1$${"c".repeat(22)}$${"k".repeat(43)}`;

// --- the lattice, on its own (pure) -----------------------------------------

test("the lattice is STRICTLY below, which is the whole rule", () => {
  // Below-or-equal is how one account quietly becomes two, and neither can be
  // told from the other afterwards.
  assert.equal(mayActOnRole("company_admin", "shop_manager"), true);
  assert.equal(mayActOnRole("company_admin", "company_admin"), false);
  assert.equal(mayActOnRole("shop_manager", "staff"), true);
  assert.equal(mayActOnRole("shop_manager", "shop_manager"), false);
  assert.equal(mayActOnRole("shop_manager", "company_admin"), false);
  assert.equal(mayActOnRole("staff", "staff"), false);
  assert.equal(mayActOnRole("platform_admin", "company_admin"), true);
});

test("an unknown role THROWS rather than scoring below everything", () => {
  // A -1 would make every comparison answer "yes, you may", which is the failure
  // direction that hands a typo the keys.
  assert.throws(() => rankOf("owner"), /unknown role/);
  assert.throws(() => rankOf(undefined), /unknown role/);
  assert.throws(() => mayActOnRole("company_admin", "superuser"), /unknown role/);
});

test("A MEMBER OF STAFF MAY SET ONLY THEIR OWN LANGUAGE", () => {
  // The lists are asserted whole rather than by example. Widening one is a decision
  // about what somebody may do to their own account with nobody's approval, and
  // these lines are what make that decision arrive in a diff instead of quietly.
  assert.deepEqual(selfPatchableFields("staff"), ["language"]);
  assert.deepEqual(selfPatchableFields("shop_manager"), ["displayName", "phone", "language"]);
  assert.deepEqual(selfPatchableFields("company_admin"), ["displayName", "phone", "language"]);
  assert.deepEqual(selfPatchableFields("platform_admin"), ["displayName", "phone", "language"]);
  assert.deepEqual(Object.keys(SELF_PATCHABLE_FIELDS).sort(), [
    "company_admin", "platform_admin", "shop_manager", "staff"
  ]);

  // A waiter's name is how the manager knows who took an order and their phone is
  // how the manager reaches them on a shift. Changing either does not break the
  // waiter's screen, it breaks the roster of the person above them -- who cannot
  // see that it happened.
  assert.equal(permitsSelfPatch(["displayName"], "staff"), false);
  assert.equal(permitsSelfPatch(["phone"], "staff"), false);
  assert.equal(permitsSelfPatch(["language"], "staff"), true);

  // From a shop manager up, those are your own contact details.
  assert.equal(permitsSelfPatch(["displayName"], "shop_manager"), true);
  assert.equal(permitsSelfPatch(["phone", "language"], "company_admin"), true);

  // One permitted field does not carry a forbidden one in with it: EVERY field in
  // the patch has to be on the list, not just one of them.
  assert.equal(permitsSelfPatch(["displayName", "role"], "company_admin"), false);
  assert.equal(permitsSelfPatch(["language", "phone"], "staff"), false);
  assert.equal(permitsSelfPatch(["status"], "company_admin"), false);
  // Your sign-in name is how the person above you reaches you. It is nobody's.
  assert.equal(permitsSelfPatch(["email"], "platform_admin"), false);

  // An unknown role THROWS rather than falling through to the longest list, which
  // is the direction that would hand a typo the most permissive answer.
  assert.throws(() => permitsSelfPatch(["language"], "owner"), /unknown role/);
});

// --- the routes -------------------------------------------------------------

function scopeFor(role, userId, shopIds = []) {
  const input = { kind: "tenant", userId, sessionId: SESSION_ID, companyId: COMPANY, role, shopIds };
  if (role === "company_admin" || role === "platform_admin") input.administeredShopIds = shopIds;
  return createScope(input);
}

function harness(scope, userId) {
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
      sessions: {
        resolveSession: async () => ({
          sessionId: SESSION_ID, userId, role: scope.role, companyId: COMPANY,
          actingCompanyId: COMPANY, email: "a@example.test", displayName: "A",
          mustChangePassword: false, status: "active", companyStatus: "active"
        }),
        renewSession: async () => null
      },
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
      tenantUsers: require("../repositories/users")
    }
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

const get = (base, path) => fetch(`${base}${path}`, { headers: { "X-Forwarded-For": "203.0.113.7", Cookie: COOKIE } });
const post = (base, path, body) =>
  fetch(`${base}${path}`, { method: "POST", headers: POST_HEADERS, body: body === undefined ? "{}" : JSON.stringify(body) });
const patch = (base, path, body) =>
  fetch(`${base}${path}`, { method: "PATCH", headers: POST_HEADERS, body: JSON.stringify(body) });

const NEW_STAFF = {
  email: "aye@example.test",
  displayName: "Aye Aye Mon",
  phone: "09 42 118 9021",
  role: "staff",
  shopIds: [SHOP_A]
};

describe("the users routes", { skip: skipDatabaseTests() }, () => {
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
      `INSERT INTO companies (id, name, slug) VALUES ($1, 'Sakura Kitchen', 'sakura'), ($2, 'Mandalay Grill', 'mandalay')`,
      [COMPANY, OTHER_COMPANY]
    );
    await db.unscoped(
      `INSERT INTO shops (id, company_id, name, slug, time_zone, business_day_rollover_hour, currency, language) VALUES
         ($1, $3, 'Bogyoke', 'bogyoke', 'Asia/Yangon', 6, 'MMK', 'my'),
         ($2, $3, 'Hledan', 'hledan', 'Asia/Yangon', 6, 'MMK', 'my')`,
      [SHOP_A, SHOP_B, COMPANY]
    );
    await db.unscoped(
      `INSERT INTO users (id, company_id, role, email, display_name, password_hash) VALUES
         ($1, $4, 'company_admin', 'ceo@example.test', 'Khin Myat', $5),
         ($2, $4, 'shop_manager', 'thura@example.test', 'Thura Zaw', $5),
         ($3, $4, 'staff', 'minmin@example.test', 'Min Min', $5)`,
      [CEO, MANAGER, STAFF, COMPANY, HASH]
    );
    await db.unscoped(
      `INSERT INTO user_shops (company_id, user_id, shop_id) VALUES ($1, $2, $3), ($1, $4, $3)`,
      [COMPANY, MANAGER, SHOP_A, STAFF]
    );
  }

  const asCeo = () => harness(scopeFor("company_admin", CEO, [SHOP_A, SHOP_B]), CEO);
  const asManager = () => harness(scopeFor("shop_manager", MANAGER, [SHOP_A]), MANAGER);

  test("the CEO creates a person and is handed the password to read out", async () => {
    await reset();
    const { deps, audits } = asCeo();
    await withServer(deps, async (base) => {
      const response = await post(base, "/api/admin/users", NEW_STAFF);
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(response.headers.get("location"), `/api/admin/users/${body.id}`);
      // §5.1: two words and four digits, readable out loud across a noisy kitchen.
      assert.match(body.initialPassword, /^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/);
      assert.equal(body.mustChangePassword, true);
      assert.deepEqual(body.shopIds, [SHOP_A]);
      assert.equal(audits.at(-1).action, "user.created");

      // The ONLY response that carries it -- reading the row back never does.
      const read = await (await get(base, `/api/admin/users/${body.id}`)).json();
      assert.equal(read.initialPassword, undefined);
    });
  });

  test("nobody creates at or above their own rank", async () => {
    await reset();
    await withServer(asCeo().deps, async (base) => {
      // A company_admin minting a second company_admin is how one account quietly
      // becomes two.
      const peer = await post(base, "/api/admin/users", {
        ...NEW_STAFF, email: "peer@example.test", role: "company_admin", shopIds: []
      });
      assert.equal(peer.status, 403);
    });
    await withServer(asManager().deps, async (base) => {
      const promoted = await post(base, "/api/admin/users", {
        ...NEW_STAFF, email: "x@example.test", role: "shop_manager"
      });
      // The exact scenario §5.4 names: a shop_manager POSTing a role above their
      // own, with every database constraint satisfied.
      assert.equal(promoted.status, 403);
      assert.equal((await post(base, "/api/admin/users", { ...NEW_STAFF, email: "y@example.test" })).status, 201);
    });
  });

  test("a person who reaches nothing is refused before they exist", async () => {
    await reset();
    await withServer(asCeo().deps, async (base) => {
      const orphan = await post(base, "/api/admin/users", { ...NEW_STAFF, shopIds: [] });
      assert.equal(orphan.status, 422);
      // A zero-assignment staff row reaches nothing AND is invisible to every
      // shop_manager: a person who exists, cannot work, and cannot be found by
      // the only people who would notice.
      assert.deepEqual((await orphan.json()).error.errors, [{ field: "shopIds", code: "too_short" }]);

      const missing = await post(base, "/api/admin/users", {});
      assert.deepEqual((await missing.json()).error.errors, [
        { field: "email", code: "required" },
        { field: "displayName", code: "required" },
        { field: "phone", code: "required" },
        { field: "role", code: "required" }
      ]);
    });
  });

  test("a manager sees the staff of their own shops and nobody else", async () => {
    await reset();
    // Somebody at Hledan, which this manager is not assigned to.
    const elsewhere = "aaaaaaaa-0003-4000-8000-000000000034";
    await db.unscoped(
      `INSERT INTO users (id, company_id, role, email, display_name, password_hash)
       VALUES ($1, $2, 'staff', 'hnin@example.test', 'Hnin Wai', $3)`,
      [elsewhere, COMPANY, HASH]
    );
    await db.unscoped(`INSERT INTO user_shops (company_id, user_id, shop_id) VALUES ($1, $2, $3)`,
      [COMPANY, elsewhere, SHOP_B]);

    await withServer(asManager().deps, async (base) => {
      const listed = (await (await get(base, "/api/admin/users")).json()).users;
      // Their own staff only: not the CEO above them, not their peer, not the
      // staff of a shop they do not run.
      assert.deepEqual(listed.map((u) => u.id), [STAFF]);
      assert.equal((await get(base, `/api/admin/users/${elsewhere}`)).status, 404);
      assert.equal((await get(base, `/api/admin/users/${CEO}`)).status, 404);
    });

    await withServer(asCeo().deps, async (base) => {
      const listed = (await (await get(base, "/api/admin/users")).json()).users;
      assert.equal(listed.length, 4, "the CEO sees everyone in the company");
    });
  });

  test("a person assigned to two shops is listed ONCE", async () => {
    await reset();
    await db.unscoped(`INSERT INTO user_shops (company_id, user_id, shop_id) VALUES ($1, $2, $3)`,
      [COMPANY, STAFF, SHOP_B]);
    // The reason containment is an EXISTS semi-join and never an INNER JOIN: a
    // JOIN duplicates them and then silently truncates the page at LIMIT.
    await withServer(harness(scopeFor("shop_manager", MANAGER, [SHOP_A, SHOP_B]), MANAGER).deps, async (base) => {
      const listed = (await (await get(base, "/api/admin/users")).json()).users;
      assert.deepEqual(listed.map((u) => u.id), [STAFF]);
      assert.deepEqual(listed[0].shopIds.sort(), [SHOP_A, SHOP_B].sort());
    });
  });

  test("you may rename yourself and nothing else", async () => {
    await reset();
    await withServer(asCeo().deps, async (base) => {
      const renamed = await patch(base, `/api/admin/users/${CEO}`, { displayName: "Khin Myat Oo" });
      assert.equal(renamed.status, 200);

      // A route that let you change your own role would make the lattice
      // decorative.
      const promoted = await patch(base, `/api/admin/users/${CEO}`, { status: "suspended" });
      assert.equal(promoted.status, 403);
      assert.equal((await promoted.json()).error.code, "self_modification_forbidden");
      assert.equal((await post(base, `/api/admin/users/${CEO}/password-reset`)).status, 403);
    });
  });

  test("a manager cannot touch a peer, and cannot promote anybody", async () => {
    await reset();
    await withServer(asManager().deps, async (base) => {
      // Not strictly below them.
      assert.equal((await patch(base, `/api/admin/users/${CEO}`, { displayName: "X" })).status, 404);

      // role and shopIds are companyAdmin-only, and that check is BODY-dependent
      // so it cannot be a route declaration.
      const promote = await patch(base, `/api/admin/users/${STAFF}`, { role: "shop_manager" });
      assert.equal(promote.status, 403);
      const reassign = await patch(base, `/api/admin/users/${STAFF}`, { shopIds: [SHOP_B] });
      assert.equal(reassign.status, 403);

      // What they CAN do: access and a name.
      assert.equal((await patch(base, `/api/admin/users/${STAFF}`, { status: "suspended" })).status, 200);
    });
  });

  test("suspending somebody kills the sessions they already hold", async () => {
    await reset();
    const before = await db.unscoped("SELECT sessions_valid_from FROM users WHERE id = $1", [STAFF]);
    await withServer(asCeo().deps, async (base) => {
      assert.equal((await patch(base, `/api/admin/users/${STAFF}`, { status: "suspended" })).status, 200);
    });
    const after = await db.unscoped("SELECT sessions_valid_from, status FROM users WHERE id = $1", [STAFF]);
    assert.equal(after.rows[0].status, "suspended");
    // Without the bump they go on working on the session they already have.
    assert.ok(after.rows[0].sessions_valid_from > before.rows[0].sessions_valid_from);
  });

  test("a CEO cannot promote anybody to CEO, and the operator can", async () => {
    await reset();
    await withServer(asCeo().deps, async (base) => {
      // Strictly below AFTER as well as before. This is the rule that keeps a
      // company to one company_admin, and it is why §6.2 says a company's FIRST
      // one is created by a scoped platform admin -- rank 3 clears rank 2.
      const refused = await patch(base, `/api/admin/users/${MANAGER}`, { role: "company_admin" });
      assert.equal(refused.status, 403);
    });

    const operator = harness(scopeFor("platform_admin", CEO, [SHOP_A, SHOP_B]), CEO);
    await withServer(operator.deps, async (base) => {
      const promoted = await patch(base, `/api/admin/users/${MANAGER}`, { role: "company_admin" });
      assert.equal(promoted.status, 200);
      // Company-wide by definition, so a leftover assignment row would be a claim
      // about their reach that nothing reads.
      assert.deepEqual((await promoted.json()).shopIds, []);
      const rows = await db.unscoped("SELECT shop_id FROM user_shops WHERE user_id = $1", [MANAGER]);
      assert.deepEqual(rows.rows, []);
    });
  });

  test("a password reset hands over a new one and clears the lockout", async () => {
    await reset();
    await db.unscoped(
      "UPDATE users SET failed_login_count = 5, locked_until = now() + interval '1 hour' WHERE id = $1",
      [STAFF]
    );
    const { deps, audits } = asCeo();
    await withServer(deps, async (base) => {
      const response = await post(base, `/api/admin/users/${STAFF}/password-reset`);
      assert.equal(response.status, 200);
      assert.match((await response.json()).initialPassword, /^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/);
      assert.equal(audits.at(-1).action, "user.password_reset");
    });
    const row = await db.unscoped(
      "SELECT failed_login_count, locked_until, must_change_password FROM users WHERE id = $1", [STAFF]
    );
    // There is no separate unlock route: the remedy that helps somebody locked
    // out is a working password.
    assert.equal(row.rows[0].failed_login_count, 0);
    assert.equal(row.rows[0].locked_until, null);
    assert.equal(row.rows[0].must_change_password, true);
  });

  test("another company's person is the same 404 as nobody at all", async () => {
    await reset();
    const outsider = "aaaaaaaa-0003-4000-8000-000000000035";
    await db.unscoped(
      `INSERT INTO users (id, company_id, role, email, display_name, password_hash)
       VALUES ($1, $2, 'staff', 'outsider@example.test', 'Outsider', $3)`,
      [outsider, OTHER_COMPANY, HASH]
    );
    await withServer(asCeo().deps, async (base) => {
      assert.equal((await get(base, `/api/admin/users/${outsider}`)).status, 404);
      assert.equal((await get(base, "/api/admin/users/00000000-0000-4000-8000-000000000000")).status, 404);
      assert.equal((await get(base, "/api/admin/users/not-a-uuid")).status, 404);
      assert.equal((await patch(base, `/api/admin/users/${outsider}`, { displayName: "X" })).status, 404);
      // ...and the listing never had them.
      const listed = (await (await get(base, "/api/admin/users")).json()).users;
      assert.equal(listed.some((u) => u.id === outsider), false);
    });
  });

  test("a duplicate address is 409, and an empty patch is refused", async () => {
    await reset();
    await withServer(asCeo().deps, async (base) => {
      const clash = await post(base, "/api/admin/users", { ...NEW_STAFF, email: "ceo@example.test" });
      assert.equal(clash.status, 409);
      assert.equal((await clash.json()).error.code, "email_unavailable");
      assert.equal((await patch(base, `/api/admin/users/${STAFF}`, {})).status, 400);
    });
  });

  test("EVERYBODY CAN READ THEMSELVES, whatever containment says about them", async () => {
    await reset();
    await withServer(asManager().deps, async (base) => {
      // Containment for a manager pins u.role = 'staff' -- correctly, because they
      // administer staff and not their peers. A manager is not staff, so asking for
      // their OWN row got the same 404 as asking for a stranger's, and Account
      // settings could not be drawn at all. Reading yourself is not administration.
      const self = await get(base, `/api/admin/users/${MANAGER}`);
      assert.equal(self.status, 200);
      assert.equal((await self.json()).email, "thura@example.test");

      // The rule is about YOURSELF and nothing else: a peer is still invisible.
      assert.equal((await get(base, `/api/admin/users/${CEO}`)).status, 404);
    });
  });

  test("your name, your number and your language, set by you", async () => {
    await reset();
    await withServer(asManager().deps, async (base) => {
      // §7A.3: the console language is per-person, and everybody below the platform
      // owner sets their own. A manager who had to ask for it is the version of this
      // rule that reads as an obstacle.
      const changed = await patch(base, `/api/admin/users/${MANAGER}`, {
        displayName: "Thura Z.",
        phone: "09 42 118 9999",
        language: "en"
      });
      assert.equal(changed.status, 200);
      const body = await changed.json();
      assert.equal(body.language, "en");
      assert.equal(body.phone, "09 42 118 9999");

      // null is a value, not an absence: it means "follow my shop", which is the
      // default and has to be reachable again after choosing.
      assert.equal((await (await patch(base, `/api/admin/users/${MANAGER}`, { language: null })).json()).language, null);

      // And the line that has not moved. Your role and your status are somebody
      // else's decision about you.
      assert.equal((await patch(base, `/api/admin/users/${MANAGER}`, { status: "suspended" })).status, 403);
      assert.equal((await patch(base, `/api/admin/users/${MANAGER}`, { role: "company_admin" })).status, 403);
    });
  });
});
