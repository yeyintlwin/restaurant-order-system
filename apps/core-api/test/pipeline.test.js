"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { route, createApp } = require("../http/router");
const { sendJson } = require("../http/respond");
const { SESSION_COOKIE_NAME } = require("../http/cookies");
const { createRateLimiter } = require("../lib/rate-limit");
const { createSemaphore } = require("../lib/semaphore");

// Scratch routes for this file only, exercising each pipeline branch. route-auth
// deliberately registers nothing, so these cannot pollute its census.
const ORIGIN = "https://api.yeyintlwin.com";
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";

route("GET", "/__pipe/open", { auth: "public", sample: {} }, (req, res) => sendJson(res, 200, { ok: true }));
route("GET", "/__pipe/me", { auth: "user", roles: ["anyUser"], sample: {} }, (req, res) =>
  sendJson(res, 200, { userId: req.core.scope.userId, actorKind: req.core.actorKind })
);
route(
  "POST",
  "/__pipe/change",
  { auth: "user", roles: ["anyUser"], body: null, audit: "auth.logout", exemptFromPasswordChange: true, sample: {} },
  (req, res) => sendJson(res, 200, { ok: true })
);
route(
  "POST",
  "/__pipe/guarded",
  { auth: "user", roles: ["anyUser"], body: null, audit: "auth.logout", sample: {} },
  (req, res) => sendJson(res, 200, { ok: true })
);
route(
  "POST",
  "/__pipe/limited",
  { auth: "public", body: null, audit: "auth.login_failed", limit: { key: "ip", name: "login-global" }, sample: {} },
  (req, res) => sendJson(res, 200, { ok: true })
);

const USER = "aaaaaaaa-0003-4000-8000-000000000001";
const SESSION_ID = "aaaaaaaa-0008-4000-8000-000000000001";

function harness(overrides = {}) {
  const renewals = [];
  let at = 1_700_000_000_000;
  const deps = {
    log: () => {},
    apiPublicOrigin: ORIGIN,
    trustedProxyHops: 1,
    sessionIdleSeconds: 28800,
    sessionAbsoluteSeconds: 604800,
    loginRatePerMinute: 3,
    passwordAbuseThreshold: 5,
    adminMintRatePer10min: 20,
    pairingMintRatePer10min: 30,
    pairRatePerMinute: 20,
    rotateRatePerHour: 5,
    rateLimiter: createRateLimiter({ now: () => at }),
    scryptSemaphore: createSemaphore({ slots: 2 }),
    mustChangePassword: false,
    sessions: {
      resolveSession: async () => ({
        sessionId: SESSION_ID, userId: USER, actingCompanyId: null,
        expiresAt: new Date(at + 1000), absoluteExpiresAt: new Date(at + 100000),
        lastSeenAt: new Date(at), email: "a@example.test", displayName: "A",
        role: "company_admin", companyId: "aaaaaaaa-0001-4000-8000-000000000001",
        mustChangePassword: deps.mustChangePassword, actingCompanyStatus: null
      }),
      renewSession: async (input) => { renewals.push(input); return null; }
    },
    scopes: {
      materialiseScope: async (input) => ({ kind: "tenant", userId: input.userId, sessionId: input.sessionId, companyId: input.companyId, role: input.role, shopIds: [] })
    },
    appendAuditEvent: async () => "1",
    ...overrides
  };
  return { deps, renewals, advance: (ms) => { at += ms; } };
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

const cookie = { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` };
const jsonPost = { Origin: ORIGIN, "Content-Type": "application/json", ...cookie };

test("a public route is unaffected by the pipeline", async () => {
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/open`);
    assert.equal(response.status, 200);
  });
});

test("an unknown path is 404 BEFORE any credential or Origin is considered", async () => {
  // Spec 6.3.5 marks step 2 [credential-independent]. Running the Origin gate as
  // an app.use() ahead of matching would answer 403 here, handing an attacker a
  // route-existence oracle that needs no credential at all.
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/nonexistent`, { method: "POST" });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "not_found");
  });
});

test("a cookie-authenticated GET resolves and sets the log actor", async () => {
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/me`, { headers: cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { userId: USER, actorKind: "user" });
  });
});

