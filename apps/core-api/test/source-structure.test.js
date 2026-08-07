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

  // EXACTLY three runtime dependencies. express is listed explicitly because
  // http/router.js requires it and the Dockerfile installs from THIS manifest
  // with `npm ci --workspaces=false` -- leaning on the repo root's hoisted
  // express@4.22.2 would produce an image that boots straight into
  // MODULE_NOT_FOUND while everything stayed green locally.
  //
  // The third is the e-paper SDK, and it moved HERE from
  // apps/customer-order/package.json. Spec 11.7: core-api is the SDK's one
  // permitted caller, which C16 below asserts as a one-element list. This
  // literal and that rule have to move together -- widening C16 without the
  // manifest gives a permitted caller that cannot resolve its own require.
  assert.deepEqual(
    Object.keys(manifest.dependencies).sort(),
    [SDK_SPECIFIER, "express", "pg"]
  );

  // A file: link, never a version range: the SDK is workspace-local and has no
  // registry entry, so a caret here resolves to nothing at `npm ci` time.
  assert.equal(manifest.dependencies[SDK_SPECIFIER], "file:../../packages/epaper-hub-sdk");

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

  // .github/workflows/deploy.yml carries an `ssh … <<'EOF'` heredoc whose body IS the
  // remote shell's stdin, so a CRLF checkout ships \r on every line of that script.
  assert.match(attributes, /^\*\.yml text eol=lf$/m);

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

test("the walker scanned every source file, with POSIX separators", () => {
  // Requirement 2: a floor plus sentinels. Without it, a walker returning []
  // makes every "no file matches X" rule below pass -- and that is not
  // hypothetical. C9 spent the whole of Plan 1 comparing [] to [] because
  // apps/core-api/lib/ did not exist, and nobody noticed until Plan 2a put a file
  // in it.
  //
  // Plan 1 ended at fifteen. Plan 2a adds seven: migrations/0002_identity.sql,
  // lib/{tokens,password,semaphore,client-ip,audit-vocabulary}.js and
  // repositories/auth/audit.js, and http/body.js is the twenty-third. The
  // e-paper boundary adds epaper/hub-client.js and
  // http/routes/table-displays.js. Plan 2b adds ten and the walker reports
  // thirty-five. MEASURED, not estimated: the floor was set to an absurd number,
  // the reported count read back, and then mutation-tested at N + 1 to confirm it
  // can go red. Raise this floor in each later plan as repositories/ and
  // http/routes/ fill in. 0003_admin_console.sql and the platform seam bring the
  // walker to thirty-seven.
  //
  // MEASURED, and the first measurement was WRONG: counted by hand it came to
  // thirty-four, because walk() takes /\.(?:js|sql)$/ and the three migrations are
  // source files here too. A floor set from a guess is a floor that never catches
  // anything, which is the exact vacuity this assertion exists to prevent -- so it
  // was read back off the walker itself.
  assert.ok(
    SOURCE_FILES.length >= 37,
    `scanned only ${SOURCE_FILES.length} files: ${SOURCE_FILES.join(", ")}`
  );

  for (const sentinel of [
    "db/index.js",
    "http/routes/health.js",
    "migrations/0001_init.sql",
    // Plan 2a's three new AREAS, one sentinel each. The floor alone cannot catch
    // a walker that silently stops descending into one of them -- the count would
    // still clear the floor on the strength of the others, and C9 and C14 would
    // go back to comparing [] to [] exactly as C9 did for the whole of Plan 1.
    "lib/tokens.js",
    "repositories/auth/audit.js",
    "migrations/0002_identity.sql",
    // epaper/ is the fourth AREA, and its sentinel is the one that matters most:
    // C16 asserts "exactly one file requires the SDK" as a deepEqual against
    // ["epaper/hub-client.js"]. A walker that stopped descending into epaper/
    // would compare [] to [] -- and C16 would report the boundary intact at the
    // exact moment the file defining it had gone missing.
    "epaper/hub-client.js",
    // Plan 2b. One per file that a rule would silently stop checking if the walker
    // lost it: C9 and C14 scan lib/, C2 and C4 scan repositories/auth/, and the two
    // http/ files below are the entire credential path.
    "lib/rate-limit.js",
    "lib/authorization.js",
    "http/cookies.js",
    "http/csrf.js",
    "http/authenticate.js",
    // repositories/platform/ is the fifth AREA, and its sentinel matters for the
    // same reason epaper/'s does: C5 asserts that the cross-tenant needle appears
    // ONLY under this directory, and C6 measures the directory's exports against a
    // budget. A walker that stopped descending here would report both as clean at
    // the exact moment the seam had gone missing.
    "repositories/platform/query.js",
    "http/routes/auth.js",
    "repositories/auth/users.js",
    "repositories/auth/sessions.js",
    "repositories/auth/scope-materialize.js",
    "scripts/create-platform-admin.js"
  ]) {
    assert.ok(SOURCE_FILES.includes(sentinel), `sentinel ${sentinel} was not scanned`);
  }

  assert.ok(
    SOURCE_FILES.every((file) => !file.includes("\\")),
    "a scanned path contains a backslash: path.sep was not normalised"
  );
});

