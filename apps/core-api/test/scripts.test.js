const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const SETUP_SCRIPT = path.join(__dirname, "..", "scripts", "setup-template-db.js");

function runScript(scriptPath, { env = {}, argv = [] } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  const result = spawnSync(process.execPath, [scriptPath, ...argv], {
    env: childEnv,
    encoding: "utf8"
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("setup-template-db exits 0 and does nothing when the URL is unset", () => {
  const { status, output } = runScript(SETUP_SCRIPT, {
    env: { CORE_API_TEST_DATABASE_URL: undefined, CORE_API_SKIP_DB_TESTS: undefined }
  });

  // Exit 0, because a red pretest would take the database-free suites down with
  // it. The database-backed suites still fail loudly -- from cloneTemplate(), not here.
  assert.equal(status, 0);
  assert.match(output, /CORE_API_TEST_DATABASE_URL/);
});

test("setup-template-db exits 0 and does nothing under the skip hatch", () => {
  const { status, output } = runScript(SETUP_SCRIPT, {
    env: {
      CORE_API_SKIP_DB_TESTS: "1",
      CORE_API_TEST_DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/postgres"
    }
  });

  assert.equal(status, 0);
  assert.match(output, /CORE_API_SKIP_DB_TESTS/);
});

test("setup-template-db exits non-zero when the URL is set but unreachable", () => {
  const { status } = runScript(SETUP_SCRIPT, {
    env: {
      CORE_API_SKIP_DB_TESTS: undefined,
      CORE_API_TEST_DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/postgres"
    }
  });

  // A configured-but-broken database is an operator error, not a reason to be quiet.
  assert.notEqual(status, 0);
});

const RESET_SCRIPT = path.join(__dirname, "..", "scripts", "reset-database.js");

const LOCAL_DSN = "postgres://core_api_owner:devpassword@127.0.0.1:5433/core";
const REMOTE_DSN = "postgres://core_api_owner:devpassword@core-db.example.com:5432/core";

function runReset(env, argv = []) {
  return runScript(RESET_SCRIPT, {
    env: { NODE_ENV: "development", DATABASE_MIGRATION_URL: LOCAL_DSN, ...env },
    argv
  });
}

// Each guard is asserted with the OTHER two satisfied, so a weakened guard cannot
// hide behind a sibling.
test("guard 1: refuses under NODE_ENV=production even with a local host and --yes", () => {
  const { status, output } = runReset({ NODE_ENV: "production" }, ["--yes"]);

  assert.notEqual(status, 0);
  assert.match(output, /NODE_ENV/);
  assert.match(output, /production/);
});

test("guard 2: refuses a non-local host even in development with --yes", () => {
  const { status, output } = runReset({ DATABASE_MIGRATION_URL: REMOTE_DSN }, ["--yes"]);

  assert.notEqual(status, 0);
  assert.match(output, /core-db\.example\.com/);
  assert.match(output, /not local/i);
});

test("guard 3: refuses without --yes, after printing host, port and database", () => {
  const { status, output } = runReset({}, []);

  assert.notEqual(status, 0);
  assert.match(output, /host=127\.0\.0\.1/);
  assert.match(output, /port=5433/);
  assert.match(output, /database=core/);
  assert.match(output, /--yes/);
});

test("reset-database refuses when DATABASE_MIGRATION_URL is absent", () => {
  const { status, output } = runReset({ DATABASE_MIGRATION_URL: undefined }, ["--yes"]);

  assert.notEqual(status, 0);
  assert.match(output, /DATABASE_MIGRATION_URL/);
});
