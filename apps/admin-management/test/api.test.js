"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createApi } = require("../public/api.js");

// A stub in the shape fetch actually returns: a status, a json() and the request
// recorded so the assertions can be about what went over the wire.
function stubFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => next.body ?? {}
    };
  };
  return { fetch, calls };
}

const ME = {
  user: { id: "u1", email: "a@example.test", displayName: "A", role: "platform_admin", companyId: null, mustChangePassword: false },
  scope: { kind: "platform", companyId: null, shopIds: [] },
  session: { expiresAt: "2026-08-05T08:00:00.000Z", absoluteExpiresAt: "2026-08-12T00:00:00.000Z" }
};

test("me() returns signedIn with the document on 200", async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: ME });
  const result = await createApi(fetch).me();

  assert.equal(result.state, "signedIn");
  assert.equal(result.me.user.email, "a@example.test");
  assert.equal(calls[0].url, "/api/admin/auth/me");
  // Same origin, so the cookie rides along without any CORS mode.
  assert.equal(calls[0].init.credentials, "same-origin");
});

test("me() returns signedOut on 401 and mustChangePassword on that 403", async () => {
  const out = await createApi(stubFetch({ status: 401, body: { error: { code: "unauthenticated" } } }).fetch).me();
  assert.equal(out.state, "signedOut");

  const forced = await createApi(
    stubFetch({ status: 403, body: { error: { code: "password_change_required" } } }).fetch
  ).me();
  assert.equal(forced.state, "mustChangePassword");
});

test("login() sends JSON and reports signedIn on 200", async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: ME });
  const result = await createApi(fetch).login("a@example.test", "correct-horse-battery");

  assert.equal(result.state, "signedIn");
  assert.equal(calls[0].init.method, "POST");
  // 5.3 requires this exact header on the login route, or core-api answers 415.
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    email: "a@example.test",
    password: "correct-horse-battery"
  });
});

test("login() reports mustChangePassword when the 200 says so", async () => {
  // Spec 4.2: sign-in succeeded and the cookie is set; the account simply cannot do
  // anything else yet. Landing on the ordinary signed-in state and letting them
  // discover the 403 by clicking is the version to avoid.
  const forced = { ...ME, user: { ...ME.user, mustChangePassword: true } };
  const result = await createApi(stubFetch({ status: 200, body: forced }).fetch).login("a@example.test", "x");
  assert.equal(result.state, "mustChangePassword");
});

test("login() surfaces the server's own message and never invents one", async () => {
  // 5.8(b): "wrong password" and "unknown email" must stay indistinguishable. A
  // client that writes its own text is how they drift apart.
  const body = { error: { code: "invalid_credentials", message: "Those sign-in details were not accepted." } };
  const result = await createApi(stubFetch({ status: 401, body }).fetch).login("a@example.test", "wrong");

  assert.equal(result.state, "failed");
  assert.equal(result.message, "Those sign-in details were not accepted.");
  assert.equal(result.code, "invalid_credentials");
});

test("login() returns field errors from a 422 without rewording them", async () => {
  const body = { error: { code: "validation_failed", message: "The request could not be processed.", errors: [{ field: "email", code: "required" }] } };
  const result = await createApi(stubFetch({ status: 422, body }).fetch).login("", "x");

  assert.equal(result.state, "failed");
  assert.deepEqual(result.fieldErrors, [{ field: "email", code: "required" }]);
});

test("changePassword() reports the two failures the UI must tell apart", async () => {
  const wrongCurrent = await createApi(
    stubFetch({ status: 403, body: { error: { code: "current_password_invalid", message: "The current password is incorrect." } } }).fetch
  ).changePassword("wrong", "a-brand-new-passphrase");
  assert.equal(wrongCurrent.state, "failed");
  assert.equal(wrongCurrent.code, "current_password_invalid");

  const tooShort = await createApi(
    stubFetch({ status: 422, body: { error: { code: "validation_failed", message: "The request could not be processed.", errors: [{ field: "newPassword", code: "too_short" }] } } }).fetch
  ).changePassword("right", "short");
  assert.deepEqual(tooShort.fieldErrors, [{ field: "newPassword", code: "too_short" }]);
});

test("a transport failure is a distinct state, not a sign-in failure", async () => {
  // The proxy answers 502 when core-api is down. Reporting that as "those sign-in
  // details were not accepted" sends the operator to reset a password that is fine.
  const result = await createApi(stubFetch(new TypeError("fetch failed")).fetch).login("a@example.test", "x");
  assert.equal(result.state, "unreachable");
});

test("the password appears in the body and nowhere else", async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: ME });
  await createApi(fetch).login("a@example.test", "correct-horse-battery");

  assert.doesNotMatch(calls[0].url, /correct-horse-battery/);
  assert.doesNotMatch(JSON.stringify(calls[0].init.headers), /correct-horse-battery/);
});
