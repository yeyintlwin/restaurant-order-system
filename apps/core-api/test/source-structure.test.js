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
