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
