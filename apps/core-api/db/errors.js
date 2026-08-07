// PURE (Tier 1). No database, no filesystem, no network, no clock.
//
// The two vocabularies below are the whole reason "no internals ever reach the
// client" is a mechanism rather than a promise: ApiError refuses to be
// constructed with anything outside them, so the only way to answer a request
// is with a code that was written down here first.

// Every code maps to exactly one status, so the pair is checkable and
// new ApiError(403, "not_found") is a typo the constructor catches.
const TOP_LEVEL_ERROR_CODES = Object.freeze({
  invalid_json: 400,
  invalid_request: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  pairing_failed: 401,
  forbidden: 403,
  origin_not_allowed: 403,
  password_change_required: 403,
  self_modification_forbidden: 403,
  current_password_invalid: 403,
  // One code, one message, for unknown route, unknown resource and resource
  // outside scope. Splitting it would confirm that a real resource type exists
  // at a real id, which is the leak choosing 404 over 403 was meant to close.
  not_found: 404,
  method_not_allowed: 405,
  company_name_taken: 409,
  shop_name_taken: 409,
  // A URL name collides the same way a display name does, so it answers the same
  // way. Two codes rather than one `slug_taken`, because the two have different
  // scopes and the caller has to know which: a company's is unique across the
  // PLATFORM, a shop's only inside its company (0003_admin_console.sql), so the
  // remedy for one is "pick another" and for the other it may be "you are looking
  // at the wrong company".
  company_slug_taken: 409,
  shop_slug_taken: 409,
  table_label_taken: 409,
  terminal_name_taken: 409,
  email_unavailable: 409,
  last_platform_admin: 409,
  last_company_admin: 409,
  role_not_shop_assignable: 409,
  terminal_suspended: 409,
  company_suspended: 409,
  scope_required: 409,
  scope_selected: 409,
  acting_company_suspended: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  validation_failed: 422,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503
});

// These appear ONLY inside errors[]. `not_found` is deliberately in both lists:
// it is a legitimate 404 and a legitimate field verdict for shopIds[1].
const FIELD_ERROR_CODES = Object.freeze([
  "required",
  "type",
  // DISTINCT from too_short, and the difference is what the caller should do about
  // it. too_short means "give me more"; empty means "you sent nothing, and if you
  // meant to remove the value, send null". Reporting an emptied box as too_short
  // told a manager their blank receipt footer needed to be LONGER.
  "empty",
  "too_short",
  "too_long",
  "pattern",
  "not_in_enum",
  "out_of_range",
  "invalid_uuid",
  "invalid_time_zone",
  "ambiguous_business_day",
  "unknown_field",
  "not_found",
  "duplicate",
  "immutable"
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function assertFieldError(entry, index) {
  if (entry === null || typeof entry !== "object") {
    throw new Error(`ApiError: errors[${index}] must be an object`);
  }
  if (typeof entry.field !== "string" || entry.field === "") {
    throw new Error(`ApiError: errors[${index}].field must be a non-empty string`);
  }
  if (!FIELD_ERROR_CODES.includes(entry.code)) {
    throw new Error(`ApiError: errors[${index}].code "${String(entry.code)}" is not a field error code`);
  }
}

class ApiError extends Error {
  constructor(status, code, errors) {
    super(typeof code === "string" ? code : "internal_error");
    this.name = "ApiError";

    // hasOwn, not `code in`, so "toString" and "constructor" are unknown codes
    // rather than prototype members that pass the lookup.
    if (typeof code !== "string" || !hasOwn(TOP_LEVEL_ERROR_CODES, code)) {
      const hint = FIELD_ERROR_CODES.includes(code)
        ? ` — field codes belong inside errors[]: new ApiError(422, "validation_failed", [{ field, code: "${code}" }])`
        : "";
      throw new Error(`ApiError: "${String(code)}" is not a top-level error code${hint}`);
    }
    if (TOP_LEVEL_ERROR_CODES[code] !== status) {
      throw new Error(`ApiError: "${code}" is a ${TOP_LEVEL_ERROR_CODES[code]}, not a ${String(status)}`);
    }

    if (code === "validation_failed") {
      if (!Array.isArray(errors) || errors.length === 0) {
        throw new Error("ApiError: validation_failed requires a non-empty errors array");
      }
      errors.forEach(assertFieldError);
      // Copy, never keep the caller's objects: a future caller attaching a
      // `sql` or `cause` property must not be able to reach the response.
      this.errors = Object.freeze(errors.map((entry) => Object.freeze({ field: entry.field, code: entry.code })));
    } else if (errors !== undefined) {
      throw new Error(`ApiError: only validation_failed carries errors[]; "${code}" must not`);
    }

    this.status = status;
    this.code = code;
  }
}

// Leak prevention, mechanism 3 (spec 6.3.6): pg errors are mapped by SQLSTATE
// only, never by message or constraint name.
//
//   null           -> no fixed mapping; the top-level handler answers
//                     500 internal_error.
//   { code: null } -> 409, but the code itself must come from the call site's
//                     `conflicts` map, keyed by err.constraint. That constraint
//                     name is an internal lookup key and is never serialised,
//                     which keeps _key/_fkey/_check strings out of every
//                     response and decouples the API vocabulary from the DDL.
const PG_ERROR_MAP = Object.freeze({
  "57014": Object.freeze({ status: 503, code: "service_unavailable" }),
  "53300": Object.freeze({ status: 503, code: "service_unavailable" }),
  "23505": Object.freeze({ status: 409, code: null }),
  "23503": Object.freeze({ status: 409, code: null }),
  "23514": Object.freeze({ status: 409, code: null })
});

function pgErrorToHttp(sqlstate) {
  return typeof sqlstate === "string" && hasOwn(PG_ERROR_MAP, sqlstate) ? PG_ERROR_MAP[sqlstate] : null;
}

module.exports = { ApiError, pgErrorToHttp, TOP_LEVEL_ERROR_CODES, FIELD_ERROR_CODES };
