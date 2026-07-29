const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const {
  TEMPLATE_DATABASE_NAME,
  FIXTURE_TABLES,
  databaseNameFor,
  maintenanceDsn,
  requireTestDatabaseUrl,
  skipDatabaseTests
} = require("../testing/database");

test("a test file maps to a deterministic 23-character database name", () => {
  const name = databaseNameFor(path.join(__dirname, "schema-invariants.test.js"));

  assert.match(name, /^core_api_t_[0-9a-f]{12}$/);
  assert.equal(name.length, 23);
  assert.equal(name, databaseNameFor(path.join(__dirname, "schema-invariants.test.js")));
  assert.notEqual(name, databaseNameFor(path.join(__dirname, "source-structure.test.js")));
});

test("the name comes from the POSIX-relative path, so win32 and CI agree", () => {
  // The digest is taken over "test/schema-invariants.test.js" -- forward slashes,
  // relative to apps/core-api. A backslash here means the developer's laptop and
  // the CI runner disagree about which database a failure lives in.
  const expected = "core_api_t_" + crypto
    .createHash("sha256")
    .update("test/schema-invariants.test.js")
    .digest("hex")
    .slice(0, 12);

  assert.equal(databaseNameFor(path.join(__dirname, "schema-invariants.test.js")), expected);
});

test("requireTestDatabaseUrl throws -- never skips -- and names the variable and an example", () => {
  assert.throws(
    () => requireTestDatabaseUrl({}),
    (error) => {
      assert.match(error.message, /CORE_API_TEST_DATABASE_URL/);
      assert.match(error.message, /postgres:\/\/core_api_owner:devpassword@127\.0\.0\.1:5433\/postgres/);
      assert.match(error.message, /CORE_API_SKIP_DB_TESTS=1/);
      assert.match(error.message, /\$env:CORE_API_TEST_DATABASE_URL/);
      return true;
    }
  );

  assert.equal(
    requireTestDatabaseUrl({ CORE_API_TEST_DATABASE_URL: "postgres://u@h/postgres" }),
    "postgres://u@h/postgres"
  );
});

test("the skip hatch is a separate lever and is off unless set to exactly 1", () => {
  assert.equal(skipDatabaseTests({}), false);
  assert.equal(skipDatabaseTests({ CORE_API_SKIP_DB_TESTS: "0" }), false);
  assert.equal(skipDatabaseTests({ CORE_API_SKIP_DB_TESTS: "1" }), "CORE_API_SKIP_DB_TESTS=1");
});

test("maintenanceDsn swaps only the database name, preserving credentials and port", () => {
  assert.equal(
    maintenanceDsn("postgres://u:p@127.0.0.1:5433/postgres", "core_api_t_abc123abc123"),
    "postgres://u:p@127.0.0.1:5433/core_api_t_abc123abc123"
  );
});

test("the truncate set names all ten non-infrastructure tables", () => {
  assert.deepEqual(FIXTURE_TABLES, [
    "audit_events",
    "terminal_tokens",
    "terminal_pairing_codes",
    "terminals",
    "user_sessions",
    "user_shops",
    "shop_tables",
    "shops",
    "users",
    "companies"
  ]);
  assert.equal(FIXTURE_TABLES.length, 10);
  assert.ok(!FIXTURE_TABLES.includes("schema_migrations"));
  assert.equal(TEMPLATE_DATABASE_NAME, "core_api_test_template");
});