test("every rule matches its own violating fixture and ignores it inside a comment", () => {
  assert.ok(RULES.length >= 1, "no rules were registered");

  for (const entry of RULES) {
    assert.ok(
      entry.pattern.test(stripComments(entry.mustMatch, entry.extension)),
      `${entry.name}: the regex does not match its own violating fixture`
    );
    assert.ok(
      !entry.pattern.test(stripComments(entry.mustNotMatch, entry.extension)),
      `${entry.name}: the regex still matches after comments are stripped`
    );
  }
});

// A fixture is synthetic BAD code, so one tripping a different rule is not
// automatically wrong -- but it is one of exactly two things, and only one of them
// is acceptable. Either the text genuinely is two violations at once (allowlisted
// below, with the reason), or the fixture carries decoration its own pattern never
// needed. The second is how Task 10 shipped a C2 violation copied out of C4's
// fixture, which is the most example-like text in this file and sits on an
// ALLOWLIST rule -- so it is read by exactly the people entitled to write that call.
const FIXTURE_CROSS_TRIPS = {
  "C1 require pg -> C9 impure require in lib": "the fixture IS a pg require; both rules correctly forbid that exact text",
  "C2 raw query -> C2 query on any handle": "C2's two needles are nested by construction -- a pool/client handle IS a handle, so clause 1's fixture must trip clause 2 or clause 2 is not the broader of the pair"
};

test("no rule's fixture trips a different rule except where that is stated", () => {
  const observed = [];
  for (const entry of RULES) {
    for (const other of RULES) {
      if (other === entry || other.extension !== entry.extension) continue;
      if (other.pattern.test(stripComments(entry.mustMatch, entry.extension))) {
        observed.push(`${entry.name} -> ${other.name}`);
      }
    }
  }
  assert.deepEqual(observed.sort(), Object.keys(FIXTURE_CROSS_TRIPS).sort());
});

test("C1: db/pool.js is the only file that requires pg", () => {
  assert.deepEqual(filesMatching(PG_REQUIRE), ["db/pool.js"]);
});

// --- source walker -------------------------------------------------------
// test/ and testing/ are excluded on purpose: the harness legitimately requires
// "pg" and issues client.query() to build databases, and testing/** sits outside
// the withUnscopedConnection allowlist because no legitimate tenant scope can
// create rows in two tenants. C13 asserts test/ separately, with readdirSync.
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "test",
  "testing",
  "coverage",
  "public",
  ".git"
]);

function walk(directory, prefix = "") {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      found.push(...walk(path.join(directory, entry.name), `${prefix}${entry.name}/`));
      continue;
    }
    if (!/\.(?:js|sql)$/.test(entry.name)) continue;
    // Requirement 1: the relative path is assembled from "/" literals, never
    // from path.sep.
    found.push(`${prefix}${entry.name}`);
  }
  return found;
}

const SOURCE_FILES = walk(appRoot).sort();

// --- repository walker ---------------------------------------------------
// C16's second half. Every other rule here is scoped to apps/core-api because
// every other rule is about this app's internals; the SDK boundary is about who
// in the REPOSITORY may drive a display, so it needs a walker that leaves.
//
// test/ and testing/ are excluded for the same reason walk() excludes them, plus
// one specific to this rule: THIS FILE would otherwise match its own C16
// fixture. The spliced SDK_SPECIFIER already stops that, and the exclusion means
// the rule does not depend on the splice staying spliced.
//
// Restricted to apps/ and packages/. docs/ carries design prose that names the
// specifier deliberately, and .worktrees/ is gitignored scratch that is not part
// of the tree the boundary describes.
const REPOSITORY_ROOTS = ["apps", "packages"];

function walkRepository() {
  const found = [];
  for (const root of REPOSITORY_ROOTS) {
    for (const relative of walk(path.join(repoRoot, root), `${root}/`)) {
      found.push(relative);
    }
  }
  return found.sort();
}

const REPOSITORY_FILES = walkRepository();

function repositoryFilesMatching(pattern) {
  return REPOSITORY_FILES.filter((file) =>
    pattern.test(stripComments(readText(repoRoot, ...file.split("/")), extensionOf(file)))
  ).sort();
}

function extensionOf(file) {
  return file.endsWith(".sql") ? ".sql" : ".js";
}

