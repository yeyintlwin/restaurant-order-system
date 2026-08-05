"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SESSION_COOKIE_NAME,
  readCookieValues,
  buildSessionCookie,
  buildClearingCookie
} = require("../http/cookies");

test("the cookie is __Host- prefixed, and that is the whole point", () => {
  // Spec 5.2. Host-only scoping controls only what THIS server sets. Any sibling
  // under yeyintlwin.com -- order., epaper-hub., the Phase-7 captive portal serving
  // untrusted guest devices, or a network attacker answering plain HTTP for a
  // non-existent *.yeyintlwin.com name -- can set core_session=<value>;
  // Domain=yeyintlwin.com. The __Host- prefix is what makes that impossible at the
  // browser, and the browser enforces it only if Secure is set, Path is exactly /,
  // and there is NO Domain attribute.
  assert.equal(SESSION_COOKIE_NAME, "__Host-core_session");
});

test("a built cookie carries every attribute the __Host- prefix requires, and no Domain", () => {
  const header = buildSessionCookie("AAAAAAAAAAAAAAAAAAAAAA", 28800);

  assert.match(header, /^__Host-core_session=AAAAAAAAAAAAAAAAAAAAAA;/);
  assert.match(header, /;\s*Path=\/(?:;|$)/);
  assert.match(header, /;\s*Secure(?:;|$)/);
  assert.match(header, /;\s*HttpOnly(?:;|$)/);
  assert.match(header, /;\s*SameSite=Lax(?:;|$)/);
  assert.match(header, /;\s*Max-Age=28800(?:;|$)/);
  // A Domain attribute makes the browser REJECT a __Host- cookie outright, so the
  // failure is "the user can never sign in" rather than a weakened cookie.
  assert.doesNotMatch(header, /Domain=/i);
});

test("SameSite is Lax, not None and not Strict", () => {
  // None would require Secure AND would let any site's fetch carry it, which is
  // the CSRF surface the Origin rule then has to close alone. Strict breaks the
  // ordinary case of following a link into /admin from an email or a bookmark and
  // arriving signed out.
  assert.match(buildSessionCookie("x".repeat(22), 1), /SameSite=Lax/);
});

test("the clearing cookie empties the value and expires immediately", () => {
  const header = buildClearingCookie();
  assert.match(header, /^__Host-core_session=;/);
  assert.match(header, /;\s*Max-Age=0(?:;|$)/);
  // Same attribute set, because a browser matches the cookie to delete on
  // name+path+domain: a clearing header with a different Path deletes nothing and
  // the stale cookie is presented on the next request.
  assert.match(header, /;\s*Path=\/(?:;|$)/);
  assert.match(header, /;\s*Secure(?:;|$)/);
  assert.match(header, /;\s*HttpOnly(?:;|$)/);
});

test("a token that could break out of the header is refused, not escaped", () => {
  // The value is minted by lib/tokens.js as 22 Base64URL characters, so anything
  // else is a programming error. Refusing beats encoding: an encoded value would
  // be stored by the browser and returned in a form the resolver never matches,
  // and the symptom would be "login succeeds and me returns 401".
  for (const bad of ["a;b", "a\nb", "", "not-22-chars", 5, null]) {
    assert.throws(() => buildSessionCookie(bad, 60), /22 Base64URL/, JSON.stringify(bad));
  }
  assert.throws(() => buildSessionCookie("A".repeat(22), 0), /positive integer/);
});

test("readCookieValues returns EVERY value for a name, not the first", () => {
  // Spec 6.3.4: "No session cookie, unresolvable, or MORE THAN ONE
  // __Host-core_session" is 401. A parser that returns one value cannot express
  // "more than one", and the classic bug is that it returns the FIRST -- so an
  // attacker who can set a cookie on a sibling host shadows the real session with
  // one the server then trusts.
  const header = "__Host-core_session=first; other=x; __Host-core_session=second";
  assert.deepEqual(readCookieValues(header, SESSION_COOKIE_NAME), ["first", "second"]);
});

test("readCookieValues tolerates the shapes a real Cookie header takes", () => {
  assert.deepEqual(readCookieValues("a=1;b=2", "b"), ["2"]);
  assert.deepEqual(readCookieValues("  a=1 ;  b = 2  ", "b"), ["2"]);
  assert.deepEqual(readCookieValues("a=1; b=", "b"), [""]);
  assert.deepEqual(readCookieValues("a=1; b", "b"), []);
  assert.deepEqual(readCookieValues("", "b"), []);
  assert.deepEqual(readCookieValues(undefined, "b"), []);
  // A repeated Cookie header arrives as an ARRAY. Stringifying it would join with
  // a comma and invent a boundary no browser wrote -- the same trap
  // lib/client-ip.js documents for X-Forwarded-For.
  assert.deepEqual(readCookieValues(["a=1", "b=2"], "b"), []);
});

test("readCookieValues does not match a name by prefix", () => {
  // "__Host-core_session_backup=evil" must not answer for "__Host-core_session".
  assert.deepEqual(readCookieValues("__Host-core_session_backup=evil", SESSION_COOKIE_NAME), []);
  assert.deepEqual(readCookieValues("x__Host-core_session=evil", SESSION_COOKIE_NAME), []);
});
