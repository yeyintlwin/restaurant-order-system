const assert = require("node:assert/strict");
const fs = require("node:fs");
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

const BOOTSTRAP_SCRIPT = path.join(__dirname, "..", "scripts", "create-platform-admin.js");

// A complete, valid configuration that reaches NO database: every guard under test
// fires before the pool is opened, so these cases need no Postgres.
const BOOTSTRAP_ENV = {
  NODE_ENV: "development",
  POSTGRES_PASSWORD: "devpassword",
  DATABASE_MIGRATION_URL: "postgres://core_api_owner:devpassword@127.0.0.1:5433/core",
  DATABASE_URL: "postgres://core_api_app:apppassword@127.0.0.1:5433/core",
  API_PUBLIC_ORIGIN: "http://localhost:3200"
};

test("the bootstrap CLI refuses a piped password and exits non-zero", () => {
  // THE GUARD THE WHOLE DESIGN RESTS ON. spawnSync gives the child a pipe, never a
  // TTY, so this is the `docker compose exec -T` case exactly. Without the refusal,
  // `echo 'pw' | docker compose exec -T ...` works and the password is in shell
  // history -- which is the thing "never from argv" exists to prevent.
  const { status, output } = runScript(BOOTSTRAP_SCRIPT, {
    env: BOOTSTRAP_ENV,
    argv: ["ops@example.test"]
  });
  assert.notEqual(status, 0);
  assert.match(output, /interactive terminal/i);
  // And it names the fix, because the operator's next move is to drop one flag.
  assert.match(output, /docker compose exec/);
  assert.doesNotMatch(output, /exec -T/);
});

test("the bootstrap CLI refuses a missing or malformed email before opening a pool", () => {
  // Checked against the users.email CHECK's own shape. Reaching the database to be
  // told 23514 would surface a constraint name to an operator, and the message would
  // be about DDL rather than about what they typed.
  for (const argv of [[], ["not-an-email"], ["two words@example.test"]]) {
    const { status, output } = runScript(BOOTSTRAP_SCRIPT, { env: BOOTSTRAP_ENV, argv });
    assert.notEqual(status, 0, JSON.stringify(argv));
    assert.match(output, /email/i);
  }
});

// COMMENTS STRIPPED FIRST, and that is not a nicety. The script's own header explains
// why there is no force flag, so a raw match would be red against a CORRECT file --
// and both repairs available to whoever hits it lose: deleting the documentation, or
// weakening the regex until it stops checking. source-structure.test.js:327-334 names
// this exact trap and carries the stripper this one copies.
function withoutComments(text) {
  return text.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

test("the bootstrap CLI has no force flag and never reads a password from argv", () => {
  // Spec 9.10, stated as an absence. A force flag would mean "overwrite the account
  // that is already there", and the remedy for a forgotten password is
  // scripts/set-password.js.
  const source = withoutComments(fs.readFileSync(BOOTSTRAP_SCRIPT, "utf8"));
  assert.doesNotMatch(source, /--force/);
  // The same rule seen from the other side: argv carries the address and the display
  // name, never the secret.
  assert.doesNotMatch(source, /argv\[2\]|argv\.slice\(3\)/);
});

test("the bootstrap guard is monotonic, and the script says so where an operator will read it", () => {
  // Spec 12's acceptance checkbox depends on it and design.md:714/:855 make it the
  // justification for the only peer-creating route in the system. A script that
  // silently lost the guard would pass every other test in this file.
  const source = fs.readFileSync(BOOTSTRAP_SCRIPT, "utf8");
  assert.match(source, /already been bootstrapped/);
  assert.match(source, /bootstrapPlatformAdmin/);
  // And it must NOT reach for the current-state question, which a DELETE defeats.
  assert.doesNotMatch(withoutComments(source), /countActivePlatformAdmins/);
});