// Comments are stripped before matching. Without this, DOCUMENTING a rule
// violates it -- a header comment in http/authenticate.js explaining why
// req.query.api_key is rejected would turn C7 red, and both repairs (delete the
// documentation, weaken the regex) lose. 0001_init.sql is ~40% comment.
function stripComments(source, extension) {
  if (extension === ".sql") return source.replace(/--[^\n]*/g, "");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function sourceOf(file) {
  return stripComments(readText(appRoot, ...file.split("/")), extensionOf(file));
}

function filesMatching(pattern, filter = () => true) {
  return SOURCE_FILES.filter(filter)
    .filter((file) => pattern.test(sourceOf(file)))
    .sort();
}

// Each rule carries a permanent positive fixture (a synthetic violating line the
// regex must catch) and a negative one (the same line commented out). Never
// declare these patterns with the /g flag: RegExp.test is stateful under /g.
const RULES = [];

function rule(name, pattern, mustMatch, mustNotMatch, extension = ".js") {
  RULES.push({ name, pattern, mustMatch, mustNotMatch, extension });
  return pattern;
}

// C1 -- db/pool.js is the ONLY file that may require "pg", and everything else
// goes through db/index.js. deepEqual on a sorted array, not a subset: a second
// requirer is a finding, not a warning.
const PG_REQUIRE = rule(
  "C1 require pg",
  /require\(\s*["']pg["']\s*\)/,
  'const { Pool } = require("pg");',
  '// const { Pool } = require("pg");'
);

test("C2: no raw query outside db/ and the nine sanctioned pre-tenant files", () => {
  // Clause 1, unchanged, and deliberately NOT exempting the allowlist. `pool` and
  // `client` name a real pg Client, and withUnscopedConnection yields a narrow
  // { query } handle that is not one. repositories/auth/* may query; it may not
  // claim to hold a Client. db/health.js and repositories/auth/audit.js both name
  // the handle `connection`, and audit.js documents that as load-bearing.
  assert.deepEqual(filesMatching(RAW_QUERY, (file) => !file.startsWith("db/")), []);

  // Clause 2, which closes the naming-convention escape. Clause 1 is a
  // VARIABLE-NAME rule, and measured against its own pattern, session.query(),
  // connection.query(), conn.query(), db.query() and handle.query() all walk
  // straight past it. So a handler writing
  //     const session = await acquireRuntimeClient();
  //     await session.query("SELECT * FROM users WHERE email = $1", [email]);
  // passes C1 (no pg require), C2, C3, C4 (no withUnscopedConnection) and C5 --
  // unscoped SQL outside db/, on the login path, invisible to the entire
  // structural suite. acquireRuntimeClient is re-exported from db/index.js, so
  // that is four lines of ordinary-looking code.
  //
  // The exemption therefore has to be a FILE list rather than a promise about
  // identifiers, and C4's is the right list: budgeted at exactly nine, asserted
  // as such, and unable to grow without a visible diff. Widening instead to all
  // of repositories/ -- the reading a reasonable person reaches, since C4 already
  // sanctions repositories/auth/* to hold a connection, so "obviously it may
  // query it" -- would permanently remove the choke point from the directory 2b
  // and 2c fill with users.js, sessions.js and scope-materialize.js, which is
  // precisely the code that owns tenant isolation.
  //
  // And the allowlist will not need widening for ordinary Phase-2 repositories,
  // which is the objection to expect. The SCOPED path is a function call, not a
  // handle method: a tenant repository writes
  //     const { rows } = await tenantQuery(scope, SELECT_ITEMS, [id]);
  // and the sole `.query(` sits inside db/index.js at tenantQuery's own body,
  // which is exempt. So clause 2 can only fire on a file that went around
  // tenantQuery to hold a raw handle -- which is the finding, not a false
  // positive. Adding a file here is therefore always the wrong repair.
  assert.deepEqual(
    filesMatching(
      ANY_HANDLE_QUERY,
      (file) => !file.startsWith("db/") && !UNSCOPED_ALLOWLIST.includes(file)
    ),
    []
  );
});

test("C3: only http/router.js requires express or registers a route", () => {
  assert.deepEqual(filesMatching(EXPRESS_REQUIRE), ["http/router.js"]);
  assert.deepEqual(filesMatching(ROUTE_REGISTRATION, (file) => file !== "http/router.js"), []);
});

test("C16: epaper/hub-client.js is the only file in this app that requires the SDK", () => {
  assert.deepEqual(filesMatching(SDK_REQUIRE), ["epaper/hub-client.js"]);
});

test("C16: and it is the only one in the REPOSITORY, which is the half that matters", () => {
  // The clause the app-local walker cannot reach, and the only one that states
  // spec 11.7's actual claim. Every other rule in this file is scoped to
  // apps/core-api, which is correct for pg and express -- they are this app's
  // internals. The SDK is not: the caller this boundary was built to remove
  // lived in apps/customer-order, and a rule that only ever looked inside
  // core-api would have been GREEN for the whole of the period the violation
  // existed. That is not hypothetical -- it is the state of the tree at the
  // commit before this one.
  //
  // deepEqual against a one-element list, not a subset: a second requirer is a
  // finding, not a warning. Adding a file here is always the wrong repair --
  // core-api is the controlling API and no other app drives a display.
  assert.deepEqual(repositoryFilesMatching(SDK_REQUIRE), ["apps/core-api/epaper/hub-client.js"]);
});

test("the repository walker really scanned the other apps, with POSIX separators", () => {
  // The anti-vacuity floor for the rule above, and it is the same lesson C9
  // learned the expensive way: a walker returning [] makes "no file matches X"
  // pass forever. These four sentinels sit in the three apps and the one package
  // the rule has to be able to see -- apps/customer-order most of all, since it
  // is the app the boundary was moved OUT of.
  for (const sentinel of [
    "apps/core-api/epaper/hub-client.js",
    "apps/customer-order/server.js",
    "apps/epaper-hub/server.js",
    "packages/epaper-hub-sdk/index.js"
  ]) {
    assert.ok(REPOSITORY_FILES.includes(sentinel), `sentinel ${sentinel} was not scanned`);
  }

  assert.ok(
    REPOSITORY_FILES.every((file) => !file.includes("\\")),
    "a scanned repository path contains a backslash: path.sep was not normalised"
  );
});

test("C4: withUnscopedConnection has nine sanctioned callers and no others", () => {
  // The budget itself, so the list cannot be padded without a visible diff.
  assert.equal(UNSCOPED_ALLOWLIST.length, 9);
  assert.equal(new Set(UNSCOPED_ALLOWLIST).size, 9);

  assert.deepEqual(
    filesMatching(UNSCOPED_CALL).filter((file) => !UNSCOPED_ALLOWLIST.includes(file)),
    [],
    "a file outside the allowlist calls withUnscopedConnection"
  );
});

test("C5: the cross-tenant escape hatch appears only under repositories/platform/", () => {
  assert.deepEqual(
    filesMatching(CROSS_TENANT_NEEDLE, (file) => !file.startsWith("repositories/platform/")),
    []
  );
});

// C2 -- raw query calls live only under db/. Everything else goes through the
// choke point, or the tenant predicate came from nowhere.
//
// TWO needles, because the rule has two jobs and one regex cannot do both. This
// one bans the two identifiers that mean "a real pg Client" EVERYWHERE outside
// db/, including inside the C4 allowlist, where the handle is a narrow
// { query } object and calling it `client` misdescribes what is held.
const RAW_QUERY = rule(
  "C2 raw query",
  /\b(?:pool|client)\.query\s*\(/,
  "await client.query('SELECT 1');",
  "// await client.query('SELECT 1');"
);

// ...and this one bans a query on ANY handle, exempted by file rather than by
// name. Strictly broader than RAW_QUERY, and applied to a strictly narrower set
// of files -- neither replaces the other. Verified green against the tree the day
// it landed: the only `.query(` outside db/ is repositories/auth/audit.js, which
// is already on C4's list, so this needs zero new exceptions.
const ANY_HANDLE_QUERY = rule(
  "C2 query on any handle",
  /\.query\s*\(/,
  "await session.query('SELECT 1');",
  "// await session.query('SELECT 1');"
);

// C3 -- one way to register a route means one place authentication can be
// forgotten. This is the static half of the fix for Express's
// app.use('/api/terminal', mw) boundary-matching hole, which does not cover
// /api/terminals/*.
const EXPRESS_REQUIRE = rule(
  "C3 require express",
  /require\(\s*["']express["']\s*\)/,
  'const express = require("express");',
  '// const express = require("express");'
);

const ROUTE_REGISTRATION = rule(
  "C3 route registration",
  /\bapp\.(?:get|post|put|patch|delete|use)\s*\(|\bexpress\.Router\s*\(/,
  "app.use('/api/terminal', mw);",
  "// app.use('/api/terminal', mw);"
);

// C16 -- spec 11.7, stated as an exclusive: "@restaurant/epaper-hub-sdk has
// exactly one permitted caller, and it is core-api." The SDK reaches twelve
// physical panels and renders the QR from a URL that IS the table's visit
// credential, so "which process may drive a display" is an authorisation
// question, not a layering preference.
//
// The specifier is SPLICED for the same reason C5's needle is: the two proofs
// this rule is graded by are `grep -rn 'epaper-hub-sdk' apps/` and the deepEqual
// below, and a test file carrying the literal makes the first of them report a
// violation that is really its own scanner. Verified by mutation both ways --
// adding the require to another file turns C16 red, removing it turns it green.
const SDK_SPECIFIER = "@restaurant/epaper-hub" + "-sdk";

const SDK_REQUIRE = rule(
  "C16 require epaper-hub-sdk",
  new RegExp(`require\\(\\s*["']${SDK_SPECIFIER}["']\\s*\\)`),
  `const { createEpaperHubSdk } = require("${SDK_SPECIFIER}");`,
  `// const { createEpaperHubSdk } = require("${SDK_SPECIFIER}");`
);

// C4 -- the unscoped-connection allowlist: nine entries, under db/ and
// repositories/auth/. The only mechanism that stops an exempt zone expanding
// silently. Asserted as "no caller outside the list" rather than deepEqual,
// because repositories/auth/* arrives in a later plan; tighten it to a full
// deepEqual once all nine files exist.
const UNSCOPED_ALLOWLIST = [
  "db/index.js",
  "db/health.js",
  "db/migrate.js",
  "repositories/auth/users.js",
  "repositories/auth/sessions.js",
  "repositories/auth/terminal-tokens.js",
  "repositories/auth/pairing.js",
  "repositories/auth/scope-materialize.js",
  "repositories/auth/audit.js"
];

const UNSCOPED_CALL = rule(
  "C4 unscoped call",
  /\bwithUnscopedConnection\s*\(/,
  // MINIMAL on purpose. C4's pattern is /withUnscopedConnection\s*\(/, which
  // matches on the call alone -- a callback body here is decoration its own rule
  // never needed, and the decoration independently violated C2. Task 10 shipped a
  // C2 violation copied straight out of this string.
  "await withUnscopedConnection(fn);",
  "// await withUnscopedConnection(fn);"
);

// C5 -- the needle is built by concatenation so the scanner cannot match itself
// and report a false pass.
const CROSS_TENANT_NEEDLE = rule(
  "C5 cross-tenant needle",
  new RegExp("dangerously" + "QueryAcrossTenants"),
  "await dangerously" + "QueryAcrossTenants(scope, sql, params);",
  "// await dangerously" + "QueryAcrossTenants(scope, sql, params);"
);

test("C6: the platform exempt zone is budgeted at exactly seventeen functions", () => {
  // Asserted unconditionally: the literal IS the budget, and it must stay sorted
  // and duplicate-free whether or not the modules exist yet.
  assert.equal(PLATFORM_EXPORTS.length, 17);
  assert.equal(new Set(PLATFORM_EXPORTS).size, 17);
  assert.deepEqual(PLATFORM_EXPORTS, [...PLATFORM_EXPORTS].sort());
});

test(
  "C6: repositories/platform/ exports exactly the budgeted functions",
  {
    // A VISIBLE TAP skip, never a silent pass: the platform OPERATIONS arrive with
    // the platform routes, and this arms itself then.
    //
    // Armed on companies.js rather than on the directory, because the seam lands
    // before the operations that use it -- the same shape as 0002 and Plan 2a's
    // lib/ modules, which shipped with nothing reading them so the risky part
    // reached production alone. Keyed on the directory, query.js arriving by itself
    // would demand ten functions that have no reason to exist yet, and the only
    // ways out are to write ten stubs or to hold the seam back.
    //
    // The BUDGET above stays armed unconditionally, which is the half that stops
    // the list being padded. This clause only decides when the directory is
    // measured against it.
    skip: fs.existsSync(path.join(appRoot, "repositories", "platform", "companies.js"))
      ? false
      : "repositories/platform/ holds only the seam so far"
  },
  () => {
    const exported = [];
    for (const file of SOURCE_FILES.filter((f) => f.startsWith("repositories/platform/"))) {
      const module = require(path.join(appRoot, ...file.split("/")));
      for (const name of Object.keys(module)) {
        if (typeof module[name] === "function") exported.push(name);
      }
    }
    assert.deepEqual(exported.sort(), PLATFORM_EXPORTS);
  }
);

test("C7: no request logger, no api-key header, no credential-shaped query parameter", () => {
  assert.deepEqual(filesMatching(LOGGING_DEPENDENCY), []);
  assert.deepEqual(filesMatching(API_KEY_HEADER), []);

  for (const file of SOURCE_FILES) {
    const finder = new RegExp(CREDENTIAL_QUERY.source, "g");
    for (const access of sourceOf(file).match(finder) || []) {
      assert.ok(
        !/token|key|code|secret|password|session/i.test(access),
        `${file} reads a credential-shaped query parameter: ${access}`
      );
    }
  }
});

test("C8: no string-literal fallback for a credential-shaped environment variable", () => {
  assert.deepEqual(filesMatching(SECRET_FALLBACK), []);
});

test("C9: nothing under lib/ touches the filesystem, the network or the database", () => {
  assert.deepEqual(filesMatching(IMPURE_REQUIRE, (file) => file.startsWith("lib/")), []);

  // The forms the single rule() fixture never exercised. It only ever proved the
  // `node:fs` branch, which is why the mandatory-prefix and no-subpath holes
  // survived: the rule LOOKED mutation-tested. `require("net")` is the specific
  // one that matters -- lib/client-ip.js's whole signature exists to avoid it.
  for (const banned of [
    'require("net")',
    "require('net')",
    'require("fs")',
    'require("http")',
    'require("https")',
    'require("node:fs/promises")',
    'require("node:dns")',
    'require("dns/promises")',
    'require("node:tls")',
    'require("child_process")',
    'require("node:child_process")',
    'require( "node:net" )',
    'require("../db")',
    'require("../db/index")'
  ]) {
    assert.match(banned, IMPURE_REQUIRE, `C9 does not catch ${banned}`);
  }

  // ...and the permitted set, so widening the alternation cannot quietly ban the
  // thing lib/ is built out of. node:crypto is the CSPRNG behind every token and
  // every password hash; a rule that banned it would be repaired by weakening it.
  for (const allowed of [
    'require("node:crypto")',
    'require("crypto")',
    'require("./tokens")',
    'require("node:assert/strict")',
    'require("dns-packet")',
    'require("../db-fixtures")'
  ]) {
    assert.doesNotMatch(allowed, IMPURE_REQUIRE, `C9 wrongly catches ${allowed}`);
  }
});

test("C14: nothing under lib/ mints a credential from a non-cryptographic source", () => {
  assert.deepEqual(filesMatching(WEAK_RANDOM, (file) => file.startsWith("lib/")), []);
});

test("C15: every lib/ primitive still contains the construct that makes it strong", () => {
  // Each pattern is proved against the exact text it guards AND against the exact
  // text the regression replaces it with, so C15 cannot report green because the
  // regex is wrong rather than because the file is intact. This is the positive
  // rule's version of the fixture pair every rule() carries.
  const [SAFE_COMPARE, NFKC] = REQUIRED_PRIMITIVES;
  assert.match("return crypto.timingSafeEqual(actual, expected);", SAFE_COMPARE.pattern);
  assert.doesNotMatch("return actual.equals(expected);", SAFE_COMPARE.pattern);
  assert.match('password.normalize("NFKC"),', NFKC.pattern);
  assert.doesNotMatch("password,", NFKC.pattern);

  for (const { file, pattern, atLeast, why } of REQUIRED_PRIMITIVES) {
    // Load-bearing, and the whole reason C15 is a table rather than a bare
    // assert.match: without it a rename makes this rule vacuously green, which is
    // exactly how C9 spent the whole of Plan 1 comparing [] to [].
    assert.ok(SOURCE_FILES.includes(file), `C15 names ${file}, which was not scanned`);

    // Counted, not tested: `atLeast` is 2 for a construct that must appear on two
    // different code paths, and RegExp.test with /g is stateful -- see the note on
    // RULES. Comments are stripped first, so documenting the construct is not the
    // same as calling it.
    const found = (sourceOf(file).match(new RegExp(pattern.source, "g")) || []).length;
    assert.ok(
      found >= atLeast,
      `${file} has ${found} occurrence(s) of ${pattern}, needs ${atLeast}. ${why}`
    );
  }
});

// C6 -- exempt-zone budget. One entry per /api/platform/* route in the design,
// plus the audit writer. Adding an eleventh requires editing a name list in a
// test: a diff a reviewer cannot miss.
// Ten domain functions, plus the seam itself. dangerouslyQueryAcrossTenants was
// missing from the original budget because the budget was written from spec §5.4's
// list of OPERATIONS, and the seam is not an operation -- but §5.4's own file map
// puts it in this directory (repositories/platform/query.js), and C5 hunts for its
// name across the whole tree. Budgeting it here is what keeps "the entire
// cross-tenant surface is one grep" true.
//
// withPlatformScope is deliberately NOT here: repositories/platform/* take it from
// db/index.js the way repositories/auth/* take withUnscopedConnection, so it never
// becomes an export of this directory.
const PLATFORM_EXPORTS = [
  "appendPlatformAuditEvent",
  "createCompany",
  "createPlatformAdmin",
  "dangerouslyQueryAcrossTenants",
  "getCompany",
  // The five that attach a mark to a record and take the old file off the disk.
  // They are cross-tenant for one reason said twice: a logo key is the hash of the
  // file, so the same picture used by two companies is ONE file -- which makes
  // "is this still needed" a question about every company and every shop, and
  // makes a tenant-scoped answer to it a way to delete another company mark.
  "getCompanyLogo",
  "getPlatformAdmin",
  "getShopLogo",
  "isReferenced",
  "listCompanies",
  // The contact directory's platform half: every company's CEO and every shop's
  // manager, in one list, which is a shape that has no company_id in it by
  // definition. Widening the budget is the point of the budget -- it makes the
  // twelfth cross-tenant function a line in a diff rather than a file nobody
  // noticed appearing under this directory.
  "listContactsAcrossTenants",
  "listPlatformAdmins",
  "resetPlatformAdminPassword",
  "setCompanyLogo",
  "setShopLogo",
  "updateCompany",
  "updatePlatformAdmin"
];

// C7 -- credentials never travel through a channel that ends up in an access
// log, a Referer header or a browser history entry.
const LOGGING_DEPENDENCY = rule(
  "C7 morgan",
  /require\(\s*["']morgan["']\s*\)/,
  'const morgan = require("morgan");',
  '// const morgan = require("morgan");'
);

const API_KEY_HEADER = rule(
  "C7 x-api-key",
  /x-api-key/i,
  'const key = req.headers["x-api-key"];',
  '// const key = req.headers["x-api-key"];'
);

const CREDENTIAL_QUERY = rule(
  "C7 credential query parameter",
  /req\.query(?:\.[A-Za-z_$][\w$]*|\[\s*["'][^"']*["']\s*\])/,
  "const t = req.query.api_key;",
  "// const t = req.query.api_key;"
);

// C8 -- a string-literal fallback for a secret is a shipped default credential.
// `options.x ?? process.env.X` is fine; `process.env.X ?? "dev"` is not.
const SECRET_FALLBACK = rule(
  "C8 secret fallback",
  /process\.env\.[A-Z_]*(?:KEY|SECRET|PASSWORD|TOKEN|URL)[A-Z_]*\s*(?:\|\||\?\?)\s*["'`]/,
  'const dsn = process.env.DATABASE_URL || "postgres://dev";',
  '// const dsn = process.env.DATABASE_URL || "postgres://dev";'
);

// C9 -- what stops Tier 1 quietly decaying into Tier 3. A require-graph check,
// not a behaviour check: a lib/ module reading Date.now() passes this and is
// still non-deterministic. That discipline rests on review.
//
// The `node:` prefix is OPTIONAL and every branch takes a subpath, because the
// previous pattern demanded the prefix and allowed a subpath on the `../db`
// branch alone -- so `require("net")`, `require("fs")` and
// `require("node:fs/promises")` all walked past it. That is not a hypothetical
// gap: lib/client-ip.js takes `isIP` as an ARGUMENT, and the only justification
// for that contortion is this rule. If C9 cannot see `require("net")` -- the
// form every reference and every autocompletion produces -- the contortion is
// theatre, and the missing four characters are invisible in review because the
// reviewer reads the word "net" and sees a banned module correctly rejected.
// node:crypto is deliberately NOT banned: it is what makes lib/ strong, and C15
// requires it.
const IMPURE_REQUIRE = rule(
  "C9 impure require in lib",
  /require\(\s*["'](?:(?:node:)?(?:fs|http2|https?|net|dns|tls|dgram|child_process)|pg|\.\.\/db)(?:\/[^"']*)?["']\s*\)/,
  'const fs = require("node:fs");',
  '// const fs = require("node:fs");'
);

// C14 -- lib/ mints every credential in the service, and the strength of the
// randomness behind them is the one property with no observable signature. A
// Math.random() token is still 22 Base64URL characters, still unique across a
// thousand draws, and still passes C9 -- the downgrade REMOVES a require rather
// than adding one. Nothing else in the suite can see it.
//
// pseudoRandomBytes is banned alongside it: the name reads as a synonym for
// randomBytes and is not one.
const WEAK_RANDOM = rule(
  "C14 weak randomness in lib",
  /Math\.random\s*\(|pseudoRandomBytes/,
  "const x = Math.random();",
  "// const x = Math.random();"
);

// C15 -- the POSITIVE counterpart to C14, and the only rule in this file that
// asserts a file still CONTAINS something. Every other assertion here is
// `filesMatching(...) === []`, which by construction can only ever see text being
// ADDED. C14's own comment names that limitation -- "the downgrade REMOVES a
// require rather than adding one" -- and then encodes a single instance of it.
// The dangerous edit to a credential primitive is a DELETION, and until this rule
// there was nothing in the suite that could see one.
//
// MEMBERSHIP IS EARNED BY MEASUREMENT, not by looking crypto-shaped. An entry
// belongs here only if removing the construct leaves the whole suite GREEN;
// otherwise the behavioural test is the better guard, and a second copy of it
// here is decoration that rots into a rule nobody has seen fail. Both entries
// below were measured at 353/353 green with the construct gone.
//
// Two constructs that look like obvious members are deliberately ABSENT for that
// reason, also measured: crypto.randomBytes in lib/tokens.js (mintToken) and in
// hashPassword (the salt) each turn a test red on their own -- "minted tokens do
// not repeat" and the distinct-hash test -- and C14 independently bans
// Math.random(). Adding them would grow the table without closing anything.
const REQUIRED_PRIMITIVES = [
  {
    file: "lib/password.js",
    pattern: /crypto\.timingSafeEqual\s*\(/,
    atLeast: 1,
    why:
      "This is the derived-key comparison on the unauthenticated login path. " +
      "Swapping it for actual.equals(expected) -- a byte-at-a-time compare that " +
      "leaks the match length through timing -- leaves every test green. The swap " +
      "has a WRITTEN motive, which is what makes it likely rather than exotic: " +
      "the comment above the call flags that timingSafeEqual throws on a length " +
      "mismatch, while a sibling test in password.test.js demands that a " +
      "malformed stored value be false and never a throw."
  },
  {
    file: "lib/password.js",
    pattern: /\.normalize\(\s*["']NFKC["']\s*\)/,
    atLeast: 2,
    why:
      "ONE on the hash path (normalise) and ONE on the verify path, which is why " +
      "the count is 2 and not 1 -- a single occurrence means one of the two paths " +
      "lost it. Deleting the verify-path call leaves every test green: the sole " +
      "NFKC test compares hashPassword against hashPassword and never calls " +
      "verifyPassword, and every verifyPassword argument in the suite is pure " +
      "ASCII, hence NFKC-invariant. The effect is that anyone who set a password " +
      "through an IME hashes one way at write time and is compared another at " +
      "read time, and can never sign in again -- returned as a plain false, " +
      "indistinguishable from a wrong password. 'Normalisation belongs on the " +
      "write path' is the defensible-sounding instinct that gets it deleted."
  }
];

test("C10: migration filenames are contiguous, unique and additive-only", () => {
  const files = fs.readdirSync(path.join(appRoot, "migrations")).sort();

  assert.ok(files.length >= 1, "migrations/ is empty");
  for (const file of files) assert.match(file, /^\d{4}_[a-z0-9_]+\.sql$/);

  const numbers = files.map((file) => Number(file.slice(0, 4)));
  assert.equal(new Set(numbers).size, numbers.length, "duplicate migration prefix");
  assert.deepEqual(
    numbers,
    numbers.map((_, index) => index + 1),
    "migration numbers are not contiguous from 0001"
  );

  for (const file of files) {
    const raw = readText(appRoot, "migrations", file);
    const stripped = stripComments(raw, ".sql");

    assert.ok(!DESTRUCTIVE_DDL.test(stripped), `${file} drops a table or a column`);
    if (UNSAFE_NOT_NULL.test(stripped)) {
      assert.match(stripped, /\bDEFAULT\b/i, `${file} adds NOT NULL with no DEFAULT`);
    }
    // Checked against RAW text on purpose: this directive IS a comment, so
    // stripping first would make the rule unenforceable.
    assert.ok(!raw.includes(NO_TRANSACTION_DIRECTIVE), `${file} opts out of the transaction`);
  }
});

test("C13: test/ holds only *.test.js, and no test writes into the app's migrations/", () => {
  const entries = fs.readdirSync(path.join(appRoot, "test"), { withFileTypes: true });
  assert.ok(entries.length >= 1, "test/ is empty");

  for (const entry of entries) {
    assert.ok(entry.isFile(), `test/${entry.name} is not a file`);
    assert.match(entry.name, /\.test\.js$/, `test/${entry.name} is not a *.test.js file`);
  }

  for (const entry of entries) {
    const source = stripComments(readText(appRoot, "test", entry.name), ".js");
    const finder = new RegExp(WRITE_CALL.source, "g");
    for (const call of source.match(finder) || []) {
      assert.ok(
        !/migrations/.test(call) || /tmp/i.test(call),
        `test/${entry.name} writes into a migrations directory outside tmp: ${call.slice(0, 120)}`
      );
    }
  }
});

// C10 -- migration hygiene. Additive-only discipline is the entire safety story
// for a push-to-main pipeline with no staging tier.
const DESTRUCTIVE_DDL = rule(
  "C10 destructive DDL",
  /\bDROP\s+(?:TABLE|COLUMN)\b/i,
  "ALTER TABLE users DROP COLUMN email;",
  "-- ALTER TABLE users DROP COLUMN email;",
  ".sql"
);

const UNSAFE_NOT_NULL = rule(
  "C10 SET NOT NULL",
  /\bSET\s+NOT\s+NULL\b/i,
  "ALTER TABLE users ALTER COLUMN email SET NOT NULL;",
  "-- ALTER TABLE users ALTER COLUMN email SET NOT NULL;",
  ".sql"
);

const NO_TRANSACTION_DIRECTIVE = "-- migrate: no-transaction";

// C13 -- test/ contains only *.test.js, because node --test spawns every .js
// under a directory named test as its own process: a helper here would race the
// real suites and could DROP the template out from under a sibling. The write
// rule is scoped to "names migrations without naming tmp", so migrate.test.js
// can still build whole migration directories under os.tmpdir(). The positive
// fixture is spliced so this file cannot match itself and report a false pass.
const WRITE_CALL = rule(
  "C13 filesystem write call",
  /\b(?:writeFileSync|appendFileSync|copyFileSync|renameSync|unlinkSync|rmSync|mkdirSync|cpSync)\s*\([^;]*/,
  "fs.write" + 'FileSync(path.join(dir, "migrations", "0002_bad.sql"), sql);',
  "// fs.write" + 'FileSync(path.join(dir, "migrations", "0002_bad.sql"), sql);'
);
