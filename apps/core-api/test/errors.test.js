const assert = require("node:assert/strict");
const test = require("node:test");

const { ApiError, pgErrorToHttp, TOP_LEVEL_ERROR_CODES, FIELD_ERROR_CODES } = require("../db/errors");

test("the top-level vocabulary is exactly the settled table, and nothing else", () => {
  assert.deepEqual(Object.keys(TOP_LEVEL_ERROR_CODES).sort(), [
    "acting_company_suspended",
    "company_name_taken",
    "company_suspended",
    "current_password_invalid",
    "email_unavailable",
    "forbidden",
    "internal_error",
    "invalid_credentials",
    "invalid_json",
    "invalid_request",
    "last_company_admin",
    "last_platform_admin",
    "method_not_allowed",
    "not_found",
    "origin_not_allowed",
    "pairing_failed",
    "password_change_required",
    "payload_too_large",
    "rate_limited",
    "role_not_shop_assignable",
    "scope_required",
    "scope_selected",
    "self_modification_forbidden",
    "service_unavailable",
    "shop_name_taken",
    "table_label_taken",
    "terminal_name_taken",
    "terminal_suspended",
    "unauthenticated",
    "unsupported_media_type",
    "validation_failed"
  ]);
  assert.equal(TOP_LEVEL_ERROR_CODES.not_found, 404);
  assert.equal(TOP_LEVEL_ERROR_CODES.validation_failed, 422);
  assert.equal(TOP_LEVEL_ERROR_CODES.service_unavailable, 503);
  assert.ok(Object.isFrozen(TOP_LEVEL_ERROR_CODES));
});

test("the field vocabulary is exactly the settled list", () => {
  assert.deepEqual([...FIELD_ERROR_CODES].sort(), [
    "ambiguous_business_day",
    "duplicate",
    "immutable",
    "invalid_time_zone",
    "invalid_uuid",
    "not_found",
    "not_in_enum",
    "out_of_range",
    "pattern",
    "required",
    "too_long",
    "too_short",
    "type",
    "unknown_field"
  ]);
});

test("a well-formed ApiError carries only status, code and (for 422) errors", () => {
  const error = new ApiError(404, "not_found");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ApiError");
  assert.equal(error.status, 404);
  assert.equal(error.code, "not_found");
  assert.equal(error.errors, undefined);
});

test("a field code in the top-level position is impossible", () => {
  // Without this, a handler ships {"code":"invalid_time_zone"} and the two layers
  // of the error model collapse into one undocumented vocabulary.
  assert.throws(() => new ApiError(422, "invalid_time_zone"), /not a top-level error code/);
  assert.throws(() => new ApiError(422, "invalid_time_zone"), /field codes belong inside errors\[\]/);
  assert.throws(() => new ApiError(422, "required"), /not a top-level error code/);
});

test("not_found is legal at the top level even though it is also a field code", () => {
  assert.equal(new ApiError(404, "not_found").code, "not_found");
  assert.deepEqual(new ApiError(422, "validation_failed", [{ field: "shopIds[1]", code: "not_found" }]).errors, [
    { field: "shopIds[1]", code: "not_found" }
  ]);
});

test("an unknown code and a code/status disagreement are both rejected", () => {
  assert.throws(() => new ApiError(418, "teapot"), /not a top-level error code/);
  assert.throws(() => new ApiError(403, "not_found"), /is a 404, not a 403/);
  assert.throws(() => new ApiError(500, "toString"), /not a top-level error code/);
});

test("errors[] belongs to validation_failed and to nothing else", () => {
  assert.throws(() => new ApiError(422, "validation_failed"), /non-empty errors array/);
  assert.throws(() => new ApiError(422, "validation_failed", []), /non-empty errors array/);
  assert.throws(
    () => new ApiError(404, "not_found", [{ field: "shopId", code: "not_found" }]),
    /only validation_failed carries errors\[\]/
  );
  assert.throws(
    () => new ApiError(422, "validation_failed", [{ field: "timeZone", code: "nope" }]),
    /is not a field error code/
  );
  assert.throws(
    () => new ApiError(422, "validation_failed", [{ field: "", code: "required" }]),
    /field must be a non-empty string/
  );
});

test("errors[] entries are copied and frozen, so nothing can be smuggled through them", () => {
  const supplied = [{ field: "timeZone", code: "invalid_time_zone", sql: "SELECT 1 FROM users" }];
  const error = new ApiError(422, "validation_failed", supplied);
  assert.deepEqual(error.errors, [{ field: "timeZone", code: "invalid_time_zone" }]);
  assert.ok(Object.isFrozen(error.errors));
  assert.ok(Object.isFrozen(error.errors[0]));
});


test("a cancelled statement and an exhausted server both become 503", () => {
  // 57014 is statement_timeout firing; 53300 is too_many_connections. Both are
  // "come back in a moment", never "your request was wrong".
  assert.deepEqual(pgErrorToHttp("57014"), { status: 503, code: "service_unavailable" });
  assert.deepEqual(pgErrorToHttp("53300"), { status: 503, code: "service_unavailable" });
});

test("constraint-class sqlstates map to 409 with the code left to the call site", () => {
  // code:null means "the call site's conflicts map, keyed by err.constraint,
  // decides" — which is what keeps _key/_fkey/_check strings out of responses
  // and decouples the API vocabulary from the DDL.
  for (const sqlstate of ["23505", "23503", "23514"]) {
    assert.deepEqual(pgErrorToHttp(sqlstate), { status: 409, code: null }, sqlstate);
  }
});

test("an unmapped sqlstate has no mapping at all, so it becomes 500", () => {
  assert.equal(pgErrorToHttp("22P02"), null);
  assert.equal(pgErrorToHttp("42P01"), null);
  assert.equal(pgErrorToHttp(undefined), null);
  assert.equal(pgErrorToHttp("constructor"), null);
});

test("the mapping is frozen so no caller can widen it at runtime", () => {
  const mapped = pgErrorToHttp("57014");
  assert.ok(Object.isFrozen(mapped));
});
