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
require("../http/routes/companies");

const ORIGIN = "https://api.yeyintlwin.com";
const ADMIN = "aaaaaaaa-0003-4000-8000-000000000009";
const SESSION_ID = "aaaaaaaa-0008-4000-8000-000000000009";
const COOKIE = `${SESSION_COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAA`;
const POST_HEADERS = { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7", Cookie: COOKIE };

// Never verified against -- resolveSession is stubbed, so nothing signs in. It only
// has to satisfy users_password_hash_check, which is LIKE 'scrypt$%' AND 40..512
// characters. The length half is the one that catches a hand-written placeholder.
const PLACEHOLDER_HASH = `scrypt$N=32768,r=8,p=1$${"c".repeat(22)}$${"k".repeat(43)}`;

// THE STAMP IS THE POINT. Copying the object literal out of auth-routes.test.js
// gives an unstamped { kind: "platform", ... }, which reaches assertPlatformScope,
// throws "not produced by createScope()", and presents as an opaque 500 on every
// route in this file -- with the fixture at fault and the route looking guilty.
// db/scope.js is the only thing that can mint one.
const PLATFORM_SCOPE = createScope({ kind: "platform", userId: ADMIN, sessionId: SESSION_ID });
const TENANT_SCOPE = createScope({
  kind: "tenant",
  userId: ADMIN,
  sessionId: SESSION_ID,
  companyId: "aaaaaaaa-0001-4000-8000-000000000001",
  role: "company_admin",
  shopIds: [],
  administeredShopIds: []
});

const SESSION_ROW = Object.freeze({
  sessionId: SESSION_ID,
  userId: ADMIN,
  role: "platform_admin",
  companyId: null,
  actingCompanyId: null,
  email: "padmin@example.test",
  displayName: "P Admin",
  mustChangePassword: false,
  status: "active",
  companyStatus: null
});

function harness(overrides = {}) {
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
        resolveSession: async () => ({ ...SESSION_ROW, ...(overrides.session || {}) }),
        renewSession: async () => null
      },
      scopes: { materialiseScope: async () => overrides.scope || PLATFORM_SCOPE },
      appendAuditEvent: async (event) => { audits.push(event); return "1"; },
      // The REAL repositories. Stubbing them here would leave the SQL, the
      // conflicts mapping and the audit atomicity untested -- which is most of
      // what this slice is.
      companies: require("../repositories/platform/companies"),
      platformAudit: require("../repositories/platform/audit"),
      ...(overrides.deps || {})
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

const get = (base, path) => fetch(`${base}${path}`, { headers: { "X-Forwarded-For": "203.0.113.7", Cookie: COOKIE } });
const post = (base, body) =>
  fetch(`${base}/api/platform/companies`, { method: "POST", headers: POST_HEADERS, body: JSON.stringify(body) });
const patch = (base, id, body) =>
  fetch(`${base}/api/platform/companies/${id}`, { method: "PATCH", headers: POST_HEADERS, body: JSON.stringify(body) });

describe("the platform companies routes", { skip: skipDatabaseTests() }, () => {
  let db;

  before(async () => {
    db = await cloneTemplate(__filename);
    openRuntimePool({ connectionString: db.connectionString, max: 4 });
  });
  after(async () => {
    await closeAllPools();
    await db.drop();
  });

  // companies.created_by_user_id and audit_events.actor_user_id both REFERENCE
  // users, so the acting administrator has to be a real row or every write is a
  // 23503 the route reports as a 500.
  async function reset() {
    await db.resetFixtures();
    await db.unscoped(
      `INSERT INTO users (id, company_id, role, email, display_name, password_hash)
       VALUES ($1, NULL, 'platform_admin', 'padmin@example.test', 'P Admin', $2)`,
      [ADMIN, PLACEHOLDER_HASH]
    );
  }

  test("a tenant scope is refused by the platform alias", async () => {
    await reset();
    const { deps } = harness({ scope: TENANT_SCOPE });
    await withServer(deps, async (base) => {
      const response = await get(base, "/api/platform/companies");
      // 403 and the GENERIC code. Spec 6.3.3 promises 409 scope_selected for a
      // platform admin who has chosen a company, and NOTHING in the service
      // produces that code yet -- the static role gate answers first. Asserted as
      // it behaves, not as the spec wishes, so the day a producer is added this
      // test is what notices.
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "forbidden");
    });
  });

  test("an empty platform lists nothing, and a created company appears", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      assert.deepEqual((await (await get(base, "/api/platform/companies")).json()).companies, []);

      const created = await post(base, { name: "Sakura Kitchen", slug: "sakura" });
      assert.equal(created.status, 201);
      const company = await created.json();
      // Rule 7 of the route table, made real: the Location points at the GET
      // registered in the same file.
      assert.equal(created.headers.get("location"), `/api/platform/companies/${company.id}`);
      assert.equal(company.slug, "sakura");
      // Summed from the shops, never stored -- so a brand new company is 0 and 0
      // without anything having written a zero anywhere.
      assert.equal(company.shopCount, 0);
      assert.equal(company.tableCount, 0);

      const listed = (await (await get(base, "/api/platform/companies")).json()).companies;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, company.id);

      const one = await get(base, `/api/platform/companies/${company.id}`);
      assert.equal(one.status, 200);
      assert.deepEqual(await one.json(), company);
    });
  });

  test("creating a company writes exactly one audit row, in the same transaction", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      const company = await (await post(base, { name: "Sakura Kitchen", slug: "sakura" })).json();
      const { rows } = await db.unscoped(
        "SELECT action, outcome, company_id, target_kind, target_id, detail FROM audit_events"
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, "company.created");
      assert.equal(rows[0].outcome, "success");
      assert.equal(rows[0].company_id, company.id);
      assert.equal(rows[0].target_id, company.id);
      assert.deepEqual(rows[0].detail, { name: "Sakura Kitchen", slug: "sakura" });
    });
  });

  test("a duplicate slug is 409 company_slug_taken and leaves no audit row", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      await post(base, { name: "Sakura Kitchen", slug: "sakura" });
      const clash = await post(base, { name: "Something Else", slug: "sakura" });
      assert.equal(clash.status, 409);
      assert.equal((await clash.json()).error.code, "company_slug_taken");

      // The rollback half. One company, one audit row -- the failed attempt left
      // neither, because the insert and the audit share a transaction.
      const companies = await db.unscoped("SELECT id FROM companies");
      const audits = await db.unscoped("SELECT id FROM audit_events");
      assert.equal(companies.rows.length, 1);
      assert.equal(audits.rows.length, 1);
    });
  });

  test("a duplicate NAME is its own code, distinct from the slug's", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      await post(base, { name: "Sakura Kitchen", slug: "sakura" });
      const clash = await post(base, { name: "Sakura Kitchen", slug: "sakura-two" });
      assert.equal(clash.status, 409);
      assert.equal((await clash.json()).error.code, "company_name_taken");
    });
  });

  test("both missing fields are named at once, not one per round trip", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      const response = await post(base, {});
      assert.equal(response.status, 422);
      assert.deepEqual((await response.json()).error.errors, [
        { field: "name", code: "required" },
        { field: "slug", code: "required" }
      ]);
    });
  });

  test("every shape the slug rule forbids is refused, and never repaired", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      const cases = [
        ["Sakura Kitchen", "pattern"],   // a space
        ["Sakura", "pattern"],           // upper case
        ["1sakura", "pattern"],          // leading digit
        ["sakura-", "pattern"],          // trailing hyphen
        ["sakura--x", "pattern"],        // doubled hyphen
        ["s", "too_short"],
        ["a".repeat(25), "too_long"]
      ];
      for (const [slug, code] of cases) {
        const response = await post(base, { name: "A Company", slug });
        assert.equal(response.status, 422, slug);
        assert.deepEqual((await response.json()).error.errors, [{ field: "slug", code }], slug);
      }
      // " sakura " is NOT trimmed into "sakura". Silently repairing it would mean
      // the address the caller was shown is not the address that was stored.
      const padded = await post(base, { name: "A Company", slug: " sakura " });
      assert.equal(padded.status, 422);
      assert.deepEqual((await padded.json()).error.errors, [{ field: "slug", code: "pattern" }]);
    });
  });

  test("a malformed path id is 404, never 422", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      // Spec 6.3.3: unknown route, unknown resource and resource outside scope are
      // one answer. A typed refusal here confirms a real resource type at a real id.
      for (const id of ["not-a-uuid", "12345", "00000000-0000-4000-8000-00000000000"]) {
        const response = await get(base, `/api/platform/companies/${id}`);
        assert.equal(response.status, 404, id);
        assert.equal((await response.json()).error.code, "not_found", id);
      }
      const unknown = await get(base, "/api/platform/companies/00000000-0000-4000-8000-000000000000");
      assert.equal(unknown.status, 404);
    });
  });

  test("a rename is audited; an empty patch is refused before anything is read", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      const company = await (await post(base, { name: "Sakura Kitchen", slug: "sakura" })).json();

      const renamed = await patch(base, company.id, { name: "Sakura Group", status: "suspended" });
      assert.equal(renamed.status, 200);
      const body = await renamed.json();
      assert.equal(body.name, "Sakura Group");
      assert.equal(body.status, "suspended");
      // An absent key means "do not change", so the slug survives a body that never
      // mentioned it.
      assert.equal(body.slug, "sakura");

      const { rows } = await db.unscoped(
        "SELECT action, detail FROM audit_events WHERE action = 'company.updated'"
      );
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].detail, { name: "Sakura Group", slug: "sakura", status: "suspended" });

      const empty = await patch(base, company.id, {});
      assert.equal(empty.status, 400);
      assert.equal((await empty.json()).error.code, "invalid_request");
    });
  });

  test("patching a company that does not exist is 404 and audits nothing", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      const response = await patch(base, "00000000-0000-4000-8000-000000000000", { name: "Ghost" });
      assert.equal(response.status, 404);
      // company.updated declares outcome success ONLY. A failure row here would be
      // refused by the vocabulary and would turn this 404 into a 500.
      const { rows } = await db.unscoped("SELECT id FROM audit_events WHERE action = 'company.updated'");
      assert.equal(rows.length, 0);
    });
  });

  test("the list query is validated, and both failures are named", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      const bad = await get(base, "/api/platform/companies?status=deleted&limit=0");
      assert.equal(bad.status, 422);
      assert.deepEqual((await bad.json()).error.errors, [
        { field: "status", code: "not_in_enum" },
        { field: "limit", code: "out_of_range" }
      ]);
    });
  });

  test("?status filters, and all is the default rather than a third state", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      const a = await (await post(base, { name: "Active Co", slug: "active-co" })).json();
      const b = await (await post(base, { name: "Suspended Co", slug: "suspended-co" })).json();
      await patch(base, b.id, { status: "suspended" });

      const all = (await (await get(base, "/api/platform/companies")).json()).companies;
      assert.equal(all.length, 2);
      const active = (await (await get(base, "/api/platform/companies?status=active")).json()).companies;
      assert.deepEqual(active.map((c) => c.id), [a.id]);
      const suspended = (await (await get(base, "/api/platform/companies?status=suspended")).json()).companies;
      assert.deepEqual(suspended.map((c) => c.id), [b.id]);
      // Explicit "all" and no parameter at all are the same request.
      const explicit = (await (await get(base, "/api/platform/companies?status=all")).json()).companies;
      assert.equal(explicit.length, 2);
    });
  });

  test("the counts are summed from the shops, so they cannot drift", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      const company = await (await post(base, { name: "Sakura Kitchen", slug: "sakura" })).json();
      const shop = "aaaaaaaa-0002-4000-8000-000000000001";
      await db.unscoped(
        `INSERT INTO shops (id, company_id, name, slug, time_zone, business_day_rollover_hour, currency, language)
         VALUES ($1, $2, 'Bogyoke', 'bogyoke', 'Asia/Yangon', 6, 'MMK', 'my')`,
        [shop, company.id]
      );
      await db.unscoped(
        `INSERT INTO shop_tables (company_id, shop_id, label) VALUES ($1, $2, '1'), ($1, $2, '2')`,
        [company.id, shop]
      );

      // Nothing wrote a count anywhere. The next read simply says two.
      const one = await (await get(base, `/api/platform/companies/${company.id}`)).json();
      assert.equal(one.shopCount, 1);
      assert.equal(one.tableCount, 2);
      const listed = (await (await get(base, "/api/platform/companies")).json()).companies;
      assert.equal(listed[0].tableCount, 2);
    });
  });

  test("the CEO rides along, and a company without one says so rather than omitting it", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      const company = await (await post(base, { name: "Sakura Kitchen", slug: "sakura" })).json();
      // The console draws "No CEO yet" and offers the action that fixes it. That
      // needs a key that is present and null, not a key that is absent.
      assert.equal(company.ceo, null);

      const ceo = "aaaaaaaa-0003-4000-8000-000000000051";
      await db.unscoped(
        `INSERT INTO users (id, company_id, role, email, display_name, password_hash)
         VALUES ($1, $2, 'company_admin', 'khin@sakura.mm', 'Khin Myat', $3)`,
        [ceo, company.id, PLACEHOLDER_HASH]
      );

      const one = await (await get(base, `/api/platform/companies/${company.id}`)).json();
      assert.deepEqual(one.ceo, { id: ceo, displayName: "Khin Myat", email: "khin@sakura.mm" });
      const listed = (await (await get(base, "/api/platform/companies")).json()).companies;
      assert.deepEqual(listed[0].ceo, { id: ceo, displayName: "Khin Myat", email: "khin@sakura.mm" });

      // A suspended CEO is not a CEO who can sign in, so the row reads as empty and
      // the console offers to appoint one. Anything else shows a name that cannot act.
      await db.unscoped("UPDATE users SET status = 'suspended' WHERE id = $1", [ceo]);
      assert.equal((await (await get(base, `/api/platform/companies/${company.id}`)).json()).ceo, null);
    });
  });

  test("two active CEOs cannot hand back one person's name with another's address", async () => {
    await reset();
    const { deps } = harness();
    await withServer(deps, async (base) => {
      const company = await (await post(base, { name: "Sakura Kitchen", slug: "sakura" })).json();
      // A handover is two active company_admins for as long as it takes. Both
      // subqueries order the same way, so they land on the same row -- an unordered
      // LIMIT 1 in each is how the name and the email come from different people.
      for (const [n, id, email, name] of [
        [1, "aaaaaaaa-0003-4000-8000-000000000061", "first@sakura.mm", "First In"],
        [2, "aaaaaaaa-0003-4000-8000-000000000062", "second@sakura.mm", "Second In"]
      ]) {
        await db.unscoped(
          `INSERT INTO users (id, company_id, role, email, display_name, password_hash, created_at)
           VALUES ($1, $2, 'company_admin', $3, $4, $5, now() + ($6 || ' seconds')::interval)`,
          [id, company.id, email, name, PLACEHOLDER_HASH, String(n)]
        );
      }
      const one = await (await get(base, `/api/platform/companies/${company.id}`)).json();
      assert.deepEqual(one.ceo, {
        id: "aaaaaaaa-0003-4000-8000-000000000061",
        displayName: "First In",
        email: "first@sakura.mm"
      });
    });
  });
});
