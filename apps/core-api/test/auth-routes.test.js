"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../http/router");
const { createRateLimiter } = require("../lib/rate-limit");
const { createSemaphore } = require("../lib/semaphore");
const { hashPassword } = require("../lib/password");
const { SESSION_COOKIE_NAME } = require("../http/cookies");

require("../http/routes/auth");

const ORIGIN = "https://api.yeyintlwin.com";
const USER = "aaaaaaaa-0003-4000-8000-000000000001";
const COMPANY = "aaaaaaaa-0001-4000-8000-000000000001";
const SESSION_ID = "aaaaaaaa-0008-4000-8000-000000000001";
const PASSWORD = "correct-horse-battery";

// Hashed ONCE for the whole file. scrypt at N=32768 costs ~100 ms, and a fixture
// rebuilt per test turns this suite into a minute of CPU for no coverage.
let storedHash;

function activeUser(overrides = {}) {
  return {
    id: USER,
    email: "till@example.test",
    displayName: "Till",
    role: "company_admin",
    companyId: COMPANY,
    passwordHash: storedHash,
    mustChangePassword: false,
    status: "active",
    lockedUntil: null,
    failedLoginCount: 0,
    companyStatus: "active",
    ...overrides
  };
}

function harness(overrides = {}) {
  const audits = [];
  const bumped = [];
  const cleared = [];
  const deps = {
    log: () => {},
    apiPublicOrigin: ORIGIN,
    trustedProxyHops: 1,
    sessionIdleSeconds: 28800,
    sessionAbsoluteSeconds: 604800,
    loginRatePerMinute: 30,
    // Small on purpose. The pad is asserted by call ordering, never by wall clock:
    // a timing assertion is the flakiest test a CI box can run.
    loginTimeBudgetMs: 250,
    passwordAbuseThreshold: 5,
    adminMintRatePer10min: 20,
    pairingMintRatePer10min: 30,
    pairRatePerMinute: 20,
    rotateRatePerHour: 5,
    rateLimiter: createRateLimiter({ now: () => 1_700_000_000_000 }),
    scryptSemaphore: createSemaphore({ slots: 2 }),
    users: {
      findByEmailForLogin: async () => activeUser(),
      recordFailedLogin: async (id) => { bumped.push(id); return { failedLoginCount: 1, lockedUntil: null }; },
      recordSuccessfulLogin: async (id) => { cleared.push(id); }
    },
    sessions: {
      createSession: async () => ({
        id: SESSION_ID,
        expiresAt: new Date("2026-08-05T08:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-08-12T00:00:00.000Z")
      })
    },
    scopes: {
      materialiseScope: async (input) => ({
        kind: "tenant",
        userId: input.userId,
        sessionId: input.sessionId,
        companyId: input.companyId,
        role: input.role,
        shopIds: [],
        administeredShopIds: []
      })
    },
    appendAuditEvent: async (event) => { audits.push(event); return "1"; },
    ...overrides
  };
  return { deps, audits, bumped, cleared };
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

function login(base, body, headers = {}) {
  return fetch(`${base}/api/admin/auth/login`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7", ...headers },
    body: JSON.stringify(body)
  });
}

test.before(async () => { storedHash = await hashPassword(PASSWORD); });

