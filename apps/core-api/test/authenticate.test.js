"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { sessionTokensPresented, clientAddressOf, authenticateUser } = require("../http/authenticate");
const { SESSION_COOKIE_NAME } = require("../http/cookies");
const { hashToken } = require("../lib/tokens");
const { ApiError } = require("../db/errors");

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBBBB";
const USER = "aaaaaaaa-0003-4000-8000-000000000001";
const SESSION = "aaaaaaaa-0008-4000-8000-000000000001";
const COMPANY = "aaaaaaaa-0001-4000-8000-000000000001";

function request(headers = {}) {
  return { headers, core: { deps: {} } };
}

// A stub pair standing in for the two repositories. No database: this file is
// about the CHANNEL, and both repositories have their own database suites.
function deps(overrides = {}) {
  return {
    sessions: {
      resolveSession: async (tokenHash) =>
        tokenHash.equals(hashToken(TOKEN))
          ? {
              sessionId: SESSION, userId: USER, actingCompanyId: null,
              expiresAt: new Date(), absoluteExpiresAt: new Date(), lastSeenAt: new Date(),
              email: "a-admin@example.test", displayName: "A Admin",
              role: "company_admin", companyId: COMPANY,
              mustChangePassword: false, actingCompanyStatus: null
            }
          : null
    },
    scopes: {
      materialiseScope: async (input) => ({ kind: "tenant", role: input.role, companyId: input.companyId, shopIds: [] })
    },
    ...overrides
  };
}

test("a session presented in the cookie resolves", async () => {
  const result = await authenticateUser(request({ cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` }), deps());
  assert.equal(result.session.userId, USER);
  assert.equal(result.scope.companyId, COMPANY);
});

test("no cookie is 401 unauthenticated", async () => {
  await assert.rejects(() => authenticateUser(request(), deps()), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "unauthenticated");
    return true;
  });
});

test("TWO session cookies is 401, and is not resolved by picking one", async () => {
  // Spec 6.3.4 names it explicitly. Picking the first is the natural
  // implementation and it is the vulnerability: an attacker who can set a cookie
  // on a sibling host shadows the real session with one the server then trusts.
  // Picking the LAST is no better -- it just moves which one wins.
  const req = request({ cookie: `${SESSION_COOKIE_NAME}=${TOKEN}; ${SESSION_COOKIE_NAME}=${OTHER}` });
  await assert.rejects(() => authenticateUser(req, deps()), /unauthenticated/);
  assert.equal(sessionTokensPresented(req).length, 2);
});

test("a session token in Authorization is NOT accepted -- strict channel binding", async () => {
  // Spec 5.3: "a session cookie is never accepted from an Authorization header, a
  // terminal token is never accepted from a cookie or a query string, and
  // presenting both credentials does not widen access." The last clause is the one
  // that gets lost: a resolver that tries the cookie and FALLS BACK to the header
  // satisfies the first two sentences and violates the third.
  await assert.rejects(
    () => authenticateUser(request({ authorization: `Bearer ${TOKEN}` }), deps()),
    /unauthenticated/
  );
});

test("presenting both a bad cookie and a good bearer does not widen access", async () => {
  await assert.rejects(
    () => authenticateUser(
      request({ cookie: `${SESSION_COOKIE_NAME}=${OTHER}`, authorization: `Bearer ${TOKEN}` }),
      deps()
    ),
    /unauthenticated/
  );
});

test("a malformed cookie value is refused before it reaches the database", async () => {
  // hashToken() would happily digest any string, so an unfiltered value turns
  // every junk cookie into an indexed lookup. The shape check is free and keeps
  // the unauthenticated path off the database.
  let calls = 0;
  const spy = deps({ sessions: { resolveSession: async () => { calls += 1; return null; } } });
  await assert.rejects(() => authenticateUser(request({ cookie: `${SESSION_COOKIE_NAME}=nope` }), spy), /unauthenticated/);
  assert.equal(calls, 0, "a malformed token must not reach resolveSession");
});

test("authenticateUser never writes: it returns the session and leaves renewal to step 14", async () => {
  // Spec 6.3.5: "Resolution at step 5 is read-only ... Invariant: a rejected
  // request never extends a session." Without it, a script on a same-site sibling
  // can fetch(..., {credentials:'include'}) every five minutes, collect
  // 403 origin_not_allowed each time, and hold an unattended till session alive to
  // the 7-day absolute cap instead of letting it die at the 8-hour idle horizon.
  const calls = [];
  const spy = deps({
    sessions: {
      resolveSession: async () => { calls.push("resolve"); return null; },
      renewSession: async () => { calls.push("renew"); return null; }
    }
  });
  await assert.rejects(() => authenticateUser(request({ cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` }), spy));
  assert.deepEqual(calls, ["resolve"]);
});

test("clientAddressOf counts from the right and fails closed", () => {
  assert.deepEqual(clientAddressOf({ headers: { "x-forwarded-for": "1.2.3.4, 9.9.9.9" } }, 1), {
    ip: "9.9.9.9", bucketKey: "9.9.9.9", trusted: true
  });
  // Hop count 0 (the development default) trusts nothing, so every request lands
  // in the one shared "unknown" bucket -- strictest, and the correct fail-closed
  // answer when no proxy is declared.
  assert.deepEqual(clientAddressOf({ headers: { "x-forwarded-for": "1.2.3.4" } }, 0), {
    ip: null, bucketKey: "unknown", trusted: false
  });
  assert.equal(clientAddressOf({ headers: {} }, 1).bucketKey, "unknown");
  // A repeated header arrives as an array; joining it would invent an entry
  // boundary no proxy wrote.
  assert.equal(clientAddressOf({ headers: { "x-forwarded-for": ["1.2.3.4", "5.6.7.8"] } }, 1).trusted, false);
});
