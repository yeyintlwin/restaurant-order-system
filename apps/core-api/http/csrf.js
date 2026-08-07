"use strict";

// PURE: it takes header strings and a route entry and either returns or throws an
// ApiError. It never touches `res`, which is what identity spec 6.3 requires --
// "source-structure.test.js forbids app.use( outside router.js, so a pure
// http/csrf.js called from the [dispatch] wrapper is the only compliant shape."
//
// PLACEMENT MATTERS AND IS NOT A STYLE CHOICE. This runs INSIDE the dispatch
// wrapper, after route lookup. As an app.use() ahead of the routes it would run
// BEFORE matching, so an unknown path with no Origin would answer
// 403 origin_not_allowed instead of 404 not_found -- destroying the
// [credential-independent] property spec 6.3.5 marks on step 2, and handing an
// attacker a route-existence oracle that needs no credential at all.

const { ApiError } = require("../db/errors");
const { JSON_CONTENT_TYPE } = require("./body");

// Clause 2 of identity spec 6.3: browser-facing PUBLIC posts. Plan 2d adds
// forgot-password, reset-password and verify-email here, in the same commit as the
// routes. It is a list of route KEYS rather than paths so a GET on the same path
// could never inherit the gate by accident.
//
// MIRROR: route-auth.test.js carries a census that deep-equals the derived
// origin-gated set. Find both with:
//   grep -rn "origin-gated\|ORIGIN_GATED_PUBLIC_KEYS" apps/core-api
const ORIGIN_GATED_PUBLIC_KEYS = Object.freeze(["POST /api/admin/auth/login"]);

// Spec 5.3, amended by identity spec 6.3. Gated on the AUTHENTICATION CHANNEL,
// never on the verb: the blanket "every state-changing request needs an Origin"
// rule would 403 every kiosk, native shell and curl on /api/terminal/*, and
// because pairing failures are deliberately opaque the operator would read it as a
// bad code and burn through reissues.
function requiresOriginCheck(entry) {
  // Device routes, exempt. What makes the exemption safe is strict channel binding
  // in http/authenticate.js, not an Origin header nobody sends.
  if (entry.path.startsWith("/api/terminal/")) return false;
  if (entry.options.auth === "user") return entry.method !== "GET";
  if (entry.options.auth === "public") return ORIGIN_GATED_PUBLIC_KEYS.includes(entry.key);
  return false;
}

// ORIGIN FIRST. A request from evil.test carrying text/plain must be told 403 and
// not 415: answering 415 would confirm the origin was acceptable, which is a
// one-bit oracle for whichever origin the attacker is guessing.
//
// Exact string equality against API_PUBLIC_ORIGIN, never a suffix or hostname
// test: "https://api.yeyintlwin.com.evil.test" ends with nothing useful, and
// endsWith(".yeyintlwin.com") would admit every sibling this cookie's __Host-
// prefix exists to exclude. Origin is case-sensitive per the URL standard, and
// config.js already normalises API_PUBLIC_ORIGIN through new URL().origin.
// The three a logo upload may arrive as, and the property that matters is not that
// they are images -- it is that an HTML FORM CANNOT SEND THEM. A form's enctype is
// one of three values (urlencoded, multipart, text/plain), which is the whole reason
// the JSON requirement is a CSRF defence rather than a formality. image/png is as
// unreachable from a form as application/json is, so a route that takes bytes keeps
// exactly the same guarantee.
//
// The list is closed and does not include multipart: allowing that would give the
// gate away, and the upload routes take a raw body precisely so it is not needed.
const IMAGE_CONTENT_TYPE = new RegExp("^image[/](png|jpeg|webp)[ ]*(;|$)", "i");

function assertOriginAndContentType({ origin, contentType, apiPublicOrigin, accepts = "json" }) {
  if (typeof apiPublicOrigin !== "string" || apiPublicOrigin === "") {
    throw new Error("csrf: apiPublicOrigin is required (config.js makes it a required variable)");
  }
  if (typeof origin !== "string" || origin !== apiPublicOrigin) {
    throw new ApiError(403, "origin_not_allowed");
  }
  // A DELETE with no body has no Content-Type to check, and demanding one would be
  // asking a request with nothing in it to describe its nothing. The Origin check
  // above is the CSRF defence for it, and that has already run.
  if (accepts === "none") return;
  // A route that declares nothing gets the JSON rule, which is every route but three.
  const allowed = accepts === "image" ? IMAGE_CONTENT_TYPE : JSON_CONTENT_TYPE;
  if (!allowed.test(String(contentType || ""))) {
    throw new ApiError(415, "unsupported_media_type");
  }
}

module.exports = { ORIGIN_GATED_PUBLIC_KEYS, requiresOriginCheck, assertOriginAndContentType, IMAGE_CONTENT_TYPE };
