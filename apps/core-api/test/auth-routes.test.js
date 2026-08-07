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
    companyName: "Sakura Kitchen",
    companySlug: "sakura",
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
    // The whole key set, asserted. Widening the me-document is a decision about
    // what every client is handed on every page load, and this line is what makes
    // that decision arrive in a diff.
    assert.deepEqual(Object.keys(body).sort(), ["company", "scope", "session", "user"]);
    // The company the session ACTS in, named. A CEO has no other way to learn the
    // name of their own company -- no route hands a tenant user their company row.
    assert.deepEqual(body.company, { id: COMPANY, name: "Sakura Kitchen", slug: "sakura" });
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

const SESSION_ROW = {
  sessionId: SESSION_ID,
  userId: USER,
  actingCompanyId: null,
  expiresAt: new Date("2026-08-05T08:00:00.000Z"),
  absoluteExpiresAt: new Date("2026-08-12T00:00:00.000Z"),
  lastSeenAt: new Date("2026-08-05T00:00:00.000Z"),
  email: "till@example.test",
  displayName: "Till",
  role: "company_admin",
  companyId: COMPANY,
  mustChangePassword: false,
  actingCompanyStatus: null
};

// A harness whose session resolver answers, for the five authenticated routes.
// `calls` records the ORDER of repository writes, which is the only way to assert
// "delete before bump" without a clock.
function signedIn(overrides = {}) {
  const calls = [];
  const base = harness();
  const deps = {
    ...base.deps,
    sessions: {
      ...base.deps.sessions,
      resolveSession: async () => ({ ...SESSION_ROW, ...(overrides.session || {}) }),
      renewSession: async () => null,
      deleteSession: async (id) => { calls.push(["deleteSession", id]); return 1; },
      deleteAllSessionsForUser: async (id) => { calls.push(["deleteAllSessionsForUser", id]); return 3; }
    },
    users: {
      ...base.deps.users,
      findById: async () => activeUser(),
      writePasswordHash: async (id, hash, options) => { calls.push(["writePasswordHash", id, options]); },
      bumpSessionsValidFrom: async (id) => { calls.push(["bumpSessionsValidFrom", id]); }
    },
    ...(overrides.deps || {})
  };
  return { deps, calls, audits: base.audits };
}

const COOKIE = { cookie: `${SESSION_COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAA` };
const POST_HEADERS = { Origin: ORIGIN, "Content-Type": "application/json", ...COOKIE };

test("GET me returns the same document login returned", async () => {
  const { deps } = signedIn();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/api/admin/auth/me`, { headers: COOKIE });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.id, USER);
    assert.equal(body.user.mustChangePassword, false);
    assert.equal(body.scope.kind, "tenant");
    assert.deepEqual(body.scope.shopIds, []);
    assert.equal(body.session.expiresAt, "2026-08-05T08:00:00.000Z");
  });
});

test("me is NOT exempt from the password-change gate; logout is", async () => {
  // Spec 6.2 states both, and gives the reason for the asymmetry: me's 403 is
  // self-describing and login already returned mustChangePassword, while a user who
  // cannot sign out has no way to abandon a session they must not use.
  const { deps } = signedIn({ session: { mustChangePassword: true } });
  await withServer(deps, async (base) => {
    const me = await fetch(`${base}/api/admin/auth/me`, { headers: COOKIE });
    assert.equal(me.status, 403);
    assert.equal((await me.json()).error.code, "password_change_required");

    const out = await fetch(`${base}/api/admin/auth/logout`, { method: "POST", headers: POST_HEADERS });
    assert.equal(out.status, 200);
  });
});

test("logout deletes the presenting session and clears the cookie", async () => {
  const { deps, calls, audits } = signedIn();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/api/admin/auth/logout`, { method: "POST", headers: POST_HEADERS });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    // The SAME attributes as the setting cookie: a browser matches the cookie to
    // delete on name + path + domain, so a clearing header with a different Path
    // deletes nothing and the stale cookie comes back on the next request.
    assert.match(response.headers.get("set-cookie"), /^__Host-core_session=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/);
  });
  assert.deepEqual(calls, [["deleteSession", SESSION_ID]]);
  assert.equal(audits[0].action, "auth.logout");
  assert.equal(audits[0].actorUserId, USER);
});

