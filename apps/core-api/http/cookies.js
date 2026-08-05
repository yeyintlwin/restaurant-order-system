"use strict";

// PURE (spec 8.8, Tier 1): no database, no filesystem, no network, no clock, and
// no `req`/`res` -- it takes header STRINGS and returns header STRINGS, which is
// what lets every case below be a unit test.
//
// It lives in http/ rather than lib/ because it is HTTP vocabulary, not a
// credential primitive; nothing here mints or hashes anything.

const { TOKEN_LENGTH } = require("../lib/tokens");

// Spec 5.2, and the prefix is load-bearing rather than decorative. Host-only
// scoping controls only what THIS server sets; any sibling under yeyintlwin.com --
// order., epaper-hub., the Phase-7 captive portal serving untrusted guest devices,
// the Phase-4/5 terminal subdomains, or a network attacker answering plain HTTP for
// a non-existent *.yeyintlwin.com name -- can set
// core_session=<value>; Domain=yeyintlwin.com. __Host- is what makes that
// impossible at the browser.
const SESSION_COOKIE_NAME = "__Host-core_session";

// The browser enforces the prefix only when ALL THREE hold: Secure is present,
// Path is exactly "/", and there is NO Domain attribute. Getting any of them wrong
// does not weaken the cookie, it makes the browser refuse to store it -- so the
// symptom is "nobody can stay signed in", which is at least loud.
//
// SameSite=Lax is the second layer (5.3): None would let any site's fetch carry it
// and leave the Origin rule as the only CSRF control, while Strict signs the user
// out of any link followed in from outside.
const BASE_ATTRIBUTES = Object.freeze(["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]);

// http://localhost is a "potentially trustworthy origin" in every current browser,
// so Secure and __Host- both work against the development server that
// API_PUBLIC_ORIGIN allows there. No environment-dependent attribute set exists,
// deliberately: one that dropped Secure outside production would be a config value
// away from dropping it in production.

const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);

function assertToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new Error(
      `session cookie value must be ${TOKEN_LENGTH} Base64URL characters as minted by lib/tokens.js`
    );
  }
}

function buildSessionCookie(token, maxAgeSeconds) {
  assertToken(token);
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new Error(`session cookie Max-Age must be a positive integer, got ${JSON.stringify(maxAgeSeconds)}`);
  }
  return [`${SESSION_COOKIE_NAME}=${token}`, ...BASE_ATTRIBUTES, `Max-Age=${maxAgeSeconds}`].join("; ");
}

// The SAME attribute set, because a browser matches the cookie to delete on
// name + path + domain. A clearing header with a different Path deletes nothing,
// and the stale cookie is presented again on the next request -- which reads as
// "logout does not work" and is diagnosed as a server bug.
function buildClearingCookie() {
  return [`${SESSION_COOKIE_NAME}=`, ...BASE_ATTRIBUTES, "Max-Age=0"].join("; ");
}

// EVERY value for the name, in header order. Returning one value cannot express
// spec 6.3.4's "more than one __Host-core_session", and the natural
// implementation returns the FIRST -- so an attacker able to set a cookie on a
// sibling host shadows the real session with one the server then trusts.
function readCookieValues(header, name) {
  // A repeated Cookie header arrives as an array. Joining it would invent an entry
  // boundary no browser wrote; treat it as absent, which is fail-closed.
  if (typeof header !== "string" || header === "") return [];

  const values = [];
  for (const pair of header.split(";")) {
    const equals = pair.indexOf("=");
    // A bare token with no "=" is not a cookie. RFC 6265 has no such form.
    if (equals === -1) continue;
    // Exact name match, never a prefix: "__Host-core_session_backup=evil" must not
    // answer for "__Host-core_session".
    if (pair.slice(0, equals).trim() !== name) continue;
    values.push(pair.slice(equals + 1).trim());
  }
  return values;
}

module.exports = {
  SESSION_COOKIE_NAME,
  BASE_ATTRIBUTES,
  buildSessionCookie,
  buildClearingCookie,
  readCookieValues
};