test("a 401 clears the cookie only when one was presented", async () => {
  // Spec 6.3.4: "+ clearing Set-Cookie only when one was presented". Sending one
  // unconditionally would let any unauthenticated request instruct a browser to
  // drop a cookie it never sent.
  const { deps } = harness({ sessions: { resolveSession: async () => null, renewSession: async () => null } });
  await withServer(deps, async (base) => {
    const without = await fetch(`${base}/__pipe/me`);
    assert.equal(without.status, 401);
    assert.deepEqual(without.headers.getSetCookie(), []);

    const with_ = await fetch(`${base}/__pipe/me`, { headers: cookie });
    assert.equal(with_.status, 401);
    assert.match(with_.headers.getSetCookie().join(), /__Host-core_session=;.*Max-Age=0/);
  });
});

test("must_change_password is 403 on a non-exempt route and passes on an exempt one", async () => {
  // Spec 5.4: "must_change_password is enforced IN THE RESOLVER, not the UI:
  // while true, every route except POST /api/admin/auth/password and
  // POST /api/admin/auth/logout returns 403."
  const { deps } = harness();
  deps.mustChangePassword = true;
  await withServer(deps, async (base) => {
    const blocked = await fetch(`${base}/__pipe/guarded`, { method: "POST", headers: jsonPost });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, "password_change_required");

    const allowed = await fetch(`${base}/__pipe/change`, { method: "POST", headers: jsonPost });
    assert.equal(allowed.status, 200);
  });
});