test("logout-all deletes THEN bumps, and reports the count it deleted", async () => {
  // The ordering IS the correctness argument. Bump-then-delete leaves a session
  // created in the gap with created_at > sessions_valid_from, so the resolver
  // accepts it and it survives the one button that exists to kill it.
  const { deps, calls, audits } = signedIn();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/api/admin/auth/logout-all`, { method: "POST", headers: POST_HEADERS });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, revokedSessionCount: 3 });
    assert.match(response.headers.get("set-cookie"), /Max-Age=0$/);
  });
  assert.deepEqual(calls, [
    ["deleteAllSessionsForUser", USER],
    ["bumpSessionsValidFrom", USER]
  ]);
  assert.deepEqual(audits[0].detail, { revokedSessionCount: 3 });
});

test("logout-all IS gated by the password-change requirement", async () => {
  // Only logout and password are exempt -- spec 8.5 rule 3 fixes the set at two, and
  // route-auth.test.js asserts it by set equality. Adding a third here would be a
  // design change, not a convenience.
  const { deps } = signedIn({ session: { mustChangePassword: true } });
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/api/admin/auth/logout-all`, { method: "POST", headers: POST_HEADERS });
    assert.equal(response.status, 403);
  });
});

test("no cookie is 401 and sets no clearing header; a bad cookie is 401 and does", async () => {
  // Spec 6.3.4: the clearing Set-Cookie goes out "only when one was presented".
  // Unconditional, it would let any unauthenticated request instruct a browser to
  // drop a cookie it never sent.
  const { deps } = signedIn({ deps: { sessions: { resolveSession: async () => null, renewSession: async () => null } } });
  await withServer(deps, async (base) => {
    const none = await fetch(`${base}/api/admin/auth/me`);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("set-cookie"), null);

    const stale = await fetch(`${base}/api/admin/auth/me`, { headers: COOKIE });
    assert.equal(stale.status, 401);
    assert.match(stale.headers.get("set-cookie"), /Max-Age=0$/);
  });
});

function changePassword(base, body) {
  return fetch(`${base}/api/admin/auth/password`, {
    method: "POST",
    headers: POST_HEADERS,
    body: JSON.stringify(body)
  });
}

