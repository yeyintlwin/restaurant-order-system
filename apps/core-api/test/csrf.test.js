"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ORIGIN_GATED_PUBLIC_KEYS, requiresOriginCheck, assertOriginAndContentType } = require("../http/csrf");
const { ApiError } = require("../db/errors");

const ORIGIN = "https://api.yeyintlwin.com";

function entry(method, path, options) {
  return { key: `${method} ${path}`, method, path, options };
}

test("cookie-authenticated non-GET routes are gated", () => {
  assert.equal(requiresOriginCheck(entry("POST", "/api/admin/auth/logout", { auth: "user" })), true);
  assert.equal(requiresOriginCheck(entry("PATCH", "/api/admin/users/:userId", { auth: "user" })), true);
  assert.equal(requiresOriginCheck(entry("PUT", "/api/admin/users/:userId/shops", { auth: "user" })), true);
  assert.equal(requiresOriginCheck(entry("DELETE", "/api/admin/x", { auth: "user" })), true);
});

test("cookie-authenticated GETs are not, and spec 6.3.4 is why", () => {
  // 5.3's prose says "every request authenticated by the cookie"; 6.3.4's
  // exhaustive table and 6.3.3's baseline sets both say "cookie-auth NON-GET".
  // The tables win: SameSite=Lax lets a GET carry the cookie only on a top-level
  // navigation, that changes no state, and the JSON is unreadable to the
  // initiating page because this service emits no CORS for cookie routes.
  assert.equal(requiresOriginCheck(entry("GET", "/api/admin/auth/me", { auth: "user" })), false);
});

test("login is gated even though it is public", () => {
  assert.equal(requiresOriginCheck(entry("POST", "/api/admin/auth/login", { auth: "public" })), true);
  assert.deepEqual(ORIGIN_GATED_PUBLIC_KEYS, ["POST /api/admin/auth/login"]);
});

test("device routes under /api/terminal/ are exempt, which is the rule and not an exception", () => {
  // 5.3: kiosks, native shells and curl send no Origin, and pairing failures are
  // deliberately opaque -- so a 403 there is read as a bad code and the operator
  // burns through reissues. This clause is also what keeps the ONE working
  // authenticated route in the service reachable.
  assert.equal(
    requiresOriginCheck(entry("POST", "/api/terminal/table-displays/:tableNumber", { auth: "terminal" })),
    false
  );
  assert.equal(requiresOriginCheck(entry("POST", "/api/terminal/pair", { auth: "public" })), false);
  assert.equal(requiresOriginCheck(entry("GET", "/health", { auth: "public" })), false);
});

test("a missing or mismatched Origin is 403 origin_not_allowed", () => {
  for (const origin of [undefined, "", "https://evil.test", "https://api.yeyintlwin.com.evil.test", ORIGIN.toUpperCase()]) {
    assert.throws(
      () => assertOriginAndContentType({ origin, contentType: "application/json", apiPublicOrigin: ORIGIN }),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 403);
        assert.equal(error.code, "origin_not_allowed");
        return true;
      },
      JSON.stringify(origin)
    );
  }
});

test("a wrong Content-Type is 415, and the two accepted spellings both pass", () => {
  for (const contentType of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON"]) {
    assert.doesNotThrow(() =>
      assertOriginAndContentType({ origin: ORIGIN, contentType, apiPublicOrigin: ORIGIN })
    );
  }
  for (const contentType of [undefined, "", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    assert.throws(
      () => assertOriginAndContentType({ origin: ORIGIN, contentType, apiPublicOrigin: ORIGIN }),
      (error) => {
        assert.equal(error.status, 415);
        assert.equal(error.code, "unsupported_media_type");
        return true;
      },
      JSON.stringify(contentType)
    );
  }
});

test("Origin is checked BEFORE Content-Type", () => {
  // 6.3.5's ordering is the security property. A request from evil.test with a
  // text/plain body must be told 403, not 415: answering 415 confirms the origin
  // was acceptable, which is a one-bit oracle for whichever origin the attacker is
  // guessing.
  assert.throws(
    () => assertOriginAndContentType({ origin: "https://evil.test", contentType: "text/plain", apiPublicOrigin: ORIGIN }),
    (error) => {
      assert.equal(error.code, "origin_not_allowed");
      return true;
    }
  );
});

test("the header list is exactly the one http/body.js already enforces", () => {
  // Two places must agree about what "JSON" means, and the second is
  // http/body.js's JSON_CONTENT_TYPE. Read it rather than restate it: a route with
  // no body still has to pass the gate, and a gate that accepted a spelling the
  // body reader then rejected would answer 415 AFTER the Origin check, from a
  // different file, for a request that carried nothing.
  const { JSON_CONTENT_TYPE } = require("../http/body");
  assert.match("application/json; charset=utf-8", JSON_CONTENT_TYPE);
  assert.doesNotMatch("application/json; charset=utf-16", JSON_CONTENT_TYPE);
});
