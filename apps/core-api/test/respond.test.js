// "use strict" is load-bearing here, not decoration: assigning to a frozen object is a silent
// no-op in sloppy mode, so the Object.isFrozen test below would pass vacuously without it.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { SECURITY_HEADERS, sendJson } = require("../http/respond");

function createResponse() {
  return {
    statusCode: 0,
    ended: false,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = String(value);
    },
    end(chunk) {
      this.body = chunk === undefined ? "" : String(chunk);
      this.ended = true;
    }
  };
}

test("sendJson writes the status, the JSON body and an accurate Content-Length", () => {
  const res = createResponse();

  sendJson(res, 201, { ok: true, app: "core-api" });

  assert.equal(res.statusCode, 201);
  assert.equal(res.ended, true);
  assert.equal(res.body, '{"ok":true,"app":"core-api"}');
  assert.equal(res.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(res.headers["Content-Length"], String(Buffer.byteLength(res.body)));
});

test("every response carries no-store and the security headers", () => {
  const res = createResponse();

  sendJson(res, 200, { ok: true });

  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  assert.equal(res.headers["X-Frame-Options"], "DENY");
  assert.equal(res.headers["Content-Security-Policy"], "default-src 'none'; frame-ancestors 'none'");
});

test("SECURITY_HEADERS is frozen so no caller can weaken it for one route", () => {
  assert.equal(Object.isFrozen(SECURITY_HEADERS), true);
  assert.throws(() => {
    SECURITY_HEADERS["Cache-Control"] = "public";
  }, TypeError);
});

test("caller headers merge on top without dropping the base set", () => {
  const res = createResponse();

  sendJson(res, 405, { error: "x" }, { Allow: "GET, HEAD" });

  assert.equal(res.headers.Allow, "GET, HEAD");
  assert.equal(res.headers["Cache-Control"], "no-store");
});

const { ERROR_MESSAGES, sendError } = require("../http/respond");
const { TOP_LEVEL_ERROR_CODES } = require("../db/errors");

// The scanner from spec §6.3.6 mechanism 4(a). Every error body produced anywhere in the
// suite is checked against it; asserting it here means a bad message string is caught by the
// unit that owns the table rather than by a database suite three plans from now.
const LEAK_SCANNER =
  /(SELECT|INSERT|UPDATE|DELETE|FROM |WHERE |pg_|_key\b|_fkey\b|_check\b|at Object\.|node:internal|\/app\/|scrypt\$|unreachable|checksum_mismatch)/i;

test("sendError serialises exactly the four-key allowlist and drops everything else", () => {
  const res = createResponse();
  const error = new Error("relation \"users\" does not exist");
  error.status = 409;
  error.code = "email_unavailable";
  error.constraint = "users_email_active_key";
  error.detail = "Key (email)=(a@b.test) already exists.";
  error.cause = new Error("pg: 23505");

  sendError(res, error, "k3f9x2ab");

  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId"]);
  assert.equal(body.error.code, "email_unavailable");
  assert.equal(body.error.requestId, "k3f9x2ab");
  assert.doesNotMatch(res.body, /users_email_active_key|does not exist|23505|a@b\.test/);
});

test("the message comes from the static table, never from Error.message", () => {
  const res = createResponse();

  sendError(res, { status: 404, code: "not_found", message: "shop aaaa-0001 is not yours" }, "abcd1234");

  assert.equal(JSON.parse(res.body).error.message, ERROR_MESSAGES.not_found);
  assert.doesNotMatch(res.body, /aaaa-0001|is not yours/);
});

test("errors[] appears only for validation_failed and is reduced to field and code", () => {
  const withErrors = createResponse();
  sendError(
    withErrors,
    { status: 422, code: "validation_failed", errors: [{ field: "timeZone", code: "invalid_time_zone", hint: "Asia/Tokyo" }] },
    "abcd1234"
  );
  const validation = JSON.parse(withErrors.body).error;
  assert.deepEqual(validation.errors, [{ field: "timeZone", code: "invalid_time_zone" }]);

  const without = createResponse();
  sendError(without, { status: 409, code: "shop_name_taken", errors: [{ field: "name", code: "duplicate" }] }, "abcd1234");
  assert.equal("errors" in JSON.parse(without.body).error, false);
});

test("an unknown code degrades to 500 internal_error instead of echoing it", () => {
  const res = createResponse();

  sendError(res, { status: 418, code: "ERR_INVALID_ARG_TYPE" }, "abcd1234");

  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error.code, "internal_error");
});

test("503 always carries Retry-After: 5 and 405 accepts an Allow header", () => {
  const unavailable = createResponse();
  sendError(unavailable, { status: 503, code: "service_unavailable" }, "abcd1234");
  assert.equal(unavailable.headers["Retry-After"], "5");

  const notAllowed = createResponse();
  sendError(notAllowed, { status: 405, code: "method_not_allowed" }, "abcd1234", { Allow: "GET, HEAD" });
  assert.equal(notAllowed.headers.Allow, "GET, HEAD");
  assert.equal(notAllowed.headers["Cache-Control"], "no-store");
});

test("no message in the static table trips the leak scanner", () => {
  // The trap this catches is real and non-obvious: the natural wording for scope_selected is
  // "Clear the SELECTed company", and /SELECT/i matches "selected".
  for (const [code, message] of Object.entries(ERROR_MESSAGES)) {
    assert.doesNotMatch(message, LEAK_SCANNER, `ERROR_MESSAGES.${code}`);
  }
});

test("ERROR_MESSAGES covers exactly the ApiError vocabulary and no code degrades to 500", () => {
  assert.deepEqual(Object.keys(ERROR_MESSAGES).sort(), Object.keys(TOP_LEVEL_ERROR_CODES).sort());

  for (const [code, status] of Object.entries(TOP_LEVEL_ERROR_CODES)) {
    const res = createResponse();
    sendError(res, { status, code }, "abcd1234");
    assert.equal(res.statusCode, status, `${code} silently degraded to ${res.statusCode}`);
    assert.equal(JSON.parse(res.body).error.code, code);
  }
});