test("a correct current password rewrites the hash, kills every session and mints one", async () => {
  const { deps, calls } = signedIn();
  const created = [];
  deps.sessions = {
    ...deps.sessions,
    createSession: async (input) => {
      created.push(input);
      return {
        id: "aaaaaaaa-0008-4000-8000-000000000002",
        expiresAt: new Date("2026-08-05T09:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-08-12T00:00:00.000Z")
      };
    }
  };

  await withServer(deps, async (base) => {
    const response = await changePassword(base, { currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /^__Host-core_session=[A-Za-z0-9_-]{22}; Path=\/; Secure/);
    const body = await response.json();
    assert.equal(body.user.mustChangePassword, false);
    assert.equal(body.session.expiresAt, "2026-08-05T09:00:00.000Z");
  });

  // WRITE, THEN DELETE, THEN CREATE. writePasswordHash bumps sessions_valid_from, so
  // creating before deleting would delete the session just minted, and creating
  // before writing would mint one the bump then invalidates.
  assert.deepEqual(calls, [
    ["writePasswordHash", USER, { mustChangePassword: false }],
    ["deleteAllSessionsForUser", USER]
  ]);
  assert.equal(created.length, 1);
});

test("a wrong current password is 403, and never touches the login credential", async () => {
  // Spec 5.8(a)/6.3.7(a): writing users.locked_until here lets a STOLEN SESSION drive
  // the legitimate owner's LOGIN lockout -- three 403s, then one request every
  // fourteen minutes holds the fifteen-minute cap forever while the victim reads
  // their own uniform 401 as a typo.
  const { deps, calls } = signedIn();
  await withServer(deps, async (base) => {
    const response = await changePassword(base, { currentPassword: "not-the-password", newPassword: "a-brand-new-passphrase" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "current_password_invalid");
    assert.equal(response.headers.get("set-cookie"), null);
  });
  assert.deepEqual(calls, [], "a failed attempt wrote something");
});

test("the Nth consecutive failure destroys the presenting session, not the account", async () => {
  const { deps, calls, audits } = signedIn();
  deps.passwordAbuseThreshold = 3;

  await withServer(deps, async (base) => {
    for (let n = 0; n < 2; n += 1) {
      const response = await changePassword(base, { currentPassword: "wrong", newPassword: "a-brand-new-passphrase" });
      assert.equal(response.status, 403, `attempt ${n + 1}`);
    }
    const breach = await changePassword(base, { currentPassword: "wrong", newPassword: "a-brand-new-passphrase" });
    assert.equal(breach.status, 429);
    assert.equal((await breach.json()).error.code, "rate_limited");
    assert.ok(Number(breach.headers.get("retry-after")) >= 1);
    assert.match(breach.headers.get("set-cookie"), /Max-Age=0$/);
  });

  assert.deepEqual(calls, [["deleteSession", SESSION_ID]]);
  const abuse = audits.find((event) => event.action === "user.password_change_abuse");
  assert.equal(abuse.outcome, "failure");
  assert.equal(abuse.detail.consecutiveFailures, 3);
});

test("a correct password resets the consecutive count", async () => {
  // Spec 5.8(a): the ceiling counts CONSECUTIVE failures. Without the reset, a user
  // who mistypes twice a month is eventually signed out for succeeding.
  const { deps } = signedIn();
  deps.passwordAbuseThreshold = 2;
  deps.sessions = { ...deps.sessions, createSession: async () => ({ id: SESSION_ID, expiresAt: new Date(), absoluteExpiresAt: new Date() }) };

  await withServer(deps, async (base) => {
    assert.equal((await changePassword(base, { currentPassword: "wrong", newPassword: "a-brand-new-passphrase" })).status, 403);
    assert.equal((await changePassword(base, { currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" })).status, 200);
    assert.equal((await changePassword(base, { currentPassword: "wrong", newPassword: "a-brand-new-passphrase" })).status, 403);
  });
});

test("a policy violation on the new password is 422 on that field", async () => {
  const { deps } = signedIn();
  await withServer(deps, async (base) => {
    const response = await changePassword(base, { currentPassword: PASSWORD, newPassword: "short" });
    assert.equal(response.status, 422);
    assert.deepEqual((await response.json()).error.errors, [{ field: "newPassword", code: "too_short" }]);
  });
});

test("a user who must change their password can reach this route and only this route", async () => {
  const { deps } = signedIn({ session: { mustChangePassword: true } });
  deps.sessions = { ...deps.sessions, createSession: async () => ({ id: SESSION_ID, expiresAt: new Date(), absoluteExpiresAt: new Date() }) };
  await withServer(deps, async (base) => {
    // Spec 6.2: currentPassword is required in ALL cases, including the forced-change
    // flow -- the server-minted initialPassword IS the current password.
    const response = await changePassword(base, { currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" });
    assert.equal(response.status, 200);
  });
});

function selectScope(base, body) {
  return fetch(`${base}/api/admin/scope`, { method: "POST", headers: POST_HEADERS, body: JSON.stringify(body) });
}

function platformAdmin(overrides = {}) {
  const { deps, calls, audits } = signedIn({
    session: { role: "platform_admin", companyId: null, actingCompanyId: null }
  });
  deps.sessions = {
    ...deps.sessions,
    findCompanyForScopeSelection: async () => ({ id: COMPANY, status: "active" }),
    setActingCompany: async (sessionId, companyId) => { calls.push(["setActingCompany", sessionId, companyId]); return 1; },
    ...(overrides.sessions || {})
  };
  deps.scopes = {
    materialiseScope: async (input) =>
      input.actingCompanyId === null
        ? { kind: "platform", userId: input.userId, sessionId: input.sessionId }
        : {
            kind: "tenant", userId: input.userId, sessionId: input.sessionId,
            companyId: input.actingCompanyId, role: "platform_admin",
            shopIds: [], administeredShopIds: [], auditCrossTenant: true
          }
  };
  return { deps, calls, audits };
}

test("selecting a company writes acting_company_id and returns the new scope", async () => {
  const { deps, calls, audits } = platformAdmin();
  await withServer(deps, async (base) => {
    const response = await selectScope(base, { companyId: COMPANY });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.scope.kind, "tenant");
    assert.equal(body.scope.companyId, COMPANY);
    // The user's OWN company stays null -- users_platform_admin_has_no_company makes
    // that a constraint, and the acting company is a session fact, not a user fact.
    assert.equal(body.user.companyId, null);
    assert.deepEqual(body.scope.administeredShopIds, []);
  });
  assert.deepEqual(calls, [["setActingCompany", SESSION_ID, COMPANY]]);
  assert.equal(audits[0].action, "scope.selected");
  assert.equal(audits[0].companyId, COMPANY);
});

test("clearing returns the platform scope and writes scope.cleared with no target", async () => {
  const { deps, calls, audits } = platformAdmin();
  await withServer(deps, async (base) => {
    const response = await selectScope(base, { companyId: null });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.scope.kind, "platform");
    assert.equal(body.scope.companyId, null);
    // ALWAYS an array. A platform scope reaches no shop, and [] is the honest
    // rendering of that -- never a missing key the client has to guess about.
    assert.deepEqual(body.scope.shopIds, []);
    assert.equal("administeredShopIds" in body.scope, false);
  });
  assert.deepEqual(calls, [["setActingCompany", SESSION_ID, null]]);
  assert.equal(audits[0].action, "scope.cleared");
  // audit_events_target_pair is (target_kind IS NULL) = (target_id IS NULL), so a
  // uniform-looking target_kind:'company' with a null id is a CHECK violation.
  assert.equal(audits[0].targetKind, undefined);
  assert.equal(audits[0].targetId, undefined);
});

test("a missing companyId key is 422; an explicit null is not", async () => {
  // Spec 6.2 makes the key required and explicitly nullable, so {} and
  // {"companyId": null} are two different requests and must not collapse into one.
  const { deps } = platformAdmin();
  await withServer(deps, async (base) => {
    const missing = await selectScope(base, {});
    assert.equal(missing.status, 422);
    assert.deepEqual((await missing.json()).error.errors, [{ field: "companyId", code: "required" }]);

    assert.equal((await selectScope(base, { companyId: null })).status, 200);
  });
});

test("an unknown company is 404 and a suspended one is 409, and both are audited", async () => {
  for (const [company, status, code] of [
    [null, 404, "not_found"],
    [{ id: COMPANY, status: "suspended" }, 409, "company_suspended"]
  ]) {
    const { deps, audits } = platformAdmin({ sessions: { findCompanyForScopeSelection: async () => company } });
    await withServer(deps, async (base) => {
      const response = await selectScope(base, { companyId: COMPANY });
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
    });
    assert.equal(audits[0].outcome, "failure");
    // The probed id goes in target_id, which is text with NO foreign key. The
    // company_id COLUMN references companies, so an id that matches no row would
    // raise 23503 inside the failure path and turn a 404 into a 500.
    assert.equal(audits[0].targetId, COMPANY);
    assert.equal(audits[0].companyId, undefined);
  }
});

test("a real company_admin is refused even though `companyAdmin` admits them", async () => {
  // The gap the four aliases cannot close. Without the handler's narrowing, every
  // company admin on the platform could set their own session's acting_company_id.
  const { deps } = signedIn();
  deps.sessions = { ...deps.sessions, setActingCompany: async () => 1, findCompanyForScopeSelection: async () => ({ id: COMPANY, status: "active" }) };
  await withServer(deps, async (base) => {
    const response = await selectScope(base, { companyId: COMPANY });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "forbidden");
  });
});

test("THE BOOTSTRAP ADMIN CAN STILL USE THE FOUR IDENTITY ROUTES", async () => {
  // Part 5 departure (d), and the regression that no other test in this file can see.
  // signedIn() resolves a company_admin and platformAdmin() is otherwise pointed only
  // at /api/admin/scope, so under a plain roles:["anyUser"] the whole suite stays
  // green while the ONLY account this plan creates gets 403 for reading `me`, for
  // signing out, and for changing the password the CLI just set.
  //
  // An unscoped platform admin is what login always produces: it materialises
  // actingCompanyId: null, and materialiseScope answers that with { kind: "platform" }.
  const { deps } = platformAdmin();
  deps.users = {
    ...deps.users,
    findById: async () => activeUser({ role: "platform_admin", companyId: null })
  };
  deps.sessions = {
    ...deps.sessions,
    createSession: async () => ({
      id: SESSION_ID,
      expiresAt: new Date("2026-08-05T08:00:00.000Z"),
      absoluteExpiresAt: new Date("2026-08-12T00:00:00.000Z")
    })
  };

  await withServer(deps, async (base) => {
    const me = await fetch(`${base}/api/admin/auth/me`, { headers: COOKIE });
    assert.equal(me.status, 200, "an unscoped platform admin cannot read me");
    assert.equal((await me.json()).scope.kind, "platform");

    const changed = await fetch(`${base}/api/admin/auth/password`, {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" })
    });
    assert.equal(changed.status, 200, "an unscoped platform admin cannot change their password");

    for (const path of ["/api/admin/auth/logout", "/api/admin/auth/logout-all"]) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: POST_HEADERS });
      assert.equal(response.status, 200, `an unscoped platform admin cannot ${path}`);
    }
  });
});

test("a tenant route alias still refuses an unscoped platform admin", async () => {
  // The other half, and the reason the fix is two aliases rather than a wider
  // `anyUser`. Plan 2c registers ~20 TENANT routes at anyUser; an unscoped platform
  // scope carries no companyId, so admitting it there would drive a tenant query with
  // nothing to bind. 6.3.3 promises those routes answer 409 scope_required -- which
  // NOTHING IN PLAN 2b PRODUCES. This test pins the refusal so Plan 2c inherits a
  // known-closed door rather than an accident.
  const { permits } = require("../lib/authorization");
  const unscoped = { kind: "platform", userId: USER, sessionId: SESSION_ID };
  assert.equal(permits(unscoped, ["anyUser"]), false);
  assert.equal(permits(unscoped, ["manager"]), false);
  assert.equal(permits(unscoped, ["companyAdmin"]), false);
  assert.equal(permits(unscoped, ["platform", "anyUser"]), true);
});