test("the gate order is 401, then 403 password_change_required, then 403 origin", async () => {
  // 6.3.5 puts step 6 before step 7. Reversed, an attacker with no session learns
  // whether their Origin is allowed before being asked for a credential.
  const { deps } = harness();
  deps.mustChangePassword = true;
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/guarded`, {
      method: "POST",
      headers: { ...cookie, Origin: "https://evil.test", "Content-Type": "text/plain" }
    });
    assert.equal((await response.json()).error.code, "password_change_required");
  });
});

test("a cookie-authenticated POST needs Origin and Content-Type; a GET does not", async () => {
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const noOrigin = await fetch(`${base}/__pipe/change`, {
      method: "POST", headers: { ...cookie, "Content-Type": "application/json" }
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((await noOrigin.json()).error.code, "origin_not_allowed");

    const badType = await fetch(`${base}/__pipe/change`, {
      method: "POST", headers: { ...cookie, Origin: ORIGIN, "Content-Type": "text/plain" }
    });
    assert.equal(badType.status, 415);

    const get = await fetch(`${base}/__pipe/me`, { headers: cookie });
    assert.equal(get.status, 200, "a cookie-auth GET is not origin-gated (6.3.3, 6.3.4)");
  });
});

test("a credential-independent bucket sheds with 429 and NO Retry-After", async () => {
  const { deps } = harness();
  await withServer(deps, async (base) => {
    for (let n = 1; n <= 3; n += 1) {
      const ok = await fetch(`${base}/__pipe/limited`, {
        method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.5" }
      });
      assert.equal(ok.status, 200, `call ${n}`);
    }
    const shed = await fetch(`${base}/__pipe/limited`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.5" }
    });
    assert.equal(shed.status, 429);
    assert.equal(shed.headers.get("retry-after"), null, "login-global must not confirm the bucket");
    assert.equal((await shed.json()).error.code, "rate_limited");
  });
});

test("the credential-independent bucket is consumed BEFORE any credential is read", async () => {
  // Spec 6.3.5 step 4a: "before any scrypt is queued". A limiter that ran after
  // resolution would let an attacker queue work by presenting junk.
  let resolved = 0;
  const { deps } = harness({
    sessions: { resolveSession: async () => { resolved += 1; return null; }, renewSession: async () => null }
  });
  await withServer(deps, async (base) => {
    for (let n = 0; n < 5; n += 1) {
      await fetch(`${base}/__pipe/limited`, {
        method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.6" }
      });
    }
  });
  assert.equal(resolved, 0, "a public route must not resolve a credential at all");
});

test("a rejected request never extends a session; a successful one does", async () => {
  // The invariant of 5.2 and 6.3.5 step 14, and the attack it closes: a script on
  // order.yeyintlwin.com can fetch(..., {credentials:'include'}) every five
  // minutes, collect 403 origin_not_allowed each time, and hold an unattended till
  // session alive to the 7-day absolute cap.
  const { deps, renewals } = harness();
  await withServer(deps, async (base) => {
    await fetch(`${base}/__pipe/change`, { method: "POST", headers: { ...cookie, "Content-Type": "application/json" } });
    assert.deepEqual(renewals, [], "a 403 renewed a session");

    await fetch(`${base}/__pipe/me`, { headers: { ...cookie, "X-Forwarded-For": "198.51.100.7" } });
    assert.equal(renewals.length, 1);
    assert.equal(renewals[0].sessionId, SESSION_ID);
    assert.equal(renewals[0].lastSeenIp, "198.51.100.7");
  });
});

test("a renewal failure is logged on its own line and never surfaces", async () => {
  // Step 14 runs after the response is written, so a throw there must not be
  // surfaced: the request succeeded, and the only casualty is an idle window that
  // slides a minute later. The log half is asserted because the obvious way to
  // write it -- req.core.logExtra.renewal = "failed" -- is a DEAD WRITE. A real
  // renewSession awaits a database round trip, so res.on("finish") has long since
  // fired and spread logExtra by the time the catch runs, and the write is
  // discarded unread. That mistake passes a status-only test, which is why this
  // one reads the lines.
  const lines = [];
  const { deps } = harness({
    log: (line) => lines.push(line),
    sessions: {
      resolveSession: async () => ({
        sessionId: SESSION_ID, userId: USER, actingCompanyId: null,
        expiresAt: new Date(), absoluteExpiresAt: new Date(), lastSeenAt: new Date(),
        email: "a@example.test", displayName: "A", role: "company_admin",
        companyId: "aaaaaaaa-0001-4000-8000-000000000001",
        mustChangePassword: false, actingCompanyStatus: null
      }),
      renewSession: async () => { throw new Error("connection terminated unexpectedly"); }
    }
  });
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/me`, { headers: cookie });
    assert.equal(response.status, 200);
  });

  // Two lines for one request: the access line from res.on("finish") and the
  // renewal failure. Selected by `level`, never by index -- whether "finish" beats
  // the catch depends on whether the socket write completes in a nextTick or in an
  // I/O callback, and a test that pins that ordering pins the wrong thing.
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed.length, 2, lines.join(" | "));
  const access = parsed.find((line) => line.level === undefined);
  const failure = parsed.find((line) => line.level === "error");
  assert.equal(access.status, 200);
  assert.equal(access.renewal, undefined, "the access log is one line per request and carries no renewal field");
  assert.equal(failure.route, "/__pipe/me");
  assert.equal(failure.status, 200);
  assert.equal(failure.requestId, access.requestId, "the two lines must be joinable on requestId");
  assert.match(failure.message, /^renewSession: connection terminated unexpectedly$/);
});

test("the existing terminal route still works: the pipeline resolves nothing for it", async () => {
  // THE REGRESSION THIS WHOLE TASK RISKS. POST /api/terminal/table-displays/:tableNumber
  // authenticates a configured service token in its own handler and has no
  // terminal_tokens row behind it. A pipeline that resolved a bearer would 401 it
  // before the handler ran, and a pipeline that origin-gated /api/terminal/* would
  // 403 it.
  require("../http/routes/table-displays");
  const { deps } = harness({
    tableDisplay: { configured: true, updateTableDisplay: async () => ({ ok: true }) },
    tableDisplayServiceToken: "0123456789abcdef0123456789abcdef"
  });
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/api/terminal/table-displays/7`, {
      method: "POST",
      headers: { Authorization: "Bearer 0123456789abcdef0123456789abcdef", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "Welcome", orderingUrl: "https://order.example.test/t/AAAAAAAAAAAAAAAAAAAAAA" })
    });
    assert.equal(response.status, 200, "no Origin header, no cookie, and it must still be 200");
  });
});
