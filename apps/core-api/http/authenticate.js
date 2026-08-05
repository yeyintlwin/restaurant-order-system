"use strict";

// Pipeline step 5 (spec 6.3.5): credential resolution and strict channel binding,
// READ-ONLY. Every write that touches a session -- renewal, deletion -- belongs to
// step 14 or to a handler.
//
// THIS MODULE ISSUES NO SQL. It calls the two pre-tenant repositories, which are
// on rule C4's allowlist; this file is not, and rule C2's second needle bans a
// `.query(` here regardless of what the handle is called.
//
// IT RESOLVES auth:'user' AND NOTHING ELSE. auth:'terminal' passes through the
// pipeline untouched, because the only terminal route in the service authenticates
// a CONFIGURED SHARED SERVICE TOKEN inside its own handler and has no
// terminal_tokens row behind it until Phase 3 pairs apps/customer-order (spec
// 11.9). Resolving a bearer here would 401 the one working authenticated route in
// the service before its handler ever ran.

// lib/client-ip.js takes `isIP` as an ARGUMENT because rule C9 bans node:net under
// lib/, and its own header says http/ is what supplies it. This is that supply --
// the second one, alongside http/routes/table-displays.js, which was written
// before this module existed and is left alone deliberately: changing a shipped,
// tested route to reach a helper is a risk with no benefit.
const { isIP } = require("node:net");

const { ApiError } = require("../db/errors");
const { deriveClientIp } = require("../lib/client-ip");
const { hashToken, TOKEN_LENGTH } = require("../lib/tokens");
const { SESSION_COOKIE_NAME, readCookieValues } = require("./cookies");

const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);

function sessionTokensPresented(req) {
  return readCookieValues(req.headers.cookie, SESSION_COOKIE_NAME);
}

function clientAddressOf(req, trustedProxyHops) {
  return deriveClientIp({ header: req.headers["x-forwarded-for"], trustedProxyHops, isIP });
}

async function authenticateUser(req, deps) {
  const presented = sessionTokensPresented(req);

  // EXACTLY ONE. Spec 6.3.4: "No session cookie, unresolvable, or MORE THAN ONE
  // __Host-core_session" is 401. Picking the first is the natural implementation
  // and it is the vulnerability -- an attacker who can set a cookie on a sibling
  // host shadows the real session with one the server then trusts. Picking the
  // last only moves which one wins.
  if (presented.length !== 1) throw new ApiError(401, "unauthenticated");

  const token = presented[0];
  // Shape first, so a junk cookie never becomes an indexed lookup. hashToken()
  // would digest any string, so without this every 22-byte-or-not value on the
  // internet is a database round trip on the unauthenticated path.
  if (!TOKEN_PATTERN.test(token)) throw new ApiError(401, "unauthenticated");

  // The Authorization header is NEVER consulted for a session, and it is never
  // consulted as a FALLBACK either. Spec 5.3's third clause -- "presenting both
  // credentials does not widen access" -- is the one a try-cookie-then-header
  // resolver satisfies on paper and violates in fact.
  const session = await deps.sessions.resolveSession(hashToken(token));
  if (session === null) throw new ApiError(401, "unauthenticated");

  const scope = await deps.scopes.materialiseScope({
    userId: session.userId,
    sessionId: session.sessionId,
    role: session.role,
    companyId: session.companyId,
    actingCompanyId: session.actingCompanyId
  });

  return { session, scope };
}

module.exports = { sessionTokensPresented, clientAddressOf, authenticateUser, TOKEN_PATTERN };
