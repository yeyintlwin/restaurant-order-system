const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// Every read normalises CRLF. The developer machine is win32 and the CI runner is
// ubuntu, so a `$`-anchored regex against raw bytes passes on one and fails on the
// other for reasons that have nothing to do with the rule being asserted.
function readText(...segments) {
  return fs.readFileSync(path.join(...segments), "utf8").replace(/\r\n/g, "\n");
}

function readJson(...segments) {
  return JSON.parse(readText(...segments));
}

test("core-api declares the scripts, dependencies and engine the image and runbooks rely on", () => {
  const manifest = readJson(appRoot, "package.json");
  const raw = readText(appRoot, "package.json");

  assert.equal(manifest.name, "core-api");
  assert.equal(manifest.private, true);
  assert.equal(manifest.scripts.start, "node server.js");
  assert.equal(manifest.scripts.test, "node --test");
  assert.equal(manifest.scripts.pretest, "node scripts/setup-template-db.js");
  assert.equal(manifest.scripts.migrate, "node db/migrate.js");
  assert.equal(manifest.scripts["db:reset"], "node scripts/reset-database.js");
  assert.equal(manifest.engines.node, ">=20");

  // EXACTLY two runtime dependencies, and only ONE of them is new to this
  // repository: apps/epaper-hub already ships express@^4.21.2, so `pg` is the
  // single NEW dependency Phase 1 introduces. express is still listed here
  // explicitly because http/router.js requires it and the Dockerfile installs
  // from THIS manifest with `npm ci --workspaces=false` -- leaning on the repo
  // root's hoisted express@4.22.2 would produce an image that boots straight into
  // MODULE_NOT_FOUND while everything stayed green locally.
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["express", "pg"]);

  // Express 5 changes path-pattern syntax and the OPTIONS/HEAD fallbacks the
  // router tail depends on. It must never arrive as a quiet caret bump.
  assert.doesNotMatch(raw, /"express":\s*"\^?5/);

  // pg-native needs libpq plus a C toolchain -- an instant failure on the Windows
  // development machine, and a silent change of driver behaviour where it builds.
  assert.doesNotMatch(raw, /pg-native/);
  assert.equal(manifest.devDependencies, undefined);

  // The Dockerfile runs `npm ci`, which refuses to run without a lockfile.
  assert.ok(
    fs.existsSync(path.join(appRoot, "package-lock.json")),
    "apps/core-api/package-lock.json must be committed: the Dockerfile runs npm ci"
  );
});

test("C12 - the repository pins SQL line endings and keeps per-app .env out of images", () => {
  const attributes = readText(repoRoot, ".gitattributes");
  const dockerignore = readText(repoRoot, ".dockerignore");

  // The migration runner's checksum is the whole point: see spec 9.4.
  assert.match(attributes, /^\*\.sql text eol=lf$/m);
  assert.match(attributes, /^\*\.sh text eol=lf$/m);

  // No `*.js` rule, deliberately: adding one would renormalise every existing .js
  // file in the repository on the next checkout.
  assert.doesNotMatch(attributes, /^\*\.js\b/m);

  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^apps\/\*\/\.env$/m);
});

test("the core-api environment example names every required variable and ships no credentials", () => {
  const example = readText(appRoot, ".env.example");

  for (const variable of [
    "NODE_ENV", "PORT", "HOST", "TZ", "API_PUBLIC_ORIGIN", "TERMINAL_ALLOWED_ORIGINS",
    "TRUSTED_PROXY_HOPS", "POSTGRES_PASSWORD", "DATABASE_MIGRATION_URL", "DATABASE_URL",
    "CORE_API_TEST_DATABASE_URL"
  ]) {
    assert.match(example, new RegExp(`^${variable}=`, "m"), `${variable} is missing from .env.example`);
  }

  // No credential carries a value. A convincing placeholder in an example file is
  // the password somebody eventually ships to production.
  for (const variable of [
    "POSTGRES_PASSWORD", "DATABASE_MIGRATION_URL", "DATABASE_URL", "CORE_API_TEST_DATABASE_URL"
  ]) {
    assert.match(example, new RegExp(`^${variable}=$`, "m"), `${variable} must be left empty`);
  }

  // The tunables are documented in exactly one place: config.js DEFAULTS. Repeating
  // them here would create a second place to edit and a silent way for the two to
  // disagree -- which is the drift config.test.js exists to prevent.
  assert.doesNotMatch(
    example,
    /^(?:SESSION_|PAIRING_|TERMINAL_TOKEN_|LOGIN_|SCRYPT_|PAIR_|ADMIN_MINT_|PASSWORD_ABUSE_|ROTATE_|AUDIT_|DB_POOL_)/m
  );
});

test("the core-api README carries the runbook entries the definition of done greps for", () => {
  const readme = readText(appRoot, "README.md");

  // Spec 12, verbatim:
  //   grep -q create-platform-admin apps/core-api/README.md
  //   grep -q CORE_API_TEST_DATABASE_URL apps/core-api/README.md
  assert.match(readme, /create-platform-admin/);
  assert.match(readme, /CORE_API_TEST_DATABASE_URL/);

  // The one escape hatch for a laptop with no Postgres has to be discoverable, or
  // the developer's repair for a red pretest is to delete the database suites.
  assert.match(readme, /CORE_API_SKIP_DB_TESTS/);

  // db/health.js's fatal 28P01 message names this section by title. A renamed
  // heading turns that message into a dead pointer during an outage.
  assert.match(readme, /^## Rotating database passwords$/m);

  // ...and the message must point at the file that actually carries the heading.
  // The plan quoted infra/README.md, which has no such section. db/health.js is
  // written in Task 37 and copies this string, so the pointer is fixed here before
  // it can propagate.
  // Matched without a leading "see": the quoted message wraps, and the blockquote
  // marker sits between the two words.
  assert.match(readme, /apps\/core-api\/README\.md 'Rotating database passwords'/);
  assert.doesNotMatch(readme, /infra\/README\.md 'Rotating database passwords'/);

  // The local recipe, including the deliberate 5433.
  assert.match(readme, /docker run -d --name core-db-dev/);
  assert.match(readme, /127\.0\.0\.1:5433:5432/);
});

test("C11 - the repository test script runs the core-api suite", () => {
  const rootPackage = readJson(repoRoot, "package.json");

  // deploy.yml is both the test gate and the deployer; a core-api suite the root
  // script does not invoke is a suite nothing runs before a push reaches the box.
  assert.match(rootPackage.scripts.test, /apps\/core-api/);
  assert.match(rootPackage.scripts.test, /npm --prefix apps\/core-api test/);

  // The three existing suites must survive the edit.
  for (const existing of [
    "npm --prefix packages/epaper-hub-sdk test",
    "npm --prefix apps/epaper-hub test",
    "npm --prefix apps/customer-order test"
  ]) {
    assert.ok(
      rootPackage.scripts.test.includes(existing),
      `root scripts.test no longer runs "${existing}"`
    );
  }
});
