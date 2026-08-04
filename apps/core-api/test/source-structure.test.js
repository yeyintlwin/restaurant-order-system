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

test("the walker scanned every Plan-1 source file, with POSIX separators", () => {
  // Requirement 2: a floor plus sentinels. Without it, a walker returning []
  // makes every "no file matches X" rule below pass. Plan 1 ends with exactly
  // fifteen scanned files: config.js, env-file.js, server.js,
  // db/{errors,health,index,migrate,pool,scope}.js, http/{respond,router}.js,
  // http/routes/health.js, migrations/0001_init.sql and
  // scripts/{reset-database,setup-template-db}.js. Raise this floor in each
  // later plan as lib/, repositories/ and http/routes/ fill in.
  assert.ok(
    SOURCE_FILES.length >= 15,
    `scanned only ${SOURCE_FILES.length} files: ${SOURCE_FILES.join(", ")}`
  );

  for (const sentinel of ["db/index.js", "http/routes/health.js", "migrations/0001_init.sql"]) {
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

test("C2: no raw pool/client query outside db/", () => {
  assert.deepEqual(filesMatching(RAW_QUERY, (file) => !file.startsWith("db/")), []);
});

test("C3: only http/router.js requires express or registers a route", () => {
  assert.deepEqual(filesMatching(EXPRESS_REQUIRE), ["http/router.js"]);
  assert.deepEqual(filesMatching(ROUTE_REGISTRATION, (file) => file !== "http/router.js"), []);
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
const RAW_QUERY = rule(
  "C2 raw query",
  /\b(?:pool|client)\.query\s*\(/,
  "await client.query('SELECT 1');",
  "// await client.query('SELECT 1');"
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
  "await withUnscopedConnection((client) => client.query(sql));",
  "// await withUnscopedConnection((client) => client.query(sql));"
);

// C5 -- the needle is built by concatenation so the scanner cannot match itself
// and report a false pass.
const CROSS_TENANT_NEEDLE = rule(
  "C5 cross-tenant needle",
  new RegExp("dangerously" + "QueryAcrossTenants"),
  "await dangerously" + "QueryAcrossTenants(scope, sql, params);",
  "// await dangerously" + "QueryAcrossTenants(scope, sql, params);"
);

test("C6: the platform exempt zone is budgeted at exactly ten functions", () => {
  // Asserted unconditionally: the literal IS the budget, and it must stay sorted
  // and duplicate-free whether or not the modules exist yet.
  assert.equal(PLATFORM_EXPORTS.length, 10);
  assert.equal(new Set(PLATFORM_EXPORTS).size, 10);
  assert.deepEqual(PLATFORM_EXPORTS, [...PLATFORM_EXPORTS].sort());
});

test(
  "C6: repositories/platform/ exports exactly the budgeted functions",
  {
    // A VISIBLE TAP skip, never a silent pass: repositories/platform/ arrives
    // with the platform routes in a later plan, and this arms itself then.
    skip: fs.existsSync(path.join(appRoot, "repositories", "platform"))
      ? false
      : "repositories/platform/ does not exist yet"
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
});

test("C14: nothing under lib/ mints a credential from a non-cryptographic source", () => {
  assert.deepEqual(filesMatching(WEAK_RANDOM, (file) => file.startsWith("lib/")), []);
});

// C6 -- exempt-zone budget. One entry per /api/platform/* route in the design,
// plus the audit writer. Adding an eleventh requires editing a name list in a
// test: a diff a reviewer cannot miss.
const PLATFORM_EXPORTS = [
  "appendPlatformAuditEvent",
  "createCompany",
  "createPlatformAdmin",
  "getCompany",
  "getPlatformAdmin",
  "listCompanies",
  "listPlatformAdmins",
  "resetPlatformAdminPassword",
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
const IMPURE_REQUIRE = rule(
  "C9 impure require in lib",
  /require\(\s*["'](?:node:fs|node:https?|node:net|pg|\.\.\/db(?:\/[^"']*)?)["']\s*\)/,
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
