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
require("../http/routes/platform-admins");

const ORIGIN = "https://api.yeyintlwin.com";
const ME = "aaaaaaaa-0003-4000-8000-000000000041";
const OTHER = "aaaaaaaa-0003-4000-8000-000000000042";
const SESSION_ID = "aaaaaaaa-0008-4000-8000-000000000041";
const COOKIE = `${SESSION_COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAA`;
const POST_HEADERS = { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7", Cookie: COOKIE };
const HASH = `scrypt$N=32768,r=8,p=1$${"c".repeat(22)}$${"k".repeat(43)}`;

const PLATFORM_SCOPE = createScope({ kind: "platform", userId: ME, sessionId: SESSION_ID });

function harness() {
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
          sessionId: SESSION_ID, userId: ME, role: "platform_admin", companyId: null,
          actingCompanyId: null, email: "me@example.test", displayName: "Me",
          mustChangePassword: false, status: "active", companyStatus: null
        }),
        renewSession: async () => null
      },
      scopes: { materialiseScope: async () => PLATFORM_SCOPE },
      appendAuditEvent: async (event) => { audits.push(event); return "1"; },
      platformAdmins: require("../repositories/platform/admins"),
      platformAudit: require("../repositories/platform/audit")
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

describe("the platform admins routes", { skip: skipDatabaseTests() }, () => {
  let db;

  before(async () => {
    db = await cloneTemplate(__filename);
    openRuntimePool({ connectionString: db.connectionString, max: 4 });
  });
  after(async () => {
    await closeAllPools();
    await db.drop();
  });

  async function reset({ second = false } = {}) {
    await db.resetFixtures();
    await db.unscoped(
      `INSERT INTO users (id, company_id, role, email, display_name, password_hash)
       VALUES ($1, NULL, 'platform_admin', 'me@example.test', 'Me', $2)`,
      [ME, HASH]
    );
    if (second) {
      await db.unscoped(
        `INSERT INTO users (id, company_id, role, email, display_name, password_hash)
         VALUES ($1, NULL, 'platform_admin', 'other@example.test', 'Other', $2)`,
        [OTHER, HASH]
      );
    }
  }

  test("the sole route that creates a peer does so, and hands over the password", async () => {
    await reset();
    const { deps, audits } = harness();
    await withServer(deps, async (base) => {
      const response = await post(base, "/api/platform/admins", {
        email: "second@example.test", displayName: "Second Admin"
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(response.headers.get("location"), `/api/platform/admins/${body.id}`);
      assert.match(body.initialPassword, /^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/);
      assert.equal(body.mustChangePassword, true);
      assert.equal(audits.length, 0, "the platform writer joins the transaction, not the pre-tenant one");

      // §6.2's lost-response repair has to be executable: the GET exists so the
      // Location is followable.
      const followed = await get(base, `/api/platform/admins/${body.id}`);
      assert.equal(followed.status, 200);
      assert.equal((await followed.json()).initialPassword, undefined);
    });
    const rows = await db.unscoped("SELECT action, target_id FROM audit_events");
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].action, "platform.admin_created");
  });

  test("a platform admin has no company, whatever the row says", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      const body = await (await post(base, "/api/platform/admins", {
        email: "second@example.test", displayName: "Second"
      })).json();
      const { rows } = await db.unscoped("SELECT company_id, role FROM users WHERE id = $1", [body.id]);
      // users_platform_admin_has_no_company makes this a constraint rather than a
      // convention, and the repository writes NULL explicitly rather than trusting it.
      assert.equal(rows[0].company_id, null);
      assert.equal(rows[0].role, "platform_admin");
    });
  });

  test("THE LAST ACTIVE ADMINISTRATOR CANNOT BE SUSPENDED", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      // §9.1: they have nobody above them. Suspending the last one is a door
      // locked from the inside with the key still in it -- and the last time this
      // happened for real it was repaired with SQL on the box.
      const created = await (await post(base, "/api/platform/admins", {
        email: "second@example.test", displayName: "Second"
      })).json();

      // Two active now, so suspending one is allowed...
      assert.equal((await patch(base, `/api/platform/admins/${created.id}`, { status: "suspended" })).status, 200);

      // ...and now there is one, and it is me, so it is refused. Suspending
      // yourself is refused earlier and for its own reason.
      const other = await (await post(base, "/api/platform/admins", {
        email: "third@example.test", displayName: "Third"
      })).json();
      await patch(base, `/api/platform/admins/${other.id}`, { status: "suspended" });

      const suicide = await patch(base, `/api/platform/admins/${ME}`, { status: "suspended" });
      assert.equal(suicide.status, 403);
      assert.equal((await suicide.json()).error.code, "self_modification_forbidden");
    });
  });

  test("the refusal is by COUNT, not by identity", async () => {
    await reset({ second: true });
    await withServer(harness().deps, async (base) => {
      // Two active: suspending the other one is fine.
      assert.equal((await patch(base, `/api/platform/admins/${OTHER}`, { status: "suspended" })).status, 200);
    });
    // One active left, and it is not me -- so the count rule has to fire on
    // somebody else's row too, not just on self-suspension.
    await reset({ second: true });
    await db.unscoped("UPDATE users SET status = 'suspended' WHERE id = $1", [ME]);
    await withServer(harness().deps, async (base) => {
      const response = await patch(base, `/api/platform/admins/${OTHER}`, { status: "suspended" });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "last_platform_admin");
    });
  });

  test("suspending an already-suspended admin is a no-op, not a lockout", async () => {
    await reset({ second: true });
    await db.unscoped("UPDATE users SET status = 'suspended' WHERE id = $1", [OTHER]);
    await withServer(harness().deps, async (base) => {
      // Only ME is active, but OTHER is already suspended, so this changes
      // nothing about how many people can sign in.
      const response = await patch(base, `/api/platform/admins/${OTHER}`, { status: "suspended" });
      assert.equal(response.status, 200);
    });
  });

  test("role is refused by name rather than silently ignored", async () => {
    await reset({ second: true });
    await withServer(harness().deps, async (base) => {
      const response = await patch(base, `/api/platform/admins/${OTHER}`, { role: "staff", displayName: "X" });
      assert.equal(response.status, 422);
      assert.deepEqual((await response.json()).error.errors, [{ field: "role", code: "immutable" }]);
    });
  });

  test("a password reset unlocks as well, and never targets yourself", async () => {
    await reset({ second: true });
    await db.unscoped(
      "UPDATE users SET failed_login_count = 5, locked_until = now() + interval '1 hour' WHERE id = $1",
      [OTHER]
    );
    await withServer(harness().deps, async (base) => {
      const response = await post(base, `/api/platform/admins/${OTHER}/password-reset`);
      assert.equal(response.status, 200);
      assert.match((await response.json()).initialPassword, /^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/);
      assert.equal((await post(base, `/api/platform/admins/${ME}/password-reset`)).status, 403);
    });
    const { rows } = await db.unscoped(
      "SELECT failed_login_count, locked_until, must_change_password FROM users WHERE id = $1", [OTHER]
    );
    assert.equal(rows[0].failed_login_count, 0);
    assert.equal(rows[0].locked_until, null);
    assert.equal(rows[0].must_change_password, true);
  });

  test("a tenant user id is the same 404 as nobody at all", async () => {
    await reset();
    const tenantUser = "aaaaaaaa-0003-4000-8000-000000000043";
    const company = "aaaaaaaa-0001-4000-8000-000000000041";
    await db.unscoped("INSERT INTO companies (id, name, slug) VALUES ($1, 'C', 'c-one')", [company]);
    await db.unscoped(
      `INSERT INTO users (id, company_id, role, email, display_name, password_hash)
       VALUES ($1, $2, 'company_admin', 'ceo@example.test', 'CEO', $3)`,
      [tenantUser, company, HASH]
    );
    await withServer(harness().deps, async (base) => {
      // Every statement pins company_id IS NULL AND role = 'platform_admin', so a
      // company's admin must read as absent here rather than as a user this route
      // is willing to edit.
      assert.equal((await get(base, `/api/platform/admins/${tenantUser}`)).status, 404);
      assert.equal((await patch(base, `/api/platform/admins/${tenantUser}`, { displayName: "X" })).status, 404);
      assert.equal((await post(base, `/api/platform/admins/${tenantUser}/password-reset`)).status, 404);
      assert.equal((await get(base, "/api/platform/admins/not-a-uuid")).status, 404);

      const listed = (await (await get(base, "/api/platform/admins")).json()).admins;
      assert.deepEqual(listed.map((a) => a.id), [ME]);
    });
  });

  test("a duplicate address is 409 and the vocabulary code says which one", async () => {
    await reset();
    await withServer(harness().deps, async (base) => {
      const clash = await post(base, "/api/platform/admins", { email: "me@example.test", displayName: "Twin" });
      assert.equal(clash.status, 409);
      assert.equal((await clash.json()).error.code, "email_unavailable");
    });
  });
});