test("a correct password returns the me-document and a __Host- cookie", async () => {
  const { deps, cleared } = harness();
  await withServer(deps, async (base) => {
    const response = await login(base, { email: "Till@Example.test", password: PASSWORD });
    assert.equal(response.status, 200);

    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=`), cookie);
    assert.match(cookie, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800$/);

    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["scope", "session", "user"]);
    assert.deepEqual(body.user, {
      id: USER,
      email: "till@example.test",
      displayName: "Till",
      role: "company_admin",
      companyId: COMPANY,
      mustChangePassword: false
    });
    assert.deepEqual(body.scope.shopIds, []);
    assert.deepEqual(body.scope.administeredShopIds, []);
    assert.equal(body.session.expiresAt, "2026-08-05T08:00:00.000Z");
    assert.deepEqual(cleared, [USER]);
  });
});

test("the response carries no password hash anywhere in it", async () => {
  // The login lookup selects password_hash, so the row that reaches the handler
  // holds it. A me-document built by spreading that row would ship a scrypt PHC
  // string to the client, and the 6.3.6 leak scanner does not read 200 bodies.
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const text = await (await login(base, { email: "till@example.test", password: PASSWORD })).text();
    assert.doesNotMatch(text, /scrypt\$/);
    assert.doesNotMatch(text, /passwordHash/);
  });
});

test("every failure cause produces a byte-identical 401", async () => {
  // Spec 6.2: "401 invalid_credentials (uniform: unknown email, wrong password,
  // locked, suspended user, suspended company)". Compared as TEXT with the
  // requestId stripped -- requestId is per-request random and is the only field
  // that legitimately differs.
  const causes = {
    unknown: { findByEmailForLogin: async () => null },
    wrongPassword: { findByEmailForLogin: async () => activeUser() },
    suspendedUser: { findByEmailForLogin: async () => activeUser({ status: "suspended" }) },
    suspendedCompany: { findByEmailForLogin: async () => activeUser({ companyStatus: "suspended" }) },
    locked: { findByEmailForLogin: async () => activeUser({ lockedUntil: new Date(Date.now() + 600_000) }) }
  };

  const seen = new Set();
  for (const [name, users] of Object.entries(causes)) {
    const { deps } = harness();
    deps.users = { ...deps.users, ...users };
    await withServer(deps, async (base) => {
      const response = await login(base, { email: "till@example.test", password: "wrong-password-here" });
      assert.equal(response.status, 401, name);
      assert.equal(response.headers.get("set-cookie"), null, `${name} must not set a cookie`);
      const text = (await response.text()).replace(/"requestId":"[^"]+"/, '"requestId":"X"');
      seen.add(text);
    });
  }
  assert.equal(seen.size, 1, `the five failure causes produced ${seen.size} distinct bodies`);
});

test("an unknown address still writes auth.login_failed with the derived source_ip", async () => {
  // THE ROW THE DEPLOY GATE READS. Spec 5.7: the audit row "is the only externally
  // observable evidence of what the server derived as the client IP, and the deploy
  // gate in 9.5 asserts against it". Its probe uses an address that matches NO user,
  // so a handler that writes the row only when the user exists makes the gate assert
  // on nothing and pass whatever TRUSTED_PROXY_HOPS is set to.
  const { deps, audits, bumped } = harness({
    users: { findByEmailForLogin: async () => null, recordFailedLogin: async () => null, recordSuccessfulLogin: async () => {} }
  });
  await withServer(deps, async (base) => {
    await login(base, { email: "xff-probe@invalid.test", password: "x" }, { "X-Forwarded-For": "203.0.113.99, 10.0.0.1" });
  });

  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], {
    actorKind: "anonymous",
    action: "auth.login_failed",
    outcome: "failure",
    sourceIp: "10.0.0.1",
    detail: { email: "xff-probe@invalid.test" }
  });
  // No user row, so nothing to bump -- and recordFailedLogin(null) would be an
  // UPDATE ... WHERE id = NULL, which matches nothing and hides the mistake.
  assert.deepEqual(bumped, []);
});

test("only a wrong password on an otherwise-eligible account bumps the counter", async () => {
  // A locked account must NOT bump: one request every 14 minutes would then hold
  // the 15-minute cap forever, which is the permanent-DoS shape spec 5.8(a) rejects
  // on the password route for the same reason. A suspended user and a suspended
  // company have no login to throttle.
  for (const [name, user] of Object.entries({
    locked: activeUser({ lockedUntil: new Date(Date.now() + 600_000) }),
    suspendedUser: activeUser({ status: "suspended" }),
    suspendedCompany: activeUser({ companyStatus: "suspended" })
  })) {
    const { deps, bumped } = harness();
    deps.users = { ...deps.users, findByEmailForLogin: async () => user };
    await withServer(deps, async (base) => {
      await login(base, { email: "till@example.test", password: PASSWORD });
    });
    assert.deepEqual(bumped, [], `${name} bumped failed_login_count`);
  }

  const { deps, bumped } = harness();
  await withServer(deps, async (base) => {
    await login(base, { email: "till@example.test", password: "wrong-password-here" });
  });
  assert.deepEqual(bumped, [USER]);
});

test("the scrypt slot is released on the failure path too", async () => {
  // A `finally`-less release leaks one slot per failed login, and with SCRYPT_SLOTS
  // at 2 the service stops answering login after two wrong passwords -- as a 503,
  // which reads as a database problem.
  const semaphore = createSemaphore({ slots: 1, queueDepth: 0 });
  const { deps } = harness({ scryptSemaphore: semaphore });
  await withServer(deps, async (base) => {
    await login(base, { email: "till@example.test", password: "wrong-password-here" });
    assert.deepEqual(semaphore.stats(), { running: 0, queued: 0, slots: 1, queueDepth: 0 });
    const second = await login(base, { email: "till@example.test", password: PASSWORD });
    assert.equal(second.status, 200, "the second login was shed: the first never released");
  });
});

test("a missing field is 422 and names both fields at once", async () => {
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const response = await login(base, {});
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, "validation_failed");
    assert.deepEqual(body.error.errors, [
      { field: "email", code: "required" },
      { field: "password", code: "required" }
    ]);
  });
});

test("an over-long address is refused before the lookup, and 254 exactly is not", async () => {
  // The bound the users.email CHECK already carries. Without it the folded address
  // lands in audit_events.detail on every failure -- see the login_failed row above,
  // which is written for an address that matches nothing -- and that column has no
  // length CHECK and no sweeper until Plan 2d.
  let looked = 0;
  const { deps, audits } = harness({
    users: {
      findByEmailForLogin: async () => { looked += 1; return null; },
      recordFailedLogin: async () => null,
      recordSuccessfulLogin: async () => {}
    }
  });
  await withServer(deps, async (base) => {
    // 242 + "@example.test" (13) = 255, one character past the CHECK.
    const tooLong = await login(base, { email: `${"a".repeat(242)}@example.test`, password: PASSWORD });
    assert.equal(tooLong.status, 422);
    const body = await tooLong.json();
    assert.equal(body.error.code, "validation_failed");
    assert.deepEqual(body.error.errors, [{ field: "email", code: "too_long" }]);
    // The two properties that make this a shape check rather than an oracle: nothing
    // was looked up, and nothing was written. A 422 that reached the database would
    // tell an anonymous caller which addresses are cheap to ask about.
    assert.equal(looked, 0);
    assert.deepEqual(audits, []);

    // 241 + 13 = 254, the last legal length, so it must reach the uniform 401. An
    // exclusive bound here would lock out an address the database would have stored,
    // and the account holder would read it as a wrong password.
    const legal = await login(base, { email: `${"a".repeat(241)}@example.test`, password: PASSWORD });
    assert.equal(legal.status, 401, "254 characters is inside the CHECK, not outside it");
    assert.equal(looked, 1);
  });
});

test("login is origin-gated and content-type-gated, and Origin is answered first", async () => {
  // The one public route that carries the gate (Task 6's ORIGIN_GATED_PUBLIC_KEYS).
  // Origin before Content-Type: answering 415 to a request from evil.test would
  // confirm the origin was acceptable.
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const wrongOrigin = await fetch(`${base}/api/admin/auth/login`, {
      method: "POST",
      headers: { Origin: "https://evil.test", "Content-Type": "text/plain" },
      body: "{}"
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal((await wrongOrigin.json()).error.code, "origin_not_allowed");

    const wrongType = await fetch(`${base}/api/admin/auth/login`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
      body: "{}"
    });
    assert.equal(wrongType.status, 415);
  });
});

test("login's 429 carries NO Retry-After, on the real route", async () => {
  // Spec 6.2 marks login and pair as the two 429s that must not carry the header:
  // it would confirm to an attacker that their probes are landing in a bucket.
  // pipeline.test.js proves the roster honours that on a SCRATCH route; this proves
  // the shipped route declares the right limiter, which is the half that can regress.
  const { deps } = harness({ loginRatePerMinute: 2 });
  await withServer(deps, async (base) => {
    await login(base, { email: "till@example.test", password: "wrong-password-here" });
    await login(base, { email: "till@example.test", password: "wrong-password-here" });
    const shed = await login(base, { email: "till@example.test", password: "wrong-password-here" });
    assert.equal(shed.status, 429);
    assert.equal(shed.headers.get("retry-after"), null);
  });
});
