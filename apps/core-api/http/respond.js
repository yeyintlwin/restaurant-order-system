"use strict";

// PURE (spec §8.8 Tier 1): no database, no filesystem, no network, no ambient clock.
// Every response in the service is written through this module, which is what makes
// "no-store and the security headers on EVERY response" a mechanism rather than a promise.
//
// The CSP here is correct for a JSON API. Phase 2 serves the admin UI same-origin at /admin;
// that static handler needs its own, looser policy and must not reuse this one.
// HSTS is deliberately absent — TLS is terminated by Nginx, so it belongs in infra/nginx/.
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
});

// The closed code vocabulary of spec §6.3.2, with the client-facing message for each. The key
// set is asserted equal to db/errors.js's TOP_LEVEL_ERROR_CODES, which owns the code -> status
// mapping; this table owns nothing but the wording.
//
// A code never changes meaning and a message is never derived from an exception, a driver string
// or user input. Messages are deliberately non-confirming: "email_unavailable" must not tell the
// caller whether the address exists (§5.8(b)). "Chosen", not "selected", in the scope messages —
// the §6.3.6 leak scanner matches /SELECT/i, and "selected" contains it.
const ERROR_MESSAGES = Object.freeze({
  invalid_json: "The request body is not valid JSON.",
  invalid_request: "The request could not be processed.",
  unauthenticated: "Authentication is required.",
  invalid_credentials: "Those sign-in details were not accepted.",
  pairing_failed: "That pairing code was not accepted.",
  forbidden: "You do not have access to that.",
  origin_not_allowed: "The request origin is not allowed.",
  password_change_required: "You must change your password before continuing.",
  self_modification_forbidden: "You cannot make that change to your own account.",
  current_password_invalid: "The current password is incorrect.",
  not_found: "Not found.",
  method_not_allowed: "That method is not allowed for this path.",
  company_name_taken: "That company name is already in use.",
  shop_name_taken: "That shop name is already in use.",
  table_label_taken: "That table label is already in use.",
  terminal_name_taken: "That terminal name is already in use.",
  email_unavailable: "That email address is not available.",
  last_platform_admin: "The last active platform administrator cannot be changed.",
  last_company_admin: "The last active company administrator cannot be changed.",
  role_not_shop_assignable: "That role cannot be assigned to shops.",
  terminal_suspended: "That terminal is suspended.",
  company_suspended: "That company is suspended.",
  scope_required: "Choose a company before using this endpoint.",
  scope_selected: "Clear the chosen company before using this endpoint.",
  acting_company_suspended: "The chosen company is suspended.",
  payload_too_large: "The request body is too large.",
  unsupported_media_type: "Content-Type must be application/json.",
  validation_failed: "The request could not be processed.",
  rate_limited: "Too many requests. Try again shortly.",
  internal_error: "Something went wrong.",
  service_unavailable: "The service is temporarily unavailable."
});

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.statusCode = status;
  res.end(text);
}

// `error` may be any object — an ApiError, a pg error, a plain Error. Only `status`, `code`
// and (for validation_failed) `errors` are ever read; every other property is dropped on the
// floor. That is the property spec §6.3.6 mechanism 4(b) exists to pin down.
//
// Retry-After is added for 503 only. 429 gets one per route in a later plan, because login and
// pair are the two 429s that must NOT carry it (§6.2).
function sendError(res, error, requestId, extraHeaders = {}) {
  const source = error || {};
  let code = typeof source.code === "string" ? source.code : "internal_error";
  let status = Number.isInteger(source.status) ? source.status : 500;
  if (!Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)) {
    code = "internal_error";
    status = 500;
  }

  const payload = { code, message: ERROR_MESSAGES[code], requestId: String(requestId) };
  if (code === "validation_failed" && Array.isArray(source.errors)) {
    payload.errors = source.errors.map((entry) => ({ field: String(entry.field), code: String(entry.code) }));
  }

  const headers = status === 503 ? { "Retry-After": "5", ...extraHeaders } : extraHeaders;
  sendJson(res, status, { error: payload }, headers);
}

module.exports = { SECURITY_HEADERS, ERROR_MESSAGES, sendJson, sendError };
