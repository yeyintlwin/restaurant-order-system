# Core API Phase 1 — Plan 1: Foundation Implementation Plan

> **For agentic workers:** implement this plan one task at a time, in order, ticking each `- [ ]` as you go. Read **"How to pick this up"** below before Task 1 — it carries the execution order, the chunking, and two local hazards.
>
> If your tool has the superpowers skills, `superpowers:subagent-driven-development` or `superpowers:executing-plans` will drive this well. **They are not required.** Every task is self-contained: files, the complete test, the exact command, the expected output, the complete implementation, the commit.

**Goal:** Stand up apps/core-api as an Express + node-postgres service on port 3200 that validates its configuration, runs its migrations before it listens, answers /health and /health/ready, and enforces the tenant choke point with tests that cannot pass vacuously.

**Architecture:** A single CommonJS Express process. config.js is pure (env object in, frozen config out); db/pool.js is the only file that requires pg and exports functions, never a Pool; db/index.js is the choke point (withTenantScope / tenantQuery / withUnscopedConnection / buildTenantStatement) and re-exports pool lifecycle so every other module reaches the database through it; db/migrate.js applies migrations/0001_init.sql against a supplied client under a session advisory lock; http/router.js is the only file that requires express and owns route registration, boot-time table validation and the JSON 404/405/error tail. Tests are node --test only, with a real Postgres reached exclusively through testing/database.js, which clones a migrated template database per test file.

**Tech Stack:** Node 20 (CommonJS, plain JavaScript, no TypeScript), Express 4.21.x, node-postgres (pg) 8.x, PostgreSQL 14+ (16-alpine locally), node --test + node:assert/strict, npm workspaces at the repo root. pg is the only dependency new to the repository; express already ships in apps/epaper-hub.

**Spec:** [2026-07-29-core-api-phase1-design.md](../specs/2026-07-29-core-api-phase1-design.md). Section references below (§3.3, §9.4, …) point at it.

---

## Execution log

**Status: 11 of 48 tasks done.** The next thing to do is **Task 11**, then Task 19, then Tasks 12-17. A local Postgres is required from here on.

**Correction to the execution order below.** The note says to do Task 18 and "the `createEmptyDatabase` half of Task 19" before Task 10. The first half is right and the second is not: everything Task 19 appends sits below a `require("../db/migrate")`, so no part of it can load until `db/migrate.js` exists. `db/migrate.js` is created by **Task 11**. The order that actually works is **18, 10, 11, 19, 12-17** - Tasks 10 and 11 need nothing but `node:fs`, and Task 19 only needs the module to exist, not to be finished.

Append one row per working session. Record the last task actually finished — a
task counts as finished only when all five of its steps are ticked and its
commit exists.

| Date | Session did | Tasks finished | Commits | Next |
| --- | --- | --- | --- | --- |
| 2026-07-29 | Design and planning only. Wrote the Phase 1 spec, reviewed it adversarially (65 findings, 45 applied), wrote this plan from five parallel drafts and reconciled twelve conflicting signatures, then prepared the handoff. **Wrote no application code.** | none — 0/48 | `0f0651a`, `5a2a0e2`, `99ab46c`, `300bf0f` | Task 1 |
| 2026-07-29 | Task 1. `apps/core-api` now exists with its manifest, lockfile and first test. The test failed with the predicted `ENOENT` before the manifest was written, and both dependencies were verified to resolve inside `apps/core-api/node_modules` rather than from the repo root's hoisted `express`. | **1/48** | `416acea` | Task 2 |
| 2026-07-29 | Task 2. `.gitattributes` and the `apps/*/.env` line in `.dockerignore`. `git check-attr` confirms the rules stay narrow: `.sql` resolves to `eol: lf`, `apps/core-api/package.json` stays `unspecified`. | **2/48** | `75beae8` | Task 3 |
| 2026-07-29 | Task 3. `.env.example` — the variables with no code default, every credential left empty. Confirmed `.env.example` is tracked while `apps/core-api/.env` is ignored. | **3/48** | `7b5bf6c` | Task 4 |
| 2026-07-29 | Task 4. Operator README. **Corrected a defect in the task:** the quoted `28P01` message pointed at `apps/core-api/README.md 'Rotating database passwords'`, but the heading lives in `apps/core-api/README.md`. `db/health.js` (Task 37) copies that string, so the pointer was fixed here before it could propagate, and the test now asserts both the right path and the absence of the wrong one. | **4/48** | `18f822b` | Task 5 |
| 2026-07-29 | Tasks 5-7. `env-file.js` and the whole of `config.js`. Task 7 was applied as targeted additions rather than the full-file replacement it prescribes; the diff was five functions plus the returned keys. 28 tests across three suites, all green. **Note:** `npm --prefix apps/core-api test` cannot run until Task 20 creates `scripts/setup-template-db.js`, because `pretest` invokes it. Until then run `node --test apps/core-api/test/*.test.js` from the repository root. | **7/48** | `bfbae8c`, `818b6db`, `d6ae37e` | Task 8 |
| 2026-07-29 | Tasks 8-9, finishing Chunk A. `config.js` DEFAULTS pinned to the Compose block, root `npm test` wired to the core-api suite. 33 tests across three suites, all green, still with no database. | **9/48** | `d31b3b5` | Task 18 |
| 2026-07-29 | Tasks 18 and 10. Local Postgres 16 started on 5433. `testing/database.js` pure half, and `0001_init.sql` copied from Appendix A - digest matches the plan exactly. Smoke-applied against the real cluster: 11 tables, clean. **Found the execution-order note to be half wrong**; the corrected order is recorded above. | **11/48** | `5a3c2df`, `d4a0f49` | Task 11 |

## How to pick this up

This plan is written to be executed in chunks, across sessions, and by whatever
tool is at hand. Nothing about it depends on the conversation it came from.

**The checkboxes are the state.** Every step is a `- [ ]`. Tick them as you go and
commit the plan file with the code — the next session, or the next tool, reads the
last ticked box and continues from there. There is no other progress tracker, and
none is needed.

**The superpowers reference above is optional.** If your tool has those skills, use
them. If not, ignore the line: every task is self-contained — files to touch, the
complete test, the exact command, the expected output, the complete implementation,
the commit. Read the task, do the five steps, move on.

**To find out where you are**, from the repository root:

```bash
git log --oneline -5
npm test
```

If `apps/core-api` does not exist yet, start at Task 1.

### Execution order — read this before Task 10

**Do Task 18 and the `createEmptyDatabase` half of Task 19 BEFORE Task 10.**

Tasks 11–17 require `apps/core-api/testing/database.js`, and the task that creates
it sits in Part 3. Followed front to back, Task 11's test fails with
`Cannot find module '../testing/database'` — a failure that looks like a mistake in
the task rather than an ordering problem, and costs an hour to diagnose. The
dependency is one-directional and shallow: Part 2 needs only `createEmptyDatabase`
and the DSN plumbing, never `cloneTemplate` (which in turn needs `db/migrate.js`,
which is what Part 2 builds).

Suggested chunking. Each chunk ends with a green `npm test` and a commit, so any of
them is a safe place to stop for the day or hand over to another tool:

| Chunk | Tasks | Postgres? | Delivers |
| --- | --- | --- | --- |
| A | 1–9 | **no** | the package, the pure config validator, `npm test` wired |
| B | 18, and Task 19 up to `createEmptyDatabase` | yes | DSN plumbing and per-file database creation |
| C | 10–17 | yes | the migration runner and `0001_init.sql` |
| D | rest of 19, 20–22 | yes | `cloneTemplate`, `pretest`, `db:reset`, the two-tenant fixture |
| E | 23–28 | yes | the schema-invariant and source-structure suites |
| F | 29–38 | yes | the tenant choke point |
| G | 39–48 | mostly no | router, `/health`, `/health/ready`, bootstrap |

Chunk A needs no database at all, so it can be done before Postgres is installed.

### Two local hazards this machine has already hit

- **OneDrive flattens the workspace junction.** If `npm test` dies with
  `Unexpected token '.'`, the `@restaurant/epaper-hub-sdk` junction under
  `node_modules` has been replaced by a copy. Recreate it; the failure is not in
  your code.
- **CRLF.** Task 2 adds `*.sql text eol=lf` for a reason: without it the same
  migration file hashes differently on win32 and on the Ubuntu CI runner, and the
  runner reports a fatal checksum mismatch on a file nobody edited.

---

## Canonical interfaces

The five parts of this plan were drafted independently and reconciled against the
table below. **It is binding.** Where a task's code and this table disagree, the
table wins — a signature drift between two parts is the single most likely way
this plan produces code that does not run. Each entry records the form that was
rejected and why.

### `apps/core-api/db/migrate.js`

```text
runMigrations(client, options) -> Promise<{applied:string[], skipped:string[], missingFiles:string[], checked:boolean}>. `client` is an already-connected, duck-typed object with .query(text, values?); the caller owns its lifecycle. `options` = { directory (REQUIRED absolute path), appRolePassword?, check?=false, log?={info,warn}=console, now?=Date.now, sleep?, lockWaitMs?=60000 }.
Also exports: migrationsStatus(client, directory) -> Promise<'current'|'pending'|'checksum_mismatch'> (NEW in this plan; compares readMigrationFiles(directory) against the schema_migrations ledger, never throws on a pending/mismatch verdict — it returns it), readMigrationFiles(directory), normaliseSql(raw), checksumOf(buffer), MIGRATION_ADVISORY_LOCK_KEY=4264071001, MIGRATION_FILENAME_PATTERN, MINIMUM_SERVER_VERSION_NUM=140000, SCHEMA_MIGRATIONS_DDL.
CLI: a `if (require.main === module)` block at the bottom of db/migrate.js reads config, opens the migration pool, acquires one client, calls runMigrations(client, {directory: path.join(__dirname, '..', 'migrations'), appRolePassword: config.databaseAppPassword, check: process.argv.includes('--check')}), releases, closes the pool, and process.exit(1) on any throw. package.json keeps "migrate": "node db/migrate.js".
```

**Rejected alternative.** REJECTED: test-harness's runMigrations({connectionString, migrationsDir, logger}) and server-http's runMigrations({migrationsDir, connectionString, nodeEnv}). Both pass an options object in the `client` position, so every call throws 'runMigrations requires options.directory' before touching the database. The client-first form is the only one that can hold a session-level advisory lock and the BEGIN/COMMIT on one backend, and it is the only form with a complete implementation. Both callers must open a connection themselves.

### `apps/core-api/testing/database.js`

```text
cloneTemplate(testFilePath) -> Promise<Handle> and createEmptyDatabase(label) -> Promise<Handle>, where
Handle = { name:string, connectionString:string, unscoped(text, params?) -> Promise<pg.Result>, connect() -> Promise<pg.Client> (a DEDICATED, already-connected client with .query and .end — NOT a pool checkout), resetFixtures() -> Promise<pg.Result> (TRUNCATE only, no seeding), end() -> Promise<void>, drop() -> Promise<void> }.
skipDatabaseTests(env = process.env) -> false | "CORE_API_SKIP_DB_TESTS=1" — a FUNCTION. Every call site writes `describe(name, { skip: skipDatabaseTests() }, ...)` WITH parentheses.
Also exports: APP_ROOT, MIGRATIONS_DIR, TEMPLATE_DATABASE_NAME="core_api_test_template", MAINTENANCE_LOCK_ID=4264071002, FIXTURE_TABLES, TRUNCATE_STATEMENT, requireTestDatabaseUrl(env), databaseNameFor(path), maintenanceDsn(url, name), migrationChecksums(dir), isTemplateStale(disk, ledger), withMaintenanceClient(url, fn), ensureTemplateDatabase(), recreateDatabase(maintenanceDsn, databaseName) -> Promise<void> (NEW: owns the DROP/CREATE ... WITH (FORCE) mechanics so scripts/reset-database.js contains no `*.query(` call).
testing/database.js requires("pg") directly and is exempt from C1/C2/C4 because the source-structure walker excludes testing/.
```

**Rejected alternative.** REJECTED: cloneTemplate resolving to a bare DSN string (db-core), a module-level unscoped(callback) export (db-core), and a Handle with no connect() (migrations' withDatabase). The Handle form is the only one that satisfies all three consumers; connect() is added because the advisory-lock retry test and runMigrations both need two independent sessions, which a max:4 pool cannot guarantee.

### `apps/core-api/db/health.js`

```text
probeReadiness() -> Promise<'ready'|'timeout'|'unreachable'>
checkReadiness({ migrationsDir }) -> Promise<{ database:'ready'|'timeout'|'unreachable', migrations:'current'|'pending'|'checksum_mismatch' }> — composes probeReadiness() with migrationsStatus() from db/migrate.js over withUnscopedConnection; NEVER throws (any failure degrades to {database:'unreachable', migrations:'pending'}).
waitForDatabase({ attempts = 10, delayMs = 1000 } = {}) -> Promise<void> — thin wrapper: connectWithRetry(() => withUnscopedConnection((c) => c.query('SELECT 1')), { attempts, delayMs, variableName: 'DATABASE_URL' }).
connectWithRetry(attempt, options?), isRetryableConnectionError(error), fatalConnectionMessage(error, variableName), READINESS_STATEMENT_TIMEOUT_MS = 2000.
```

**Rejected alternative.** REJECTED: db-core's export list without checkReadiness/waitForDatabase (server.js and the health route both name them, so they would be undefined at runtime while the injected-collaborator tests stayed green), and probeReadiness returning a bare string to the health route (the route needs the {database, migrations} object). The migrations half is now genuinely computed instead of being assumed to exist.

### `apps/core-api/db/index.js`

```text
module.exports = { withTenantScope, tenantQuery, withUnscopedConnection, buildTenantStatement, openRuntimePool, openMigrationPool, acquireRuntimeClient, acquireMigrationClient, isRuntimePoolOpen, runtimePoolStats, closeMigrationPool, closeAllPools } — the last eight are straight re-exports of db/pool.js. Argument shapes are db/pool.js's: openRuntimePool({ connectionString, max }), openMigrationPool({ connectionString }).
```

**Rejected alternative.** REJECTED: server.js requiring ./db/pool directly. Spec 3.2 rule 1 says 'db/pool.js is the only file that may require("pg") ... Everything else goes through db/index.js', so the re-export is what makes `require("./db")` in server.js both correct and legal. Also REJECTED: openRuntimePool(config) — the frozen config carries databaseUrl/dbPoolMax, not connectionString/max, so the caller must translate.

### `apps/core-api/server.js`

```text
module.exports = { createApp, start, fatal, listenServer } — loadDotEnv is NOT exported here.
start(options = {}) -> Promise<http.Server>. Order: loadDotEnv() -> startupConfiguration(env) -> openMigrationPool({connectionString: config.databaseMigrationUrl}) -> acquireMigrationClient() -> runMigrations(client, { directory: migrationsDir, appRolePassword: config.databaseAppPassword }) -> client.release() -> closeMigrationPool() -> openRuntimePool({ connectionString: config.databaseUrl, max: config.dbPoolMax }) -> waitForDatabase({attempts:10, delayMs:1000}) -> createApp({ checkReadiness: () => checkReadiness({ migrationsDir }), log }) -> listenServer(app, config.port, config.host). All collaborators are overridable via options for tests: { config, env, migrationsDir, runMigrations, openMigrationPool, acquireMigrationClient, closeMigrationPool, openRuntimePool, waitForDatabase, checkReadiness, listen, log }.
fatal(error, options = {}) -> Promise<void> — logs error.message, awaits closeAllPools() swallowing failure, calls exit(1).
Requires: `const { openRuntimePool, openMigrationPool, acquireMigrationClient, closeMigrationPool, closeAllPools } = require("./db");` `const { checkReadiness, waitForDatabase } = require("./db/health");` `const { loadDotEnv } = require("./env-file");`
```

**Rejected alternative.** REJECTED: the drafted `openPool(config)` call, the `require("./db")` destructure of names db/index.js did not export, and the inline loadDotEnv. Also REJECTED: a start() that never opens the migration pool — spec 9.4 steps 2 and 10 require a dedicated max:1 pool that is end()ed before listen, and db/pool.js's three migration exports would otherwise have zero production callers.

### `apps/core-api/env-file.js`

```text
loadDotEnv(file = path.join(__dirname, ".env"), environment = process.env) -> undefined. Mutates `environment` in place, no-op when the file is absent, never overwrites an existing name, splits on /\r?\n/, strips one layer of surrounding quotes. module.exports = { loadDotEnv }. Tested only in test/env-file.test.js.
```

**Rejected alternative.** REJECTED: the byte-different inline copy in server.js plus its two tests in test/server-bootstrap.test.js. env-file.js is the only version that takes an `environment` argument, so it is unit-testable without mutating process.env, and it keeps config.js Tier-1 pure (no filesystem).

### `apps/core-api/package.json`

```text
name "core-api", private true, engines.node ">=20". dependencies EXACTLY { "express": "^4.21.2", "pg": "^8.13.0" } — Express 4 specifically; Express 5 changes path-pattern syntax and the OPTIONS/HEAD fallbacks the router tail depends on. scripts { start: "node server.js", pretest: "node scripts/setup-template-db.js", test: "node --test", migrate: "node db/migrate.js", db:reset: "node scripts/reset-database.js" }. A committed apps/core-api/package-lock.json produced by `npm --prefix apps/core-api install --no-workspaces`.
```

**Rejected alternative.** REJECTED: dependencies of exactly ["pg"]. Spec line 1044 says 'single dependency pg' but spec 3.2 rule 2, C3 and the line-2155 definition-of-done all require http/router.js to require("express"); the Dockerfile's `npm ci --workspaces=false` would then ship an image that dies at boot with MODULE_NOT_FOUND, masked locally by the root hoist of epaper-hub's express@4.22.2. Read 'single dependency' as 'single dependency new to the repo' and say so in a comment.

### `apps/core-api/test/source-structure.test.js`

```text
ONE file, ONE module header. scaffold-config CREATES it with: the requires (node:assert/strict, node:fs, node:path, node:test), constants `appRoot` and `repoRoot`, helpers `readText(...segments)` (UTF-8, CRLF normalised to LF) and `readJson(...segments)`, and the tests for the core-api manifest, C11 (root scripts.test names apps/core-api), C12 (.gitattributes + .dockerignore), the .env.example contract, and the README greps. The test-harness area APPENDS to the same file: `walk()`, `SOURCE_FILES`, `stripComments()`, `rule()`, `filesMatching()`, C1-C10, C13 and the two walker meta-tests — reusing appRoot/repoRoot/readText and redeclaring nothing.
```

**Rejected alternative.** REJECTED: test-harness creating its own complete copy with APP_ROOT/REPO_ROOT/read(). Two Create tasks on one path means the second either overwrites four tests or produces duplicate const declarations. test-harness also drops its own C11 and C12 tests, which scaffold-config already asserts.

### `repo-root files (.gitattributes, .dockerignore, package.json)`

```text
scaffold-config is the SOLE owner of all three.
.gitattributes (new file), exactly two rules: `*.sql text eol=lf` and `*.sh text eol=lf`. No `*.js` rule.
.dockerignore: append the single line `apps/*/.env` after the existing `.env` line; the file keeps node_modules / npm-debug.log / .env / .git / .DS_Store.
package.json scripts.test becomes `npm --prefix packages/epaper-hub-sdk test && npm --prefix apps/epaper-hub test && npm --prefix apps/customer-order test && npm --prefix apps/core-api test`.
Every other area ASSERTS these, never creates or edits them.
```

**Rejected alternative.** REJECTED: migrations creating .gitattributes and test-harness creating it a third time with `*.js text eol=lf` added — that rule would renormalise every existing .js in the repo on the next checkout, which is far outside Plan 1's blast radius. scaffold-config runs first in areaOrder, so .gitattributes lands before migrations commits 0001_init.sql, which is the sequencing constraint that mattered.

### `test command convention (all areas)`

```text
Every `Run:` line in every task is `node --test apps/core-api/test/<file>.test.js`, executed from the repository root. Never `npm --prefix apps/core-api test`.
```

**Rejected alternative.** REJECTED: the npm form. package.json declares `"pretest": "node scripts/setup-template-db.js"` from the very first task, and that script does not exist until the test-harness area, so ~20 steps would abort with 'Cannot find module ...setup-template-db.js' instead of the stated failure. The direct form also keeps the pure suites runnable with no database at all.

### `apps/core-api/db/scope.js (assertion technique)`

```text
createScope/assertTenantScope keep the drafted behaviour. The scope stamp MUST remain an own ENUMERABLE Symbol (Task 4's stamped-but-broken fixtures are built with `{...tenantScope()}`). Consequently every test that compares a whole scope writes `assert.deepEqual(Object.fromEntries(Object.entries(scope)), { ... })`, never `assert.deepEqual({ ...scope }, { ... })`.
```

**Rejected alternative.** REJECTED: spreading the scope into deepEqual. node:assert/strict compares own enumerable symbol keys, so that assertion fails against the very implementation the task ships, and the obvious 'fix' (making the stamp non-enumerable) silently turns the assertTenantScope tests into dead code.

### `apps/core-api/http/respond.js`

```text
SECURITY_HEADERS, ERROR_MESSAGES (31 codes), sendJson(res, status, body, extraHeaders = {}), sendError(res, error, requestId, extraHeaders = {}) — unchanged. test/respond.test.js gains one test that requires TOP_LEVEL_ERROR_CODES from db/errors.js and asserts `Object.keys(ERROR_MESSAGES).sort()` deep-equals `Object.keys(TOP_LEVEL_ERROR_CODES).sort()`, then drives sendError once per code asserting res.statusCode equals the mapped status.
```

**Rejected alternative.** REJECTED: two independent hand-transcribed 31-entry tables with no assertion tying them together. Both modules are Tier-1 pure, so the cross-check costs nothing and prevents a future code silently degrading to 500 internal_error.

---

## Part 1 — Package scaffolding and configuration

Nine tasks. They build, in order: the `apps/core-api` manifest, the two repo-root
files that keep migration checksums stable across win32/ubuntu, the environment
example, the operator README, the `.env` loader, the pure configuration validator in
three TDD slices, and finally the repo-root `npm test` wiring.

**This area is the SOLE owner of three repo-root files** — `/.gitattributes`,
`/.dockerignore` and the root `package.json` `scripts.test` entry. Every other area
(migrations, test-harness, db-core, server-http) **asserts** these files and never
creates or edits them. This area runs first, so `.gitattributes` is on disk before
the migrations area commits `apps/core-api/migrations/0001_init.sql` — which is the
one sequencing constraint that actually matters, because `.gitattributes` only
normalises files added *after* it exists and a `0001_init.sql` committed with CRLF
first would need `git add --renormalize` to repair.

**This area also CREATES `apps/core-api/test/source-structure.test.js`** with its
single module header (`node:assert/strict`, `node:fs`, `node:path`, `node:test`), the
constants `appRoot` / `repoRoot`, the helpers `readText(...segments)` /
`readJson(...segments)`, and exactly five tests: the core-api manifest contract, C12
(`.gitattributes` + `.dockerignore`), the `.env.example` contract, the README greps,
and C11 (root `scripts.test`). The **test-harness area APPENDS** `walk()`,
`SOURCE_FILES`, `stripComments()`, `rule()`, `filesMatching()`, C1–C10, C13 and the
two walker meta-tests **to this same file**, reusing `appRoot`, `repoRoot` and
`readText` and redeclaring neither the header nor the helpers.

**Every `Run:` line below is executed from the repository root and invokes
`node --test <file>` directly, never `npm --prefix apps/core-api test`.** The
manifest declares `"pretest": "node scripts/setup-template-db.js"` from its very
first commit, and that script does not exist until the test-harness area; the npm
form would therefore abort every step here with `Cannot find module
'…\scripts\setup-template-db.js'` instead of the stated failure. Node resolves
`require("../config")` relative to the test file, so the working directory does not
matter.

---

### Task 1: Create the `apps/core-api` package manifest

The manifest is first because every later test in this area lives under
`apps/core-api/test/`, and because `pg` and `express` must be installed before any
other area can `require("pg")` in `db/pool.js` or `require("express")` in
`http/router.js`.

**Files:**
- Create: `apps/core-api/package.json`
- Create: `apps/core-api/package-lock.json` (generated by npm, not hand-written)
- Test: `apps/core-api/test/source-structure.test.js`

- [x] **Step 1: Write the failing test**

```js
// apps/core-api/test/source-structure.test.js
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
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/source-structure.test.js`

Expected: FAIL with `Error: ENOENT: no such file or directory, open 'C:\Users\hwckv\OneDrive\Desktop\yeyintlwin\yeyintlwin-dev\restaurant-order-system\apps\core-api\package.json'`

- [x] **Step 3: Write the minimal implementation**

Create `apps/core-api/package.json`:

```json
{
  "name": "core-api",
  "version": "1.0.0",
  "private": true,
  "description": "Multi-tenant restaurant platform API: companies, shops, dining tables, users and terminals. pg is the only dependency NEW to this repository; apps/epaper-hub already ships express@^4.21.2.",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "pretest": "node scripts/setup-template-db.js",
    "test": "node --test",
    "migrate": "node db/migrate.js",
    "db:reset": "node scripts/reset-database.js"
  },
  "dependencies": {
    "express": "^4.21.2",
    "pg": "^8.13.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

Then generate the lockfile and `node_modules`. `--no-workspaces` keeps the install
local to `apps/core-api` so it produces its own `package-lock.json`; the root
`workspaces: ["apps/*"]` would otherwise hoist everything to the root lockfile and
the Dockerfile's `npm --prefix apps/core-api ci --workspaces=false` would have
nothing to read.

```bash
npm --prefix apps/core-api install --no-workspaces
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/source-structure.test.js`  Expected: PASS (1 test)

Then verify both dependencies really landed **inside `apps/core-api/node_modules`**,
not merely at the repo root — the root already hoists `express@4.22.2` for
epaper-hub, so `require("express")` from `apps/core-api` resolves upward and would
mask an omitted dependency until the Docker build:

```bash
node -e "require('./apps/core-api/node_modules/express')"
node -e "require('./apps/core-api/node_modules/pg')"
```

Both must exit 0 and print nothing.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/package.json apps/core-api/package-lock.json apps/core-api/test/source-structure.test.js
git commit -m "feat(core-api): add package manifest with express, pg and the script table"
```

---

### Task 2: Pin SQL line endings and keep per-app `.env` out of images

Spec §9.4: the migration runner hashes each `.sql` file and treats a mismatch as
fatal with **no escape hatch**. Git for Windows defaults to `autocrlf=true`, so
without `.gitattributes` the same untouched file yields one digest on this machine
and another on `ubuntu-latest`. The `.dockerignore` line is the other half: the root
file excludes only top-level `.env`, so a developer's `apps/core-api/.env` — which
now holds `DATABASE_URL` — would be baked into the production image.

Both files are owned **only** by this task. The migrations area and the test-harness
area assert their contents (C12 and the checksum tests) and must never create or
edit them; a second writer adding `*.js text eol=lf` would renormalise every
existing `.js` in the repository on the next checkout, far outside Plan 1's blast
radius.

**Files:**
- Create: `.gitattributes`
- Modify: `.dockerignore:3` (insert one line after `.env`)
- Test: `apps/core-api/test/source-structure.test.js` (append)

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/source-structure.test.js`:

```js
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
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/source-structure.test.js`

Expected: FAIL with `Error: ENOENT: no such file or directory, open 'C:\Users\hwckv\OneDrive\Desktop\yeyintlwin\yeyintlwin-dev\restaurant-order-system\.gitattributes'`

- [x] **Step 3: Write the minimal implementation**

Create `.gitattributes` at the repository root:

```gitattributes
# apps/core-api/db/migrate.js stores a SHA-256 of every migration file and treats a
# changed digest as a fatal, unrecoverable error. The developer works on win32 and
# images build on ubuntu-latest; with Git for Windows' default autocrlf=true the
# same untouched file hashes two different ways. The runner also normalises CRLF
# before hashing -- this is the belt to that braces.
*.sql text eol=lf

# A shell script checked out with CRLF fails on the Lightsail box with the
# unhelpful "\r: command not found" on its first line.
*.sh text eol=lf
```

Rewrite `.dockerignore` at the repository root (one line added after `.env`):

```dockerignore
node_modules
npm-debug.log
.env
apps/*/.env
.git
.DS_Store
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/source-structure.test.js`  Expected: PASS (2 tests)

Then confirm Git itself agrees the new rules are narrow — a file the rules must
**not** touch:

```bash
git check-attr text eol -- apps/core-api/package.json
```

Expected output: `apps/core-api/package.json: text: unspecified` and
`apps/core-api/package.json: eol: unspecified`.

- [x] **Step 5: Commit**

```bash
git add .gitattributes .dockerignore apps/core-api/test/source-structure.test.js
git commit -m "build: pin sql/sh line endings to lf and exclude apps/*/.env from images"
```

---

### Task 3: Write `apps/core-api/.env.example`

**Files:**
- Create: `apps/core-api/.env.example`
- Test: `apps/core-api/test/source-structure.test.js` (append)

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/source-structure.test.js`:

```js
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
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/source-structure.test.js`

Expected: FAIL with `Error: ENOENT: no such file or directory, open 'C:\Users\hwckv\OneDrive\Desktop\yeyintlwin\yeyintlwin-dev\restaurant-order-system\apps\core-api\.env.example'`

- [x] **Step 3: Write the minimal implementation**

Create `apps/core-api/.env.example`:

```dotenv
# Copy to apps/core-api/.env and fill in the blanks. The filled copy is already
# gitignored by the repository's `apps/*/.env` rule, and .dockerignore keeps it out
# of the production image.
#
# Only the variables that have NO code default are listed here. Everything else --
# the session, rate-limit, pairing and pool tunables -- is defaulted in config.js
# DEFAULTS to the same value docker-compose.yml sets. Repeating them here would
# create a second place to edit. See README.md for the full contract.

NODE_ENV=development
PORT=3200
HOST=127.0.0.1
TZ=UTC

# The single allowed Origin for every cookie-authenticated non-GET and for login.
# https is mandatory when NODE_ENV=production; http://localhost or http://127.0.0.1
# is accepted only outside production.
API_PUBLIC_ORIGIN=http://localhost:3200

# Comma-separated https origins for the narrow OPTIONS responder on
# /api/terminal/* only. Empty means no CORS headers are ever emitted, which is the
# Phase 1 shape: the kitchen-display and cashier-counter subdomains arrive in
# Phases 4 and 5.
TERMINAL_ALLOWED_ORIGINS=

# How many entries to count from the RIGHT of X-Forwarded-For when deriving the
# client IP. 0 means "use the socket address" and is the local value. Behind Nginx
# on the box the value is 1, and it is mandatory when NODE_ENV=production because a
# wrong hop count fails silently in both directions.
TRUSTED_PROXY_HOPS=0

# --- credentials: no defaults anywhere, fill these in yourself ----------------
#
# Start the local database first (port 5433 so a locally installed Postgres on
# 5432 cannot shadow it):
#
#   docker run -d --name core-db-dev \
#     -e POSTGRES_USER=core_api_owner -e POSTGRES_PASSWORD=<your-password> \
#     -e POSTGRES_DB=core -p 127.0.0.1:5433:5432 postgres:16-alpine
#
# POSTGRES_PASSWORD must be byte-identical to the password component of
# DATABASE_MIGRATION_URL. The server refuses to listen when the two disagree --
# that check is how "somebody edited one of the two secret files alone" is caught.
#
#   POSTGRES_PASSWORD=<your-password>
#   DATABASE_MIGRATION_URL=postgres://core_api_owner:<your-password>@127.0.0.1:5433/core
#   DATABASE_URL=postgres://core_api_app:<your-password>@127.0.0.1:5433/core
#
# DATABASE_URL must connect as core_api_app, never core_api_owner: pasting the
# migration DSN here hands the runtime pool DDL rights and deletes the two-role
# design the schema exists to create. Its password component is also what the
# migration runner feeds to ALTER ROLE core_api_app ... PASSWORD on every boot, so
# changing it here and restarting genuinely rotates the app credential.
POSTGRES_PASSWORD=
DATABASE_MIGRATION_URL=
DATABASE_URL=

# Maintenance-database DSN the test harness clones the template from. Without it
# the database suites THROW rather than skip, so a missing value can never silently
# disable the tenant-isolation sweep:
#
#   CORE_API_TEST_DATABASE_URL=postgres://core_api_owner:<your-password>@127.0.0.1:5433/postgres
CORE_API_TEST_DATABASE_URL=
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/source-structure.test.js`  Expected: PASS (3 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/.env.example apps/core-api/test/source-structure.test.js
git commit -m "docs(core-api): document the required environment variables in .env.example"
```

---

### Task 4: Write the `apps/core-api` operator README

Spec §12 gates the phase on two greps against this file
(`grep -q create-platform-admin apps/core-api/README.md` and
`grep -q CORE_API_TEST_DATABASE_URL apps/core-api/README.md`), and `db/health.js`'s
fatal `28P01` message points a reader at a *"Rotating database passwords"* runbook —
so that heading has to exist somewhere a developer can reach. The greps are mirrored
as assertions here so the requirement fails in the test run rather than at the end
of the phase.

**Files:**
- Create: `apps/core-api/README.md`
- Test: `apps/core-api/test/source-structure.test.js` (append)

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/source-structure.test.js`:

```js
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

  // The local recipe, including the deliberate 5433.
  assert.match(readme, /docker run -d --name core-db-dev/);
  assert.match(readme, /127\.0\.0\.1:5433:5432/);
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/source-structure.test.js`

Expected: FAIL with `Error: ENOENT: no such file or directory, open 'C:\Users\hwckv\OneDrive\Desktop\yeyintlwin\yeyintlwin-dev\restaurant-order-system\apps\core-api\README.md'`

- [x] **Step 3: Write the minimal implementation**

Create `apps/core-api/README.md`:

````markdown
# core-api

The multi-tenant platform API: companies, shops, dining tables, users and terminals.
Express 4 + node-postgres, plain CommonJS JavaScript, tests via `node --test`.
Listens on port **3200**, behind Nginx in production.

`pg` is the only dependency new to this repository — `apps/epaper-hub` already ships
`express@^4.21.2`.

## Local Postgres

```sh
docker run -d --name core-db-dev -e POSTGRES_USER=core_api_owner -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=core -p 127.0.0.1:5433:5432 postgres:16-alpine
```

Port **5433**, not 5432, so a Postgres already installed on the machine cannot
shadow the container. `core_api_owner` is the owner role; the runtime role
`core_api_app` is created by the migration runner on first boot, so there is nothing
to create by hand.

## Environment

Copy `.env.example` to `.env` and fill in the four blanks. `apps/core-api/.env` is
gitignored by the repository's `apps/*/.env` rule and excluded from the image by
`.dockerignore`. `server.js` loads it through `env-file.js`; a variable already
present in the real environment always wins over the file.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | Selects the production branch of the origin, proxy-hop and DSN-username rules. |
| `PORT` | `3200` | Integer 1–65535. |
| `HOST` | `0.0.0.0` | Exactly `127.0.0.1`, `::1` or `0.0.0.0`. `0.0.0.0` is correct **inside** a container. |
| `TZ` | `UTC` | Set on both containers so logs, `now()` and psql agree. |
| `API_PUBLIC_ORIGIN` | **required** | Origin only — no path, query, fragment or userinfo. `https:` in production; `http://localhost` / `http://127.0.0.1` allowed outside it. |
| `TERMINAL_ALLOWED_ORIGINS` | `""` | Comma-separated absolute **https** origins for the `/api/terminal/*` OPTIONS responder. Empty means no CORS headers at all — the Phase 1 shape. |
| `TRUSTED_PROXY_HOPS` | `0` | Count from the **right** of `X-Forwarded-For`. **Required** when `NODE_ENV=production`; a wrong value fails silently in both directions. |
| `POSTGRES_PASSWORD` | **required** | Owner-role password. Must equal the password component of `DATABASE_MIGRATION_URL` in **every** environment. ≥ 24 characters when `NODE_ENV=production`. |
| `DATABASE_MIGRATION_URL` | **required** | The migration pool (`max: 1`), closed before `listen()`. Username must be `core_api_owner` when `NODE_ENV=production` (CI runs as `postgres`). |
| `DATABASE_URL` | **required** | The runtime pool. Username must be `core_api_app` in every environment, and the DSN must differ from `DATABASE_MIGRATION_URL`. |
| `CORE_API_TEST_DATABASE_URL` | unset | Maintenance DSN the test harness clones the template from. Never set in production. |

Everything else — the session, pairing, rate-limit, scrypt and pool tunables — is
defaulted in `config.js` (`DEFAULTS`) to the same value `docker-compose.yml` sets,
so `node server.js` with only a `.env` file behaves like the container.
`test/config.test.js` asserts the two tables agree.

## Running

```sh
npm --prefix apps/core-api install --no-workspaces
npm --prefix apps/core-api run migrate      # apply migrations by hand (start() also does this)
npm --prefix apps/core-api start
```

`GET /health` answers as soon as the process is listening. `GET /health/ready`
reports the database and migration status and is what the deploy gate calls.

`npm --prefix apps/core-api run db:reset` is the only script in this repository that
destroys data. It refuses when `NODE_ENV=production`, refuses when the
`DATABASE_MIGRATION_URL` host is not `localhost` / `127.0.0.1` / `::1`, and requires
`--yes` on argv after printing host, port and database. It is also the sanctioned
answer to a local checksum surprise.

## Tests

```sh
npm --prefix apps/core-api test
```

The suite needs a Postgres it can create databases on. Set
`CORE_API_TEST_DATABASE_URL` to a **maintenance** database on that cluster:

```dotenv
CORE_API_TEST_DATABASE_URL=postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres
```

`pretest` builds a template database once and each test **file** clones it, so files
run in parallel without sharing rows. When `CORE_API_TEST_DATABASE_URL` is unset the
database suites **throw** rather than skip — a missing value must never silently
disable the tenant-isolation sweep.

The single deliberate escape hatch, for a laptop with no Postgres at all, is
`CORE_API_SKIP_DB_TESTS=1`. It turns `pretest` into a no-op exit 0 and makes the
database suites report **visible** TAP skips, so the pure suites still run:

```sh
# bash / CI
CORE_API_SKIP_DB_TESTS=1 npm --prefix apps/core-api test

# PowerShell (the development machine)
$env:CORE_API_SKIP_DB_TESTS = "1"; npm --prefix apps/core-api test
```

CI never sets it, and `test/ci-contract.test.js` asserts that.

A single pure suite can always be run straight from the repository root with no
database and no `pretest`:

```sh
node --test apps/core-api/test/config.test.js
```

## Rotating database passwords

The two credentials rotate by different mechanisms, and mixing them up is what the
startup equality check exists to catch.

**`core_api_app` (`DATABASE_URL`) — automatic.** The migration runner issues
`ALTER ROLE core_api_app LOGIN PASSWORD …` on **every** boot, using the password
component of `DATABASE_URL`. To rotate: edit `DATABASE_URL` in the secrets file and
restart. Nothing else is required.

**`core_api_owner` (`POSTGRES_PASSWORD` + `DATABASE_MIGRATION_URL`) — manual, and
the cluster must be told.** `POSTGRES_PASSWORD` is only read by `initdb`, so editing
it does **not** change the password of a cluster that already exists. Change the
role in the running cluster first, then update *both* lines in the secrets file in
the same edit — `config.js` refuses to listen if `POSTGRES_PASSWORD` and the
password inside `DATABASE_MIGRATION_URL` disagree, which is precisely how "somebody
edited one line and not the other" is caught.

If startup dies with:

> `DATABASE_MIGRATION_URL was rejected by the server (28P01). If you rotated
> POSTGRES_PASSWORD, the running cluster still holds the old value — see
> apps/core-api/README.md 'Rotating database passwords'.`

then the secrets file was rotated and the cluster was not. `28P01` is fatal with no
retry on purpose: retrying a wrong password for ten seconds buries a deterministic
failure behind a timeout.

## Bootstrapping the first platform administrator

*Ships in a later plan of this phase; recorded here so the runbook is in one place.*

```sh
cd ~/restaurant-order-system
CORE_ENV_FILE=../core-api.env docker compose exec core-api \
  node apps/core-api/scripts/create-platform-admin.js you@example.com
```

`docker compose exec`, **never `exec -T`**: `scripts/create-platform-admin.js` reads
the password from stdin with echo disabled and refuses to run when
`process.stdin.isTTY` is false, so a password can never reach shell history. It
connects with `DATABASE_URL` (`core_api_app`), not the owner. There is no `--force`;
a second run exits non-zero even if the first admin row is deleted, because the
guard reads the monotonic audit trail rather than current state.
````

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/source-structure.test.js`  Expected: PASS (4 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/README.md apps/core-api/test/source-structure.test.js
git commit -m "docs(core-api): add the local setup, test and password-rotation runbook"
```

---

### Task 5: Copy `loadDotEnv` into `apps/core-api/env-file.js`

Spec §9.9 calls for a copy of `loadDotEnv()` from `apps/customer-order/server.js:28-35`
— eight lines, no `dotenv` dependency, and it already refuses to override a value
already present in the environment.

> **DEPARTURE from spec §7's layout, stated deliberately.** §7 puts `loadDotEnv`
> inside `server.js`. It goes in its own module instead for two reasons: it can be
> unit-tested without booting a server or opening a pool, and `server.js` stays
> owned by the server area with no shared edit. It cannot go in `config.js`, which
> §8.8 pins to Tier 1 (no filesystem). **The server area does
> `const { loadDotEnv } = require("./env-file");` and calls it as step 0 of
> `start()`; it does not reimplement it, and `test/server-bootstrap.test.js` does
> not re-test it — the three tests below are the only ones.**

**Files:**
- Create: `apps/core-api/env-file.js`
- Test: `apps/core-api/test/env-file.test.js`

- [x] **Step 1: Write the failing test**

```js
// apps/core-api/test/env-file.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadDotEnv } = require("../env-file");

function writeEnvFile(lines, newline = "\n") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "core-api-env-"));
  const file = path.join(directory, ".env");
  fs.writeFileSync(file, lines.join(newline), "utf8");
  return file;
}

test("loadDotEnv fills only the names the environment does not already have", () => {
  const file = writeEnvFile([
    "# a comment line is ignored",
    "",
    "PORT=3200",
    "HOST=127.0.0.1",
    "POSTGRES_PASSWORD=devpassword"
  ]);
  const environment = { PORT: "9999" };

  loadDotEnv(file, environment);

  // A real environment variable -- from Compose, from CI, from the shell -- always
  // beats the file. Reversing this would let a stale local .env silently override
  // the secrets file on the box.
  assert.equal(environment.PORT, "9999");
  assert.equal(environment.HOST, "127.0.0.1");
  assert.equal(environment.POSTGRES_PASSWORD, "devpassword");
});

test("loadDotEnv strips one layer of surrounding quotes and ignores non-assignments", () => {
  const file = writeEnvFile([
    'API_PUBLIC_ORIGIN="http://localhost:3200"',
    "DATABASE_URL='postgres://core_api_app:pw@127.0.0.1:5433/core'",
    "TERMINAL_ALLOWED_ORIGINS=",
    "NOT A KEY",
    "SPACED KEY=value"
  ]);
  const environment = {};

  loadDotEnv(file, environment);

  assert.equal(environment.API_PUBLIC_ORIGIN, "http://localhost:3200");
  assert.equal(environment.DATABASE_URL, "postgres://core_api_app:pw@127.0.0.1:5433/core");
  assert.equal(environment.TERMINAL_ALLOWED_ORIGINS, "");
  assert.deepEqual(
    Object.keys(environment).sort(),
    ["API_PUBLIC_ORIGIN", "DATABASE_URL", "TERMINAL_ALLOWED_ORIGINS"]
  );
});

test("loadDotEnv reads a CRLF file and treats a missing file as a no-op", () => {
  // Every editor on this win32 machine writes CRLF, and a parser splitting on "\n"
  // alone would leave a trailing "\r" on every value -- turning a correct password
  // into an authentication failure that is invisible in the file.
  const file = writeEnvFile(["PORT=3200", "HOST=0.0.0.0"], "\r\n");
  const environment = {};

  loadDotEnv(file, environment);
  assert.equal(environment.PORT, "3200");
  assert.equal(environment.HOST, "0.0.0.0");

  const missing = path.join(path.dirname(file), "does-not-exist.env");
  assert.doesNotThrow(() => loadDotEnv(missing, environment));
  assert.deepEqual(Object.keys(environment).sort(), ["HOST", "PORT"]);
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/env-file.test.js`

Expected: FAIL with `Error: Cannot find module '../env-file'`

- [x] **Step 3: Write the minimal implementation**

```js
// apps/core-api/env-file.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * A copy of loadDotEnv() from apps/customer-order/server.js:28-35, duplicated
 * rather than shared: packages/shared is not in the root "workspaces" array, so
 * consuming it would mean changing the workspace layout for eight lines.
 *
 * A name already present in `environment` is never overwritten, so a real
 * environment variable always beats the file.
 *
 * The `environment` parameter is the one change from the original: it exists so the
 * test can assert against a plain object instead of mutating process.env for the
 * whole test worker. server.js calls loadDotEnv() with no arguments at all.
 */
function loadDotEnv(file = path.join(__dirname, ".env"), environment = process.env) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || environment[match[1]] !== undefined) continue;
    environment[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

module.exports = { loadDotEnv };
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/env-file.test.js`  Expected: PASS (3 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/env-file.js apps/core-api/test/env-file.test.js
git commit -m "feat(core-api): load apps/core-api/.env without a dotenv dependency"
```

---

### Task 6: `config.js` — credentials, DSNs and the public origin

The first of three slices. This one covers every rule that can hand an attacker
something: the two database credentials, the role split between them, and the origin
that CSRF and cookie policy are anchored to. Defaulted knobs (`PORT`, `HOST`, the
tunables) arrive in the next task.

Note `databaseAppPassword`: it is the decoded password component of `DATABASE_URL`,
and it exists because spec §9.4 has the migration runner issue
`ALTER ROLE core_api_app LOGIN PASSWORD …` on **every** boot. Without it the runner
has nothing to pass, the role stays `NOLOGIN` on a fresh cluster, and the documented
rotation lever is a no-op.

**Files:**
- Create: `apps/core-api/config.js`
- Test: `apps/core-api/test/config.test.js`

- [x] **Step 1: Write the failing test**

```js
// apps/core-api/test/config.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

const { startupConfiguration, ConfigurationError } = require("../config");

// The literal recipe from spec 9.9 "Local development". Every case below starts
// from one of these two environments and breaks exactly one thing, so a failure
// names the rule that fired rather than the first rule in the file.
const DEV_ENV = Object.freeze({
  NODE_ENV: "development",
  API_PUBLIC_ORIGIN: "http://localhost:3200",
  POSTGRES_PASSWORD: "devpassword",
  DATABASE_MIGRATION_URL: "postgres://core_api_owner:devpassword@127.0.0.1:5433/core",
  DATABASE_URL: "postgres://core_api_app:devpassword@127.0.0.1:5433/core"
});

const PRODUCTION_SECRET = "0123456789abcdef0123456789"; // 26 characters

const PRODUCTION_ENV = Object.freeze({
  NODE_ENV: "production",
  API_PUBLIC_ORIGIN: "https://api.yeyintlwin.com",
  TRUSTED_PROXY_HOPS: "1",
  POSTGRES_PASSWORD: PRODUCTION_SECRET,
  DATABASE_MIGRATION_URL: `postgres://core_api_owner:${PRODUCTION_SECRET}@core-db:5432/core`,
  DATABASE_URL: `postgres://core_api_app:${PRODUCTION_SECRET}@core-db:5432/core`
});

// An override of `undefined` deletes the key, which is how "the operator forgot
// this one" is expressed.
function withEnv(base, overrides) {
  const env = { ...base, ...overrides };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
  }
  return env;
}

function assertRefusal(env, variable) {
  assert.throws(() => startupConfiguration(env), (error) => {
    assert.ok(
      error instanceof ConfigurationError,
      `expected a ConfigurationError, got ${error.name}: ${error.message}`
    );
    assert.equal(
      error.variable,
      variable,
      `expected the refusal to name ${variable}, got ${error.variable} ("${error.message}")`
    );
    return true;
  });
}

test("accepts the documented local development environment", () => {
  const config = startupConfiguration(DEV_ENV);

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.isProduction, false);
  assert.equal(config.apiPublicOrigin, "http://localhost:3200");
  assert.equal(config.postgresPassword, "devpassword");
  // The credential db/migrate.js feeds to ALTER ROLE core_api_app on every boot.
  assert.equal(config.databaseAppPassword, "devpassword");
  assert.equal(config.databaseUrl, DEV_ENV.DATABASE_URL);
  assert.equal(config.databaseMigrationUrl, DEV_ENV.DATABASE_MIGRATION_URL);
  assert.equal(config.databaseMigrationHost, "127.0.0.1");
  assert.equal(config.databaseMigrationPort, 5433);
  assert.equal(config.databaseMigrationDatabase, "core");
  assert.equal(config.trustedProxyHops, 0);
  assert.ok(Object.isFrozen(config));
});

test("refuses to listen when a required variable is missing or empty", () => {
  for (const variable of [
    "POSTGRES_PASSWORD", "DATABASE_MIGRATION_URL", "DATABASE_URL", "API_PUBLIC_ORIGIN"
  ]) {
    assertRefusal(withEnv(DEV_ENV, { [variable]: undefined }), variable);
    assertRefusal(withEnv(DEV_ENV, { [variable]: "" }), variable);
  }

  // Whitespace is emptiness for everything except a password, which is read
  // untrimmed because a password may legitimately end in a space.
  assertRefusal(withEnv(DEV_ENV, { API_PUBLIC_ORIGIN: "   " }), "API_PUBLIC_ORIGIN");
  assertRefusal(withEnv(DEV_ENV, { DATABASE_URL: "   " }), "DATABASE_URL");
});

test("reads only the environment object it was given, never process.env", () => {
  const previous = process.env.API_PUBLIC_ORIGIN;
  process.env.API_PUBLIC_ORIGIN = "https://leaked.example.test";
  try {
    assertRefusal(withEnv(DEV_ENV, { API_PUBLIC_ORIGIN: undefined }), "API_PUBLIC_ORIGIN");
  } finally {
    if (previous === undefined) delete process.env.API_PUBLIC_ORIGIN;
    else process.env.API_PUBLIC_ORIGIN = previous;
  }
});

test("the POSTGRES_PASSWORD length floor applies only under NODE_ENV=production", () => {
  const short = "short-but-fine"; // 14 characters

  const development = withEnv(DEV_ENV, {
    POSTGRES_PASSWORD: short,
    DATABASE_MIGRATION_URL: `postgres://core_api_owner:${short}@127.0.0.1:5433/core`,
    DATABASE_URL: `postgres://core_api_app:${short}@127.0.0.1:5433/core`
  });
  assert.equal(startupConfiguration(development).postgresPassword, short);

  assertRefusal(withEnv(PRODUCTION_ENV, {
    POSTGRES_PASSWORD: short,
    DATABASE_MIGRATION_URL: `postgres://core_api_owner:${short}@core-db:5432/core`,
    DATABASE_URL: `postgres://core_api_app:${short}@core-db:5432/core`
  }), "POSTGRES_PASSWORD");
});

test("POSTGRES_PASSWORD must equal the password inside DATABASE_MIGRATION_URL, always", () => {
  // The two live in one secrets file as two views of one credential. A difference
  // means somebody edited one line and not the other, in either environment.
  assertRefusal(withEnv(DEV_ENV, { POSTGRES_PASSWORD: "devpassword-typo" }), "POSTGRES_PASSWORD");
  assertRefusal(withEnv(PRODUCTION_ENV, {
    DATABASE_MIGRATION_URL: `postgres://core_api_owner:${PRODUCTION_SECRET}x@core-db:5432/core`
  }), "POSTGRES_PASSWORD");
});

test("a percent-encoded DSN password is compared after decoding", () => {
  const password = "p@ss word/50%";
  const env = withEnv(DEV_ENV, {
    POSTGRES_PASSWORD: password,
    DATABASE_MIGRATION_URL: "postgres://core_api_owner:p%40ss%20word%2F50%25@127.0.0.1:5433/core",
    DATABASE_URL: "postgres://core_api_app:p%40ss%20word%2F50%25@127.0.0.1:5433/core"
  });

  const config = startupConfiguration(env);
  assert.equal(config.postgresPassword, password);
  // ALTER ROLE ... PASSWORD must receive the decoded value, not the DSN escaping.
  assert.equal(config.databaseAppPassword, password);
});

test("a DSN whose password is not valid percent-encoding is refused by name", () => {
  assertRefusal(withEnv(DEV_ENV, {
    DATABASE_MIGRATION_URL: "postgres://core_api_owner:pa%ss@127.0.0.1:5433/core"
  }), "DATABASE_MIGRATION_URL");
});

test("both DSNs must be complete postgres connection strings", () => {
  for (const variable of ["DATABASE_MIGRATION_URL", "DATABASE_URL"]) {
    const username = variable === "DATABASE_URL" ? "core_api_app" : "core_api_owner";

    assertRefusal(withEnv(DEV_ENV, { [variable]: "not a url" }), variable);
    assertRefusal(withEnv(DEV_ENV, {
      [variable]: `mysql://${username}:devpassword@127.0.0.1:5433/core`
    }), variable);
    assertRefusal(withEnv(DEV_ENV, {
      [variable]: "postgres://:devpassword@127.0.0.1:5433/core"
    }), variable);
    assertRefusal(withEnv(DEV_ENV, {
      [variable]: `postgres://${username}@127.0.0.1:5433/core`
    }), variable);
    assertRefusal(withEnv(DEV_ENV, {
      [variable]: `postgres://${username}:devpassword@127.0.0.1:5433/`
    }), variable);
    // A host that is neither core-db nor loopback crosses a network we do not own,
    // so plaintext is refused there.
    assertRefusal(withEnv(DEV_ENV, {
      [variable]: `postgres://${username}:devpassword@db.example.com:5432/core`
    }), variable);
  }

  const remote = withEnv(DEV_ENV, {
    DATABASE_MIGRATION_URL: "postgresql://core_api_owner:devpassword@db.example.com:5432/core?sslmode=require",
    DATABASE_URL: "postgresql://core_api_app:devpassword@db.example.com:5432/core?sslmode=require"
  });
  const config = startupConfiguration(remote);
  assert.equal(config.databaseMigrationHost, "db.example.com");
  assert.equal(config.databaseMigrationPort, 5432);
});

test("DATABASE_URL is always core_api_app; the owner username is required only in production", () => {
  // Pasting the migration DSN here hands the runtime pool DDL rights.
  assertRefusal(withEnv(DEV_ENV, {
    DATABASE_URL: "postgres://core_api_owner:devpassword@127.0.0.1:5433/core"
  }), "DATABASE_URL");

  // CI runs as postgres, so a non-owner migration username must stay legal outside
  // production or the runner could not be exercised at all.
  const ci = withEnv(DEV_ENV, {
    DATABASE_MIGRATION_URL: "postgres://postgres:devpassword@127.0.0.1:5433/core"
  });
  assert.equal(startupConfiguration(ci).databaseMigrationUrl, ci.DATABASE_MIGRATION_URL);

  assertRefusal(withEnv(PRODUCTION_ENV, {
    DATABASE_MIGRATION_URL: `postgres://postgres:${PRODUCTION_SECRET}@core-db:5432/core`
  }), "DATABASE_MIGRATION_URL");
});

test("DATABASE_URL must differ from DATABASE_MIGRATION_URL", () => {
  const same = "postgres://core_api_app:devpassword@127.0.0.1:5433/core";
  assertRefusal(withEnv(DEV_ENV, {
    DATABASE_MIGRATION_URL: same,
    DATABASE_URL: same
  }), "DATABASE_URL");
});

test("API_PUBLIC_ORIGIN is an origin, and plaintext is a development-only relaxation", () => {
  assert.equal(
    startupConfiguration(withEnv(DEV_ENV, { API_PUBLIC_ORIGIN: "https://api.yeyintlwin.com/" })).apiPublicOrigin,
    "https://api.yeyintlwin.com"
  );
  assert.equal(
    startupConfiguration(withEnv(DEV_ENV, { API_PUBLIC_ORIGIN: "http://127.0.0.1:3200" })).apiPublicOrigin,
    "http://127.0.0.1:3200"
  );
  assert.equal(startupConfiguration(PRODUCTION_ENV).apiPublicOrigin, "https://api.yeyintlwin.com");

  for (const bad of [
    "api.yeyintlwin.com",
    "https://api.yeyintlwin.com/admin",
    "https://api.yeyintlwin.com/?x=1",
    "https://api.yeyintlwin.com/#fragment",
    "https://user:pw@api.yeyintlwin.com",
    "http://evil.example.test"
  ]) {
    assertRefusal(withEnv(DEV_ENV, { API_PUBLIC_ORIGIN: bad }), "API_PUBLIC_ORIGIN");
  }

  assertRefusal(withEnv(PRODUCTION_ENV, { API_PUBLIC_ORIGIN: "http://localhost:3200" }), "API_PUBLIC_ORIGIN");
});

test("TRUSTED_PROXY_HOPS defaults to 0 outside production and is mandatory inside it", () => {
  assert.equal(startupConfiguration(DEV_ENV).trustedProxyHops, 0);
  assert.equal(startupConfiguration(withEnv(DEV_ENV, { TRUSTED_PROXY_HOPS: "2" })).trustedProxyHops, 2);
  assert.equal(startupConfiguration(PRODUCTION_ENV).trustedProxyHops, 1);

  // A wrong hop count fails silently in both directions, so production states it.
  assertRefusal(withEnv(PRODUCTION_ENV, { TRUSTED_PROXY_HOPS: undefined }), "TRUSTED_PROXY_HOPS");
  for (const bad of ["-1", "1.5", "one"]) {
    assertRefusal(withEnv(DEV_ENV, { TRUSTED_PROXY_HOPS: bad }), "TRUSTED_PROXY_HOPS");
  }
});

test("startupConfiguration refuses anything that is not an environment object", () => {
  for (const value of [undefined, null, "PORT=3200", 42]) {
    assert.throws(() => startupConfiguration(value), TypeError);
  }
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/config.test.js`

Expected: FAIL with `Error: Cannot find module '../config'`

- [x] **Step 3: Write the minimal implementation**

```js
// apps/core-api/config.js
"use strict";

// PURE (spec 8.8, Tier 1). startupConfiguration(env) reads nothing ambient -- no
// process.env, no clock, no filesystem -- so every rule below is exercised by
// handing it a plain object. server.js is the only production caller and it passes
// process.env, after env-file.js's loadDotEnv() has filled the gaps.

const ORIGIN_LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

// Hosts a Postgres connection may reach without TLS: the Compose service name and
// the loopback addresses. Anything else crosses a network we do not own.
const LOCAL_DATABASE_HOSTS = ["core-db", "localhost", "127.0.0.1", "::1"];

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

class ConfigurationError extends Error {
  constructor(variable, problem) {
    super(`${variable} ${problem}`);
    this.name = "ConfigurationError";
    this.variable = variable;
  }
}

// Trimmed read, for values that are never secrets: a stray trailing space in a
// .env file is a typo everywhere except in a password.
function readValue(env, name) {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Untrimmed read. A password may legitimately end in a space, and trimming one
// silently turns a correct secret into an authentication failure nobody can see.
function readSecret(env, name) {
  const raw = env[name];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function required(name, value) {
  if (value === undefined) {
    throw new ConfigurationError(name, "must be set to a non-empty value");
  }
  return value;
}

function parseInteger(name, raw, min, max) {
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigurationError(name, `must be an integer, got "${raw}"`);
  }
  const value = Number(raw);
  const bound = max === UNBOUNDED ? `at least ${min}` : `between ${min} and ${max}`;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(name, `must be an integer ${bound}, got "${raw}"`);
  }
  return value;
}

function decodeComponent(name, part, value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ConfigurationError(
      name,
      `has a ${part} that is not valid percent-encoding (a literal % must be written %25)`
    );
  }
}

// `requiredUsername === null` means "any username", which is how CI, running as
// postgres, is allowed to drive the migration runner.
function parseDatabaseUrl(name, raw, requiredUsername) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(name, "must be a postgres:// connection string");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigurationError(name, `must use the postgres: or postgresql: scheme, got "${url.protocol}"`);
  }
  if (url.username === "") throw new ConfigurationError(name, "must include a username");
  if (url.password === "") throw new ConfigurationError(name, "must include a password");

  const database = decodeComponent(name, "database name", url.pathname.replace(/^\//, ""));
  if (database === "") throw new ConfigurationError(name, "must name a database");

  // new URL() keeps the square brackets on an IPv6 literal; every comparison here
  // wants the bare address.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_DATABASE_HOSTS.includes(host) && url.searchParams.get("sslmode") !== "require") {
    throw new ConfigurationError(
      name,
      `must set sslmode=require unless the host is one of ${LOCAL_DATABASE_HOSTS.join(", ")}, got "${host}"`
    );
  }

  const username = decodeComponent(name, "username", url.username);
  if (requiredUsername !== null && username !== requiredUsername) {
    throw new ConfigurationError(name, `must connect as ${requiredUsername}, got "${username}"`);
  }

  return {
    href: raw,
    username,
    password: decodeComponent(name, "password", url.password),
    database,
    host,
    port: url.port === "" ? 5432 : Number(url.port)
  };
}

function parseOrigin(name, raw, allowHttpLoopback) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(name, `must be an absolute URL, got "${raw}"`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError(name, `must not carry a username or password, got "${raw}"`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigurationError(name, `must not carry a query string or fragment, got "${raw}"`);
  }
  if (url.pathname !== "/") {
    throw new ConfigurationError(name, `must be an origin with no path, got "${url.pathname}"`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && allowHttpLoopback && ORIGIN_LOOPBACK_HOSTS.includes(host)) {
    return url.origin;
  }
  throw new ConfigurationError(name, allowHttpLoopback
    ? `must use https:, or http: with a ${ORIGIN_LOOPBACK_HOSTS.join("/")} host, got "${raw}"`
    : `must use https:, got "${raw}"`);
}

function startupConfiguration(env) {
  if (env === null || typeof env !== "object") {
    throw new TypeError("startupConfiguration(env) requires an environment object");
  }

  const nodeEnv = readValue(env, "NODE_ENV") ?? "development";
  const isProduction = nodeEnv === "production";

  const postgresPassword = required("POSTGRES_PASSWORD", readSecret(env, "POSTGRES_PASSWORD"));
  if (isProduction && postgresPassword.length < 24) {
    throw new ConfigurationError(
      "POSTGRES_PASSWORD",
      "must be at least 24 characters when NODE_ENV=production"
    );
  }

  // The core_api_owner rule is production-only so CI, which connects as postgres,
  // can run the migration runner at all (spec 9.4).
  const migration = parseDatabaseUrl(
    "DATABASE_MIGRATION_URL",
    required("DATABASE_MIGRATION_URL", readSecret(env, "DATABASE_MIGRATION_URL")),
    isProduction ? "core_api_owner" : null
  );

  // core_api_app is required in EVERY environment: pasting the migration DSN here
  // hands the runtime pool DDL rights and deletes the two-role design that
  // 0001_init.sql exists to create.
  const runtime = parseDatabaseUrl(
    "DATABASE_URL",
    required("DATABASE_URL", readSecret(env, "DATABASE_URL")),
    "core_api_app"
  );

  if (runtime.href === migration.href) {
    throw new ConfigurationError("DATABASE_URL", "must differ from DATABASE_MIGRATION_URL");
  }

  // Unconditional. The two are two views of one credential held in one secrets
  // file, so a difference means one line was edited and the other was not.
  if (migration.password !== postgresPassword) {
    throw new ConfigurationError(
      "POSTGRES_PASSWORD",
      "must equal the password component of DATABASE_MIGRATION_URL"
    );
  }

  const apiPublicOrigin = parseOrigin(
    "API_PUBLIC_ORIGIN",
    required("API_PUBLIC_ORIGIN", readValue(env, "API_PUBLIC_ORIGIN")),
    !isProduction
  );

  // Deliberately NOT defaulted to the Compose value of 1: a wrong hop count fails
  // silently in both directions, so production must state it and development gets
  // the fail-safe 0 ("use the socket address").
  const trustedProxyHopsRaw = readValue(env, "TRUSTED_PROXY_HOPS");
  if (isProduction && trustedProxyHopsRaw === undefined) {
    throw new ConfigurationError("TRUSTED_PROXY_HOPS", "must be set when NODE_ENV=production");
  }
  const trustedProxyHops = parseInteger("TRUSTED_PROXY_HOPS", trustedProxyHopsRaw ?? "0", 0, UNBOUNDED);

  return Object.freeze({
    nodeEnv,
    isProduction,

    postgresPassword,
    // The decoded password component of DATABASE_URL. db/migrate.js feeds it to
    // `ALTER ROLE core_api_app LOGIN PASSWORD <quote_literal($1)>` on every boot,
    // which is what makes "edit DATABASE_URL and redeploy" a real rotation and
    // what gives the role LOGIN at all on a fresh cluster.
    databaseAppPassword: runtime.password,
    databaseUrl: runtime.href,
    databaseMigrationUrl: migration.href,
    // Derived from DATABASE_MIGRATION_URL, for scripts/reset-database.js, which
    // prints host, port and database before it will destroy anything.
    databaseMigrationHost: migration.host,
    databaseMigrationPort: migration.port,
    databaseMigrationDatabase: migration.database,

    apiPublicOrigin,
    trustedProxyHops
  });
}

module.exports = { startupConfiguration, ConfigurationError };
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/config.test.js`  Expected: PASS (13 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/config.js apps/core-api/test/config.test.js
git commit -m "feat(core-api): validate credentials, DSNs and the public origin at startup"
```

---

### Task 7: `config.js` — the defaulted knobs

**Files:**
- Modify: `apps/core-api/config.js` (complete replacement below)
- Test: `apps/core-api/test/config.test.js` (append)

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/config.test.js`:

```js
test("PORT and HOST default to the container's values and reject anything else", () => {
  const config = startupConfiguration(DEV_ENV);
  assert.equal(config.port, 3200);
  assert.equal(config.host, "0.0.0.0");

  assert.equal(startupConfiguration(withEnv(DEV_ENV, { PORT: "65535" })).port, 65535);
  for (const port of ["0", "65536", "3.5", "3200abc", "-1"]) {
    assertRefusal(withEnv(DEV_ENV, { PORT: port }), "PORT");
  }

  for (const host of ["127.0.0.1", "::1", "0.0.0.0"]) {
    assert.equal(startupConfiguration(withEnv(DEV_ENV, { HOST: host })).host, host);
  }
  // HOST is a closed set of three: a public-IP typo here would publish the API
  // past Nginx. Note 0.0.0.0 is correct INSIDE a container -- a process bound to
  // 127.0.0.1 there is unreachable from docker-proxy and answers nothing.
  for (const host of ["localhost", "192.0.2.10", "0.0.0.0:3200"]) {
    assertRefusal(withEnv(DEV_ENV, { HOST: host }), "HOST");
  }
});

test("TERMINAL_ALLOWED_ORIGINS is an empty, frozen list by default", () => {
  const origins = startupConfiguration(DEV_ENV).terminalAllowedOrigins;

  assert.deepEqual(origins, []);
  assert.ok(Object.isFrozen(origins));
  assert.deepEqual(
    startupConfiguration(withEnv(DEV_ENV, { TERMINAL_ALLOWED_ORIGINS: "" })).terminalAllowedOrigins,
    []
  );
});

test("TERMINAL_ALLOWED_ORIGINS accepts exact https origins and nothing else", () => {
  assert.deepEqual(
    startupConfiguration(withEnv(DEV_ENV, {
      TERMINAL_ALLOWED_ORIGINS: "https://kitchen.example.test, https://counter.example.test"
    })).terminalAllowedOrigins,
    ["https://kitchen.example.test", "https://counter.example.test"]
  );

  for (const value of [
    "https://kitchen.example.test/app",                            // trailing path
    "https://kitchen.example.test,https://kitchen.example.test/",  // duplicate
    "http://localhost:3200",                                       // plaintext, even loopback
    "kitchen.example.test"                                         // not absolute
  ]) {
    assertRefusal(withEnv(DEV_ENV, { TERMINAL_ALLOWED_ORIGINS: value }), "TERMINAL_ALLOWED_ORIGINS");
  }
});

test("the tunables default to the container's values", () => {
  const config = startupConfiguration(DEV_ENV);

  assert.equal(config.sessionIdleSeconds, 28800);
  assert.equal(config.sessionAbsoluteSeconds, 604800);
  assert.equal(config.pairingCodeTtlSeconds, 900);
  assert.equal(config.terminalTokenTtlSeconds, 7776000);
  assert.equal(config.loginRatePerMinute, 30);
  assert.equal(config.loginTimeBudgetMs, 400);
  assert.equal(config.scryptSlots, 2);
  assert.equal(config.pairRatePerMinute, 20);
  assert.equal(config.adminMintRatePer10min, 20);
  assert.equal(config.pairingMintRatePer10min, 30);
  assert.equal(config.passwordAbuseThreshold, 5);
  assert.equal(config.rotateRatePerHour, 5);
  assert.equal(config.auditRetentionDays, 365);
  assert.equal(config.dbPoolMax, 8);
});

test("every count-style tunable refuses zero, a negative and a non-integer", () => {
  for (const variable of [
    "SESSION_IDLE_SECONDS", "SESSION_ABSOLUTE_SECONDS", "PAIRING_CODE_TTL_SECONDS",
    "TERMINAL_TOKEN_TTL_SECONDS", "LOGIN_RATE_PER_MINUTE", "SCRYPT_SLOTS",
    "PAIR_RATE_PER_MINUTE", "ADMIN_MINT_RATE_PER_10MIN", "PAIRING_MINT_RATE_PER_10MIN",
    "PASSWORD_ABUSE_THRESHOLD", "ROTATE_RATE_PER_HOUR", "AUDIT_RETENTION_DAYS", "DB_POOL_MAX"
  ]) {
    for (const bad of ["0", "-1", "1.5", "lots"]) {
      assertRefusal(withEnv(DEV_ENV, { [variable]: bad }), variable);
    }
  }
});

test("LOGIN_TIME_BUDGET_MS must leave room for worst-case scrypt", () => {
  // The fixed budget must exceed ~100 ms of scrypt with margin, or the
  // "byte-identical outcome after the same wall-clock budget" property leaks
  // through overrun.
  assert.equal(
    startupConfiguration(withEnv(DEV_ENV, { LOGIN_TIME_BUDGET_MS: "250" })).loginTimeBudgetMs,
    250
  );
  assertRefusal(withEnv(DEV_ENV, { LOGIN_TIME_BUDGET_MS: "249" }), "LOGIN_TIME_BUDGET_MS");
  assertRefusal(withEnv(DEV_ENV, { LOGIN_TIME_BUDGET_MS: "0" }), "LOGIN_TIME_BUDGET_MS");
});

test("SCRYPT_SLOTS and DB_POOL_MAX are bounded above as well as below", () => {
  // Above 8 slots the memory-hard parameters put the process inside OOM-killer
  // range on a 512 MB container; DB_POOL_MAX is sized against max_connections=40.
  assert.equal(startupConfiguration(withEnv(DEV_ENV, { SCRYPT_SLOTS: "8" })).scryptSlots, 8);
  assertRefusal(withEnv(DEV_ENV, { SCRYPT_SLOTS: "9" }), "SCRYPT_SLOTS");

  assert.equal(startupConfiguration(withEnv(DEV_ENV, { DB_POOL_MAX: "20" })).dbPoolMax, 20);
  assertRefusal(withEnv(DEV_ENV, { DB_POOL_MAX: "21" }), "DB_POOL_MAX");
});

test("SESSION_ABSOLUTE_SECONDS must strictly exceed SESSION_IDLE_SECONDS", () => {
  // Otherwise every session violates user_sessions_idle_within_absolute on its
  // first renewal.
  assertRefusal(
    withEnv(DEV_ENV, { SESSION_IDLE_SECONDS: "600", SESSION_ABSOLUTE_SECONDS: "600" }),
    "SESSION_ABSOLUTE_SECONDS"
  );
  assertRefusal(
    withEnv(DEV_ENV, { SESSION_IDLE_SECONDS: "600", SESSION_ABSOLUTE_SECONDS: "599" }),
    "SESSION_ABSOLUTE_SECONDS"
  );
  assert.equal(
    startupConfiguration(withEnv(DEV_ENV, {
      SESSION_IDLE_SECONDS: "600",
      SESSION_ABSOLUTE_SECONDS: "601"
    })).sessionAbsoluteSeconds,
    601
  );
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/config.test.js`

Expected: FAIL in `PORT and HOST default to the container's values and reject anything else` with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` / `undefined !== 3200`

- [x] **Step 3: Write the minimal implementation**

Replace `apps/core-api/config.js` in full:

```js
// apps/core-api/config.js
"use strict";

// PURE (spec 8.8, Tier 1). startupConfiguration(env) reads nothing ambient -- no
// process.env, no clock, no filesystem -- so every rule below is exercised by
// handing it a plain object. server.js is the only production caller and it passes
// process.env, after env-file.js's loadDotEnv() has filled the gaps.
//
// Naming rule: every DEFAULTED config key is the camelCase of its environment
// variable name (ADMIN_MINT_RATE_PER_10MIN -> adminMintRatePer10min). Derived keys
// -- isProduction, databaseAppPassword, databaseMigration* -- have no environment
// variable of their own.

const ORIGIN_LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

// Hosts a Postgres connection may reach without TLS: the Compose service name and
// the loopback addresses. Anything else crosses a network we do not own.
const LOCAL_DATABASE_HOSTS = ["core-db", "localhost", "127.0.0.1", "::1"];

// The only three addresses HOST may take. 0.0.0.0 is correct INSIDE a container:
// a process bound to 127.0.0.1 there is unreachable from docker-proxy and answers
// nothing. The "not reachable except through Nginx" property comes from the
// Compose mapping 127.0.0.1:3200:3200, not from this bind.
const BIND_ADDRESSES = ["127.0.0.1", "::1", "0.0.0.0"];

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

class ConfigurationError extends Error {
  constructor(variable, problem) {
    super(`${variable} ${problem}`);
    this.name = "ConfigurationError";
    this.variable = variable;
  }
}

// Trimmed read, for values that are never secrets: a stray trailing space in a
// .env file is a typo everywhere except in a password.
function readValue(env, name) {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Untrimmed read. A password may legitimately end in a space, and trimming one
// silently turns a correct secret into an authentication failure nobody can see.
function readSecret(env, name) {
  const raw = env[name];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function required(name, value) {
  if (value === undefined) {
    throw new ConfigurationError(name, "must be set to a non-empty value");
  }
  return value;
}

function parseInteger(name, raw, min, max) {
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigurationError(name, `must be an integer, got "${raw}"`);
  }
  const value = Number(raw);
  const bound = max === UNBOUNDED ? `at least ${min}` : `between ${min} and ${max}`;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(name, `must be an integer ${bound}, got "${raw}"`);
  }
  return value;
}

function readInteger(env, name, fallback, min, max) {
  return parseInteger(name, readValue(env, name) ?? fallback, min, max);
}

function decodeComponent(name, part, value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ConfigurationError(
      name,
      `has a ${part} that is not valid percent-encoding (a literal % must be written %25)`
    );
  }
}

// `requiredUsername === null` means "any username", which is how CI, running as
// postgres, is allowed to drive the migration runner.
function parseDatabaseUrl(name, raw, requiredUsername) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(name, "must be a postgres:// connection string");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigurationError(name, `must use the postgres: or postgresql: scheme, got "${url.protocol}"`);
  }
  if (url.username === "") throw new ConfigurationError(name, "must include a username");
  if (url.password === "") throw new ConfigurationError(name, "must include a password");

  const database = decodeComponent(name, "database name", url.pathname.replace(/^\//, ""));
  if (database === "") throw new ConfigurationError(name, "must name a database");

  // new URL() keeps the square brackets on an IPv6 literal; every comparison here
  // wants the bare address.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_DATABASE_HOSTS.includes(host) && url.searchParams.get("sslmode") !== "require") {
    throw new ConfigurationError(
      name,
      `must set sslmode=require unless the host is one of ${LOCAL_DATABASE_HOSTS.join(", ")}, got "${host}"`
    );
  }

  const username = decodeComponent(name, "username", url.username);
  if (requiredUsername !== null && username !== requiredUsername) {
    throw new ConfigurationError(name, `must connect as ${requiredUsername}, got "${username}"`);
  }

  return {
    href: raw,
    username,
    password: decodeComponent(name, "password", url.password),
    database,
    host,
    port: url.port === "" ? 5432 : Number(url.port)
  };
}

function parseOrigin(name, raw, allowHttpLoopback) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(name, `must be an absolute URL, got "${raw}"`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError(name, `must not carry a username or password, got "${raw}"`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigurationError(name, `must not carry a query string or fragment, got "${raw}"`);
  }
  if (url.pathname !== "/") {
    throw new ConfigurationError(name, `must be an origin with no path, got "${url.pathname}"`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && allowHttpLoopback && ORIGIN_LOOPBACK_HOSTS.includes(host)) {
    return url.origin;
  }
  throw new ConfigurationError(name, allowHttpLoopback
    ? `must use https:, or http: with a ${ORIGIN_LOOPBACK_HOSTS.join("/")} host, got "${raw}"`
    : `must use https:, got "${raw}"`);
}

function parseOriginList(name, raw) {
  const origins = [];
  for (const entry of raw.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    // https unconditionally, with no loopback relaxation: these origins name
    // browser apps on real subdomains, and an http entry would make the terminal
    // CORS responder advertise a plaintext origin from a production box.
    const origin = parseOrigin(name, entry, false);
    if (origins.includes(origin)) {
      throw new ConfigurationError(name, `lists ${origin} more than once`);
    }
    origins.push(origin);
  }
  return Object.freeze(origins);
}

function parseBindAddress(name, raw) {
  if (!BIND_ADDRESSES.includes(raw)) {
    throw new ConfigurationError(name, `must be one of ${BIND_ADDRESSES.join(", ")}, got "${raw}"`);
  }
  return raw;
}

function startupConfiguration(env) {
  if (env === null || typeof env !== "object") {
    throw new TypeError("startupConfiguration(env) requires an environment object");
  }

  const nodeEnv = readValue(env, "NODE_ENV") ?? "development";
  const isProduction = nodeEnv === "production";

  const postgresPassword = required("POSTGRES_PASSWORD", readSecret(env, "POSTGRES_PASSWORD"));
  if (isProduction && postgresPassword.length < 24) {
    throw new ConfigurationError(
      "POSTGRES_PASSWORD",
      "must be at least 24 characters when NODE_ENV=production"
    );
  }

  // The core_api_owner rule is production-only so CI, which connects as postgres,
  // can run the migration runner at all (spec 9.4).
  const migration = parseDatabaseUrl(
    "DATABASE_MIGRATION_URL",
    required("DATABASE_MIGRATION_URL", readSecret(env, "DATABASE_MIGRATION_URL")),
    isProduction ? "core_api_owner" : null
  );

  // core_api_app is required in EVERY environment: pasting the migration DSN here
  // hands the runtime pool DDL rights and deletes the two-role design that
  // 0001_init.sql exists to create.
  const runtime = parseDatabaseUrl(
    "DATABASE_URL",
    required("DATABASE_URL", readSecret(env, "DATABASE_URL")),
    "core_api_app"
  );

  if (runtime.href === migration.href) {
    throw new ConfigurationError("DATABASE_URL", "must differ from DATABASE_MIGRATION_URL");
  }

  // Unconditional. The two are two views of one credential held in one secrets
  // file, so a difference means one line was edited and the other was not.
  if (migration.password !== postgresPassword) {
    throw new ConfigurationError(
      "POSTGRES_PASSWORD",
      "must equal the password component of DATABASE_MIGRATION_URL"
    );
  }

  const apiPublicOrigin = parseOrigin(
    "API_PUBLIC_ORIGIN",
    required("API_PUBLIC_ORIGIN", readValue(env, "API_PUBLIC_ORIGIN")),
    !isProduction
  );

  // Deliberately NOT defaulted to the Compose value of 1: a wrong hop count fails
  // silently in both directions, so production must state it and development gets
  // the fail-safe 0 ("use the socket address").
  const trustedProxyHopsRaw = readValue(env, "TRUSTED_PROXY_HOPS");
  if (isProduction && trustedProxyHopsRaw === undefined) {
    throw new ConfigurationError("TRUSTED_PROXY_HOPS", "must be set when NODE_ENV=production");
  }
  const trustedProxyHops = parseInteger("TRUSTED_PROXY_HOPS", trustedProxyHopsRaw ?? "0", 0, UNBOUNDED);

  const sessionIdleSeconds = readInteger(env, "SESSION_IDLE_SECONDS", "28800", 1, UNBOUNDED);
  const sessionAbsoluteSeconds = readInteger(env, "SESSION_ABSOLUTE_SECONDS", "604800", 1, UNBOUNDED);
  if (sessionAbsoluteSeconds <= sessionIdleSeconds) {
    // Otherwise every session violates user_sessions_idle_within_absolute on its
    // first renewal.
    throw new ConfigurationError(
      "SESSION_ABSOLUTE_SECONDS",
      `must be strictly greater than SESSION_IDLE_SECONDS (${sessionIdleSeconds}), got ${sessionAbsoluteSeconds}`
    );
  }

  return Object.freeze({
    nodeEnv,
    isProduction,

    port: readInteger(env, "PORT", "3200", 1, 65535),
    host: parseBindAddress("HOST", readValue(env, "HOST") ?? "0.0.0.0"),

    postgresPassword,
    // The decoded password component of DATABASE_URL. db/migrate.js feeds it to
    // `ALTER ROLE core_api_app LOGIN PASSWORD <quote_literal($1)>` on every boot,
    // which is what makes "edit DATABASE_URL and redeploy" a real rotation and
    // what gives the role LOGIN at all on a fresh cluster.
    databaseAppPassword: runtime.password,
    databaseUrl: runtime.href,
    databaseMigrationUrl: migration.href,
    // Derived from DATABASE_MIGRATION_URL, for scripts/reset-database.js, which
    // prints host, port and database before it will destroy anything.
    databaseMigrationHost: migration.host,
    databaseMigrationPort: migration.port,
    databaseMigrationDatabase: migration.database,

    apiPublicOrigin,
    terminalAllowedOrigins: parseOriginList(
      "TERMINAL_ALLOWED_ORIGINS",
      readValue(env, "TERMINAL_ALLOWED_ORIGINS") ?? ""
    ),
    trustedProxyHops,

    sessionIdleSeconds,
    sessionAbsoluteSeconds,
    pairingCodeTtlSeconds: readInteger(env, "PAIRING_CODE_TTL_SECONDS", "900", 1, UNBOUNDED),
    terminalTokenTtlSeconds: readInteger(env, "TERMINAL_TOKEN_TTL_SECONDS", "7776000", 1, UNBOUNDED),
    loginRatePerMinute: readInteger(env, "LOGIN_RATE_PER_MINUTE", "30", 1, UNBOUNDED),
    // 250 ms floor: the budget must exceed worst-case scrypt (~100 ms) with margin
    // or the fixed-time login property leaks through overrun.
    loginTimeBudgetMs: readInteger(env, "LOGIN_TIME_BUDGET_MS", "400", 250, UNBOUNDED),
    // Above 8 the memory-hard parameters put the process inside OOM-killer range
    // on a 512 MB container that shares the box with Postgres.
    scryptSlots: readInteger(env, "SCRYPT_SLOTS", "2", 1, 8),
    pairRatePerMinute: readInteger(env, "PAIR_RATE_PER_MINUTE", "20", 1, UNBOUNDED),
    adminMintRatePer10min: readInteger(env, "ADMIN_MINT_RATE_PER_10MIN", "20", 1, UNBOUNDED),
    pairingMintRatePer10min: readInteger(env, "PAIRING_MINT_RATE_PER_10MIN", "30", 1, UNBOUNDED),
    passwordAbuseThreshold: readInteger(env, "PASSWORD_ABUSE_THRESHOLD", "5", 1, UNBOUNDED),
    rotateRatePerHour: readInteger(env, "ROTATE_RATE_PER_HOUR", "5", 1, UNBOUNDED),
    auditRetentionDays: readInteger(env, "AUDIT_RETENTION_DAYS", "365", 1, UNBOUNDED),
    // Sized against max_connections=40, leaving room for psql, pg_dump and the
    // migration connection.
    dbPoolMax: readInteger(env, "DB_POOL_MAX", "8", 1, 20)
  });
}

module.exports = { startupConfiguration, ConfigurationError };
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/config.test.js`  Expected: PASS (21 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/config.js apps/core-api/test/config.test.js
git commit -m "feat(core-api): validate the bind address, terminal origins and tunables"
```

---

### Task 8: Make the config defaults a table pinned to the Compose block

Spec §9.12: the Compose entries are meant to be *documentation*, with `config.js`
holding the load-bearing values, so a developer running `node server.js` with only a
`.env` file gets production-identical behaviour. That only stays true if something
fails when the two disagree. This task extracts the inline defaults into an exported
`DEFAULTS` table and pins it to the Compose block.

> **Seam.** `docker-compose.yml` is Plan 5. Until it exists the Compose block is
> reproduced in the test as a literal table copied from spec §9.1. When the file
> lands, the Plan 5 task replaces `COMPOSE_DEFAULTS` and
> `COMPOSE_CORE_API_ENVIRONMENT_KEYS` with a parse of the real `environment:` block
> and every assertion below keeps its meaning unchanged.

**Files:**
- Modify: `apps/core-api/test/config.test.js:4` (import `DEFAULTS`) and append
- Modify: `apps/core-api/config.js` (complete replacement below)

- [x] **Step 1: Write the failing test**

First replace line 4 of `apps/core-api/test/config.test.js` with:

```js
const { startupConfiguration, ConfigurationError, DEFAULTS } = require("../config");
```

Then append to the end of the file:

```js
// --- the Compose contract ---------------------------------------------------
// docker-compose.yml is Plan 5. Until it lands, these two literals ARE the
// contract: they are copied character for character from the core-api service's
// `environment:` block in spec 9.1. When the compose file arrives, replace them
// with a parse of the real file; the assertions below do not change.

const COMPOSE_CORE_API_ENVIRONMENT_KEYS = [
  "PORT", "HOST", "TZ", "API_PUBLIC_ORIGIN", "TERMINAL_ALLOWED_ORIGINS", "TRUSTED_PROXY_HOPS",
  "SESSION_IDLE_SECONDS", "SESSION_ABSOLUTE_SECONDS", "PAIRING_CODE_TTL_SECONDS",
  "TERMINAL_TOKEN_TTL_SECONDS", "LOGIN_RATE_PER_MINUTE", "LOGIN_TIME_BUDGET_MS", "SCRYPT_SLOTS",
  "PAIR_RATE_PER_MINUTE", "ADMIN_MINT_RATE_PER_10MIN", "PAIRING_MINT_RATE_PER_10MIN",
  "PASSWORD_ABUSE_THRESHOLD", "ROTATE_RATE_PER_HOUR", "AUDIT_RETENTION_DAYS", "DB_POOL_MAX"
];

const COMPOSE_DEFAULTS = {
  PORT: "3200",
  HOST: "0.0.0.0",
  TERMINAL_ALLOWED_ORIGINS: "",
  SESSION_IDLE_SECONDS: "28800",
  SESSION_ABSOLUTE_SECONDS: "604800",
  PAIRING_CODE_TTL_SECONDS: "900",
  TERMINAL_TOKEN_TTL_SECONDS: "7776000",
  LOGIN_RATE_PER_MINUTE: "30",
  LOGIN_TIME_BUDGET_MS: "400",
  SCRYPT_SLOTS: "2",
  PAIR_RATE_PER_MINUTE: "20",
  ADMIN_MINT_RATE_PER_10MIN: "20",
  PAIRING_MINT_RATE_PER_10MIN: "30",
  PASSWORD_ABUSE_THRESHOLD: "5",
  ROTATE_RATE_PER_HOUR: "5",
  AUDIT_RETENTION_DAYS: "365",
  DB_POOL_MAX: "8"
};

// The three keys Compose sets that config.js deliberately does NOT default, each
// with the reason stated so the exclusion is a decision rather than a hole.
const NOT_DEFAULTED_IN_CODE = {
  TZ: "a process concern (log timestamps, now(), psql output); config.js exposes no field",
  API_PUBLIC_ORIGIN: "required with no default: a default would let a misconfigured box accept logins for the wrong origin",
  TRUSTED_PROXY_HOPS: "required under NODE_ENV=production; the development default is 0, deliberately not Compose's 1"
};

function camelCaseOf(name) {
  return name
    .toLowerCase()
    .split("_")
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

test("config.js defaults every knob to the value the Compose file sets", () => {
  assert.deepEqual(DEFAULTS, COMPOSE_DEFAULTS);
  assert.ok(Object.isFrozen(DEFAULTS));
});

test("the Compose keys config.js does not default are a stated, closed list", () => {
  assert.deepEqual(
    [...Object.keys(COMPOSE_DEFAULTS), ...Object.keys(NOT_DEFAULTED_IN_CODE)].sort(),
    [...COMPOSE_CORE_API_ENVIRONMENT_KEYS].sort()
  );
  for (const [variable, reason] of Object.entries(NOT_DEFAULTED_IN_CODE)) {
    assert.ok(reason.length > 0, `${variable} needs a stated reason`);
  }
});

test("the defaults table is what config.js actually applies", () => {
  // Spelling every default out explicitly must produce a config identical to
  // leaving them all unset. A correct DEFAULTS table the parser ignores fails
  // here and nowhere else.
  assert.deepEqual(
    startupConfiguration(DEV_ENV),
    startupConfiguration({ ...DEV_ENV, ...COMPOSE_DEFAULTS })
  );
});

test("every defaulted variable has a config field named by the mechanical camelCase rule", () => {
  const config = startupConfiguration(DEV_ENV);
  for (const name of Object.keys(DEFAULTS)) {
    assert.ok(
      Object.hasOwn(config, camelCaseOf(name)),
      `config has no "${camelCaseOf(name)}" field for ${name}`
    );
  }
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/config.test.js`

Expected: FAIL in `config.js defaults every knob to the value the Compose file sets` with `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` showing `+ undefined` against the expected table — `DEFAULTS` is not exported yet. (`every defaulted variable has a config field…` fails alongside it with `TypeError: Cannot convert undefined or null to object` from `Object.keys(DEFAULTS)`.)

- [x] **Step 3: Write the minimal implementation**

Replace `apps/core-api/config.js` in full:

```js
// apps/core-api/config.js
"use strict";

// PURE (spec 8.8, Tier 1). startupConfiguration(env) reads nothing ambient -- no
// process.env, no clock, no filesystem -- so every rule below is exercised by
// handing it a plain object. server.js is the only production caller and it passes
// process.env, after env-file.js's loadDotEnv() has filled the gaps.
//
// Naming rule: every DEFAULTED config key is the camelCase of its environment
// variable name (ADMIN_MINT_RATE_PER_10MIN -> adminMintRatePer10min). Derived keys
// -- isProduction, databaseAppPassword, databaseMigration* -- have no environment
// variable of their own.

const ORIGIN_LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

// Hosts a Postgres connection may reach without TLS: the Compose service name and
// the loopback addresses. Anything else crosses a network we do not own.
const LOCAL_DATABASE_HOSTS = ["core-db", "localhost", "127.0.0.1", "::1"];

// The only three addresses HOST may take. 0.0.0.0 is correct INSIDE a container:
// a process bound to 127.0.0.1 there is unreachable from docker-proxy and answers
// nothing. The "not reachable except through Nginx" property comes from the
// Compose mapping 127.0.0.1:3200:3200, not from this bind.
const BIND_ADDRESSES = ["127.0.0.1", "::1", "0.0.0.0"];

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * The default for every variable docker-compose.yml also sets, stored as the RAW
 * STRING Compose sets so test/config.test.js can compare this table to the Compose
 * block character for character. These values are the load-bearing ones: the
 * Compose entries are documentation, which is what lets `node server.js` with only
 * a .env file behave identically to the container.
 *
 * Three Compose keys are deliberately absent, and the test asserts that exact
 * exclusion list:
 *   TZ                 - a process concern; config.js exposes no field for it
 *   API_PUBLIC_ORIGIN  - required; a default would let a misconfigured box accept
 *                        logins for the wrong origin
 *   TRUSTED_PROXY_HOPS - required in production; the development default is 0,
 *                        deliberately not Compose's 1
 */
const DEFAULTS = Object.freeze({
  PORT: "3200",
  HOST: "0.0.0.0",
  TERMINAL_ALLOWED_ORIGINS: "",
  SESSION_IDLE_SECONDS: "28800",
  SESSION_ABSOLUTE_SECONDS: "604800",
  PAIRING_CODE_TTL_SECONDS: "900",
  TERMINAL_TOKEN_TTL_SECONDS: "7776000",
  LOGIN_RATE_PER_MINUTE: "30",
  LOGIN_TIME_BUDGET_MS: "400",
  SCRYPT_SLOTS: "2",
  PAIR_RATE_PER_MINUTE: "20",
  ADMIN_MINT_RATE_PER_10MIN: "20",
  PAIRING_MINT_RATE_PER_10MIN: "30",
  PASSWORD_ABUSE_THRESHOLD: "5",
  ROTATE_RATE_PER_HOUR: "5",
  AUDIT_RETENTION_DAYS: "365",
  DB_POOL_MAX: "8"
});

class ConfigurationError extends Error {
  constructor(variable, problem) {
    super(`${variable} ${problem}`);
    this.name = "ConfigurationError";
    this.variable = variable;
  }
}

// Trimmed read, for values that are never secrets: a stray trailing space in a
// .env file is a typo everywhere except in a password.
function readValue(env, name) {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Untrimmed read. A password may legitimately end in a space, and trimming one
// silently turns a correct secret into an authentication failure nobody can see.
function readSecret(env, name) {
  const raw = env[name];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function required(name, value) {
  if (value === undefined) {
    throw new ConfigurationError(name, "must be set to a non-empty value");
  }
  return value;
}

function parseInteger(name, raw, min, max) {
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigurationError(name, `must be an integer, got "${raw}"`);
  }
  const value = Number(raw);
  const bound = max === UNBOUNDED ? `at least ${min}` : `between ${min} and ${max}`;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(name, `must be an integer ${bound}, got "${raw}"`);
  }
  return value;
}

// The default comes from DEFAULTS, never from the call site: one table is what the
// Compose contract test can actually compare against.
function readInteger(env, name, min, max) {
  return parseInteger(name, readValue(env, name) ?? DEFAULTS[name], min, max);
}

function decodeComponent(name, part, value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ConfigurationError(
      name,
      `has a ${part} that is not valid percent-encoding (a literal % must be written %25)`
    );
  }
}

// `requiredUsername === null` means "any username", which is how CI, running as
// postgres, is allowed to drive the migration runner.
function parseDatabaseUrl(name, raw, requiredUsername) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(name, "must be a postgres:// connection string");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigurationError(name, `must use the postgres: or postgresql: scheme, got "${url.protocol}"`);
  }
  if (url.username === "") throw new ConfigurationError(name, "must include a username");
  if (url.password === "") throw new ConfigurationError(name, "must include a password");

  const database = decodeComponent(name, "database name", url.pathname.replace(/^\//, ""));
  if (database === "") throw new ConfigurationError(name, "must name a database");

  // new URL() keeps the square brackets on an IPv6 literal; every comparison here
  // wants the bare address.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_DATABASE_HOSTS.includes(host) && url.searchParams.get("sslmode") !== "require") {
    throw new ConfigurationError(
      name,
      `must set sslmode=require unless the host is one of ${LOCAL_DATABASE_HOSTS.join(", ")}, got "${host}"`
    );
  }

  const username = decodeComponent(name, "username", url.username);
  if (requiredUsername !== null && username !== requiredUsername) {
    throw new ConfigurationError(name, `must connect as ${requiredUsername}, got "${username}"`);
  }

  return {
    href: raw,
    username,
    password: decodeComponent(name, "password", url.password),
    database,
    host,
    port: url.port === "" ? 5432 : Number(url.port)
  };
}

function parseOrigin(name, raw, allowHttpLoopback) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(name, `must be an absolute URL, got "${raw}"`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError(name, `must not carry a username or password, got "${raw}"`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigurationError(name, `must not carry a query string or fragment, got "${raw}"`);
  }
  if (url.pathname !== "/") {
    throw new ConfigurationError(name, `must be an origin with no path, got "${url.pathname}"`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && allowHttpLoopback && ORIGIN_LOOPBACK_HOSTS.includes(host)) {
    return url.origin;
  }
  throw new ConfigurationError(name, allowHttpLoopback
    ? `must use https:, or http: with a ${ORIGIN_LOOPBACK_HOSTS.join("/")} host, got "${raw}"`
    : `must use https:, got "${raw}"`);
}

function parseOriginList(name, raw) {
  const origins = [];
  for (const entry of raw.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    // https unconditionally, with no loopback relaxation: these origins name
    // browser apps on real subdomains, and an http entry would make the terminal
    // CORS responder advertise a plaintext origin from a production box.
    const origin = parseOrigin(name, entry, false);
    if (origins.includes(origin)) {
      throw new ConfigurationError(name, `lists ${origin} more than once`);
    }
    origins.push(origin);
  }
  return Object.freeze(origins);
}

function parseBindAddress(name, raw) {
  if (!BIND_ADDRESSES.includes(raw)) {
    throw new ConfigurationError(name, `must be one of ${BIND_ADDRESSES.join(", ")}, got "${raw}"`);
  }
  return raw;
}

function startupConfiguration(env) {
  if (env === null || typeof env !== "object") {
    throw new TypeError("startupConfiguration(env) requires an environment object");
  }

  const nodeEnv = readValue(env, "NODE_ENV") ?? "development";
  const isProduction = nodeEnv === "production";

  const postgresPassword = required("POSTGRES_PASSWORD", readSecret(env, "POSTGRES_PASSWORD"));
  if (isProduction && postgresPassword.length < 24) {
    throw new ConfigurationError(
      "POSTGRES_PASSWORD",
      "must be at least 24 characters when NODE_ENV=production"
    );
  }

  // The core_api_owner rule is production-only so CI, which connects as postgres,
  // can run the migration runner at all (spec 9.4).
  const migration = parseDatabaseUrl(
    "DATABASE_MIGRATION_URL",
    required("DATABASE_MIGRATION_URL", readSecret(env, "DATABASE_MIGRATION_URL")),
    isProduction ? "core_api_owner" : null
  );

  // core_api_app is required in EVERY environment: pasting the migration DSN here
  // hands the runtime pool DDL rights and deletes the two-role design that
  // 0001_init.sql exists to create.
  const runtime = parseDatabaseUrl(
    "DATABASE_URL",
    required("DATABASE_URL", readSecret(env, "DATABASE_URL")),
    "core_api_app"
  );

  if (runtime.href === migration.href) {
    throw new ConfigurationError("DATABASE_URL", "must differ from DATABASE_MIGRATION_URL");
  }

  // Unconditional. The two are two views of one credential held in one secrets
  // file, so a difference means one line was edited and the other was not.
  if (migration.password !== postgresPassword) {
    throw new ConfigurationError(
      "POSTGRES_PASSWORD",
      "must equal the password component of DATABASE_MIGRATION_URL"
    );
  }

  const apiPublicOrigin = parseOrigin(
    "API_PUBLIC_ORIGIN",
    required("API_PUBLIC_ORIGIN", readValue(env, "API_PUBLIC_ORIGIN")),
    !isProduction
  );

  // Deliberately NOT defaulted to the Compose value of 1: a wrong hop count fails
  // silently in both directions, so production must state it and development gets
  // the fail-safe 0 ("use the socket address").
  const trustedProxyHopsRaw = readValue(env, "TRUSTED_PROXY_HOPS");
  if (isProduction && trustedProxyHopsRaw === undefined) {
    throw new ConfigurationError("TRUSTED_PROXY_HOPS", "must be set when NODE_ENV=production");
  }
  const trustedProxyHops = parseInteger("TRUSTED_PROXY_HOPS", trustedProxyHopsRaw ?? "0", 0, UNBOUNDED);

  const sessionIdleSeconds = readInteger(env, "SESSION_IDLE_SECONDS", 1, UNBOUNDED);
  const sessionAbsoluteSeconds = readInteger(env, "SESSION_ABSOLUTE_SECONDS", 1, UNBOUNDED);
  if (sessionAbsoluteSeconds <= sessionIdleSeconds) {
    // Otherwise every session violates user_sessions_idle_within_absolute on its
    // first renewal.
    throw new ConfigurationError(
      "SESSION_ABSOLUTE_SECONDS",
      `must be strictly greater than SESSION_IDLE_SECONDS (${sessionIdleSeconds}), got ${sessionAbsoluteSeconds}`
    );
  }

  return Object.freeze({
    nodeEnv,
    isProduction,

    port: readInteger(env, "PORT", 1, 65535),
    host: parseBindAddress("HOST", readValue(env, "HOST") ?? DEFAULTS.HOST),

    postgresPassword,
    // The decoded password component of DATABASE_URL. db/migrate.js feeds it to
    // `ALTER ROLE core_api_app LOGIN PASSWORD <quote_literal($1)>` on every boot,
    // which is what makes "edit DATABASE_URL and redeploy" a real rotation and
    // what gives the role LOGIN at all on a fresh cluster.
    databaseAppPassword: runtime.password,
    databaseUrl: runtime.href,
    databaseMigrationUrl: migration.href,
    // Derived from DATABASE_MIGRATION_URL, for scripts/reset-database.js, which
    // prints host, port and database before it will destroy anything.
    databaseMigrationHost: migration.host,
    databaseMigrationPort: migration.port,
    databaseMigrationDatabase: migration.database,

    apiPublicOrigin,
    terminalAllowedOrigins: parseOriginList(
      "TERMINAL_ALLOWED_ORIGINS",
      readValue(env, "TERMINAL_ALLOWED_ORIGINS") ?? DEFAULTS.TERMINAL_ALLOWED_ORIGINS
    ),
    trustedProxyHops,

    sessionIdleSeconds,
    sessionAbsoluteSeconds,
    pairingCodeTtlSeconds: readInteger(env, "PAIRING_CODE_TTL_SECONDS", 1, UNBOUNDED),
    terminalTokenTtlSeconds: readInteger(env, "TERMINAL_TOKEN_TTL_SECONDS", 1, UNBOUNDED),
    loginRatePerMinute: readInteger(env, "LOGIN_RATE_PER_MINUTE", 1, UNBOUNDED),
    // 250 ms floor: the budget must exceed worst-case scrypt (~100 ms) with margin
    // or the fixed-time login property leaks through overrun.
    loginTimeBudgetMs: readInteger(env, "LOGIN_TIME_BUDGET_MS", 250, UNBOUNDED),
    // Above 8 the memory-hard parameters put the process inside OOM-killer range
    // on a 512 MB container that shares the box with Postgres.
    scryptSlots: readInteger(env, "SCRYPT_SLOTS", 1, 8),
    pairRatePerMinute: readInteger(env, "PAIR_RATE_PER_MINUTE", 1, UNBOUNDED),
    adminMintRatePer10min: readInteger(env, "ADMIN_MINT_RATE_PER_10MIN", 1, UNBOUNDED),
    pairingMintRatePer10min: readInteger(env, "PAIRING_MINT_RATE_PER_10MIN", 1, UNBOUNDED),
    passwordAbuseThreshold: readInteger(env, "PASSWORD_ABUSE_THRESHOLD", 1, UNBOUNDED),
    rotateRatePerHour: readInteger(env, "ROTATE_RATE_PER_HOUR", 1, UNBOUNDED),
    auditRetentionDays: readInteger(env, "AUDIT_RETENTION_DAYS", 1, UNBOUNDED),
    // Sized against max_connections=40, leaving room for psql, pg_dump and the
    // migration connection.
    dbPoolMax: readInteger(env, "DB_POOL_MAX", 1, 20)
  });
}

module.exports = { startupConfiguration, ConfigurationError, DEFAULTS };
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/config.test.js`  Expected: PASS (25 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/config.js apps/core-api/test/config.test.js
git commit -m "refactor(core-api): pin config defaults to the compose environment block"
```

---

### Task 9: Wire `npm test` at the repository root

The root `package.json` `scripts.test` entry is owned **only** by this task; the
test-harness area asserts it as part of C11's neighbourhood and never edits it.

> **Sequencing note.** `apps/core-api`'s `pretest` runs
> `scripts/setup-template-db.js`, which the **test-harness area** creates later in
> this plan. Until it exists, `npm --prefix apps/core-api test` — and therefore the
> repo-root `npm test` this task wires up — aborts with
> `Error: Cannot find module '…\apps\core-api\scripts\setup-template-db.js'`. That
> is why Step 4 below verifies the wiring with `node --test` on the structural suite
> rather than by running `npm test`, and why the end-to-end root `npm test` check is
> listed as a follow-up to run once the test-harness area has landed.

**Files:**
- Modify: `package.json:8`
- Test: `apps/core-api/test/source-structure.test.js` (append)

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/source-structure.test.js`:

```js
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
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/source-structure.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /apps\/core-api/. Input:` followed by the current script `'npm --prefix packages/epaper-hub-sdk test && npm --prefix apps/epaper-hub test && npm --prefix apps/customer-order test'`

- [x] **Step 3: Write the minimal implementation**

Replace `package.json` at the repository root:

```json
{
  "name": "restaurant-order-system",
  "private": true,
  "workspaces": [
    "apps/*"
  ],
  "scripts": {
    "test": "npm --prefix packages/epaper-hub-sdk test && npm --prefix apps/epaper-hub test && npm --prefix apps/customer-order test && npm --prefix apps/core-api test",
    "start:customer": "npm --prefix apps/customer-order start",
    "demo:epaper": "npm --prefix apps/epaper-hub run demo"
  }
}
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/source-structure.test.js`  Expected: PASS (5 tests)

Follow-up, once the test-harness area has committed
`apps/core-api/scripts/setup-template-db.js`: run `npm test` at the repository root
and confirm it is green and its output includes `apps/core-api`. That is spec §12's
"npm test at the repo root is green and its output includes apps/core-api" item.

- [x] **Step 5: Commit**

```bash
git add package.json apps/core-api/test/source-structure.test.js
git commit -m "test: run the core-api suite from the repository test script"
```

---

## Part 2 — Migration runner and `0001_init.sql`

> **Stop — prerequisite.** Tasks 11–17 require `apps/core-api/testing/database.js`,
> which Task 18 and the first half of Task 19 create in Part 3. Do those two first,
> or Task 11's test fails with `Cannot find module '../testing/database'`. See
> "Execution order" near the top of this plan.

Eight tasks. `db/migrate.js` implements steps **3–10** of the twelve-step contract
in spec §9.4, plus the `--check` CLI that `npm run migrate` invokes. Steps 1
(`startupConfiguration()`), 2 (open the migration pool), 11 (open the runtime
pool) and 12 (`listen()`) belong to `config.js`, `db/pool.js` and `server.js`.

**`runMigrations(client, options)` takes an already-connected client — the caller
owns the connection's lifecycle.** That is not an accident of style: the advisory
lock is *session*-level and the `BEGIN`/`COMMIT` around each file must land on the
same backend, so the runner cannot be handed a pool or a DSN. Both production
callers open a connection first — `server.js` via `openMigrationPool()` +
`acquireMigrationClient()`, and `testing/database.js` when it builds the template
database — and both release it themselves.

**Prerequisites.** Tasks 1 and 2 are pure `node:fs` and need nothing but Node 20.
From Task 3 onward the tests require `apps/core-api/testing/database.js`
(test-harness area) and the `pg` dependency declared in
`apps/core-api/package.json` (scaffold-config area). `.gitattributes` is created
by scaffold-config, which runs first; this area **asserts** it in Task 1 Step 4
and never writes it.

**Run commands** below are executed **from the repository root** and use the
direct `node --test` form, never `npm --prefix … test` — `package.json` declares
a `pretest` that does not exist until the test-harness area, so the npm form
would abort with the wrong error. The database-backed cases need a maintenance
DSN:

```sh
export CORE_API_TEST_DATABASE_URL='postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
# PowerShell: $env:CORE_API_TEST_DATABASE_URL = 'postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
```

with the local cluster from §9.9 running:

```sh
docker run -d --name core-db-dev -e POSTGRES_USER=core_api_owner -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=core -p 127.0.0.1:5433:5432 postgres:16-alpine
```

---

### Task 10: Install `0001_init.sql` verbatim and pin it with a digest

**Files:**
- Create: `apps/core-api/migrations/0001_init.sql`
- Test: `apps/core-api/test/migrate.test.js`

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/migrate.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// --- the migration set on disk ---------------------------------------------

test("0001_init.sql is installed verbatim from the design appendix", () => {
  assert.deepEqual(fs.readdirSync(MIGRATIONS_DIR).sort(), ["0001_init.sql"]);
  const text = fs.readFileSync(path.join(MIGRATIONS_DIR, "0001_init.sql"), "utf8");

  assert.equal(text.includes("```"), false, "the markdown fence was copied with the SQL");
  // .gitattributes pins *.sql to eol=lf; this is the assertion that notices when
  // it stops working, because a CRLF working tree changes the runner's digest.
  assert.equal(text.includes("\r\n"), false, "0001_init.sql must be stored with LF endings");
  assert.equal((text.match(/\n/g) || []).length, 518, "expected 518 lines");
  assert.equal((text.match(/^CREATE TABLE/gm) || []).length, 11);
  assert.match(text, /SET LOCAL lock_timeout = '3s';/);
  assert.match(text, /CREATE OR REPLACE FUNCTION set_updated_at\(\) RETURNS trigger/);
  // Two dollar-quoted bodies -- set_updated_at and the guarded grant block -- so
  // four $$ tokens. A runner that split this file on ";" would cut both in half.
  assert.equal((text.match(/\$\$/g) || []).length, 4);

  const normalised = Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
  assert.equal(normalised.length, 26765, "expected 26765 bytes with LF endings");
  assert.equal(
    crypto.createHash("sha256").update(normalised).digest("hex"),
    "432e324975c3567411a78708f5fcfc65dbf675e67355b5eb79c78b9812c00385"
  );
});
```

The digest is taken over the **CRLF-normalised** bytes, so the assertion is
checkout-mode independent and is byte-for-byte the value the runner will later
store in `schema_migrations.checksum`.

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/migrate.test.js`
Expected: FAIL with `Error: ENOENT: no such file or directory, scandir '…\apps\core-api\migrations'`

- [x] **Step 3: Copy Appendix A of the spec into the file unchanged**

Do **not** retype or re-derive the DDL. Copy Appendix A of
`docs/superpowers/specs/2026-07-29-core-api-phase1-design.md` — the fenced block
only, without the ```` ```sql ```` opening fence and the closing ```` ``` ````.
From the repository root, in Git Bash:

```bash
mkdir -p apps/core-api/migrations
sed -n '2176,2693p' docs/superpowers/specs/2026-07-29-core-api-phase1-design.md \
  > apps/core-api/migrations/0001_init.sql

# Four verifications. grep -c prints 0 and exits 1 when it finds nothing --
# for the fence and the CR checks, that non-zero exit IS the passing result.
wc -l < apps/core-api/migrations/0001_init.sql                 # 518
grep -c '```' apps/core-api/migrations/0001_init.sql           # 0
grep -c $'\r' apps/core-api/migrations/0001_init.sql           # 0
grep -c '^CREATE TABLE' apps/core-api/migrations/0001_init.sql # 11
tr -d '\r' < apps/core-api/migrations/0001_init.sql | sha256sum
# 432e324975c3567411a78708f5fcfc65dbf675e67355b5eb79c78b9812c00385
```

If the sha256 differs, the copy is wrong — fix the copy, never the constant in
the test.

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/migrate.test.js`  Expected: PASS (1 test)

Then confirm the attribute scaffold-config installed actually covers this path:

```bash
git check-attr text eol -- apps/core-api/migrations/0001_init.sql
```

Expected: two lines ending `text: set` and `eol: lf`. If either says `unspecified`,
stop — `.gitattributes` is missing or malformed, and the next Windows clone will
produce a different digest for a file nobody edited.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/migrations/0001_init.sql apps/core-api/test/migrate.test.js
git commit -m "feat(core-api): add 0001_init.sql, the Phase 1 schema, pinned by digest" \
           -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Filename validation and CRLF-normalised checksums

**Files:**
- Create: `apps/core-api/db/migrate.js`
- Modify: `apps/core-api/test/migrate.test.js:1-9` (the header, up to and including `MIGRATIONS_DIR`)
- Test: `apps/core-api/test/migrate.test.js`

- [x] **Step 1: Write the failing test**

Replace lines 1-9 of `apps/core-api/test/migrate.test.js` — everything from
`"use strict";` down to and including the `MIGRATIONS_DIR` constant — with:

```js
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const {
  checksumOf,
  normaliseSql,
  readMigrationFiles
} = require("../db/migrate");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// Every scenario builds its OWN migrations directory here. apps/core-api/migrations
// is read concurrently by every other test file -- each cloneTemplate() hashes it to
// decide whether the template is stale -- so a deliberately broken 0002 written there
// would turn unrelated suites red and make every sibling rebuild from the broken file.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "core-api-migrate-"));
after(() => fs.rmSync(scratchRoot, { recursive: true, force: true }));

let directoryCounter = 0;

function makeMigrationsDirectory(files) {
  directoryCounter += 1;
  const directory = path.join(scratchRoot, `d${directoryCounter}`);
  fs.mkdirSync(directory);
  for (const [filename, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, filename), contents);
  }
  return directory;
}
```

Then append to the end of the file:

```js
// --- filenames and checksums (no database) ---------------------------------

test("reads files in numeric order with a 32-byte digest each", () => {
  const directory = makeMigrationsDirectory({
    "0002_second.sql": "SELECT 2;\n",
    "0001_first.sql": "SELECT 1;\n"
  });
  const files = readMigrationFiles(directory);
  assert.deepEqual(files.map((file) => file.filename), ["0001_first.sql", "0002_second.sql"]);
  assert.deepEqual(files.map((file) => file.sql), ["SELECT 1;\n", "SELECT 2;\n"]);
  assert.equal(files[0].checksum.length, 32);
  assert.deepEqual(files[0].checksum, checksumOf(Buffer.from("SELECT 1;\n", "utf8")));
});

test("an invalid migration filename is fatal before anything is applied", () => {
  const directory = makeMigrationsDirectory({
    "0001_ok.sql": "SELECT 1;\n",
    "0002-bad.sql": "SELECT 2;\n"
  });
  assert.throws(
    () => readMigrationFiles(directory),
    /invalid migration filename "0002-bad\.sql".+nothing was applied/s
  );
});

test("two files sharing one number are fatal before anything is applied", () => {
  const directory = makeMigrationsDirectory({
    "0001_init.sql": "SELECT 1;\n",
    "0001_also_init.sql": "SELECT 2;\n"
  });
  assert.throws(
    () => readMigrationFiles(directory),
    /duplicate migration number 0001.+nothing was applied/s
  );
});

test("a CRLF checkout hashes identically to an LF one", () => {
  const body = "CREATE TABLE probe (id integer PRIMARY KEY);\nSELECT 1;\n";
  const lf = makeMigrationsDirectory({ "0001_probe.sql": body });
  const crlf = makeMigrationsDirectory({ "0001_probe.sql": body.replace(/\n/g, "\r\n") });
  assert.deepEqual(readMigrationFiles(lf)[0].checksum, readMigrationFiles(crlf)[0].checksum);
  assert.equal(readMigrationFiles(crlf)[0].sql.includes("\r"), false);
  assert.deepEqual(
    normaliseSql(Buffer.from("a\r\nb", "utf8")),
    Buffer.from("a\nb", "utf8")
  );
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/migrate.test.js`
Expected: FAIL with `Error: Cannot find module '../db/migrate'` / `code: 'MODULE_NOT_FOUND'`

- [x] **Step 3: Write the minimal implementation**

Create `apps/core-api/db/migrate.js`:

```js
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// One fixed key, taken session-level by every core-api process that migrates,
// so two containers started by one deploy serialise instead of racing.
const MIGRATION_ADVISORY_LOCK_KEY = 4264071001;
// Identical to the CHECK on schema_migrations.filename. Validating here means a
// bad name is fatal BEFORE any DDL runs, instead of failing the INSERT after it.
const MIGRATION_FILENAME_PATTERN = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
const MINIMUM_SERVER_VERSION_NUM = 140000;

// Windows checks out *.sql as CRLF under the Git default autocrlf=true while
// the image builds on Linux, so the same file would otherwise yield two digests
// and the runner would declare a fatal mismatch on a file nobody edited.
function normaliseSql(raw) {
  return Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

function checksumOf(normalised) {
  return crypto.createHash("sha256").update(normalised).digest();
}

function readMigrationFiles(directory) {
  const files = [];
  const byNumber = new Map();
  for (const filename of fs.readdirSync(directory).sort()) {
    if (!MIGRATION_FILENAME_PATTERN.test(filename)) {
      throw new Error(
        `invalid migration filename "${filename}": expected ` +
        `${MIGRATION_FILENAME_PATTERN.source}; nothing was applied`
      );
    }
    const number = filename.slice(0, 4);
    if (byNumber.has(number)) {
      throw new Error(
        `duplicate migration number ${number}: "${byNumber.get(number)}" and ` +
        `"${filename}"; nothing was applied`
      );
    }
    byNumber.set(number, filename);
    const normalised = normaliseSql(fs.readFileSync(path.join(directory, filename)));
    files.push({
      filename,
      sql: normalised.toString("utf8"),
      checksum: checksumOf(normalised)
    });
  }
  return files;
}

module.exports = {
  MIGRATION_ADVISORY_LOCK_KEY,
  MIGRATION_FILENAME_PATTERN,
  MINIMUM_SERVER_VERSION_NUM,
  checksumOf,
  normaliseSql,
  readMigrationFiles
};
```

`fs.readdirSync` is validated against **every** entry, not filtered to `*.sql`
first: a stray `0002_fix.sql.bak` or a `README.md` in `migrations/` is a mistake,
and a runner that silently ignores it is how a migration goes missing.

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/migrate.test.js`  Expected: PASS (5 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/db/migrate.js apps/core-api/test/migrate.test.js
git commit -m "feat(core-api): validate migration filenames and hash CRLF-normalised bytes" \
           -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Preflight — server version, the app role, the ledger table

**Files:**
- Modify: `apps/core-api/db/migrate.js` (constants, `assertServerVersion`, `ensureAppRole`, `runMigrations`, exports)
- Modify: `apps/core-api/test/migrate.test.js:1-35` (the header) and append three cases
- Test: `apps/core-api/test/migrate.test.js`

- [x] **Step 1: Write the failing test**

Replace lines 1-35 of `apps/core-api/test/migrate.test.js` — everything from
`"use strict";` down to and including the closing `}` of `makeMigrationsDirectory`
— with:

```js
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const {
  checksumOf,
  normaliseSql,
  readMigrationFiles,
  runMigrations
} = require("../db/migrate");
const { createEmptyDatabase, skipDatabaseTests } = require("../testing/database");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// Every scenario builds its OWN migrations directory here. apps/core-api/migrations
// is read concurrently by every other test file -- each cloneTemplate() hashes it to
// decide whether the template is stale -- so a deliberately broken 0002 written there
// would turn unrelated suites red and make every sibling rebuild from the broken file.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "core-api-migrate-"));
after(() => fs.rmSync(scratchRoot, { recursive: true, force: true }));

let directoryCounter = 0;

function makeMigrationsDirectory(files) {
  directoryCounter += 1;
  const directory = path.join(scratchRoot, `d${directoryCounter}`);
  fs.mkdirSync(directory);
  for (const [filename, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, filename), contents);
  }
  return directory;
}

function collectLog() {
  const infos = [];
  const warnings = [];
  return {
    info: (message) => infos.push(message),
    warn: (message) => warnings.push(message),
    infos,
    warnings
  };
}

// createEmptyDatabase() returns the frozen Handle: { name, connectionString,
// unscoped(text, params), connect(), resetFixtures(), end(), drop() }. drop()
// closes the handle's own pool, but it CANNOT drop a database that still has a
// dedicated connect() session open -- so every session is ended by withSession.
async function withDatabase(label, run) {
  const database = await createEmptyDatabase(label);
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

// A DEDICATED connection, not a pool checkout: the advisory lock is session-level
// and each file's BEGIN/COMMIT must land on one backend. The variable is called
// `session`, never `client`, so source-structure C2 (which bans /\b(?:pool|client)
// \.query\s*\(/ outside db/) cannot flag this file whatever the walker's scope.
async function withSession(database, run) {
  const session = await database.connect();
  try {
    return await run(session);
  } finally {
    await session.end();
  }
}
```

Then append to the end of the file:

```js
// --- preflight --------------------------------------------------------------

test("refuses a PostgreSQL older than 14 before it touches anything else", async () => {
  const asked = [];
  const stub = {
    query: async (text) => {
      asked.push(text);
      if (text === "SHOW server_version_num") {
        return { rows: [{ server_version_num: "130010" }] };
      }
      throw new Error(`unexpected query: ${text}`);
    }
  };
  await assert.rejects(
    () => runMigrations(stub, { directory: MIGRATIONS_DIR, log: collectLog() }),
    /server_version_num 130010 is below the required 140000/
  );
  assert.deepEqual(asked, ["SHOW server_version_num"]);
});

test("creates the ledger before it reads any file", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_ledger", async (database) => {
    await withSession(database, async (session) => {
      await runMigrations(session, { directory: makeMigrationsDirectory({}), log: collectLog() });
    });
    const columns = await database.unscoped(
      "SELECT column_name FROM information_schema.columns " +
      "WHERE table_name = 'schema_migrations' ORDER BY column_name"
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ["applied_at", "checksum", "duration_ms", "filename"]
    );
  });
});

test("ensures core_api_app with the database name derived in SQL", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_role", async (database) => {
    await withSession(database, async (session) => {
      await runMigrations(session, {
        directory: makeMigrationsDirectory({}),
        appRolePassword: "rotate-me-please-0001",
        log: collectLog()
      });
    });

    const role = await database.unscoped(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'core_api_app'"
    );
    assert.equal(role.rowCount, 1);
    assert.equal(role.rows[0].rolcanlogin, true);

    // A hardcoded REVOKE ALL ON DATABASE core would have raised 3D000 here: this
    // database is named after the test file, not "core".
    assert.notEqual(database.name, "core");
    const acl = await database.unscoped(
      "SELECT COALESCE(datacl::text, '') AS acl FROM pg_database WHERE datname = current_database()"
    );
    const entries = acl.rows[0].acl.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
    assert.equal(
      entries.some((entry) => entry.startsWith("=")),
      false,
      "PUBLIC still holds database privileges"
    );
    assert.equal(entries.some((entry) => entry.startsWith("core_api_app=")), true);
  });
});
```

The version case uses a stub with a `query` method — no database at all — and the
`assert.deepEqual(asked, [...])` is the real assertion: it proves the version gate
runs **before** the role, the ledger and the lock.

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/migrate.test.js`
Expected: FAIL, 3 failures, each `TypeError: runMigrations is not a function`

- [x] **Step 3: Write the minimal implementation**

In `apps/core-api/db/migrate.js`, add one constant immediately after
`const MINIMUM_SERVER_VERSION_NUM = 140000;`:

```js
const APP_ROLE = "core_api_app";
```

Then, immediately after that constant and before the `normaliseSql` comment
block, insert the two SQL constants:

```js
const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY CHECK (filename ~ '^[0-9]{4}_[a-z0-9_]+\\.sql$'),
  checksum    bytea       NOT NULL CHECK (octet_length(checksum) = 32),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer     NOT NULL DEFAULT 0 CHECK (duration_ms >= 0)
)`;

const ENSURE_APP_ROLE_SQL = `DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE ROLE ${APP_ROLE} NOLOGIN';
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${APP_ROLE}', current_database());
END
$$`;
```

`\\.` in the template literal is what puts a literal `\.` in the SQL — write `\.`
and JavaScript eats the backslash, leaving a regex that matches `0001_initXsql`.
The database name is derived with `current_database()` because this same runner
builds `core_api_test_template` and one clone per test file on a CI server that
has no database called `core`; a hardcoded name fails `3D000` on the very first CI
run, and the 30-second repair under pressure is a `try/catch` that leaves `PUBLIC`
holding `CONNECT` in production behind a green build history. The inner
`EXCEPTION WHEN duplicate_object` handles two test processes reaching
`CREATE ROLE` on one cluster at the same moment.

Then add, immediately after `readMigrationFiles`:

```js
async function assertServerVersion(client) {
  const { rows } = await client.query("SHOW server_version_num");
  const versionNum = Number(rows[0].server_version_num);
  if (!Number.isInteger(versionNum) || versionNum < MINIMUM_SERVER_VERSION_NUM) {
    throw new Error(
      `PostgreSQL server_version_num ${rows[0].server_version_num} is below the ` +
      `required ${MINIMUM_SERVER_VERSION_NUM} (PostgreSQL 14)`
    );
  }
}

async function ensureAppRole(client, password) {
  await client.query(ENSURE_APP_ROLE_SQL);
  if (typeof password !== "string" || password.length === 0) return;
  // ALTER ROLE cannot take a bind parameter and a DO block cannot receive one,
  // so quote_literal does the escaping server-side. Running this on EVERY boot
  // is what makes editing DATABASE_URL a real password rotation. (Consequently
  // this cluster must never run with log_statement=all.)
  const { rows } = await client.query("SELECT quote_literal($1::text) AS literal", [password]);
  await client.query(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD ${rows[0].literal}`);
}

// `client` is an already-connected, duck-typed object with .query(text, values?).
// This function never opens, releases or closes a connection: server.js and
// testing/database.js each open one and hand it in.
async function runMigrations(client, options) {
  const settings = options || {};
  if (typeof settings.directory !== "string" || settings.directory.length === 0) {
    throw new Error("runMigrations requires options.directory");
  }
  const log = settings.log || console;

  await assertServerVersion(client);
  await ensureAppRole(client, settings.appRolePassword);
  await client.query(SCHEMA_MIGRATIONS_DDL);

  const files = readMigrationFiles(settings.directory);
  log.info(`migrations: ${files.length} file(s) on disk in ${settings.directory}`);
  return { applied: [], skipped: [], missingFiles: [], checked: settings.check === true };
}
```

Finally replace `module.exports` with:

```js
module.exports = {
  MIGRATION_ADVISORY_LOCK_KEY,
  MIGRATION_FILENAME_PATTERN,
  MINIMUM_SERVER_VERSION_NUM,
  SCHEMA_MIGRATIONS_DDL,
  checksumOf,
  normaliseSql,
  readMigrationFiles,
  runMigrations
};
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/migrate.test.js`  Expected: PASS (8 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/db/migrate.js apps/core-api/test/migrate.test.js
git commit -m "feat(core-api): migration preflight - version gate, app role, ledger table" \
           -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: The advisory lock, with a bounded 60 s retry

**Files:**
- Modify: `apps/core-api/db/migrate.js` (two constants, `sleep`, `acquireMigrationLock`, `runMigrations`)
- Modify: `apps/core-api/test/migrate.test.js:10-15` (the `require("../db/migrate")` block) and append one case
- Test: `apps/core-api/test/migrate.test.js`

- [x] **Step 1: Write the failing test**

Replace the `require("../db/migrate")` destructuring block with:

```js
const {
  MIGRATION_ADVISORY_LOCK_KEY,
  checksumOf,
  normaliseSql,
  readMigrationFiles,
  runMigrations
} = require("../db/migrate");
```

Append to the end of the file:

```js
// --- the advisory lock ------------------------------------------------------

test("waits for the lock, refuses inside the bound, and releases it", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_lock", async (database) => {
    // Two INDEPENDENT sessions: the lock is session-level, so a pool checkout
    // could hand both roles the same backend and the contention would vanish.
    const holder = await database.connect();
    const runner = await database.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);

      // A fake clock: the bound is exercised in full without a real 60 s wait.
      let clock = 0;
      const naps = [];
      await assert.rejects(
        () => runMigrations(runner, {
          directory: MIGRATIONS_DIR,
          log: collectLog(),
          lockWaitMs: 3000,
          now: () => clock,
          sleep: async (ms) => {
            naps.push(ms);
            clock += ms;
          }
        }),
        /another instance is migrating/
      );
      assert.deepEqual(naps, [1000, 1000, 1000], "the runner must retry once a second, not fail on the first try");
      const probe = await database.unscoped("SELECT to_regclass('public.companies') AS present");
      assert.equal(probe.rows[0].present, null);

      await holder.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
      await runMigrations(runner, { directory: makeMigrationsDirectory({}), log: collectLog() });
      const retaken = await holder.query(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked",
        [MIGRATION_ADVISORY_LOCK_KEY]
      );
      assert.equal(retaken.rows[0].locked, true, "the runner did not release the advisory lock");
    } finally {
      await runner.end();
      await holder.end();
    }
  });
});
```

Acquisition and release are one test on purpose: a standalone "it releases the
lock" case passes vacuously against a runner that never takes one.

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/migrate.test.js`
Expected: FAIL with `Missing expected rejection.` — the runner takes no lock, so
it completes instead of refusing.

- [x] **Step 3: Write the minimal implementation**

In `apps/core-api/db/migrate.js`, add two constants immediately after
`const MINIMUM_SERVER_VERSION_NUM = 140000;` and before `const APP_ROLE`:

```js
const LOCK_WAIT_MS = 60000;
const LOCK_RETRY_MS = 1000;
```

Add `sleep` immediately before the `normaliseSql` comment block:

```js
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Add `acquireMigrationLock` immediately after `ensureAppRole`:

```js
async function acquireMigrationLock(client, waitMs, now, wait) {
  const deadline = now() + waitMs;
  for (;;) {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [MIGRATION_ADVISORY_LOCK_KEY]
    );
    if (rows[0].locked === true) return;
    if (now() >= deadline) {
      throw new Error(
        `another instance is migrating: advisory lock ${MIGRATION_ADVISORY_LOCK_KEY} ` +
        `was still held after ${waitMs} ms`
      );
    }
    await wait(LOCK_RETRY_MS);
  }
}
```

`pg_try_advisory_lock` in a bounded loop rather than the blocking
`pg_advisory_lock`: a blocking call against an orphaned lock (a cancelled `ssh`
heredoc leaves one) hangs the container forever with one log line, and
`restart: unless-stopped` never fires. `$1::bigint` is explicit because the
function is overloaded and an untyped parameter is a resolution risk.

Replace the whole `runMigrations` function with:

```js
async function runMigrations(client, options) {
  const settings = options || {};
  if (typeof settings.directory !== "string" || settings.directory.length === 0) {
    throw new Error("runMigrations requires options.directory");
  }
  const log = settings.log || console;
  const now = settings.now || Date.now;
  const wait = settings.sleep || sleep;
  const waitMs = settings.lockWaitMs === undefined ? LOCK_WAIT_MS : settings.lockWaitMs;

  await assertServerVersion(client);
  await ensureAppRole(client, settings.appRolePassword);
  await client.query(SCHEMA_MIGRATIONS_DDL);
  await acquireMigrationLock(client, waitMs, now, wait);
  try {
    const files = readMigrationFiles(settings.directory);
    log.info(`migrations: ${files.length} file(s) on disk`);
    return { applied: [], skipped: [], missingFiles: [], checked: settings.check === true };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
    } catch {}
  }
}
```

`acquireMigrationLock` is called **outside** the `try`, so a failed acquisition
never unlocks a lock this session does not hold.

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/migrate.test.js`  Expected: PASS (9 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/db/migrate.js apps/core-api/test/migrate.test.js
git commit -m "feat(core-api): serialise migrations on a bounded advisory lock" \
           -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Apply each file as ONE string in ONE transaction

**Files:**
- Modify: `apps/core-api/db/migrate.js` (`applyMigration`, `readLedger`, `runMigrations`)
- Modify: `apps/core-api/test/migrate.test.js` (append three cases)
- Test: `apps/core-api/test/migrate.test.js`

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/migrate.test.js`:

```js
// --- applying ---------------------------------------------------------------

test("applies 0001_init.sql once and re-runs as a no-op", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_apply", async (database) => {
    await withSession(database, async (session) => {
      const log = collectLog();
      const first = await runMigrations(session, { directory: MIGRATIONS_DIR, log });
      assert.deepEqual(first.applied, ["0001_init.sql"]);
      assert.deepEqual(first.skipped, []);

      const ledger = await database.unscoped(
        "SELECT filename, checksum, applied_at, duration_ms FROM schema_migrations"
      );
      assert.equal(ledger.rowCount, 1);
      assert.equal(ledger.rows[0].filename, "0001_init.sql");
      assert.equal(ledger.rows[0].checksum.length, 32);
      assert.ok(ledger.rows[0].duration_ms >= 0);
      const appliedAt = ledger.rows[0].applied_at.getTime();

      const second = await runMigrations(session, { directory: MIGRATIONS_DIR, log });
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.skipped, ["0001_init.sql"]);
      const reread = await database.unscoped(
        "SELECT applied_at FROM schema_migrations WHERE filename = '0001_init.sql'"
      );
      assert.equal(reread.rows[0].applied_at.getTime(), appliedAt);
    });

    // 0001's closing grant block is guarded on pg_roles, so this is only true if
    // the preflight created core_api_app BEFORE the file was applied.
    const granted = await database.unscoped(
      "SELECT has_table_privilege('core_api_app', 'companies', 'INSERT') AS granted"
    );
    assert.equal(granted.rows[0].granted, true);
  });
});

test("sends each file as ONE string, so dollar-quoted bodies survive", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_nosplit", async (database) => {
    await withSession(database, async (session) => {
      await runMigrations(session, { directory: MIGRATIONS_DIR, log: collectLog() });
    });

    const routine = await database.unscoped(
      "SELECT prokind FROM pg_proc WHERE proname = 'set_updated_at'"
    );
    assert.equal(routine.rowCount, 1, "set_updated_at is missing: the file was split on ';'");

    const id = "aaaaaaaa-0000-4000-8000-000000000001";
    await database.unscoped("INSERT INTO companies (id, name) VALUES ($1, 'Split Regression')", [id]);
    const before = await database.unscoped("SELECT updated_at FROM companies WHERE id = $1", [id]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await database.unscoped("UPDATE companies SET name = 'Split Regression 2' WHERE id = $1", [id]);
    const later = await database.unscoped("SELECT updated_at FROM companies WHERE id = $1", [id]);
    assert.ok(
      later.rows[0].updated_at > before.rows[0].updated_at,
      "updated_at did not move: set_updated_at's body was truncated at the first ';'"
    );
  });
});

test("a failing file rolls back whole, leaving no row and no partial table", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_rollback", async (database) => {
    const directory = makeMigrationsDirectory({
      "0001_broken.sql": [
        "CREATE TABLE early_bird (id integer PRIMARY KEY);",
        "CREATE TABLE oops (id integer PRIMARY KEY, bad no_such_type);",
        ""
      ].join("\n")
    });
    await withSession(database, async (session) => {
      await assert.rejects(
        () => runMigrations(session, { directory, log: collectLog() }),
        /migration 0001_broken\.sql failed and was rolled back/
      );
    });
    const probe = await database.unscoped(
      "SELECT to_regclass('public.early_bird') AS early, to_regclass('public.oops') AS oops"
    );
    assert.equal(probe.rows[0].early, null);
    assert.equal(probe.rows[0].oops, null);
    const ledger = await database.unscoped("SELECT count(*)::int AS n FROM schema_migrations");
    assert.equal(ledger.rows[0].n, 0);
  });
});
```

The second case is the semicolon-splitting regression and needs **both** halves: a
`pg_proc` row proves the `CREATE FUNCTION` statement parsed, and the moving
`updated_at` proves its *body* arrived intact. The third case doubles as proof
that `SET LOCAL lock_timeout` at `0001:24` is genuinely inside a transaction block
rather than a silently ignored no-op.

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/migrate.test.js`
Expected: FAIL, 3 failures — `Expected values to be strictly deep-equal:` with
`+ []` against `- [ '0001_init.sql' ]`; `set_updated_at is missing: the file was
split on ';'` (`0 !== 1`); and `Missing expected rejection.`

- [x] **Step 3: Write the minimal implementation**

In `apps/core-api/db/migrate.js`, add both functions immediately after
`acquireMigrationLock`:

```js
async function applyMigration(client, file, now) {
  const startedAt = now();
  await client.query("BEGIN");
  try {
    // ONE string, NO bound parameters. node-postgres uses the simple query
    // protocol only when nothing is bound, and that is the only protocol that
    // accepts several statements -- so the file is never split on semicolons,
    // which would cut the dollar-quoted bodies in 0001_init.sql in half.
    await client.query(file.sql);
    await client.query(
      "INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)",
      [file.filename, file.checksum, Math.max(0, Math.round(now() - startedAt))]
    );
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw new Error(`migration ${file.filename} failed and was rolled back: ${error.message}`);
  }
  return Math.max(0, Math.round(now() - startedAt));
}

async function readLedger(client) {
  const { rows } = await client.query("SELECT filename, checksum FROM schema_migrations");
  return new Map(rows.map((row) => [row.filename, Buffer.from(row.checksum)]));
}
```

The explicit `BEGIN` is what makes the file's own `SET LOCAL lock_timeout` and
`SET LOCAL statement_timeout` mean anything — `SET LOCAL` outside a transaction
block is silently ignored. Bind even one parameter alongside the file text and
node-postgres switches to the extended protocol, which raises *"cannot insert
multiple commands into a prepared statement"*; that is why the ledger `INSERT` is a
second, separate call.

Replace the whole `runMigrations` function with:

```js
async function runMigrations(client, options) {
  const settings = options || {};
  if (typeof settings.directory !== "string" || settings.directory.length === 0) {
    throw new Error("runMigrations requires options.directory");
  }
  const log = settings.log || console;
  const now = settings.now || Date.now;
  const wait = settings.sleep || sleep;
  const waitMs = settings.lockWaitMs === undefined ? LOCK_WAIT_MS : settings.lockWaitMs;

  await assertServerVersion(client);
  await ensureAppRole(client, settings.appRolePassword);
  await client.query(SCHEMA_MIGRATIONS_DDL);
  await acquireMigrationLock(client, waitMs, now, wait);
  try {
    const files = readMigrationFiles(settings.directory);
    const ledger = await readLedger(client);
    const applied = [];
    const skipped = [];
    for (const file of files) {
      const digest = file.checksum.toString("hex").slice(0, 12);
      if (ledger.has(file.filename)) {
        log.info(`migration ${file.filename} sha256:${digest} already applied`);
        skipped.push(file.filename);
        continue;
      }
      const durationMs = await applyMigration(client, file, now);
      log.info(`migration ${file.filename} sha256:${digest} applied in ${durationMs} ms`);
      applied.push(file.filename);
    }
    return { applied, skipped, missingFiles: [], checked: settings.check === true };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
    } catch {}
  }
}
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/migrate.test.js`  Expected: PASS (12 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/db/migrate.js apps/core-api/test/migrate.test.js
git commit -m "feat(core-api): apply each migration as one string in one transaction" \
           -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: The verdicts — mismatch fatal, pending fatal, missing file a warning, `--check`

**Files:**
- Modify: `apps/core-api/db/migrate.js` (`checksumMismatchMessage`, `runMigrations`)
- Modify: `apps/core-api/test/migrate.test.js` (append four cases)
- Test: `apps/core-api/test/migrate.test.js`

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/migrate.test.js`:

```js
// --- verdicts ---------------------------------------------------------------

test("a checksum mismatch is fatal and names both digests and both remedies", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_mismatch", async (database) => {
    await withSession(database, async (session) => {
      const directory = makeMigrationsDirectory({
        "0001_seed.sql": "CREATE TABLE seed (id integer PRIMARY KEY);\n"
      });
      await runMigrations(session, { directory, log: collectLog() });
      fs.writeFileSync(
        path.join(directory, "0001_seed.sql"),
        "CREATE TABLE seed (id integer PRIMARY KEY, extra text);\n"
      );
      await assert.rejects(
        () => runMigrations(session, { directory, log: collectLog() }),
        (error) => {
          assert.match(error.message, /checksum mismatch for 0001_seed\.sql/);
          assert.match(error.message, /applied: [0-9a-f]{64}/);
          assert.match(error.message, /on disk: [0-9a-f]{64}/);
          assert.match(error.message, /Never edit an applied migration/);
          assert.match(error.message, /db:reset/);
          return true;
        }
      );
    });
  });
});

test("a CRLF checkout of an applied file is not a mismatch", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_crlf", async (database) => {
    await withSession(database, async (session) => {
      const body = "CREATE TABLE crlf_probe (id integer PRIMARY KEY);\n";
      await runMigrations(session, {
        directory: makeMigrationsDirectory({ "0001_crlf_probe.sql": body }),
        log: collectLog()
      });
      const result = await runMigrations(session, {
        directory: makeMigrationsDirectory({ "0001_crlf_probe.sql": body.replace(/\n/g, "\r\n") }),
        log: collectLog()
      });
      assert.deepEqual(result.applied, []);
      assert.deepEqual(result.skipped, ["0001_crlf_probe.sql"]);
    });
  });
});

test("a ledger row with no file on disk is a WARNING, not a failure", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_rolled_back", async (database) => {
    await withSession(database, async (session) => {
      await runMigrations(session, {
        directory: makeMigrationsDirectory({
          "0001_present.sql": "CREATE TABLE present (id integer PRIMARY KEY);\n"
        }),
        log: collectLog()
      });
      const log = collectLog();
      const result = await runMigrations(session, { directory: makeMigrationsDirectory({}), log });
      assert.deepEqual(result.missingFiles, ["0001_present.sql"]);
      assert.deepEqual(result.applied, []);
      assert.equal(log.warnings.length, 1);
      assert.match(log.warnings[0], /0001_present\.sql but the file is not on disk/);
    });
  });
});

test("check mode applies nothing and fails on a pending file", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_check", async (database) => {
    const directory = makeMigrationsDirectory({
      "0001_pending.sql": "CREATE TABLE pending_probe (id integer PRIMARY KEY);\n"
    });
    await withSession(database, async (session) => {
      await assert.rejects(
        () => runMigrations(session, { directory, check: true, log: collectLog() }),
        /pending migration\(s\) never applied: 0001_pending\.sql/
      );
    });
    const probe = await database.unscoped("SELECT to_regclass('public.pending_probe') AS present");
    assert.equal(probe.rows[0].present, null);
    const ledger = await database.unscoped("SELECT count(*)::int AS n FROM schema_migrations");
    assert.equal(ledger.rows[0].n, 0);
  });
});
```

The CRLF case is the cross-platform trap end to end: the digest recorded from an
LF checkout must still match when the same file is read from a CRLF one.

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/migrate.test.js`
Expected: FAIL, 3 failures — `Missing expected rejection.` (mismatch),
`Expected values to be strictly deep-equal:` with `+ []` against
`- [ '0001_present.sql' ]` (missing file), and `Missing expected rejection.`
(check mode). The CRLF case already passes, because `readMigrationFiles`
normalises.

- [x] **Step 3: Write the minimal implementation**

In `apps/core-api/db/migrate.js`, add `checksumMismatchMessage` immediately after
`applyMigration` and before `readLedger`:

```js
function checksumMismatchMessage(file, appliedChecksum) {
  return [
    `checksum mismatch for ${file.filename}`,
    `  applied: ${appliedChecksum.toString("hex")}`,
    `  on disk: ${file.checksum.toString("hex")}`,
    "An already-applied migration was edited. Never edit an applied migration -- add",
    "the next numbered file instead. Locally, run: npm --prefix apps/core-api run db:reset"
  ].join("\n");
}
```

Replace the whole `runMigrations` function with:

```js
async function runMigrations(client, options) {
  const settings = options || {};
  if (typeof settings.directory !== "string" || settings.directory.length === 0) {
    throw new Error("runMigrations requires options.directory");
  }
  const log = settings.log || console;
  const check = settings.check === true;
  const now = settings.now || Date.now;
  const wait = settings.sleep || sleep;
  const waitMs = settings.lockWaitMs === undefined ? LOCK_WAIT_MS : settings.lockWaitMs;

  await assertServerVersion(client);
  await ensureAppRole(client, settings.appRolePassword);
  await client.query(SCHEMA_MIGRATIONS_DDL);
  await acquireMigrationLock(client, waitMs, now, wait);
  try {
    const files = readMigrationFiles(settings.directory);
    const ledger = await readLedger(client);
    const applied = [];
    const skipped = [];

    for (const file of files) {
      const digest = file.checksum.toString("hex").slice(0, 12);
      const appliedChecksum = ledger.get(file.filename);
      if (appliedChecksum) {
        if (!appliedChecksum.equals(file.checksum)) {
          throw new Error(checksumMismatchMessage(file, appliedChecksum));
        }
        log.info(`migration ${file.filename} sha256:${digest} already applied`);
        skipped.push(file.filename);
        continue;
      }
      if (check) {
        log.info(`migration ${file.filename} sha256:${digest} PENDING (check mode, not applied)`);
        continue;
      }
      const durationMs = await applyMigration(client, file, now);
      log.info(`migration ${file.filename} sha256:${digest} applied in ${durationMs} ms`);
      applied.push(file.filename);
    }

    const finalLedger = await readLedger(client);
    const onDisk = new Set(files.map((file) => file.filename));
    const missingFiles = [...finalLedger.keys()].filter((name) => !onDisk.has(name)).sort();
    const pending = files
      .map((file) => file.filename)
      .filter((name) => !finalLedger.has(name));

    // WARNING, never fatal: a rolled-back image is the only recovery lever on a
    // push-to-main pipeline with no staging tier, and it always looks like this.
    for (const filename of missingFiles) {
      log.warn(
        `WARNING: schema_migrations has a row for ${filename} but the file is not on ` +
        "disk. This is what a rolled-back image looks like; continuing."
      );
    }
    if (pending.length > 0) {
      throw new Error(
        `pending migration(s) never applied: ${pending.join(", ")}; ` +
        "the database schema is older than this code"
      );
    }
    return { applied, skipped, missingFiles, checked: check };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
    } catch {}
  }
}
```

There is no `--force` and no skip variable: `db:reset` is the only sanctioned
answer to a local checksum surprise, and against a database with real rows there
is deliberately no escape at all. `check: true` needs no separate code path — it
suppresses the apply, and the post-loop reconciliation then finds the file pending
and throws, which is exactly the exit-1 CI wants.

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/migrate.test.js`  Expected: PASS (16 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/db/migrate.js apps/core-api/test/migrate.test.js
git commit -m "feat(core-api): migration verdicts - mismatch and pending fatal, missing file a warning" \
           -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: `migrationsStatus()` — the readiness verdict that never throws

**Files:**
- Modify: `apps/core-api/db/migrate.js` (`readLedgerIfPresent`, `migrationsStatus`, exports)
- Modify: `apps/core-api/test/migrate.test.js:10-16` (the `require("../db/migrate")` block) and append four cases
- Test: `apps/core-api/test/migrate.test.js`

`runMigrations` throws its verdicts, which is right at boot and wrong at
`/health/ready` — a readiness probe must answer, not crash. `migrationsStatus`
returns the same judgement as one of three words. `db/health.js`'s
`checkReadiness()` is its only consumer, and the closed vocabulary of spec §6.3.6
(`current|pending|checksum_mismatch`) is unreachable without it.

- [ ] **Step 1: Write the failing test**

Replace the `require("../db/migrate")` destructuring block with:

```js
const {
  MIGRATION_ADVISORY_LOCK_KEY,
  checksumOf,
  migrationsStatus,
  normaliseSql,
  readMigrationFiles,
  runMigrations
} = require("../db/migrate");
```

Append to the end of the file:

```js
// --- the readiness verdict --------------------------------------------------

test("migrationsStatus reports current when every file is applied", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_status_current", async (database) => {
    await withSession(database, async (session) => {
      await runMigrations(session, { directory: MIGRATIONS_DIR, log: collectLog() });
      assert.equal(await migrationsStatus(session, MIGRATIONS_DIR), "current");
    });
  });
});

test("migrationsStatus reports pending for a file with no ledger row", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_status_pending", async (database) => {
    await withSession(database, async (session) => {
      await runMigrations(session, { directory: makeMigrationsDirectory({}), log: collectLog() });
      const directory = makeMigrationsDirectory({
        "0001_later.sql": "CREATE TABLE later (id integer PRIMARY KEY);\n"
      });
      assert.equal(await migrationsStatus(session, directory), "pending");
    });
  });
});

test("migrationsStatus reports checksum_mismatch when the ledger disagrees", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_status_mismatch", async (database) => {
    const directory = makeMigrationsDirectory({
      "0001_drifting.sql": "CREATE TABLE drifting (id integer PRIMARY KEY);\n"
    });
    await withSession(database, async (session) => {
      await runMigrations(session, { directory, log: collectLog() });
      assert.equal(await migrationsStatus(session, directory), "current");
      await database.unscoped(
        "UPDATE schema_migrations SET checksum = decode(repeat('00', 32), 'hex') WHERE filename = $1",
        ["0001_drifting.sql"]
      );
      // It RETURNS the verdict. A throw here would make /health/ready 500 on the
      // one condition it exists to describe.
      assert.equal(await migrationsStatus(session, directory), "checksum_mismatch");
    });
  });
});

test("migrationsStatus reports pending on a database that has never migrated", { skip: skipDatabaseTests() }, async () => {
  // The to_regclass guard: schema_migrations does not exist yet, and a bare
  // SELECT would raise 42P01 and be misread by checkReadiness as 'unreachable'.
  await withDatabase("migrate_status_fresh", async (database) => {
    await withSession(database, async (session) => {
      assert.equal(await migrationsStatus(session, MIGRATIONS_DIR), "pending");
    });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/migrate.test.js`
Expected: FAIL, 4 failures, each `TypeError: migrationsStatus is not a function`

- [ ] **Step 3: Write the minimal implementation**

In `apps/core-api/db/migrate.js`, add both functions immediately after
`readLedger`:

```js
async function readLedgerIfPresent(client) {
  const present = await client.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present"
  );
  if (present.rows[0].present !== true) return new Map();
  return readLedger(client);
}

// The readiness half of GET /health/ready. Unlike runMigrations this RETURNS its
// verdict: a probe that throws on 'pending' cannot report 'pending'. A ledger row
// with no file on disk is deliberately NOT a verdict here either -- it is the
// rolled-back-image case, which the runner only warns about.
async function migrationsStatus(client, directory) {
  const ledger = await readLedgerIfPresent(client);
  const files = readMigrationFiles(directory);
  let pending = false;
  for (const file of files) {
    const appliedChecksum = ledger.get(file.filename);
    if (!appliedChecksum) {
      pending = true;
      continue;
    }
    // Mismatch outranks pending: it means history was edited, which is the more
    // serious signal and the one an operator must see first.
    if (!appliedChecksum.equals(file.checksum)) return "checksum_mismatch";
  }
  return pending ? "pending" : "current";
}
```

Then add `migrationsStatus` to `module.exports`, which becomes:

```js
module.exports = {
  MIGRATION_ADVISORY_LOCK_KEY,
  MIGRATION_FILENAME_PATTERN,
  MINIMUM_SERVER_VERSION_NUM,
  SCHEMA_MIGRATIONS_DDL,
  checksumOf,
  migrationsStatus,
  normaliseSql,
  readMigrationFiles,
  runMigrations
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/migrate.test.js`  Expected: PASS (20 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/migrate.js apps/core-api/test/migrate.test.js
git commit -m "feat(core-api): migrationsStatus returns the readiness verdict instead of throwing" \
           -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: The `npm run migrate` CLI, with `--check` exiting 1

**Files:**
- Modify: `apps/core-api/db/migrate.js` (append a `require.main === module` block below `module.exports`)
- Modify: `apps/core-api/test/migrate.test.js` (header + append two cases)
- Test: `apps/core-api/test/migrate.test.js`

`package.json` already declares `"migrate": "node db/migrate.js"`. Without this
block that command loads the module, defines some functions and exits **0** having
done nothing — a green no-op that CI would read as "schema is current".

- [ ] **Step 1: Write the failing test**

Add the `child_process` require immediately after the `node:test` require in the
header:

```js
const { spawnSync } = require("node:child_process");
```

Add these two definitions immediately after the `MIGRATIONS_DIR` constant:

```js
const MIGRATE_CLI = path.join(__dirname, "..", "db", "migrate.js");

// config.js refuses to produce a configuration unless the three secrets and
// API_PUBLIC_ORIGIN are present and mutually consistent (POSTGRES_PASSWORD must
// equal the password in DATABASE_MIGRATION_URL; DATABASE_URL's user must be
// core_api_app and must differ from the migration DSN). NODE_ENV is deliberately
// not "production", which is what switches on the core_api_owner username rule.
function cliEnvironment(database) {
  const migrationUrl = new URL(database.connectionString);
  const appUrl = new URL(database.connectionString);
  appUrl.username = "core_api_app";
  appUrl.password = "app-role-rotated-on-every-boot";
  return {
    ...process.env,
    NODE_ENV: "test",
    POSTGRES_PASSWORD: decodeURIComponent(migrationUrl.password),
    DATABASE_MIGRATION_URL: database.connectionString,
    DATABASE_URL: appUrl.toString(),
    API_PUBLIC_ORIGIN: "http://127.0.0.1:3200"
  };
}
```

Append to the end of the file:

```js
// --- the CLI ----------------------------------------------------------------

test("node db/migrate.js --check exits 1 on a pending file and applies nothing", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_cli_check", async (database) => {
    const result = spawnSync(process.execPath, [MIGRATE_CLI, "--check"], {
      env: cliEnvironment(database),
      encoding: "utf8"
    });
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /pending migration\(s\) never applied: 0001_init\.sql/);

    const probe = await database.unscoped("SELECT to_regclass('public.companies') AS present");
    assert.equal(probe.rows[0].present, null);
    const ledger = await database.unscoped("SELECT count(*)::int AS n FROM schema_migrations");
    assert.equal(ledger.rows[0].n, 0);
  });
});

test("node db/migrate.js applies the migration set and exits 0", { skip: skipDatabaseTests() }, async () => {
  await withDatabase("migrate_cli_apply", async (database) => {
    const result = spawnSync(process.execPath, [MIGRATE_CLI], {
      env: cliEnvironment(database),
      encoding: "utf8"
    });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);

    const ledger = await database.unscoped("SELECT filename FROM schema_migrations");
    assert.deepEqual(ledger.rows.map((row) => row.filename), ["0001_init.sql"]);
    const probe = await database.unscoped("SELECT to_regclass('public.companies') AS present");
    assert.equal(probe.rows[0].present, "companies");
  });
});
```

Both cases spawn a real process because the exit code *is* the contract — an
in-process call cannot observe `process.exit(1)`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/migrate.test.js`
Expected: FAIL, 1 failure — `expected exit 1, got 0:` (the module loads, defines
its exports and exits cleanly). The second case passes vacuously on the exit code
and then fails on `Expected values to be strictly deep-equal: + [] - [
'0001_init.sql' ]`, so expect 2 failures in total.

- [ ] **Step 3: Write the minimal implementation**

Append to the bottom of `apps/core-api/db/migrate.js`, after `module.exports`:

```js
if (require.main === module) {
  // Required here rather than at the top of the file so the pure helpers above
  // stay loadable (and unit-testable) without pg or a validated environment.
  const { loadDotEnv } = require("../env-file");
  const { startupConfiguration } = require("../config");
  const { openMigrationPool, acquireMigrationClient, closeMigrationPool } = require("./index");

  const main = async () => {
    // Same two lines start() runs, so `npm run migrate` and `npm start` read one
    // environment and cannot disagree about which database they are pointed at.
    loadDotEnv();
    const config = startupConfiguration(process.env);
    openMigrationPool({ connectionString: config.databaseMigrationUrl });
    const client = await acquireMigrationClient();
    try {
      const result = await runMigrations(client, {
        directory: path.join(__dirname, "..", "migrations"),
        appRolePassword: config.databaseAppPassword,
        check: process.argv.includes("--check")
      });
      console.log(
        `migrations: ${result.applied.length} applied, ${result.skipped.length} already applied` +
        (result.checked ? " (check mode, nothing was applied)" : "")
      );
    } finally {
      client.release();
      // Swallowed so a close failure cannot mask the real error on its way out.
      await closeMigrationPool().catch(() => {});
    }
  };

  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
```

`process.exit(1)` rather than `process.exitCode = 1`: by that point a `pg.Pool`
may still hold the event loop open, and a migrate command that hangs instead of
failing is indistinguishable from a slow one.

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/migrate.test.js`  Expected: PASS (22 tests)

Also confirm the skip hatch is visible rather than silent:

```sh
CORE_API_SKIP_DB_TESTS=1 node --test apps/core-api/test/migrate.test.js
```

Expected: PASS with `# pass 6`, `# skip 16`, every skipped line tagged
`# SKIP CORE_API_SKIP_DB_TESTS=1`.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/migrate.js apps/core-api/test/migrate.test.js
git commit -m "feat(core-api): add the migrate CLI so npm run migrate exits 1 on pending" \
           -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Where this area stops

- **No pool, no config.** The CLI *calls* `startupConfiguration()`,
  `openMigrationPool()` and `closeMigrationPool()`; it does not define them.
  Steps 1, 2, 11 and 12 of the §9.4 table belong to `config.js`, `db/pool.js` and
  `server.js`, and `runMigrations` still never opens a connection or exits a
  process.
- **No connection retry.** The 10×1 s retry on `ECONNREFUSED`/`ENOTFOUND`/
  `ETIMEDOUT`/`57P03` and the fatal-on-`28P01`/`3D000` rule live in `db/health.js`
  and `db/pool.js`; the runner is handed a live client.
- **No readiness route.** `migrationsStatus()` is exported here and composed with
  `probeReadiness()` into `checkReadiness()` in `db/health.js`; the `{database,
  migrations}` envelope and its HTTP status are the health-route area's.
- **No template building.** `scripts/setup-template-db.js` and
  `testing/database.js` build the template by invoking `runMigrations` — that is
  the test-harness area's wiring, not this one's.
- **No schema assertions.** S1–S7 on the applied schema are
  `test/schema-invariants.test.js`, and C10 on the migration filenames is
  `test/source-structure.test.js`. This area asserts the *runner's* behaviour and
  the *bytes* of `0001_init.sql`, nothing about what the DDL means.

---

## Part 3 — Test harness and the enforcement suites

**Ordering.** Every task in this area runs **after** the other areas' tasks. The harness tasks need `db/migrate.js` and `migrations/0001_init.sql` to exist; the `source-structure.test.js` tasks must be the **last tasks in the merged plan**, because the walker meta-test's three sentinels (`db/index.js`, `http/routes/health.js`, `migrations/0001_init.sql`), C1's `deepEqual` on `["db/pool.js"]` and C3's `deepEqual` on `["http/router.js"]` all name files other areas create.

**`test/source-structure.test.js` already exists** when this area starts — scaffold-config created it with the `node:assert/strict` / `node:fs` / `node:path` / `node:test` requires, the constants `appRoot` and `repoRoot`, the helpers `readText(...segments)` (joins its arguments, returns UTF-8 with CRLF normalised to LF) and `readJson(...segments)`, and its own tests including C11 and C12. Everything below **appends** to that file and reuses those names. Never re-require `assert`/`fs`/`path`/`test`, never redeclare `appRoot`, `repoRoot` or `readText`, and never create or edit `/.gitattributes`, `/.dockerignore` or the root `package.json` — scaffold-config owns all three.

**Every command is run from the repository root**, and always as `node --test apps/core-api/test/<file>.test.js` rather than `npm test`, so `pretest` does not run and the failure you read is the failure you caused.

---

### Task 18: Deterministic test-database names and the missing-URL refusal

`testing/` is not `test/`: `node --test`'s default glob spawns **every** `.js` under a directory named `test` as its own process, so a helper placed there would run concurrently with the real suites and could `DROP` the template out from under a sibling's `CREATE DATABASE … TEMPLATE`. That is the whole reason this directory exists; C13 later keeps it from regressing.

**Files:**
- Create: `apps/core-api/testing/database.js`
- Test: `apps/core-api/test/testing-database.test.js`

- [x] **Step 1: Write the failing test**

```js
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
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/testing-database.test.js`
Expected: FAIL with `Error: Cannot find module '../testing/database'`

- [x] **Step 3: Write the minimal implementation**

Create `apps/core-api/testing/database.js`:

```js
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const APP_ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIR = path.join(APP_ROOT, "migrations");
const TEMPLATE_DATABASE_NAME = "core_api_test_template";

// db/migrate.js owns 4264071001. This is its neighbour, so the harness's
// maintenance-database mutations never contend with a real migration run.
const MAINTENANCE_LOCK_ID = 4264071002;

// FK-safe order, and deliberately NO CASCADE: when Phase 2 adds menu_items this
// statement fails loudly instead of leaving a table silently un-reset.
const FIXTURE_TABLES = [
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
];

const TRUNCATE_STATEMENT = `TRUNCATE ${FIXTURE_TABLES.join(", ")} RESTART IDENTITY`;

const MISSING_URL_MESSAGE = [
  "CORE_API_TEST_DATABASE_URL is not set, so the database-backed suites cannot run.",
  "This is a hard failure on purpose: a silently skipped tenant-isolation suite is",
  "worse than a red one.",
  "",
  "  export CORE_API_TEST_DATABASE_URL=postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres",
  "  $env:CORE_API_TEST_DATABASE_URL = 'postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'",
  "",
  "No local server yet? (see apps/core-api/README.md)",
  "  docker run -d --name core-db-dev -e POSTGRES_USER=core_api_owner \\",
  "    -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=core \\",
  "    -p 127.0.0.1:5433:5432 postgres:16-alpine",
  "",
  "If you genuinely have no Postgres, CORE_API_SKIP_DB_TESTS=1 turns these suites",
  "into VISIBLE TAP skips and makes pretest a no-op. CI never sets it."
].join("\n");

function requireTestDatabaseUrl(env = process.env) {
  const url = env.CORE_API_TEST_DATABASE_URL;
  if (typeof url !== "string" || url.length === 0) throw new Error(MISSING_URL_MESSAGE);
  return url;
}

function skipDatabaseTests(env = process.env) {
  return env.CORE_API_SKIP_DB_TESTS === "1" ? "CORE_API_SKIP_DB_TESTS=1" : false;
}

function databaseNameFor(testFilePath) {
  // path.relative yields backslashes on win32. Normalise before hashing or the
  // same file maps to two different databases on two different machines.
  const relative = path.relative(APP_ROOT, testFilePath).split(path.sep).join("/");
  const digest = crypto.createHash("sha256").update(relative).digest("hex").slice(0, 12);
  return `core_api_t_${digest}`;
}

function maintenanceDsn(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

module.exports = {
  APP_ROOT,
  MIGRATIONS_DIR,
  TEMPLATE_DATABASE_NAME,
  MAINTENANCE_LOCK_ID,
  FIXTURE_TABLES,
  TRUNCATE_STATEMENT,
  requireTestDatabaseUrl,
  skipDatabaseTests,
  databaseNameFor,
  maintenanceDsn
};
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/testing-database.test.js`  Expected: PASS (6 tests)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/testing/database.js apps/core-api/test/testing-database.test.js
git commit -m "test(core-api): deterministic per-file test database names"
```

---

### Task 19: Clone the template, self-heal staleness, hand out dedicated sessions

**Files:**
- Modify: `apps/core-api/testing/database.js` (append; replace the `module.exports` block)
- Test: `apps/core-api/test/testing-database-clone.test.js`

- [x] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");
const {
  TRUNCATE_STATEMENT,
  databaseNameFor,
  isTemplateStale,
  migrationChecksums,
  skipDatabaseTests,
  cloneTemplate,
  createEmptyDatabase
} = require("../testing/database");

const COMPANY_ID = "00000000-0000-4000-8000-0000000000ff";

// Pure. Runs even on a laptop with no Postgres, which is the point: the staleness
// rule is the correctness guarantee behind pretest, so it gets a real unit test.
test("staleness compares the ledger against the migrations directory, digest included", () => {
  const disk = [{ filename: "0001_init.sql", checksum: "aa" }];

  assert.equal(isTemplateStale(disk, [{ filename: "0001_init.sql", checksum: "aa" }]), false);
  assert.equal(isTemplateStale(disk, [{ filename: "0001_init.sql", checksum: "bb" }]), true);
  assert.equal(isTemplateStale(disk, []), true);
  assert.equal(
    isTemplateStale(disk, [
      { filename: "0001_init.sql", checksum: "aa" },
      { filename: "0002_later.sql", checksum: "cc" }
    ]),
    true
  );
});

test("the truncate statement names ten tables, restarts identity and has no CASCADE", () => {
  assert.equal(TRUNCATE_STATEMENT.match(/,/g).length, 9);
  assert.doesNotMatch(TRUNCATE_STATEMENT, /CASCADE/i);
  assert.match(TRUNCATE_STATEMENT, / RESTART IDENTITY$/);
});

test("migrationChecksums reads the real migrations directory", () => {
  const checksums = migrationChecksums();

  assert.ok(checksums.length >= 1);
  assert.equal(checksums[0].filename, "0001_init.sql");
  assert.match(checksums[0].checksum, /^[0-9a-f]{64}$/);
});

describe("cloned test database", { skip: skipDatabaseTests() }, () => {
  let db;

  before(async () => {
    db = await cloneTemplate(__filename);
  });

  after(async () => {
    if (db) await db.end();
  });

  test("the clone is named after this file and carries the full migration ledger", async () => {
    assert.equal(db.name, databaseNameFor(__filename));

    const { rows } = await db.unscoped(
      "SELECT filename, encode(checksum, 'hex') AS checksum FROM schema_migrations ORDER BY filename"
    );
    assert.deepEqual(rows, migrationChecksums());
  });

  test("the template was built by the production runner, not by psql -f or a dump", async () => {
    // set_updated_at() is inside a dollar-quoted CREATE FUNCTION. Any shortcut that
    // splits 0001_init.sql on semicolons cuts its body in half, so this row existing
    // AND the trigger actually moving updated_at is the canary for the whole class.
    const fn = await db.unscoped("SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at'");
    assert.equal(fn.rows.length, 1);

    await db.resetFixtures();
    await db.unscoped("INSERT INTO companies (id, name) VALUES ($1, $2)", [COMPANY_ID, "Trigger Probe"]);
    await db.unscoped("UPDATE companies SET name = $2 WHERE id = $1", [COMPANY_ID, "Trigger Probe 2"]);

    // Compared inside Postgres, at microsecond resolution: two JS Dates one
    // round trip apart can land in the same millisecond and compare equal.
    const { rows } = await db.unscoped(
      "SELECT updated_at > created_at AS moved FROM companies WHERE id = $1",
      [COMPANY_ID]
    );
    assert.equal(rows[0].moved, true);
  });

  test("resetFixtures empties the ten tenant tables and leaves the ledger alone", async () => {
    await db.resetFixtures();
    await db.unscoped("INSERT INTO companies (id, name) VALUES ($1, $2)", [COMPANY_ID, "To Be Truncated"]);

    await db.resetFixtures();

    const companies = await db.unscoped("SELECT count(*)::int AS n FROM companies");
    assert.equal(companies.rows[0].n, 0);

    const ledger = await db.unscoped("SELECT count(*)::int AS n FROM schema_migrations");
    assert.ok(ledger.rows[0].n >= 1);
  });

  test("connect() hands out an independent backend, not a pool checkout", async () => {
    // runMigrations holds a SESSION-level advisory lock and a BEGIN/COMMIT on one
    // backend, and the lock-contention scenario needs a second one at the same
    // time. A max:4 pool cannot guarantee two distinct sessions; this can.
    const first = await db.connect();
    const second = await db.connect();
    try {
      const a = await first.query("SELECT pg_backend_pid() AS pid");
      const b = await second.query("SELECT pg_backend_pid() AS pid");
      assert.notEqual(a.rows[0].pid, b.rows[0].pid);
    } finally {
      await first.end();
      await second.end();
    }
  });

  test("createEmptyDatabase yields a database with no schema at all", async () => {
    const empty = await createEmptyDatabase("harness-probe");
    try {
      const { rows } = await empty.unscoped("SELECT to_regclass('public.schema_migrations') AS ledger");
      assert.equal(rows[0].ledger, null);
    } finally {
      await empty.drop();
    }
  });
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/testing-database-clone.test.js`
Expected: FAIL with `TypeError: isTemplateStale is not a function`

- [x] **Step 3: Write the minimal implementation**

Append the following to `apps/core-api/testing/database.js`, deleting the `module.exports = { … }` block the previous task left at the bottom (the block below replaces it). The new `require`s sit here rather than at the top on purpose: everything above this line is pure and loads with no `pg` installed.

```js
const fs = require("node:fs");
const { Client, Pool } = require("pg");
const { runMigrations } = require("../db/migrate");

function migrationChecksums(directory = MIGRATIONS_DIR) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((filename) => {
      // Same CRLF normalisation as db/migrate.js. Duplicated on purpose: if the two
      // ever disagree the template rebuilds on every run AND S6 goes red -- both loud.
      const raw = fs.readFileSync(path.join(directory, filename));
      const normalised = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
      return { filename, checksum: crypto.createHash("sha256").update(normalised).digest("hex") };
    });
}

function isTemplateStale(diskChecksums, ledgerRows) {
  const key = (rows) => rows.map((row) => `${row.filename}:${row.checksum}`).sort().join("|");
  return key(diskChecksums) !== key(ledgerRows);
}

async function withMaintenanceClient(connectionString, fn) {
  const client = new Client({ connectionString, application_name: "core-api-test-harness" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withMaintenanceLock(fn) {
  const url = requireTestDatabaseUrl();
  return withMaintenanceClient(url, async (client) => {
    // Session-level, and held across CHECK + REBUILD + CLONE rather than just the
    // rebuild: CREATE DATABASE ... TEMPLATE t fails with "source database is being
    // accessed by other users" if any sibling test process is connected to t.
    await client.query("SELECT pg_advisory_lock($1)", [MAINTENANCE_LOCK_ID]);
    try {
      return await fn(client, url);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MAINTENANCE_LOCK_ID]);
    }
  });
}

// Takes no advisory lock and reads no environment: scripts/reset-database.js
// calls it against an operator-supplied DSN that has nothing to do with the
// test harness. Owning the DROP/CREATE mechanics here is what keeps every
// `*.query(` call in this service inside db/ and testing/ (rule C2).
async function recreateDatabase(maintenanceConnectionString, databaseName) {
  await withMaintenanceClient(maintenanceConnectionString, async (client) => {
    // WITH (FORCE) needs PostgreSQL >= 13; the runner asserts >= 14 and compose
    // pins postgres:16-alpine. It is what makes a re-run RECLAIM the name rather
    // than hang on a connection a crashed previous run left behind.
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${databaseName}"`);
  });
}

async function readTemplateLedger(url) {
  try {
    return await withMaintenanceClient(maintenanceDsn(url, TEMPLATE_DATABASE_NAME), (client) =>
      client
        .query("SELECT filename, encode(checksum, 'hex') AS checksum FROM schema_migrations")
        .then((result) => result.rows)
    );
  } catch {
    // No template, or a template with no ledger table. Either way: stale.
    return null;
  }
}

async function ensureTemplate(client, url) {
  const disk = migrationChecksums();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    TEMPLATE_DATABASE_NAME
  ]);

  if (exists.rowCount === 1) {
    const ledger = await readTemplateLedger(url);
    if (ledger && !isTemplateStale(disk, ledger)) return;
  }

  await client.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE_NAME}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${TEMPLATE_DATABASE_NAME}"`);

  // The PRODUCTION runner, on its own connection to the template database --
  // never psql -f, never a schema dump. 0001_init.sql has a dollar-quoted
  // CREATE FUNCTION and a dollar-quoted DO block, so a shortcut here means the
  // one rule most likely to be violated is the one rule never exercised. Every
  // `npm test` is therefore also a migration-runner test. runMigrations takes an
  // already-connected client FIRST; passing it an options object instead throws
  // "runMigrations requires options.directory" before touching the database.
  await withMaintenanceClient(maintenanceDsn(url, TEMPLATE_DATABASE_NAME), (conn) =>
    runMigrations(conn, {
      directory: MIGRATIONS_DIR,
      log: { info() {}, warn: console.warn }
    })
  );
}

function attach(url, name) {
  const connectionString = maintenanceDsn(url, name);
  const pool = new Pool({ connectionString, max: 4, application_name: `core-api-test:${name}` });

  return {
    name,
    connectionString,
    // Deliberately bypasses the repositories: no legitimate scope can create rows in
    // two tenants, which is exactly what a two-tenant fixture must do.
    unscoped: (text, params) => pool.query(text, params),
    // A DEDICATED backend the caller owns and must end(). Not a pool checkout:
    // two checkouts from one pool are not guaranteed to be two sessions.
    connect: async () => {
      const client = new Client({
        connectionString,
        application_name: `core-api-test-session:${name}`
      });
      await client.connect();
      return client;
    },
    resetFixtures: () => pool.query(TRUNCATE_STATEMENT),
    end: () => pool.end(),
    drop: async () => {
      await pool.end();
      await withMaintenanceLock((client) =>
        client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      );
    }
  };
}

async function ensureTemplateDatabase() {
  await withMaintenanceLock((client, url) => ensureTemplate(client, url));
}

async function cloneTemplate(testFilePath) {
  const name = databaseNameFor(testFilePath);
  const url = await withMaintenanceLock(async (client, connectionString) => {
    await ensureTemplate(client, connectionString);
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE_NAME}"`);
    return connectionString;
  });
  return attach(url, name);
}

async function createEmptyDatabase(label) {
  const digest = crypto.createHash("sha256").update(String(label)).digest("hex").slice(0, 12);
  const name = `core_api_e_${digest}`;
  const url = await withMaintenanceLock(async (client, connectionString) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
    return connectionString;
  });
  return attach(url, name);
}

module.exports = {
  APP_ROOT,
  MIGRATIONS_DIR,
  TEMPLATE_DATABASE_NAME,
  MAINTENANCE_LOCK_ID,
  FIXTURE_TABLES,
  TRUNCATE_STATEMENT,
  requireTestDatabaseUrl,
  skipDatabaseTests,
  databaseNameFor,
  maintenanceDsn,
  migrationChecksums,
  isTemplateStale,
  withMaintenanceClient,
  recreateDatabase,
  ensureTemplateDatabase,
  cloneTemplate,
  createEmptyDatabase
};
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/testing-database-clone.test.js`  Expected: PASS (8 tests, with `CORE_API_TEST_DATABASE_URL` exported; without it the three pure tests pass and the `describe` block fails loudly, which is the designed behaviour)

- [x] **Step 5: Commit**

```bash
git add apps/core-api/testing/database.js apps/core-api/test/testing-database-clone.test.js
git commit -m "test(core-api): clone a per-file database from a self-healing template"
```

---

### Task 20: `pretest` builds the template and is a no-op without a URL

**Files:**
- Create: `apps/core-api/scripts/setup-template-db.js`
- Test: `apps/core-api/test/scripts.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/scripts.test.js`
Expected: FAIL with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 0` — the child exited 1 because its `output` reads `Cannot find module '…/apps/core-api/scripts/setup-template-db.js'`

- [ ] **Step 3: Write the minimal implementation**

Create `apps/core-api/scripts/setup-template-db.js`:

```js
#!/usr/bin/env node
"use strict";

// npm `pretest`. This is an OPTIMISATION, not the correctness guarantee:
// cloneTemplate() re-checks staleness itself, because typing `node --test`
// directly is the house habit (apps/customer-order/package.json trains it) and
// Node 20 -- the CI pin and the base image -- has no --test-global-setup.
const { ensureTemplateDatabase, skipDatabaseTests } = require("../testing/database");

async function main() {
  if (skipDatabaseTests()) {
    console.log("setup-template-db: CORE_API_SKIP_DB_TESTS=1 is set, nothing to build.");
    return;
  }

  if (!process.env.CORE_API_TEST_DATABASE_URL) {
    console.log(
      "setup-template-db: CORE_API_TEST_DATABASE_URL is unset, skipping the template build.\n" +
        "The database-backed suites will fail with setup instructions when they run."
    );
    return;
  }

  await ensureTemplateDatabase();
  console.log("setup-template-db: core_api_test_template is up to date.");
}

main().catch((error) => {
  console.error(`setup-template-db failed: ${error.message}`);
  process.exit(1);
});
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/scripts.test.js`  Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/scripts/setup-template-db.js apps/core-api/test/scripts.test.js
git commit -m "test(core-api): pretest builds the template and no-ops without a URL"
```

---

### Task 21: `db:reset` and its three independent guards

**Files:**
- Create: `apps/core-api/scripts/reset-database.js`
- Modify: `apps/core-api/test/scripts.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/scripts.test.js`:

```js
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/scripts.test.js`
Expected: FAIL — `guard 1` reaches `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /NODE_ENV/. Input: "…Cannot find module '…/apps/core-api/scripts/reset-database.js'…"` (the `status` assertion passes for the wrong reason, which is why the message assertions are there)

- [ ] **Step 3: Write the minimal implementation**

Create `apps/core-api/scripts/reset-database.js`:

```js
#!/usr/bin/env node
"use strict";

// npm `db:reset`. The only script in this repository that destroys data, and the
// sanctioned answer to a local checksum surprise -- against a database with real
// rows there is no such escape, and there should not be.
//
// Three INDEPENDENT guards: each refuses on its own, so weakening one does not
// open the door.
//
// The DROP/CREATE mechanics live in testing/database.js's recreateDatabase().
// This file therefore contains no `pg` require and no `.query(` call of its own:
// C1 pins the pg requirer to db/pool.js and C2 bans raw query calls outside db/,
// and the walker scans scripts/.
const { recreateDatabase, maintenanceDsn } = require("../testing/database");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function refuse(message) {
  console.error(`db:reset refused: ${message}`);
  process.exit(1);
}

async function main(argv, env) {
  if (env.NODE_ENV === "production") {
    refuse("NODE_ENV is production. This script never runs against production.");
  }

  const dsn = env.DATABASE_MIGRATION_URL;
  if (!dsn) refuse("DATABASE_MIGRATION_URL is not set.");

  const url = new URL(dsn);
  const host = url.hostname;
  if (!LOCAL_HOSTS.has(host)) {
    refuse(`DATABASE_MIGRATION_URL host ${host} is not local (localhost, 127.0.0.1 or ::1).`);
  }

  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) refuse("DATABASE_MIGRATION_URL names no database.");

  if (!argv.includes("--yes")) {
    refuse(
      `about to DROP host=${host} port=${port} database=${database}. ` +
        "Re-run with --yes if that is what you meant."
    );
  }

  await recreateDatabase(maintenanceDsn(dsn, "postgres"), database);

  console.log(
    `db:reset dropped and recreated ${database} on ${host}:${port}. ` +
      "Start the server to re-run migrations."
  );
}

main(process.argv.slice(2), process.env).catch((error) => {
  console.error(`db:reset failed: ${error.message}`);
  process.exit(1);
});
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/scripts.test.js`  Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/scripts/reset-database.js apps/core-api/test/scripts.test.js
git commit -m "feat(core-api): db:reset with three independent destruction guards"
```

---

### Task 22: The two-tenant fixture

Every row here is load-bearing. The settled design names *"suspension revokes nothing"* as the most-repeated defect across all drafts: without a suspended shop, a `scope-materialize.js` written without `JOIN shops … AND s.status='active'` passes the cross-tenant modes and ships.

**Files:**
- Create: `apps/core-api/testing/fixtures/two-tenant.js`
- Test: `apps/core-api/test/fixtures-two-tenant.test.js`

- [ ] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const {
  IDS,
  FIXTURE_PASSWORD,
  SESSION_TOKENS,
  TERMINAL_TOKENS,
  PAIRING_CODE,
  seedTwoTenant
} = require("../testing/fixtures/two-tenant");

test("every minted credential has the house shape and is unique", () => {
  const raw = [...Object.values(SESSION_TOKENS), ...Object.values(TERMINAL_TOKENS)];

  for (const value of raw) {
    assert.match(value, /^[A-Za-z0-9_-]{22}$/, `bad credential shape: ${value}`);
  }
  assert.equal(new Set(raw).size, raw.length);
  assert.match(PAIRING_CODE.folded, /^[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.equal(PAIRING_CODE.display, "A2CTR-00001");
  assert.ok(FIXTURE_PASSWORD.length >= 12);
});

test("every fixture uuid is mnemonic, distinct and v4-shaped", () => {
  const values = Object.values(IDS);

  for (const value of values) {
    assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.equal(new Set(values).size, values.length);
});

describe("two-tenant fixture", { skip: skipDatabaseTests() }, () => {
  let db;

  before(async () => {
    db = await cloneTemplate(__filename);
  });

  beforeEach(async () => {
    await db.resetFixtures();
    await seedTwoTenant(db);
  });

  after(async () => {
    if (db) await db.end();
  });

  test("seeding is repeatable: a truncate-and-reseed leaves the same row counts", async () => {
    const count = async (table) =>
      (await db.unscoped(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

    const first = {
      companies: await count("companies"),
      users: await count("users"),
      shops: await count("shops"),
      terminals: await count("terminals"),
      tokens: await count("terminal_tokens")
    };

    await db.resetFixtures();
    await seedTwoTenant(db);

    assert.deepEqual(
      {
        companies: await count("companies"),
        users: await count("users"),
        shops: await count("shops"),
        terminals: await count("terminals"),
        tokens: await count("terminal_tokens")
      },
      first
    );
    assert.equal(first.companies, 3);
    assert.equal(first.users, 7);
    assert.equal(first.shops, 5);
    assert.equal(first.terminals, 7);
    assert.equal(first.tokens, 8);
  });

  test("Company C is suspended and still holds an active admin, a live session and a live token", async () => {
    const company = await db.unscoped("SELECT status FROM companies WHERE id = $1", [IDS.companyC]);
    assert.equal(company.rows[0].status, "suspended");

    const admin = await db.unscoped("SELECT status, role FROM users WHERE id = $1", [IDS.userCAdmin]);
    assert.equal(admin.rows[0].status, "active");
    assert.equal(admin.rows[0].role, "company_admin");

    const session = await db.unscoped(
      "SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1 AND expires_at > now()",
      [IDS.userCAdmin]
    );
    assert.equal(session.rows[0].n, 1);

    const token = await db.unscoped(
      "SELECT count(*)::int AS n FROM terminal_tokens WHERE company_id = $1 AND revoked_at IS NULL",
      [IDS.companyC]
    );
    assert.equal(token.rows[0].n, 1);
  });

  test("Shop A3 is suspended and still holds an assignment, a live terminal and a live token", async () => {
    const shop = await db.unscoped("SELECT status FROM shops WHERE id = $1", [IDS.shopA3]);
    assert.equal(shop.rows[0].status, "suspended");

    const assignment = await db.unscoped(
      "SELECT count(*)::int AS n FROM user_shops WHERE user_id = $1 AND shop_id = $2",
      [IDS.userAManager, IDS.shopA3]
    );
    assert.equal(assignment.rows[0].n, 1);

    const terminal = await db.unscoped("SELECT status FROM terminals WHERE id = $1", [
      IDS.terminalA3Kitchen
    ]);
    assert.equal(terminal.rows[0].status, "active");

    const token = await db.unscoped(
      "SELECT count(*)::int AS n FROM terminal_tokens WHERE terminal_id = $1 AND revoked_at IS NULL",
      [IDS.terminalA3Kitchen]
    );
    assert.equal(token.rows[0].n, 1);
  });

  test("A-unassigned has zero shop assignments -- the fail-closed COALESCE case", async () => {
    const { rows } = await db.unscoped(
      "SELECT count(*)::int AS n FROM user_shops WHERE user_id = $1",
      [IDS.userAUnassigned]
    );
    assert.equal(rows[0].n, 0);
  });

  test("A-staff is assigned to two shops -- the duplicate-row semi-join case", async () => {
    const { rows } = await db.unscoped(
      "SELECT shop_id FROM user_shops WHERE user_id = $1 ORDER BY shop_id",
      [IDS.userAStaff]
    );
    assert.deepEqual(rows.map((row) => row.shop_id).sort(), [IDS.shopA1, IDS.shopA2].sort());
  });

  test("A1 holds a suspended terminal that still carries a live token", async () => {
    const terminal = await db.unscoped("SELECT status, shop_id FROM terminals WHERE id = $1", [
      IDS.terminalA1Suspended
    ]);
    assert.equal(terminal.rows[0].status, "suspended");
    assert.equal(terminal.rows[0].shop_id, IDS.shopA1);

    const token = await db.unscoped(
      "SELECT count(*)::int AS n FROM terminal_tokens " +
        "WHERE terminal_id = $1 AND revoked_at IS NULL AND expires_at > now()",
      [IDS.terminalA1Suspended]
    );
    assert.equal(token.rows[0].n, 1);
  });

  test("A1's kitchen terminal holds one live token and one admin_revoke'd token", async () => {
    const { rows } = await db.unscoped(
      "SELECT revoked_reason FROM terminal_tokens WHERE terminal_id = $1 ORDER BY revoked_at NULLS FIRST",
      [IDS.terminalA1Kitchen]
    );
    assert.deepEqual(rows.map((row) => row.revoked_reason), [null, "admin_revoke"]);
  });

  test("the platform admin has two sessions: one unscoped, one pinned to A", async () => {
    const { rows } = await db.unscoped(
      "SELECT acting_company_id FROM user_sessions WHERE user_id = $1 ORDER BY acting_company_id NULLS FIRST",
      [IDS.userPlatformAdmin]
    );
    assert.deepEqual(rows.map((row) => row.acting_company_id), [null, IDS.companyA]);
  });

  test("every shop has a table labelled '1', proving the unique index is per-shop", async () => {
    const { rows } = await db.unscoped(
      "SELECT count(*)::int AS n FROM shop_tables WHERE label = '1' AND status = 'active'"
    );
    assert.equal(rows[0].n, 5);
  });

  test("A2's cashier terminal holds exactly one live pairing code", async () => {
    const { rows } = await db.unscoped(
      "SELECT count(*)::int AS n FROM terminal_pairing_codes " +
        "WHERE terminal_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()",
      [IDS.terminalA2Counter]
    );
    assert.equal(rows[0].n, 1);
  });

  test("password hashes satisfy the column CHECK and are computed once", async () => {
    const { rows } = await db.unscoped("SELECT DISTINCT password_hash FROM users");

    assert.equal(rows.length, 1, "all seven users share one hash: scrypt at N=32768 is ~100ms");
    assert.match(rows[0].password_hash, /^scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.ok(rows[0].password_hash.length >= 40 && rows[0].password_hash.length <= 512);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/fixtures-two-tenant.test.js`
Expected: FAIL with `Error: Cannot find module '../testing/fixtures/two-tenant'`

- [ ] **Step 3: Write the minimal implementation**

Create `apps/core-api/testing/fixtures/two-tenant.js`:

```js
"use strict";

const crypto = require("node:crypto");

// Hardcoded mnemonic UUIDs, never random, so a failure prints
// "expected aaaaaaaa-0003-...-0002, got bbbbbbbb-0003-...-0001" and you know which
// tenant leaked without opening a second window.
//
//   prefix : aaaaaaaa = company A, bbbbbbbb = B, cccccccc = C, 00000000 = platform
//   group2 : 0001 company  0002 shop   0003 user      0004 shop_table
//            0005 terminal 0006 token  0007 pairing   0008 session
const IDS = {
  companyA: "aaaaaaaa-0001-4000-8000-000000000001",
  companyB: "bbbbbbbb-0001-4000-8000-000000000001",
  companyC: "cccccccc-0001-4000-8000-000000000001",

  shopA1: "aaaaaaaa-0002-4000-8000-000000000001",
  shopA2: "aaaaaaaa-0002-4000-8000-000000000002",
  shopA3: "aaaaaaaa-0002-4000-8000-000000000003",
  shopB1: "bbbbbbbb-0002-4000-8000-000000000001",
  shopC1: "cccccccc-0002-4000-8000-000000000001",

  userPlatformAdmin: "00000000-0003-4000-8000-000000000001",
  userAAdmin: "aaaaaaaa-0003-4000-8000-000000000001",
  userAManager: "aaaaaaaa-0003-4000-8000-000000000002",
  userAStaff: "aaaaaaaa-0003-4000-8000-000000000003",
  userAUnassigned: "aaaaaaaa-0003-4000-8000-000000000004",
  userBAdmin: "bbbbbbbb-0003-4000-8000-000000000001",
  userCAdmin: "cccccccc-0003-4000-8000-000000000001",

  tableA1: "aaaaaaaa-0004-4000-8000-000000000001",
  tableA2: "aaaaaaaa-0004-4000-8000-000000000002",
  tableA3: "aaaaaaaa-0004-4000-8000-000000000003",
  tableB1: "bbbbbbbb-0004-4000-8000-000000000001",
  tableC1: "cccccccc-0004-4000-8000-000000000001",

  terminalA1Kitchen: "aaaaaaaa-0005-4000-8000-000000000001",
  terminalA1Suspended: "aaaaaaaa-0005-4000-8000-000000000002",
  terminalA2Kitchen: "aaaaaaaa-0005-4000-8000-000000000003",
  terminalA2Counter: "aaaaaaaa-0005-4000-8000-000000000004",
  terminalA3Kitchen: "aaaaaaaa-0005-4000-8000-000000000005",
  terminalB1Kitchen: "bbbbbbbb-0005-4000-8000-000000000001",
  terminalC1Kitchen: "cccccccc-0005-4000-8000-000000000001",

  tokenA1KitchenLive: "aaaaaaaa-0006-4000-8000-000000000001",
  tokenA1KitchenRevoked: "aaaaaaaa-0006-4000-8000-000000000002",
  tokenA1SuspendedLive: "aaaaaaaa-0006-4000-8000-000000000003",
  tokenA2KitchenLive: "aaaaaaaa-0006-4000-8000-000000000004",
  tokenA2CounterLive: "aaaaaaaa-0006-4000-8000-000000000005",
  tokenA3KitchenLive: "aaaaaaaa-0006-4000-8000-000000000006",
  tokenB1KitchenLive: "bbbbbbbb-0006-4000-8000-000000000001",
  tokenC1KitchenLive: "cccccccc-0006-4000-8000-000000000001",

  pairingCodeA2Counter: "aaaaaaaa-0007-4000-8000-000000000001",

  sessionPlatformUnscoped: "00000000-0008-4000-8000-000000000001",
  sessionPlatformInA: "00000000-0008-4000-8000-000000000002",
  sessionAAdmin: "aaaaaaaa-0008-4000-8000-000000000001",
  sessionAManager: "aaaaaaaa-0008-4000-8000-000000000002",
  sessionAStaff: "aaaaaaaa-0008-4000-8000-000000000003",
  sessionAUnassigned: "aaaaaaaa-0008-4000-8000-000000000004",
  sessionBAdmin: "bbbbbbbb-0008-4000-8000-000000000001",
  sessionCAdmin: "cccccccc-0008-4000-8000-000000000001"
};

// 22 Base64URL characters, the shape lib/tokens.js mints, but fixed so a failing
// assertion prints something a human recognises.
const SESSION_TOKENS = {
  platformUnscoped: "SessionPlatformUnscopd",
  platformInA: "SessionPlatformInAaaaa",
  aAdmin: "SessionAdminAaaaaaaaaa",
  aManager: "SessionManagerAaaaaaaa",
  aStaff: "SessionStaffAaaaaaaaaa",
  aUnassigned: "SessionUnassignedAaaaa",
  bAdmin: "SessionAdminBbbbbbbbbb",
  cAdmin: "SessionAdminCccccccccc"
};

const TERMINAL_TOKENS = {
  a1KitchenLive: "TokenA1KitchenLiveaaaa",
  a1KitchenRevoked: "TokenA1KitchenRevokedX",
  a1SuspendedLive: "TokenA1SuspendedLiveaa",
  a2KitchenLive: "TokenA2KitchenLiveaaaa",
  a2CounterLive: "TokenA2CounterLiveaaaa",
  a3KitchenLive: "TokenA3KitchenLiveaaaa",
  b1KitchenLive: "TokenB1KitchenLivebbbb",
  c1KitchenLive: "TokenC1KitchenLivecccc"
};

// Crockford base32, 10 characters, displayed XXXXX-XXXXX. Folded before hashing:
// uppercase, dashes and whitespace stripped, I/L -> 1, O -> 0.
const PAIRING_CODE = { display: "A2CTR-00001", folded: "A2CTR00001" };

const FIXTURE_PASSWORD = "fixture-password-1234";

// Guards against a typo silently shortening a credential and making a "22 Base64URL
// characters" assertion elsewhere pass for the wrong reason.
for (const value of [...Object.values(SESSION_TOKENS), ...Object.values(TERMINAL_TOKENS)]) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new Error(`two-tenant fixture credential is not 22 Base64URL chars: ${value}`);
  }
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest();

// Computed ONCE at module load. scrypt at N=32768 is ~100 ms; seven users times a
// per-test re-seed would dominate every database suite in the service. All seven
// users share one password, so one hash covers the fixture.
//
// PHC-style string, matching the users.password_hash CHECK (LIKE 'scrypt$%').
// maxmem: 128 * 32768 * 8 is exactly 33,554,432 and Node's default cap is exactly
// 32 MiB with the implementation needing slightly more, so omitting it throws at
// module load. lib/password.js must parse this encoding -- base64url, not base64.
const FIXTURE_PASSWORD_HASH = (() => {
  const salt = Buffer.from("core-api-fixture", "utf8");
  const key = crypto.scryptSync(FIXTURE_PASSWORD.normalize("NFKC"), salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$N=32768,r=8,p=1$${salt.toString("base64url")}$${key.toString("base64url")}`;
})();

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

async function insert(db, table, rows) {
  for (const row of rows) {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    await db.unscoped(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
      columns.map((column) => row[column])
    );
  }
}

function user(id, companyId, role, email, displayName, createdBy) {
  return {
    id,
    company_id: companyId,
    role,
    email,
    display_name: displayName,
    password_hash: FIXTURE_PASSWORD_HASH,
    created_by_user_id: createdBy
  };
}

function session(id, userId, actingCompanyId, rawToken, now) {
  return {
    id,
    user_id: userId,
    acting_company_id: actingCompanyId,
    token_hash: sha256(rawToken),
    expires_at: new Date(now + 8 * 60 * MINUTE),
    absolute_expires_at: new Date(now + 7 * DAY)
  };
}

function terminal(id, companyId, shopId, kind, name, status, createdBy) {
  return {
    id,
    company_id: companyId,
    shop_id: shopId,
    kind,
    name,
    status,
    created_by_user_id: createdBy
  };
}

function token(id, companyId, shopId, terminalId, rawToken, now, revocation) {
  return {
    id,
    company_id: companyId,
    shop_id: shopId,
    terminal_id: terminalId,
    token_hash: sha256(rawToken),
    expires_at: new Date(now + 90 * DAY),
    revoked_at: revocation ? new Date(now - MINUTE) : null,
    revoked_reason: revocation || null
  };
}

// Seeding order is forced by the FK cycle: companies with created_by_user_id NULL
// -> the platform admin (company_id NULL) -> tenant users created by them ->
// UPDATE companies to close the cycle. terminals.created_by_user_id and
// terminal_pairing_codes.created_by_user_id are NOT NULL, so they come last.
async function seedTwoTenant(db) {
  const now = Date.now();
  const pAdmin = IDS.userPlatformAdmin;

  await insert(db, "companies", [
    { id: IDS.companyA, name: "Company A", status: "active" },
    { id: IDS.companyB, name: "Company B", status: "active" },
    { id: IDS.companyC, name: "Company C", status: "suspended" }
  ]);

  await insert(db, "users", [
    user(pAdmin, null, "platform_admin", "padmin@example.test", "P Admin", null)
  ]);

  await insert(db, "users", [
    user(IDS.userAAdmin, IDS.companyA, "company_admin", "a-admin@example.test", "A Admin", pAdmin),
    user(IDS.userAManager, IDS.companyA, "shop_manager", "a-manager@example.test", "A Manager", pAdmin),
    user(IDS.userAStaff, IDS.companyA, "staff", "a-staff@example.test", "A Staff", pAdmin),
    user(IDS.userAUnassigned, IDS.companyA, "staff", "a-unassigned@example.test", "A Unassigned", pAdmin),
    user(IDS.userBAdmin, IDS.companyB, "company_admin", "b-admin@example.test", "B Admin", pAdmin),
    user(IDS.userCAdmin, IDS.companyC, "company_admin", "c-admin@example.test", "C Admin", pAdmin)
  ]);

  await db.unscoped("UPDATE companies SET created_by_user_id = $1", [pAdmin]);

  await insert(db, "shops", [
    { id: IDS.shopA1, company_id: IDS.companyA, name: "Shop A1", time_zone: "Asia/Tokyo",
      business_day_rollover_hour: 6, status: "active", created_by_user_id: pAdmin },
    { id: IDS.shopA2, company_id: IDS.companyA, name: "Shop A2", time_zone: "Asia/Tokyo",
      business_day_rollover_hour: 6, status: "active", created_by_user_id: pAdmin },
    // Suspended, and still carrying an assignment, a terminal and a live token.
    { id: IDS.shopA3, company_id: IDS.companyA, name: "Shop A3", time_zone: "Asia/Yangon",
      business_day_rollover_hour: 4, status: "suspended", created_by_user_id: pAdmin },
    { id: IDS.shopB1, company_id: IDS.companyB, name: "Shop B1", time_zone: "Asia/Tokyo",
      business_day_rollover_hour: 6, status: "active", created_by_user_id: pAdmin },
    { id: IDS.shopC1, company_id: IDS.companyC, name: "Shop C1", time_zone: "Asia/Tokyo",
      business_day_rollover_hour: 6, status: "active", created_by_user_id: pAdmin }
  ]);

  // All labelled '1': shop_tables_shop_label_active_key is per-shop, and this is
  // what proves it.
  await insert(db, "shop_tables", [
    { id: IDS.tableA1, company_id: IDS.companyA, shop_id: IDS.shopA1, label: "1", created_by_user_id: pAdmin },
    { id: IDS.tableA2, company_id: IDS.companyA, shop_id: IDS.shopA2, label: "1", created_by_user_id: pAdmin },
    { id: IDS.tableA3, company_id: IDS.companyA, shop_id: IDS.shopA3, label: "1", created_by_user_id: pAdmin },
    { id: IDS.tableB1, company_id: IDS.companyB, shop_id: IDS.shopB1, label: "1", created_by_user_id: pAdmin },
    { id: IDS.tableC1, company_id: IDS.companyC, shop_id: IDS.shopC1, label: "1", created_by_user_id: pAdmin }
  ]);

  await insert(db, "user_shops", [
    { company_id: IDS.companyA, user_id: IDS.userAManager, shop_id: IDS.shopA1, created_by_user_id: pAdmin },
    { company_id: IDS.companyA, user_id: IDS.userAManager, shop_id: IDS.shopA3, created_by_user_id: pAdmin },
    { company_id: IDS.companyA, user_id: IDS.userAStaff, shop_id: IDS.shopA1, created_by_user_id: pAdmin },
    { company_id: IDS.companyA, user_id: IDS.userAStaff, shop_id: IDS.shopA2, created_by_user_id: pAdmin }
    // A-unassigned deliberately gets none: array_agg over zero rows returns NULL,
    // and without COALESCE(..., '{}') that scope is byte-identical to a company
    // admin's -- revocation escalating privilege.
  ]);

  await insert(db, "user_sessions", [
    session(IDS.sessionPlatformUnscoped, pAdmin, null, SESSION_TOKENS.platformUnscoped, now),
    session(IDS.sessionPlatformInA, pAdmin, IDS.companyA, SESSION_TOKENS.platformInA, now),
    session(IDS.sessionAAdmin, IDS.userAAdmin, IDS.companyA, SESSION_TOKENS.aAdmin, now),
    session(IDS.sessionAManager, IDS.userAManager, IDS.companyA, SESSION_TOKENS.aManager, now),
    session(IDS.sessionAStaff, IDS.userAStaff, IDS.companyA, SESSION_TOKENS.aStaff, now),
    session(IDS.sessionAUnassigned, IDS.userAUnassigned, IDS.companyA, SESSION_TOKENS.aUnassigned, now),
    session(IDS.sessionBAdmin, IDS.userBAdmin, IDS.companyB, SESSION_TOKENS.bAdmin, now),
    session(IDS.sessionCAdmin, IDS.userCAdmin, IDS.companyC, SESSION_TOKENS.cAdmin, now)
  ]);

  await insert(db, "terminals", [
    terminal(IDS.terminalA1Kitchen, IDS.companyA, IDS.shopA1, "kitchen_display", "Kitchen A1", "active", pAdmin),
    // Suspended terminal holding a live token: a bearer resolver written as a bare
    // token_hash probe passes every other fixture and fails only here.
    terminal(IDS.terminalA1Suspended, IDS.companyA, IDS.shopA1, "epaper_hub", "Old Panel A1", "suspended", pAdmin),
    terminal(IDS.terminalA2Kitchen, IDS.companyA, IDS.shopA2, "kitchen_display", "Kitchen A2", "active", pAdmin),
    // The cross-shop escalation target for Mode 3.
    terminal(IDS.terminalA2Counter, IDS.companyA, IDS.shopA2, "cashier_counter", "Counter A2", "active", pAdmin),
    terminal(IDS.terminalA3Kitchen, IDS.companyA, IDS.shopA3, "kitchen_display", "Kitchen A3", "active", pAdmin),
    terminal(IDS.terminalB1Kitchen, IDS.companyB, IDS.shopB1, "kitchen_display", "Kitchen B1", "active", pAdmin),
    terminal(IDS.terminalC1Kitchen, IDS.companyC, IDS.shopC1, "kitchen_display", "Kitchen C1", "active", pAdmin)
  ]);

  await insert(db, "terminal_pairing_codes", [
    {
      id: IDS.pairingCodeA2Counter,
      company_id: IDS.companyA,
      shop_id: IDS.shopA2,
      terminal_id: IDS.terminalA2Counter,
      code_hash: sha256(PAIRING_CODE.folded),
      expires_at: new Date(now + 15 * MINUTE),
      created_by_user_id: pAdmin
    }
  ]);

  await insert(db, "terminal_tokens", [
    token(IDS.tokenA1KitchenLive, IDS.companyA, IDS.shopA1, IDS.terminalA1Kitchen, TERMINAL_TOKENS.a1KitchenLive, now, null),
    token(IDS.tokenA1KitchenRevoked, IDS.companyA, IDS.shopA1, IDS.terminalA1Kitchen, TERMINAL_TOKENS.a1KitchenRevoked, now, "admin_revoke"),
    token(IDS.tokenA1SuspendedLive, IDS.companyA, IDS.shopA1, IDS.terminalA1Suspended, TERMINAL_TOKENS.a1SuspendedLive, now, null),
    token(IDS.tokenA2KitchenLive, IDS.companyA, IDS.shopA2, IDS.terminalA2Kitchen, TERMINAL_TOKENS.a2KitchenLive, now, null),
    token(IDS.tokenA2CounterLive, IDS.companyA, IDS.shopA2, IDS.terminalA2Counter, TERMINAL_TOKENS.a2CounterLive, now, null),
    token(IDS.tokenA3KitchenLive, IDS.companyA, IDS.shopA3, IDS.terminalA3Kitchen, TERMINAL_TOKENS.a3KitchenLive, now, null),
    token(IDS.tokenB1KitchenLive, IDS.companyB, IDS.shopB1, IDS.terminalB1Kitchen, TERMINAL_TOKENS.b1KitchenLive, now, null),
    token(IDS.tokenC1KitchenLive, IDS.companyC, IDS.shopC1, IDS.terminalC1Kitchen, TERMINAL_TOKENS.c1KitchenLive, now, null)
  ]);
}

module.exports = {
  IDS,
  FIXTURE_PASSWORD,
  FIXTURE_PASSWORD_HASH,
  SESSION_TOKENS,
  TERMINAL_TOKENS,
  PAIRING_CODE,
  seedTwoTenant
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/fixtures-two-tenant.test.js`  Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/testing/fixtures/two-tenant.js apps/core-api/test/fixtures-two-tenant.test.js
git commit -m "test(core-api): two-tenant fixture with the suspended and unassigned rows"
```

---

### Task 23: Schema invariants S1–S3 — tenant column, ownership FKs, anchors

`0001_init.sql` already exists when this task runs, so the rules cannot be driven red by the DDL. They are therefore written as four **pure predicate functions** with a permanent synthetic negative fixture each: a hand-built catalogue containing the violations the rule exists to catch, asserted to be returned. The predicates are what this task builds and what the first failing run is missing; applying them to the real catalogue is one extra line per rule.

**Files:**
- Create: `apps/core-api/test/schema-invariants.test.js`
- Test: `apps/core-api/test/schema-invariants.test.js`

- [ ] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");

// S1. Five entries, not the two the settled text names. Each one's own positive
// assertion lives in its own test below, so this is a stated shape rather than a
// hole: a Phase-2 table that omits company_id fails unless a developer
// consciously edits this list.
const TENANT_COLUMN_EXCEPTIONS = [
  "audit_events",
  "companies",
  "schema_migrations",
  "user_sessions",
  "users"
];

const CONTAINMENT_COLUMNS = ["shop_id", "terminal_id", "shop_table_id", "user_id", "pairing_code_id"];

// S2. Keyed by "<child table>.<ordered child columns>". Every entry states WHY.
const COMPOSITE_FK_EXCEPTIONS = {
  "users.created_by_user_id": "attribution, not ownership",
  "companies.created_by_user_id": "attribution, not ownership",
  "shops.created_by_user_id": "attribution, not ownership",
  "shop_tables.created_by_user_id": "attribution, not ownership",
  "user_shops.created_by_user_id": "attribution, not ownership",
  "terminals.created_by_user_id": "attribution, not ownership",
  "terminal_pairing_codes.created_by_user_id": "attribution, not ownership",
  "terminal_tokens.revoked_by_user_id": "attribution, not ownership",
  "audit_events.actor_user_id": "attribution, not ownership",
  "audit_events.actor_terminal_id":
    "attribution: references a TENANT table single-column, which needs saying out loud",
  "user_sessions.user_id": "pre-tenant: read in order to DISCOVER the tenant",
  "user_sessions.acting_company_id": "pre-tenant: read in order to DISCOVER the tenant",
  "terminal_tokens.pairing_code_id":
    "the row is already anchored by its own composite FK; making this composite needs a " +
    "4-column UNIQUE that 0001 does not create"
};

// S2b. CASCADE is permitted for exactly three FKs and nothing else.
const CASCADE_FKS = new Set([
  "user_shops.user_id,company_id",
  "user_sessions.user_id",
  "user_sessions.acting_company_id"
]);

// S3. Postgres already refuses a composite FK without a matching UNIQUE. The
// assertion with teeth is the reverse: a later migration dropping an anchor once
// its last composite FK is gone leaves the NEXT table quietly unable to declare one.
const ANCHORS = {
  users_id_company_key: ["id", "company_id"],
  shops_id_company_key: ["id", "company_id"],
  shop_tables_id_shop_company_key: ["id", "shop_id", "company_id"],
  terminals_id_shop_company_key: ["id", "shop_id", "company_id"]
};

test("S1's rule rejects a synthetic Phase-2 table that mishandles company_id", () => {
  assert.deepEqual(
    tablesMissingTenantColumn({
      companies: { id: { type: "uuid", notNull: true, isPrimaryKey: true } },
      shops: { company_id: { type: "uuid", notNull: true } },
      menu_items: { id: { type: "uuid", notNull: true }, shop_id: { type: "uuid", notNull: true } },
      menu_photos: { company_id: { type: "uuid", notNull: false } },
      menu_prices: { company_id: { type: "text", notNull: true } }
    }),
    ["menu_items", "menu_photos", "menu_prices"]
  );
});

test("S2's rule rejects a synthetic containment FK that omits company_id", () => {
  assert.deepEqual(
    foreignKeysMissingTenantColumn([
      {
        name: "shop_tables_shop_fkey",
        key: "shop_tables.shop_id,company_id",
        childColumns: ["shop_id", "company_id"],
        deleteAction: "r"
      },
      {
        name: "menu_items_shop_fkey",
        key: "menu_items.shop_id",
        childColumns: ["shop_id"],
        deleteAction: "r"
      },
      {
        name: "menu_items_terminal_fkey",
        key: "menu_items.terminal_id",
        childColumns: ["terminal_id"],
        deleteAction: "r"
      }
    ]),
    ["menu_items_shop_fkey", "menu_items_terminal_fkey"]
  );
});

test("S2b's rule rejects SET NULL, SET DEFAULT and an unlisted CASCADE", () => {
  assert.deepEqual(
    foreignKeysWithWrongDeleteAction([
      { name: "ok_restrict", key: "shops.company_id", childColumns: ["company_id"], deleteAction: "r" },
      { name: "ok_cascade", key: "user_sessions.user_id", childColumns: ["user_id"], deleteAction: "c" },
      { name: "bad_setnull", key: "menu_items.shop_id", childColumns: ["shop_id"], deleteAction: "n" },
      { name: "bad_default", key: "menu_items.user_id", childColumns: ["user_id"], deleteAction: "d" },
      { name: "bad_cascade", key: "menu_items.company_id", childColumns: ["company_id"], deleteAction: "c" }
    ]),
    ["bad_cascade:c", "bad_default:d", "bad_setnull:n"]
  );
});

test("S3's rule rejects a dropped anchor and a reshaped one", () => {
  assert.deepEqual(
    reshapedAnchors({
      users_id_company_key: ["id", "company_id"],
      shops_id_company_key: ["id", "company_id"],
      terminals_id_shop_company_key: ["id", "company_id"]
    }),
    ["shop_tables_id_shop_company_key", "terminals_id_shop_company_key"]
  );
});

describe("schema invariants", { skip: skipDatabaseTests() }, () => {
  let db;
  const catalog = { tables: {}, foreignKeys: [], uniques: {}, constraintNames: new Set() };

  before(async () => {
    db = await cloneTemplate(__filename);

    const columns = await db.unscoped(`
      SELECT c.relname AS table_name,
             a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             a.attnotnull AS not_null,
             COALESCE(pk.is_pk, false) AS is_primary_key
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN LATERAL (
          SELECT true AS is_pk FROM pg_constraint pc
           WHERE pc.conrelid = c.oid AND pc.contype = 'p' AND a.attnum = ANY (pc.conkey)
        ) pk ON true
       WHERE n.nspname = 'public' AND c.relkind = 'r'`);

    for (const row of columns.rows) {
      catalog.tables[row.table_name] = catalog.tables[row.table_name] || {};
      catalog.tables[row.table_name][row.column_name] = {
        type: row.data_type,
        notNull: row.not_null,
        isPrimaryKey: row.is_primary_key
      };
    }

    const constraints = await db.unscoped(`
      SELECT con.conname,
             con.contype,
             con.confdeltype,
             child.relname AS child_table,
             (SELECT array_agg(att.attname ORDER BY u.ord)
                FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
                JOIN pg_attribute att
                  ON att.attrelid = con.conrelid AND att.attnum = u.attnum) AS child_columns
        FROM pg_constraint con
        JOIN pg_class child ON child.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = child.relnamespace
       WHERE n.nspname = 'public'`);

    for (const row of constraints.rows) {
      catalog.constraintNames.add(row.conname);
      if (row.contype === "f") {
        catalog.foreignKeys.push({
          name: row.conname,
          key: `${row.child_table}.${row.child_columns.join(",")}`,
          childTable: row.child_table,
          childColumns: row.child_columns,
          deleteAction: row.confdeltype
        });
      }
      if (row.contype === "u") catalog.uniques[row.conname] = row.child_columns;
    }
  });

  after(async () => {
    if (db) await db.end();
  });

  test("S1: every base table carries company_id uuid NOT NULL, or is a named exception", () => {
    const scanned = Object.keys(catalog.tables);
    assert.ok(scanned.length >= 11, `expected at least 11 base tables, scanned ${scanned.length}`);
    assert.deepEqual(tablesMissingTenantColumn(catalog.tables), []);
  });

  test("S1: each named exception carries its own positive assertion instead", () => {
    assert.equal(
      catalog.tables.schema_migrations.company_id,
      undefined,
      "schema_migrations must have no company_id at all"
    );

    assert.equal(catalog.tables.companies.id.type, "uuid");
    assert.equal(catalog.tables.companies.id.isPrimaryKey, true, "companies.id must be the primary key");

    assert.equal(catalog.tables.users.company_id.type, "uuid");
    assert.equal(catalog.tables.users.company_id.notNull, false, "users.company_id is nullable for platform_admin");
    assert.ok(catalog.constraintNames.has("users_platform_admin_has_no_company"));

    assert.equal(catalog.tables.user_sessions.acting_company_id.type, "uuid");
    assert.equal(catalog.tables.user_sessions.acting_company_id.notNull, false);

    assert.equal(catalog.tables.audit_events.company_id.type, "uuid");
    assert.equal(catalog.tables.audit_events.company_id.notNull, false);
    assert.ok(catalog.constraintNames.has("audit_events_shop_implies_company"));

    // The exception list itself cannot rot into naming tables that no longer exist.
    for (const table of TENANT_COLUMN_EXCEPTIONS) {
      assert.ok(catalog.tables[table], `the exception list names a table that does not exist: ${table}`);
    }
  });

  test("S2: every containment foreign key includes company_id", () => {
    assert.ok(catalog.foreignKeys.length >= 20, "the FK query returned implausibly few rows");
    assert.deepEqual(foreignKeysMissingTenantColumn(catalog.foreignKeys), []);

    const observed = new Set(catalog.foreignKeys.map((fk) => fk.key));
    for (const key of Object.keys(COMPOSITE_FK_EXCEPTIONS)) {
      assert.ok(observed.has(key), `the exception list names a foreign key that does not exist: ${key}`);
    }
  });

  test("S2b: no SET NULL or SET DEFAULT, and CASCADE only on the three named keys", () => {
    assert.deepEqual(foreignKeysWithWrongDeleteAction(catalog.foreignKeys), []);

    for (const key of CASCADE_FKS) {
      assert.ok(
        catalog.foreignKeys.some((fk) => fk.key === key),
        `the CASCADE allowlist names a foreign key that does not exist: ${key}`
      );
    }
  });

  test("S3: the four composite anchors exist by name with exact column lists", () => {
    assert.deepEqual(reshapedAnchors(catalog.uniques), []);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/schema-invariants.test.js`
Expected: FAIL with `ReferenceError: tablesMissingTenantColumn is not defined`

- [ ] **Step 3: Write the minimal implementation**

Append the four predicates to `apps/core-api/test/schema-invariants.test.js`. They are function declarations, so they are in scope for the tests above.

```js
// --- the rules themselves, as pure predicates over an introspected catalogue.
// Each returns the SORTED list of offenders, so a failure prints what is wrong
// rather than "expected true to be false".

function tablesMissingTenantColumn(tables) {
  return Object.keys(tables)
    .filter((table) => !TENANT_COLUMN_EXCEPTIONS.includes(table))
    .filter((table) => {
      const column = tables[table].company_id;
      return !column || column.type !== "uuid" || column.notNull !== true;
    })
    .sort();
}

function foreignKeysMissingTenantColumn(foreignKeys) {
  return foreignKeys
    .filter((fk) => !COMPOSITE_FK_EXCEPTIONS[fk.key])
    .filter((fk) => fk.childColumns.some((column) => CONTAINMENT_COLUMNS.includes(column)))
    .filter((fk) => !fk.childColumns.includes("company_id"))
    .map((fk) => fk.name)
    .sort();
}

function foreignKeysWithWrongDeleteAction(foreignKeys) {
  // 'r' RESTRICT everywhere, 'c' CASCADE only on the allowlist. 'n' (SET NULL)
  // and 'd' (SET DEFAULT) are impossible by construction on a composite FK whose
  // company_id is NOT NULL, and are a silent history rewrite on a single-column one.
  return foreignKeys
    .filter((fk) => fk.deleteAction !== (CASCADE_FKS.has(fk.key) ? "c" : "r"))
    .map((fk) => `${fk.name}:${fk.deleteAction}`)
    .sort();
}

function reshapedAnchors(uniques) {
  return Object.keys(ANCHORS)
    .filter((name) => JSON.stringify(uniques[name]) !== JSON.stringify(ANCHORS[name]))
    .sort();
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/schema-invariants.test.js`  Expected: PASS (9 tests; under `CORE_API_SKIP_DB_TESTS=1` the four pure ones pass and the five database-backed ones report as visible TAP skips)

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/test/schema-invariants.test.js
git commit -m "test(core-api): assert tenant columns, composite FKs and anchors (S1-S3)"
```

---

### Task 24: Schema invariants S4–S7 — digests, triggers, ledger, no plaintext columns

**Files:**
- Modify: `apps/core-api/test/schema-invariants.test.js` (append; extend the `require`)
- Test: `apps/core-api/test/schema-invariants.test.js`

- [ ] **Step 1: Write the failing test**

First, insert these four tests **inside the existing `describe("schema invariants", …)` block, immediately before its closing `});`**:

```js
  test("S4: every %_hash column is bytea(32), except the one that carries a PHC string", async () => {
    const { rows } = await db.unscoped(`
      SELECT c.relname AS table_name,
             a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             COALESCE(string_agg(pg_get_constraintdef(con.oid), ' '), '') AS checks
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_constraint con
          ON con.conrelid = c.oid AND con.contype = 'c' AND a.attnum = ANY (con.conkey)
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname LIKE '%\\_hash'
       GROUP BY c.relname, a.attname, a.atttypid, a.atttypmod`);

    const columns = rows.map((row) => ({
      table: row.table_name,
      column: row.column_name,
      type: row.data_type,
      checks: row.checks
    }));

    assert.ok(columns.length >= 4, `expected at least four %_hash columns, found ${columns.length}`);
    assert.deepEqual(hashColumnViolations(columns), []);

    for (const key of TEXT_HASH_EXCEPTIONS) {
      assert.ok(
        columns.some((column) => `${column.table}.${column.column}` === key),
        `the text-hash exception names a column that does not exist: ${key}`
      );
    }
  });

  test("S5: every table with updated_at has a BEFORE UPDATE set_updated_at() trigger", async () => {
    const { rows } = await db.unscoped(`
      SELECT c.relname AS table_name, pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal`);

    const triggers = {};
    for (const row of rows) {
      if (!triggers[row.table_name]) triggers[row.table_name] = [];
      triggers[row.table_name].push(row.definition);
    }

    // Conditional on the column, so the rule self-maintains as tables come and go.
    const withUpdatedAt = Object.keys(catalog.tables).filter((table) => catalog.tables[table].updated_at);
    assert.ok(withUpdatedAt.length >= 5, `implausibly few tables carry updated_at: ${withUpdatedAt.length}`);

    assert.deepEqual(tablesMissingUpdatedAtTrigger(catalog.tables, triggers), []);
  });

  test("S6: the migration ledger agrees, as a set, with the migrations directory", async () => {
    const { rows } = await db.unscoped(
      "SELECT filename, encode(checksum, 'hex') AS checksum FROM schema_migrations"
    );

    assert.deepEqual(ledgerDisagreements(migrationChecksums(), rows), []);
  });

  test("S7: no column is named like a plaintext credential", () => {
    assert.deepEqual(plaintextShapedColumns(catalog.tables), []);
  });
```

Then append these four pure negative fixtures at the **end of the file**:

```js
test("S4's rule rejects a hex-text digest and a bytea column with no length CHECK", () => {
  assert.deepEqual(
    hashColumnViolations([
      {
        table: "user_sessions",
        column: "token_hash",
        type: "bytea",
        checks: "CHECK ((octet_length(token_hash) = 32))"
      },
      {
        table: "users",
        column: "password_hash",
        type: "text",
        checks: "CHECK (((password_hash ~~ 'scrypt$%'::text)))"
      },
      { table: "menu_tokens", column: "token_hash", type: "text", checks: "" },
      { table: "menu_codes", column: "code_hash", type: "bytea", checks: "" }
    ]),
    ["menu_codes.code_hash", "menu_tokens.token_hash"]
  );
});

test("S5's rule rejects an AFTER trigger and a trigger calling the wrong function", () => {
  assert.deepEqual(
    tablesMissingUpdatedAtTrigger(
      {
        companies: { updated_at: { type: "timestamp with time zone" } },
        menu_items: { updated_at: { type: "timestamp with time zone" } },
        menu_photos: { updated_at: { type: "timestamp with time zone" } },
        user_shops: { created_at: { type: "timestamp with time zone" } }
      },
      {
        companies: ["CREATE TRIGGER companies_set_updated_at BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION set_updated_at()"],
        menu_items: ["CREATE TRIGGER menu_items_touch AFTER UPDATE ON public.menu_items FOR EACH ROW EXECUTE FUNCTION set_updated_at()"],
        menu_photos: ["CREATE TRIGGER menu_photos_touch BEFORE UPDATE ON public.menu_photos FOR EACH ROW EXECUTE FUNCTION audit_row()"]
      }
    ),
    ["menu_items", "menu_photos"]
  );
});

test("S6's rule reports both a file with no ledger row and a ledger row that drifted", () => {
  assert.deepEqual(
    ledgerDisagreements(
      [
        { filename: "0001_init.sql", checksum: "aa" },
        { filename: "0002_menu.sql", checksum: "bb" }
      ],
      [
        { filename: "0001_init.sql", checksum: "aa" },
        { filename: "0003_gone.sql", checksum: "cc" }
      ]
    ),
    ["disk-only 0002_menu.sql:bb", "ledger-only 0003_gone.sql:cc"]
  );
});

test("S7's rule rejects columns named like the plaintext they must never hold", () => {
  assert.deepEqual(
    plaintextShapedColumns({
      users: { password_hash: {}, email: {} },
      menu_terminals: { token: {}, code: {} },
      menu_sessions: { session_id: {}, session_token_hash: {} }
    }),
    ["menu_sessions.session_id", "menu_terminals.code", "menu_terminals.token"]
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/schema-invariants.test.js`
Expected: FAIL with `ReferenceError: hashColumnViolations is not defined`

- [ ] **Step 3: Write the minimal implementation**

Change the top-level `require` of `../testing/database` — S6 compares the ledger against the same disk-side reader the template staleness check uses, so a divergence between the two shows up here as well as in a permanent rebuild:

```js
const { cloneTemplate, migrationChecksums, skipDatabaseTests } = require("../testing/database");
```

Then append the four predicates and the one-entry exception list to the end of `apps/core-api/test/schema-invariants.test.js`:

```js
// S4. A one-entry literal, in the same style as S1: a Phase-2 %_hash column
// added as text fails unless a developer consciously edits this.
const TEXT_HASH_EXCEPTIONS = ["users.password_hash"];

function hashColumnViolations(columns) {
  return columns
    .filter((column) => {
      if (TEXT_HASH_EXCEPTIONS.includes(`${column.table}.${column.column}`)) {
        // Postgres renders LIKE as ~~ in pg_get_constraintdef, so match the literal.
        return column.type !== "text" || !/'scrypt\$%'/.test(column.checks);
      }
      return (
        column.type !== "bytea" ||
        !column.checks.includes(`octet_length(${column.column}) = 32`)
      );
    })
    .map((column) => `${column.table}.${column.column}`)
    .sort();
}

function tablesMissingUpdatedAtTrigger(tables, triggers) {
  return Object.keys(tables)
    .filter((table) => tables[table].updated_at)
    .filter(
      (table) =>
        !(triggers[table] || []).some(
          (definition) =>
            /BEFORE UPDATE ON /.test(definition) &&
            /EXECUTE FUNCTION set_updated_at\(\)/.test(definition)
        )
    )
    .sort();
}

function ledgerDisagreements(diskRows, ledgerRows) {
  const keys = (rows) => rows.map((row) => `${row.filename}:${row.checksum}`);
  const disk = keys(diskRows);
  const ledger = keys(ledgerRows);
  return [
    ...disk.filter((key) => !ledger.includes(key)).map((key) => `disk-only ${key}`),
    ...ledger.filter((key) => !disk.includes(key)).map((key) => `ledger-only ${key}`)
  ].sort();
}

// S7. Exact names only: password_hash and token_hash are the shapes this schema
// wants, and a substring rule would forbid them.
const PLAINTEXT_COLUMN_NAMES = ["password", "token", "code", "secret", "session_id"];

function plaintextShapedColumns(tables) {
  const found = [];
  for (const table of Object.keys(tables)) {
    for (const column of Object.keys(tables[table])) {
      if (PLAINTEXT_COLUMN_NAMES.includes(column)) found.push(`${table}.${column}`);
    }
  }
  return found.sort();
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/schema-invariants.test.js`  Expected: PASS (17 tests; 8 pure, 9 database-backed)

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/test/schema-invariants.test.js
git commit -m "test(core-api): assert digests, triggers, ledger and column names (S4-S7)"
```

---

### Task 25: The source walker, its two meta-tests, and C1

Two correctness requirements. **(1)** The walker builds every relative path from `/` literals, never `path.sep` — on win32 `startsWith("db/")` would match nothing, every rule would pass vacuously, and the suite would be green and worthless. **(2)** The suite asserts it scanned a plausible count and that three known sentinels at three directory depths are in the scanned set.

Every rule below is registered through `rule()`, which stores one fixture the regex **must** match and one comment-only fixture it **must not**. A single meta-test drives them all, so a rule whose regex is wrong fails immediately instead of passing vacuously forever — including the rules whose real target set is still empty in Plan 1.

**Files:**
- Modify: `apps/core-api/test/source-structure.test.js` (append)
- Test: `apps/core-api/test/source-structure.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/source-structure.test.js`. `assert`, `fs`, `path`, `test`, `appRoot`, `repoRoot` and `readText` are already in scope from scaffold-config's header — nothing here re-requires or redeclares them.

```js
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/source-structure.test.js`
Expected: FAIL with `ReferenceError: SOURCE_FILES is not defined`

- [ ] **Step 3: Write the minimal implementation**

Insert this block **immediately above the three tests appended in the previous step**, still inside `apps/core-api/test/source-structure.test.js`:

```js
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/source-structure.test.js`  Expected: PASS — scaffold-config's existing tests plus the three added here

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/test/source-structure.test.js
git commit -m "test(core-api): source walker with separator normalisation and rule self-tests"
```

---

### Task 26: C2–C5 — query surface, express, unscoped callers, cross-tenant needle

**Files:**
- Modify: `apps/core-api/test/source-structure.test.js` (append)
- Test: `apps/core-api/test/source-structure.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/source-structure.test.js`:

```js
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/source-structure.test.js`
Expected: FAIL with `ReferenceError: RAW_QUERY is not defined`

- [ ] **Step 3: Write the minimal implementation**

Insert this block **immediately above the four tests appended in the previous step**:

```js
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/source-structure.test.js`  Expected: PASS — the previous tests plus the four added here

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/test/source-structure.test.js
git commit -m "test(core-api): enforce query, express and unscoped-caller boundaries (C2-C5)"
```

---

### Task 27: C6–C9 — exempt-zone budget, credential channels, env fallbacks, lib purity

**Files:**
- Modify: `apps/core-api/test/source-structure.test.js` (append)
- Test: `apps/core-api/test/source-structure.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/source-structure.test.js`:

```js
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/source-structure.test.js`
Expected: FAIL with `ReferenceError: PLATFORM_EXPORTS is not defined`

- [ ] **Step 3: Write the minimal implementation**

Insert this block **immediately above the five tests appended in the previous step**:

```js
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/source-structure.test.js`  Expected: PASS — the previous tests plus the five added here, one of which reports `# SKIP repositories/platform/ does not exist yet`

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/test/source-structure.test.js
git commit -m "test(core-api): budget the exempt zone and enforce lib purity (C6-C9)"
```

---

### Task 28: C10 and C13 — migration hygiene and test-directory hygiene

C11 (root `scripts.test` names `apps/core-api`) and C12 (`/.gitattributes` and `/.dockerignore`) are already asserted by scaffold-config in this same file, and scaffold-config owns those three repo-root files. Nothing here creates or edits them.

**Files:**
- Modify: `apps/core-api/test/source-structure.test.js` (append)
- Test: `apps/core-api/test/source-structure.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/source-structure.test.js`:

```js
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/source-structure.test.js`
Expected: FAIL with `ReferenceError: DESTRUCTIVE_DDL is not defined`

- [ ] **Step 3: Write the minimal implementation**

Insert this block **immediately above the two tests appended in the previous step**:

```js
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/source-structure.test.js`  Expected: PASS — the previous tests plus the two added here

Then confirm the whole wiring from the repository root: `npm test` — Expected: PASS, ending with the core-api suites (scaffold-config already added `npm --prefix apps/core-api test` to the root `scripts.test`).

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/test/source-structure.test.js
git commit -m "test(core-api): migration hygiene and test-directory rules (C10, C13)"
```

---

## Part 4 — The database choke point

The whole point of this area is that a repository author **cannot write a query that reads or writes
another tenant's rows even by accident**. Five files carry that: `errors.js` fixes the vocabulary the
choke point may throw with, `scope.js` makes a scope unforgeable, `pool.js` is the only place `pg` is
named, `index.js` is the single seam every statement passes through, `health.js` is the only thing
allowed to say whether that seam is usable.

Every `Run:` line below is executed **from the repository root**. The direct `node --test <file>` form
is deliberate: `apps/core-api/package.json` declares `"pretest": "node scripts/setup-template-db.js"`,
and that script does not exist until the test-harness area, so the `npm --prefix` form would abort in
`pretest` instead of producing the failure each step states.

Two tasks in this area (`db/index.js` — pg-error translation, and `db/health.js` — `checkReadiness()`)
require files another area creates. Each carries a **Sequencing** line naming exactly what must exist
first; if the concatenated plan lists them earlier than that, move those two tasks after the task that
creates the dependency. Nothing else in this area depends on another area.

---

### Task 29: `db/errors.js` — `ApiError` and the fixed code vocabulary

**Files:**
- Create: `apps/core-api/db/errors.js`
- Test: `apps/core-api/test/errors.test.js`

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/errors.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const { ApiError, TOP_LEVEL_ERROR_CODES, FIELD_ERROR_CODES } = require("../db/errors");

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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/errors.test.js`
Expected: FAIL with `Error: Cannot find module '../db/errors'`

- [ ] **Step 3: Write the minimal implementation**

Create `apps/core-api/db/errors.js`:

```js
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

module.exports = { ApiError, TOP_LEVEL_ERROR_CODES, FIELD_ERROR_CODES };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/errors.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/errors.js apps/core-api/test/errors.test.js
git commit -m "feat(core-api): add ApiError and the fixed error code vocabulary"
```

---

### Task 30: `db/errors.js` — `pgErrorToHttp(sqlstate)`

**Files:**
- Modify: `apps/core-api/db/errors.js` (insert one block above `module.exports`, then replace the export line)
- Test: `apps/core-api/test/errors.test.js` (change the require line, append four tests)

- [ ] **Step 1: Write the failing test**

Change the first `require` line of `apps/core-api/test/errors.test.js` to:

```js
const { ApiError, pgErrorToHttp, TOP_LEVEL_ERROR_CODES, FIELD_ERROR_CODES } = require("../db/errors");
```

and append to the end of the file:

```js
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/errors.test.js`
Expected: FAIL with `TypeError: pgErrorToHttp is not a function`

- [ ] **Step 3: Write the minimal implementation**

In `apps/core-api/db/errors.js`, insert this block immediately above `module.exports`:

```js
// Leak prevention, mechanism 3 (§6.3.6): pg errors are mapped by SQLSTATE only.
// `null`            -> no fixed mapping; the top-level handler answers 500 internal_error.
// `{ code: null }`  -> 409, but the code must come from the call site's `conflicts`
//                      map keyed by err.constraint. The constraint name is an
//                      internal lookup key and is never serialised.
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
```

and replace the export line with:

```js
module.exports = { ApiError, pgErrorToHttp, TOP_LEVEL_ERROR_CODES, FIELD_ERROR_CODES };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/errors.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/errors.js apps/core-api/test/errors.test.js
git commit -m "feat(core-api): map pg SQLSTATEs to HTTP without copying driver text"
```

---

### Task 31: `db/scope.js` — `createScope()`

**Files:**
- Create: `apps/core-api/db/scope.js`
- Test: `apps/core-api/test/scope.test.js`

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/scope.test.js`. Note the whole-scope comparisons use
`Object.fromEntries(Object.entries(scope))` and not `{ ...scope }`: `node:assert/strict` compares own
**enumerable symbol** keys too, and the scope carries exactly such a stamp, so the spread form would
fail against the very implementation this task ships.

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const { createScope } = require("../db/scope");

const P_ADMIN = "11111111-1111-4111-8111-111111111111";
const A_ADMIN = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const COMPANY_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SHOP_A1 = "aaaaaaaa-0000-4000-8000-000000000011";
const SHOP_A3 = "aaaaaaaa-0000-4000-8000-000000000013";
const TERMINAL = "cccccccc-0000-4000-8000-000000000001";
const TOKEN = "dddddddd-0000-4000-8000-000000000001";

// Object.entries drops symbol keys, which is what lets a whole-scope comparison
// ignore the private stamp without making the stamp non-enumerable.
function plain(scope) {
  return Object.fromEntries(Object.entries(scope));
}

test("an unscoped platform admin gets a platform scope and nothing tenant-shaped", () => {
  const scope = createScope({ kind: "platform", userId: P_ADMIN, sessionId: SESSION });

  assert.deepEqual(plain(scope), { kind: "platform", userId: P_ADMIN, sessionId: SESSION });
  assert.equal(scope.companyId, undefined);
  assert.equal(scope.shopIds, undefined);
});

test("a scoped platform admin materialises rank-3 tenant keys", () => {
  const scope = createScope({
    kind: "tenant",
    userId: P_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "platform_admin",
    shopIds: [SHOP_A1],
    administeredShopIds: [SHOP_A1, SHOP_A3]
  });

  assert.equal(scope.role, "platform_admin");
  assert.deepEqual(scope.shopIds, [SHOP_A1]);
  assert.deepEqual(scope.administeredShopIds, [SHOP_A1, SHOP_A3]);
  assert.equal(scope.auditCrossTenant, true);
});

test("a company admin carries administeredShopIds; a manager and staff carry none", () => {
  // administeredShopIds is what makes suspension reversible: a suspended shop
  // vanishes from its manager's world while staying reachable by the admin who
  // has to un-suspend it.
  const admin = createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "company_admin",
    shopIds: [SHOP_A1],
    administeredShopIds: [SHOP_A1, SHOP_A3]
  });
  assert.deepEqual(admin.administeredShopIds, [SHOP_A1, SHOP_A3]);
  assert.equal(admin.auditCrossTenant, undefined);

  const manager = createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "shop_manager",
    shopIds: [SHOP_A1]
  });
  assert.equal("administeredShopIds" in manager, false);

  assert.throws(
    () =>
      createScope({
        kind: "tenant",
        userId: A_ADMIN,
        sessionId: SESSION,
        companyId: COMPANY_A,
        role: "staff",
        shopIds: [SHOP_A1],
        administeredShopIds: [SHOP_A1]
      }),
    /a staff scope carries no administeredShopIds/
  );
});

test("an empty assignment set is a real empty array, never null and never undefined", () => {
  // array_agg over zero rows returns NULL. Coalescing it here as well as in SQL
  // is what stops a just-revoked staff user getting a company-admin-shaped scope:
  // otherwise revocation escalates privilege.
  for (const supplied of [[], null, undefined]) {
    const scope = createScope({
      kind: "tenant",
      userId: A_ADMIN,
      sessionId: SESSION,
      companyId: COMPANY_A,
      role: "staff",
      shopIds: supplied
    });
    assert.ok(Array.isArray(scope.shopIds), `shopIds for ${JSON.stringify(supplied)}`);
    assert.deepEqual(scope.shopIds, []);
  }
});

test("a terminal scope turns the singular shopId into a one-element shopIds", () => {
  // The singular->plural conversion happens exactly here. A scope carrying
  // shopId alone leaves scope.shopIds undefined, `?? null` binds $2 = NULL, and
  // a correctly paired kitchen tablet at shop A1 is served shop A2's data.
  const scope = createScope({
    kind: "terminal",
    companyId: COMPANY_A,
    shopId: SHOP_A1,
    terminalId: TERMINAL,
    terminalKind: "kitchen_display",
    tokenId: TOKEN
  });

  assert.deepEqual(plain(scope), {
    kind: "terminal",
    companyId: COMPANY_A,
    shopIds: [SHOP_A1],
    terminalId: TERMINAL,
    terminalKind: "kitchen_display",
    tokenId: TOKEN
  });
  assert.equal(scope.userId, undefined);
});

test("every scope and every array inside it is frozen", () => {
  const scope = createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "company_admin",
    shopIds: [SHOP_A1],
    administeredShopIds: [SHOP_A1]
  });

  assert.ok(Object.isFrozen(scope));
  assert.ok(Object.isFrozen(scope.shopIds));
  assert.ok(Object.isFrozen(scope.administeredShopIds));
  assert.throws(() => scope.shopIds.push(SHOP_A3), TypeError);
});

test("createScope rejects malformed input instead of emitting a half-scope", () => {
  assert.throws(() => createScope(null), /createScope requires an object/);
  assert.throws(() => createScope({ kind: "everything" }), /unknown scope kind "everything"/);
  assert.throws(() => createScope({ kind: "platform", userId: "nope", sessionId: SESSION }), /userId must be a uuid/);
  assert.throws(
    () =>
      createScope({
        kind: "tenant",
        userId: A_ADMIN,
        sessionId: SESSION,
        companyId: COMPANY_A,
        role: "owner",
        shopIds: []
      }),
    /unknown role "owner"/
  );
  assert.throws(
    () =>
      createScope({
        kind: "tenant",
        userId: A_ADMIN,
        sessionId: SESSION,
        companyId: COMPANY_A,
        role: "staff",
        shopIds: SHOP_A1
      }),
    /shopIds must be an array of uuids/
  );
  assert.throws(
    () =>
      createScope({
        kind: "tenant",
        userId: A_ADMIN,
        sessionId: SESSION,
        companyId: COMPANY_A,
        role: "staff",
        shopIds: [SHOP_A1, "not-a-uuid"]
      }),
    /shopIds\[1\] must be a uuid/
  );
  assert.throws(
    () =>
      createScope({
        kind: "terminal",
        companyId: COMPANY_A,
        shopId: SHOP_A1,
        terminalId: TERMINAL,
        terminalKind: "printer",
        tokenId: TOKEN
      }),
    /unknown terminalKind "printer"/
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/scope.test.js`
Expected: FAIL with `Error: Cannot find module '../db/scope'`

- [ ] **Step 3: Write the minimal implementation**

Create `apps/core-api/db/scope.js`. The stamp must stay an **own, enumerable** Symbol: the next task's
`assertTenantScope` tests build stamped-but-broken fixtures with `{ ...tenantScope() }`, and a
non-enumerable stamp would not survive the spread, silently turning those tests into dead code.

```js
// PURE (Tier 1). No database, no filesystem, no network, no clock.
//
// A scope is the materialised answer to "who is calling and what may they
// touch", derived from the credential and never from a request. There is no
// "null means all" sentinel anywhere in this file: every tenant scope carries a
// real uuid[] of shop ids, because the two ways that rule has been broken in
// review are both fail-OPEN.

// Module-private on purpose: nothing outside this file can mint the stamp, so
// assertTenantScope() can tell a scope from a plain object that looks like one.
// It is an own ENUMERABLE symbol, so `{ ...scope }` copies it — which is what
// lets a test build a stamped-but-broken scope and prove the assertions bite.
const SCOPE_STAMP = Symbol("core-api.scope");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ROLES = ["platform_admin", "company_admin", "shop_manager", "staff"];
// The two roles whose world includes suspended shops.
const ADMINISTERED_ROLES = ["platform_admin", "company_admin"];
const TERMINAL_KINDS = ["kitchen_display", "cashier_counter", "epaper_hub"];

function requireUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`createScope: ${label} must be a uuid (got ${JSON.stringify(value ?? null)})`);
  }
  return value;
}

// COALESCE(array_agg(...), '{}') in JavaScript. Absent means empty, never "all".
function requireUuidArray(value, label) {
  if (value === null || value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new Error(`createScope: ${label} must be an array of uuids (got ${JSON.stringify(value)})`);
  }
  return Object.freeze(value.map((entry, index) => requireUuid(entry, `${label}[${index}]`)));
}

function createPlatformScope(input) {
  return Object.freeze({
    [SCOPE_STAMP]: true,
    kind: "platform",
    userId: requireUuid(input.userId, "userId"),
    sessionId: requireUuid(input.sessionId, "sessionId")
  });
}

function createTenantScope(input) {
  const role = input.role;
  if (!TENANT_ROLES.includes(role)) {
    throw new Error(`createScope: unknown role ${JSON.stringify(role ?? null)}`);
  }

  const scope = {
    [SCOPE_STAMP]: true,
    kind: "tenant",
    userId: requireUuid(input.userId, "userId"),
    sessionId: requireUuid(input.sessionId, "sessionId"),
    companyId: requireUuid(input.companyId, "companyId"),
    role,
    shopIds: requireUuidArray(input.shopIds, "shopIds")
  };

  if (ADMINISTERED_ROLES.includes(role)) {
    scope.administeredShopIds = requireUuidArray(input.administeredShopIds, "administeredShopIds");
  } else if (input.administeredShopIds !== undefined) {
    throw new Error(`createScope: a ${role} scope carries no administeredShopIds`);
  }

  // A platform admin acting inside a company is still crossing a tenant
  // boundary, and the audit trail has to say so.
  if (role === "platform_admin") scope.auditCrossTenant = true;

  return Object.freeze(scope);
}

function createTerminalScope(input) {
  if (!TERMINAL_KINDS.includes(input.terminalKind)) {
    throw new Error(`createScope: unknown terminalKind ${JSON.stringify(input.terminalKind ?? null)}`);
  }
  return Object.freeze({
    [SCOPE_STAMP]: true,
    kind: "terminal",
    companyId: requireUuid(input.companyId, "companyId"),
    shopIds: Object.freeze([requireUuid(input.shopId, "shopId")]),
    terminalId: requireUuid(input.terminalId, "terminalId"),
    terminalKind: input.terminalKind,
    tokenId: requireUuid(input.tokenId, "tokenId")
  });
}

function createScope(input) {
  if (input === null || typeof input !== "object") {
    throw new Error("createScope requires an object");
  }
  switch (input.kind) {
    case "platform":
      return createPlatformScope(input);
    case "tenant":
      return createTenantScope(input);
    case "terminal":
      return createTerminalScope(input);
    default:
      throw new Error(`createScope: unknown scope kind ${JSON.stringify(input.kind ?? null)}`);
  }
}

module.exports = { createScope };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/scope.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/scope.js apps/core-api/test/scope.test.js
git commit -m "feat(core-api): materialise tenant scopes with no null-means-all sentinel"
```

---

### Task 32: `db/scope.js` — `assertTenantScope()`

**Files:**
- Modify: `apps/core-api/db/scope.js` (insert one function above `module.exports`, then replace the export line)
- Test: `apps/core-api/test/scope.test.js` (change the require line, append six tests)

- [ ] **Step 1: Write the failing test**

Change the `require` line of `apps/core-api/test/scope.test.js` to:

```js
const { createScope, assertTenantScope } = require("../db/scope");
```

and append to the end of the file:

```js
function tenantScope(overrides = {}) {
  return createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "shop_manager",
    shopIds: [SHOP_A1],
    ...overrides
  });
}

test("assertTenantScope returns the scope it was given", () => {
  const scope = tenantScope();
  assert.equal(assertTenantScope(scope), scope);
  assert.equal(
    assertTenantScope(
      createScope({
        kind: "terminal",
        companyId: COMPANY_A,
        shopId: SHOP_A1,
        terminalId: TERMINAL,
        terminalKind: "kitchen_display",
        tokenId: TOKEN
      })
    ).kind,
    "terminal"
  );
});

test("an unstamped look-alike is refused", () => {
  // A plain object with every right key is exactly what a well-meaning
  // refactor produces, and it is the shape that lets a caller choose its own
  // company id.
  const forged = {
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "shop_manager",
    shopIds: [SHOP_A1]
  };
  assert.throws(() => assertTenantScope(forged), /was not produced by createScope/);
  assert.throws(() => assertTenantScope(null), /tenant scope is required/);
  assert.throws(() => assertTenantScope("company-a"), /tenant scope is required/);
});

test("a stamped scope with shopIds removed is refused", () => {
  // Spreading copies the private symbol, so this really is a stamped object —
  // which is the only way to prove the shopIds check is not dead code.
  const broken = { ...tenantScope() };
  delete broken.shopIds;
  assert.throws(() => assertTenantScope(broken), /is missing shopIds/);

  const nulled = { ...tenantScope(), shopIds: null };
  assert.throws(() => assertTenantScope(nulled), /is missing shopIds/);
});

test("a company admin or scoped platform admin without administeredShopIds is refused", () => {
  const admin = { ...tenantScope({ role: "company_admin", administeredShopIds: [SHOP_A1] }) };
  delete admin.administeredShopIds;
  assert.throws(() => assertTenantScope(admin), /is missing administeredShopIds/);

  const platform = { ...tenantScope({ role: "platform_admin", administeredShopIds: [SHOP_A1] }) };
  delete platform.administeredShopIds;
  assert.throws(() => assertTenantScope(platform), /is missing administeredShopIds/);
});

test("a platform scope cannot drive a tenant query", () => {
  const scope = createScope({ kind: "platform", userId: P_ADMIN, sessionId: SESSION });
  assert.throws(() => assertTenantScope(scope), /select a company first/);
});

test("a stamped scope with no companyId is refused", () => {
  const broken = { ...tenantScope() };
  delete broken.companyId;
  assert.throws(() => assertTenantScope(broken), /is missing companyId/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/scope.test.js`
Expected: FAIL with `TypeError: assertTenantScope is not a function`

- [ ] **Step 3: Write the minimal implementation**

In `apps/core-api/db/scope.js`, insert this function immediately above `module.exports`. It reads the
same module-private `SCOPE_STAMP`, which is why the stamp cannot be moved or made non-enumerable
without breaking the fixtures above.

```js
// The last gate before any SQL is bound. Every condition here is a failure mode
// that has actually appeared in review, and every one of them fails OPEN if it
// is missing — which is why this is a throw and never a default.
function assertTenantScope(scope) {
  if (scope === null || typeof scope !== "object") {
    throw new Error("tenant scope is required");
  }
  if (scope[SCOPE_STAMP] !== true) {
    throw new Error("tenant scope was not produced by createScope()");
  }
  if (scope.kind === "platform") {
    throw new Error("a platform scope cannot drive a tenant query; select a company first");
  }
  if (typeof scope.companyId !== "string" || scope.companyId === "") {
    throw new Error("tenant scope is missing companyId");
  }
  if (!Array.isArray(scope.shopIds)) {
    throw new Error("tenant scope is missing shopIds; an absent set is [], never null");
  }
  if (ADMINISTERED_ROLES.includes(scope.role) && !Array.isArray(scope.administeredShopIds)) {
    throw new Error(`a ${scope.role} scope is missing administeredShopIds`);
  }
  return scope;
}
```

and replace the export line with:

```js
module.exports = { createScope, assertTenantScope };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/scope.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/scope.js apps/core-api/test/scope.test.js
git commit -m "feat(core-api): refuse unstamped and incomplete tenant scopes"
```

---

### Task 33: `db/pool.js` — the only file that requires `pg`

**Files:**
- Create: `apps/core-api/db/pool.js`
- Test: `apps/core-api/test/db-index.test.js`

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/db-index.test.js`. Later tasks append to this same file; nothing here
touches a database, so it runs with no environment variables set.

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const pool = require("../db/pool");

// A DSN that is never dialled: pg's Pool constructor opens no socket until a
// client is requested, so these cases need no database.
const UNUSED_DSN = "postgres://core_api_app:pw@127.0.0.1:5432/core_api_unused";

test("db/pool.js exports functions only, never a Pool", () => {
  // Handing a Pool out is how pool.query() spreads: one connection per call,
  // so a later SET app.company_id and its SELECT land on different backends.
  for (const [name, value] of Object.entries(pool)) {
    assert.equal(typeof value, "function", `${name} must be a function`);
  }
  assert.equal(pool.Pool, undefined);
});

test("the runtime pool validates its arguments and refuses to open twice", async () => {
  assert.equal(pool.isRuntimePoolOpen(), false);
  assert.deepEqual(pool.runtimePoolStats(), { totalCount: 0, idleCount: 0, waitingCount: 0 });

  assert.throws(() => pool.openRuntimePool({ connectionString: "", max: 4 }), /connectionString/);
  assert.throws(() => pool.openRuntimePool({ connectionString: UNUSED_DSN, max: 0 }), /max/);
  assert.throws(() => pool.openRuntimePool({ connectionString: UNUSED_DSN, max: 2.5 }), /max/);

  pool.openRuntimePool({ connectionString: UNUSED_DSN, max: 4 });
  assert.equal(pool.isRuntimePoolOpen(), true);
  assert.throws(() => pool.openRuntimePool({ connectionString: UNUSED_DSN, max: 4 }), /already open/);

  await pool.closeAllPools();
  assert.equal(pool.isRuntimePoolOpen(), false);
});

test("acquiring from a closed pool is an error, not a hang", async () => {
  await assert.rejects(() => pool.acquireRuntimeClient(), /runtime pool is not open/);
  await assert.rejects(() => pool.acquireMigrationClient(), /migration pool is not open/);
});

test("the migration pool opens separately and closes independently", async () => {
  // It is max:1 and ended before listen(): an idle owner-role connection held
  // for the process lifetime is a standing capability with no user.
  pool.openMigrationPool({ connectionString: UNUSED_DSN });
  assert.throws(() => pool.openMigrationPool({ connectionString: UNUSED_DSN }), /already open/);
  await pool.closeMigrationPool();
  pool.openMigrationPool({ connectionString: UNUSED_DSN });
  await pool.closeAllPools();
});

test("closing an unopened pool is a no-op, so the fatal-exit path cannot throw", async () => {
  await pool.closeAllPools();
  await pool.closeMigrationPool();
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/db-index.test.js`
Expected: FAIL with `Error: Cannot find module '../db/pool'`

- [ ] **Step 3: Write the minimal implementation**

Create `apps/core-api/db/pool.js`:

```js
// The ONLY file in the service that may require("pg"), and it never exports a
// Pool. Everything else goes through db/index.js, which is what makes "one
// statement, one connection, one transaction, one company_id" enforceable.
// Structural test C1 asserts this file is the entire require("pg") caller set.
const { Pool } = require("pg");

// Named in pg_stat_activity, so an operator can tell a stuck migration from a
// stuck request without guessing.
const RUNTIME_APPLICATION_NAME = "core-api";
const MIGRATION_APPLICATION_NAME = "core-api-migrate";

let runtimePool = null;
let migrationPool = null;

function requireDsn(connectionString, caller) {
  if (typeof connectionString !== "string" || connectionString === "") {
    throw new Error(`${caller} requires a non-empty connectionString`);
  }
  return connectionString;
}

function openRuntimePool(options) {
  if (runtimePool !== null) throw new Error("the runtime pool is already open");
  const connectionString = requireDsn(options && options.connectionString, "openRuntimePool");
  const max = options.max;
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`openRuntimePool requires an integer max >= 1 (got ${String(max)})`);
  }

  runtimePool = new Pool({
    connectionString,
    max,
    application_name: RUNTIME_APPLICATION_NAME,
    // A checkout that cannot be satisfied must fail rather than queue forever;
    // the caller turns that into 503, which is a truthful answer.
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000
  });
  // A pg Pool emits 'error' for a client that dies while idle. Unhandled, that
  // event is an uncaught exception that kills the process every time Postgres
  // restarts underneath us.
  runtimePool.on("error", (error) => {
    console.error(`core-api: idle database client error (${error.code || error.message})`);
  });
}

function isRuntimePoolOpen() {
  return runtimePool !== null;
}

async function acquireRuntimeClient() {
  if (runtimePool === null) throw new Error("the runtime pool is not open");
  return runtimePool.connect();
}

// The connection-leak guard reads this: a repository that throws without
// releasing is a slow production death no functional assertion notices.
function runtimePoolStats() {
  if (runtimePool === null) return { totalCount: 0, idleCount: 0, waitingCount: 0 };
  return {
    totalCount: runtimePool.totalCount,
    idleCount: runtimePool.idleCount,
    waitingCount: runtimePool.waitingCount
  };
}

function openMigrationPool(options) {
  if (migrationPool !== null) throw new Error("the migration pool is already open");
  const connectionString = requireDsn(options && options.connectionString, "openMigrationPool");
  // max: 1 because the runner holds a SESSION-level advisory lock; a second
  // connection would not hold it and could apply files behind the first.
  migrationPool = new Pool({
    connectionString,
    max: 1,
    application_name: MIGRATION_APPLICATION_NAME,
    connectionTimeoutMillis: 2000
  });
  migrationPool.on("error", (error) => {
    console.error(`core-api: idle migration client error (${error.code || error.message})`);
  });
}

async function acquireMigrationClient() {
  if (migrationPool === null) throw new Error("the migration pool is not open");
  return migrationPool.connect();
}

async function closeMigrationPool() {
  if (migrationPool === null) return;
  const closing = migrationPool;
  migrationPool = null;
  await closing.end();
}

async function closeAllPools() {
  await closeMigrationPool();
  if (runtimePool === null) return;
  const closing = runtimePool;
  runtimePool = null;
  await closing.end();
}

module.exports = {
  openRuntimePool,
  isRuntimePoolOpen,
  acquireRuntimeClient,
  runtimePoolStats,
  openMigrationPool,
  acquireMigrationClient,
  closeMigrationPool,
  closeAllPools
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/db-index.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/pool.js apps/core-api/test/db-index.test.js
git commit -m "feat(core-api): build the runtime and migration pools behind pool.js"
```

---

### Task 34: `db/index.js` — `buildTenantStatement()` and every descriptor assertion

**Files:**
- Create: `apps/core-api/db/index.js`
- Test: `apps/core-api/test/db-index.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/db-index.test.js`:

```js
const { createScope } = require("../db/scope");
const { buildTenantStatement } = require("../db/index");

const COMPANY_A = "aaaaaaaa-0000-4000-8000-000000000001";
const COMPANY_B = "bbbbbbbb-0000-4000-8000-000000000001";
const SHOP_A1 = "aaaaaaaa-0000-4000-8000-000000000011";
const SHOP_A3 = "aaaaaaaa-0000-4000-8000-000000000013";
const A_ADMIN = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

function adminScope() {
  return createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "company_admin",
    shopIds: [SHOP_A1],
    administeredShopIds: [SHOP_A1, SHOP_A3]
  });
}

function managerScope() {
  return createScope({
    kind: "tenant",
    userId: A_ADMIN,
    sessionId: SESSION,
    companyId: COMPANY_A,
    role: "shop_manager",
    shopIds: [SHOP_A1]
  });
}

test("a read binds company_id itself and starts caller parameters at $2", () => {
  // Binding two leading parameters unconditionally would break every statement
  // that references only $1: Postgres derives the parameter count from the
  // highest $n in the text.
  assert.deepEqual(
    buildTenantStatement(adminScope(), { sql: "SELECT id FROM shops WHERE company_id = $1", shopScoped: false }),
    { text: "SELECT id FROM shops WHERE company_id = $1", values: [COMPANY_A] }
  );
  assert.deepEqual(
    buildTenantStatement(
      adminScope(),
      { sql: "SELECT id FROM shops WHERE company_id = $1 AND status = $2", shopScoped: false },
      ["active"]
    ),
    { text: "SELECT id FROM shops WHERE company_id = $1 AND status = $2", values: [COMPANY_A, "active"] }
  );
});

test("shopScoped chooses between the two scope-derived sets and nothing else", () => {
  const sql = "SELECT id FROM shop_tables WHERE company_id = $1 AND shop_id = ANY($2)";

  assert.deepEqual(buildTenantStatement(adminScope(), { sql, shopScoped: "active" }).values, [COMPANY_A, [SHOP_A1]]);
  assert.deepEqual(buildTenantStatement(adminScope(), { sql, shopScoped: "administered" }).values, [
    COMPANY_A,
    [SHOP_A1, SHOP_A3]
  ]);
  // A manager has no status-independent set; asking for one is a throw, never a
  // NULL that widens the query.
  assert.throws(
    () => buildTenantStatement(managerScope(), { sql, shopScoped: "administered" }),
    /carries no administeredShopIds/
  );
});

test("shopScoped is a closed vocabulary with no default", () => {
  const sql = "SELECT id FROM shop_tables WHERE company_id = $1 AND shop_id = ANY($2)";
  assert.throws(() => buildTenantStatement(adminScope(), { sql }), /shopScoped/);
  assert.throws(() => buildTenantStatement(adminScope(), { sql, shopScoped: true }), /shopScoped/);
  assert.throws(() => buildTenantStatement(adminScope(), { sql, shopScoped: "all" }), /shopScoped/);
  assert.throws(() => buildTenantStatement(adminScope(), { sql, shopScoped: [SHOP_A1] }), /shopScoped/);
});

test("the declared predicate and the SQL must agree in both directions", () => {
  assert.throws(
    () => buildTenantStatement(adminScope(), { sql: "SELECT id FROM shops", shopScoped: false }),
    /must filter on company_id = \$1/
  );
  assert.throws(
    () =>
      buildTenantStatement(adminScope(), {
        sql: "SELECT id FROM shop_tables WHERE company_id = $1",
        shopScoped: "active"
      }),
    /requires the SQL to filter on shop_id = ANY\(\$2\)/
  );
  assert.throws(
    () =>
      buildTenantStatement(adminScope(), {
        sql: "SELECT id FROM shop_tables WHERE company_id = $1 AND shop_id = ANY($2)",
        shopScoped: false
      }),
    /requires shopScoped/
  );
});

test("company_id may never be bound to a caller parameter or a literal", () => {
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "SELECT id FROM shops WHERE company_id = $2", shopScoped: false },
        [COMPANY_B]
      ),
    /company_id may only be compared to \$1/
  );
  assert.throws(
    () =>
      buildTenantStatement(adminScope(), {
        sql: "SELECT id FROM shops WHERE company_id = 'aaaaaaaa-0000-4000-8000-000000000001'",
        shopScoped: false
      }),
    /company_id may only be compared to \$1/
  );
});

test("a composite join on company_id is still allowed", () => {
  // Rejecting every second mention of company_id would ban the strongest join
  // the schema supports, so the rule is about what it is compared TO.
  const sql =
    "SELECT t.id FROM terminals t JOIN shops s ON s.id = t.shop_id AND s.company_id = t.company_id WHERE t.company_id = $1";
  assert.deepEqual(buildTenantStatement(adminScope(), { sql, shopScoped: false }).values, [COMPANY_A]);
});

test("an INSERT may not name company_id at all; the helper injects it", () => {
  // Requiring only that it APPEAR is not enough: a helper reused between a
  // platform route and a tenant invite route would let a company_admin who
  // learned another company's uuid create a company_admin row inside it.
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "INSERT INTO shop_tables (company_id, shop_id, label) VALUES ($1, $2, $3)", shopScoped: false },
        [COMPANY_B, SHOP_A1, "T1"]
      ),
    /an INSERT may not name company_id/
  );

  assert.deepEqual(
    buildTenantStatement(
      adminScope(),
      { sql: "INSERT INTO shop_tables (shop_id, label) VALUES ($2, $3) RETURNING id", shopScoped: false },
      [SHOP_A1, "T1"]
    ),
    {
      text: "INSERT INTO shop_tables (company_id, shop_id, label) VALUES ($1, $2, $3) RETURNING id",
      values: [COMPANY_A, SHOP_A1, "T1"]
    }
  );
});

test("an UPDATE may not assign company_id", () => {
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "UPDATE users SET company_id = $2 WHERE company_id = $1 AND id = $3", shopScoped: false },
        [COMPANY_B, A_ADMIN]
      ),
    /company_id may only be compared to \$1/
  );
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "UPDATE users SET company_id = $1, status = $2 WHERE company_id = $1 AND id = $3", shopScoped: false },
        ["suspended", A_ADMIN]
      ),
    /an UPDATE may not assign company_id/
  );
  assert.deepEqual(
    buildTenantStatement(
      adminScope(),
      { sql: "UPDATE shops SET name = $2 WHERE company_id = $1 AND id = $3", shopScoped: false },
      ["Renamed", SHOP_A1]
    ).values,
    [COMPANY_A, "Renamed", SHOP_A1]
  );
});

test("an INSERT reserves $1, takes no shop predicate, and must be a single VALUES row", () => {
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "INSERT INTO shop_tables (shop_id) VALUES ($1)", shopScoped: false },
        [SHOP_A1]
      ),
    /\$1 is reserved for company_id/
  );
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "INSERT INTO shop_tables (shop_id, label) VALUES ($2, $3)", shopScoped: "active" },
        [SHOP_A1, "T1"]
      ),
    /an INSERT cannot declare shopScoped/
  );
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "INSERT INTO shop_tables (shop_id, label) VALUES ($2, $3), ($2, $4)", shopScoped: false },
        [SHOP_A1, "T1", "T2"]
      ),
    /single VALUES row/
  );
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "INSERT INTO shop_tables SELECT $2, $3", shopScoped: false },
        [SHOP_A1, "T1"]
      ),
    /INSERT INTO <table> \(<columns>\) VALUES/
  );
});

test("the bound parameter count must match the highest placeholder", () => {
  // This is the "bind message supplies 2 parameters, but prepared statement
  // requires 1" failure, caught before the driver ever sees it.
  assert.throws(
    () =>
      buildTenantStatement(
        adminScope(),
        { sql: "SELECT id FROM shops WHERE company_id = $1", shopScoped: false },
        ["active"]
      ),
    /uses \$1 but 2 values are bound/
  );
  assert.throws(
    () =>
      buildTenantStatement(adminScope(), {
        sql: "SELECT id FROM shops WHERE company_id = $1 AND status = $2",
        shopScoped: false
      }),
    /uses \$2 but 1 value is bound/
  );
});

test("a shop predicate the descriptor does not declare is left alone", () => {
  // shopScoped:false plus a caller-bound shop_id = $2 is a REAL query shape.
  // Rejecting it here would hide the containment bug behind a descriptor error
  // instead of letting the isolation suite catch it where it lives.
  assert.deepEqual(
    buildTenantStatement(
      managerScope(),
      { sql: "SELECT id FROM terminals WHERE company_id = $1 AND shop_id = $2", shopScoped: false },
      [SHOP_A3]
    ).values,
    [COMPANY_A, SHOP_A3]
  );
});

test("buildTenantStatement refuses a bad scope, a bad descriptor and bad params", () => {
  const descriptor = { sql: "SELECT id FROM shops WHERE company_id = $1", shopScoped: false };
  assert.throws(() => buildTenantStatement({ companyId: COMPANY_A }, descriptor), /was not produced by createScope/);
  assert.throws(() => buildTenantStatement(adminScope(), null), /requires a descriptor object/);
  assert.throws(() => buildTenantStatement(adminScope(), { sql: "  ", shopScoped: false }), /requires sql/);
  assert.throws(() => buildTenantStatement(adminScope(), descriptor, "active"), /params must be an array/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/db-index.test.js`
Expected: FAIL with `Error: Cannot find module '../db/index'`

- [ ] **Step 3: Write the minimal implementation**

Create `apps/core-api/db/index.js`:

```js
const { assertTenantScope } = require("./scope");

const SHOP_SCOPE_VALUES = [false, "active", "administered"];

const COMPANY_PREDICATE = /\bcompany_id\b\s*=\s*\$1\b/i;
// Any comparison or assignment of company_id to something that is not $1 and is
// not another company_id column. This is what a hardcoded uuid and a
// SET company_id = $3 both look like.
const COMPANY_MISBOUND = /\bcompany_id\b\s*=\s*(?!\$1\b)(?![a-z_][a-z0-9_]*\.company_id\b)/i;
const SHOP_PREDICATE = /\bshop_id\b\s*=\s*ANY\s*\(\s*\$2\s*\)/i;
const INSERT_SHAPE = /^(\s*INSERT\s+INTO\s+[a-z_][a-z0-9_]*\s*\()([^()]+)(\)\s*VALUES\s*\()/i;
const MULTI_ROW_VALUES = /\)\s*,\s*\(/;

function statementKind(sql) {
  const match = sql.match(/^\s*([a-z]+)/i);
  return match === null ? "" : match[1].toUpperCase();
}

function highestPlaceholder(text) {
  let highest = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) {
    highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

// The SET list of an UPDATE, taken as everything between SET and the first
// WHERE. Repository SQL is hand-written and single-statement, so the simple
// slice is exact here; a subselect in the SET list would only make the slice
// SHORTER, and COMPANY_MISBOUND already covers what that would hide.
function updateSetList(sql) {
  const setAt = sql.search(/\bSET\b/i);
  if (setAt === -1) return "";
  const whereAt = sql.search(/\bWHERE\b/i);
  return whereAt === -1 || whereAt < setAt ? sql.slice(setAt) : sql.slice(setAt, whereAt);
}

// PURE. Turns a descriptor plus caller parameters into the exact text and
// values that will be sent, or throws. Every rule here is a tenant-isolation
// rule, which is why they are assertions and not documentation.
function buildTenantStatement(scope, descriptor, params = []) {
  assertTenantScope(scope);

  if (descriptor === null || typeof descriptor !== "object") {
    throw new Error("tenantQuery requires a descriptor object { sql, shopScoped, conflicts }");
  }
  const { sql, shopScoped, conflicts } = descriptor;
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new Error("tenantQuery descriptor requires sql");
  }
  if (!SHOP_SCOPE_VALUES.includes(shopScoped)) {
    throw new Error(
      `tenantQuery descriptor requires shopScoped false | "active" | "administered" (got ${JSON.stringify(
        shopScoped === undefined ? null : shopScoped
      )})`
    );
  }
  if (conflicts !== undefined && (conflicts === null || typeof conflicts !== "object")) {
    throw new Error("tenantQuery descriptor conflicts must be an object mapping constraint name to error code");
  }
  if (!Array.isArray(params)) {
    throw new Error("tenantQuery params must be an array");
  }

  const kind = statementKind(sql);
  const values = [scope.companyId];
  let text = sql;

  if (kind === "INSERT") {
    if (shopScoped !== false) {
      throw new Error(
        "tenantQuery: an INSERT cannot declare shopScoped; resolve the shop with a scoped SELECT first and let the composite foreign key anchor the write"
      );
    }
    if (/\bcompany_id\b/i.test(sql)) {
      throw new Error(
        "tenantQuery: an INSERT may not name company_id; the helper injects the column and the scope's value"
      );
    }
    if (/\$1\b/.test(sql)) {
      throw new Error("tenantQuery: $1 is reserved for company_id; an INSERT's own parameters start at $2");
    }
    if (MULTI_ROW_VALUES.test(sql)) {
      throw new Error("tenantQuery: an INSERT must have a single VALUES row");
    }
    text = sql.replace(INSERT_SHAPE, (match, head, columns, tail) => `${head}company_id, ${columns}${tail}$1, `);
    if (text === sql) {
      throw new Error("tenantQuery supports INSERT INTO <table> (<columns>) VALUES (...) only");
    }
  } else {
    if (kind === "UPDATE" && /\bcompany_id\b/i.test(updateSetList(sql))) {
      throw new Error("tenantQuery: an UPDATE may not assign company_id; the scope owns that column");
    }
    if (!COMPANY_PREDICATE.test(sql)) {
      throw new Error("tenantQuery: the SQL must filter on company_id = $1");
    }
    if (COMPANY_MISBOUND.test(sql)) {
      throw new Error("tenantQuery: company_id may only be compared to $1 or to another company_id column");
    }
    if (shopScoped === false) {
      if (SHOP_PREDICATE.test(sql)) {
        throw new Error('tenantQuery: shop_id = ANY($2) requires shopScoped "active" or "administered"');
      }
    } else {
      if (!SHOP_PREDICATE.test(sql)) {
        throw new Error(`tenantQuery: shopScoped "${shopScoped}" requires the SQL to filter on shop_id = ANY($2)`);
      }
      const shopIds = shopScoped === "active" ? scope.shopIds : scope.administeredShopIds;
      const setName = shopScoped === "active" ? "shopIds" : "administeredShopIds";
      // A missing set must be a throw, never a NULL that widens the query.
      if (!Array.isArray(shopIds) || !shopIds.every((id) => typeof id === "string")) {
        throw new Error(`tenantQuery: this scope carries no ${setName} to bind`);
      }
      values.push(shopIds);
    }
  }

  values.push(...params);

  const highest = highestPlaceholder(text);
  if (highest !== values.length) {
    throw new Error(
      `tenantQuery: the SQL uses $${highest} but ${values.length} value${
        values.length === 1 ? " is" : "s are"
      } bound; caller parameters start at $${values.length - params.length + 1}`
    );
  }

  return { text, values };
}

module.exports = { buildTenantStatement };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/db-index.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/index.js apps/core-api/test/db-index.test.js
git commit -m "feat(core-api): assert and bind the tenant predicate in one place"
```

---

### Task 35: `db/index.js` — the choke point seam and the pool re-exports

**Files:**
- Modify: `apps/core-api/db/index.js` (two requires at the top, one block above `module.exports`, replace the export line)
- Test: `apps/core-api/test/db-index.test.js` (append)

This task ships the transaction seam and makes `require("./db")` the single door to the database:
spec 3.2 rule 1 says everything outside `db/` reaches Postgres through `db/index.js`, so `server.js`
must be able to get the pool functions from here rather than reaching past the seam into `db/pool.js`.
The transaction behaviour itself is proved by the next task, against a real database.

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/db-index.test.js`:

```js
const dbSeam = require("../db/index");
const { withTenantScope, tenantQuery, withUnscopedConnection } = dbSeam;

test("tenantQuery outside a transaction is an error, not a fresh connection", async () => {
  await assert.rejects(
    () => tenantQuery(adminScope(), { sql: "SELECT id FROM shops WHERE company_id = $1", shopScoped: false }),
    /must run inside withTenantScope/
  );
});

test("the seam refuses a bad scope and a non-function body before touching the pool", async () => {
  // Every one of these must fail without checking out a client: the pool is
  // closed in this process, so a client checkout would reject with the wrong
  // message and hide the real assertion.
  await assert.rejects(() => withTenantScope({ companyId: COMPANY_A }, async () => null), /was not produced by createScope/);
  await assert.rejects(() => withTenantScope(adminScope(), "not a function"), /withTenantScope requires a function/);
  await assert.rejects(() => withUnscopedConnection("not a function"), /withUnscopedConnection requires a function/);
});

test("db/index.js is the seam: it re-exports every db/pool.js function by identity", () => {
  // Spec 3.2 rule 1: everything outside db/ goes through db/index.js. Without
  // these, server.js would have to require("./db/pool") directly, which is the
  // exact reach-past this rule exists to forbid.
  assert.deepEqual(Object.keys(dbSeam).sort(), [
    "acquireMigrationClient",
    "acquireRuntimeClient",
    "buildTenantStatement",
    "closeAllPools",
    "closeMigrationPool",
    "isRuntimePoolOpen",
    "openMigrationPool",
    "openRuntimePool",
    "runtimePoolStats",
    "tenantQuery",
    "withTenantScope",
    "withUnscopedConnection"
  ]);
  for (const name of Object.keys(pool)) {
    assert.equal(dbSeam[name], pool[name], `${name} must be the same function object as db/pool.js's`);
  }
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/db-index.test.js`
Expected: FAIL with `TypeError: tenantQuery is not a function`

- [ ] **Step 3: Write the minimal implementation**

Three edits to `apps/core-api/db/index.js`.

First, add these two lines above the existing `const { assertTenantScope } = require("./scope");`:

```js
const { AsyncLocalStorage } = require("node:async_hooks");

const pool = require("./pool");
```

Second, insert this block immediately above `module.exports`:

```js
// One open transaction per async context. tenantQuery takes no client argument
// on purpose: a repository that could choose its own connection could also
// choose one with nobody's company_id set.
const transactionStorage = new AsyncLocalStorage();

// One client, one transaction, one company_id, for the whole of fn.
async function withTenantScope(scope, fn) {
  assertTenantScope(scope);
  if (typeof fn !== "function") throw new Error("withTenantScope requires a function");

  const open = transactionStorage.getStore();
  if (open !== undefined) {
    if (open.scope !== scope) {
      throw new Error("withTenantScope() cannot open a second scope inside an open transaction");
    }
    // Composition: a repository calling another repository joins the caller's
    // transaction rather than deadlocking against it on a second connection.
    return fn();
  }

  const client = await pool.acquireRuntimeClient();
  let committed = false;
  try {
    await client.query("BEGIN");
    // A parameter cannot appear in SET LOCAL, so the GUC is written with
    // set_config(..., is_local => true), which is transaction-local in exactly
    // the same way and keeps the value out of the statement text.
    await client.query("SELECT set_config('app.company_id', $1, true)", [scope.companyId]);
    const result = await transactionStorage.run({ client, scope }, fn);
    await client.query("COMMIT");
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // The connection is already gone; releasing it is all that is left.
      }
    }
    client.release();
  }
}

// The only way to issue SQL under a tenant scope.
async function tenantQuery(scope, descriptor, params = []) {
  const store = transactionStorage.getStore();
  if (store === undefined) {
    throw new Error("tenantQuery() must run inside withTenantScope()");
  }
  if (store.scope !== scope) {
    throw new Error("tenantQuery() was given a different scope than the open transaction");
  }

  const { text, values } = buildTenantStatement(scope, descriptor, params);
  return store.client.query(text, values);
}

// Deliberately narrow: pre-tenant lookups (login, session resolution, bearer
// resolution, the pre-tenant audit writer) run before any company_id exists.
// The caller set is pinned by structural test C4, not by good intentions.
async function withUnscopedConnection(fn) {
  if (typeof fn !== "function") throw new Error("withUnscopedConnection requires a function");
  const client = await pool.acquireRuntimeClient();
  try {
    return await fn({ query: (text, values) => client.query(text, values) });
  } finally {
    client.release();
  }
}
```

Third, replace the export line with:

```js
module.exports = {
  withTenantScope,
  tenantQuery,
  withUnscopedConnection,
  buildTenantStatement,
  // Straight re-exports of db/pool.js. server.js and db/health.js reach the
  // pool through this file because db/index.js is the declared seam.
  openRuntimePool: pool.openRuntimePool,
  openMigrationPool: pool.openMigrationPool,
  acquireRuntimeClient: pool.acquireRuntimeClient,
  acquireMigrationClient: pool.acquireMigrationClient,
  isRuntimePoolOpen: pool.isRuntimePoolOpen,
  runtimePoolStats: pool.runtimePoolStats,
  closeMigrationPool: pool.closeMigrationPool,
  closeAllPools: pool.closeAllPools
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/db-index.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/index.js apps/core-api/test/db-index.test.js
git commit -m "feat(core-api): add the withTenantScope/tenantQuery choke point"
```

---

### Task 36: `db/index.js` — pg-error translation, proved against a real database

**Sequencing:** this task loads `apps/core-api/testing/database.js` (test-harness area) at require time
and needs the migrated template it clones. If your plan has not created that file yet, do that task
first. Everything before this point in this area runs with no database at all.

**Files:**
- Modify: `apps/core-api/db/index.js` (insert one function above `withTenantScope`, replace `tenantQuery`)
- Test: `apps/core-api/test/db-index.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/db-index.test.js`. `skipDatabaseTests()` is **called** — passing
the function reference itself would make every truthiness check skip the whole suite while reporting green.

```js
const { before, after, describe } = require("node:test");
const { ApiError } = require("../db/errors");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");

const TABLE_A1 = "aaaaaaaa-0000-4000-8000-000000000101";
const TABLE_B1 = "bbbbbbbb-0000-4000-8000-000000000101";
const SHOP_B1 = "bbbbbbbb-0000-4000-8000-000000000011";

let db;

describe("the choke point against a real database", { skip: skipDatabaseTests() }, () => {
  before(async () => {
    db = await cloneTemplate(__filename);
    pool.openRuntimePool({ connectionString: db.connectionString, max: 4 });

    // Seeded here rather than from testing/fixtures/two-tenant.js: this suite
    // needs only two companies and cares about nothing else the fixture builds.
    await db.unscoped("INSERT INTO companies (id, name) VALUES ($1, 'Company A'), ($2, 'Company B')", [
      COMPANY_A,
      COMPANY_B
    ]);
    await db.unscoped(
      `INSERT INTO shops (id, company_id, name, time_zone, business_day_rollover_hour)
       VALUES ($1, $3, 'A1', 'Asia/Tokyo', 6), ($2, $4, 'B1', 'Asia/Tokyo', 6)`,
      [SHOP_A1, SHOP_B1, COMPANY_A, COMPANY_B]
    );
    await db.unscoped(
      `INSERT INTO shop_tables (id, company_id, shop_id, label)
       VALUES ($1, $3, $5, '1'), ($2, $4, $6, '1')`,
      [TABLE_A1, TABLE_B1, COMPANY_A, COMPANY_B, SHOP_A1, SHOP_B1]
    );
  });

  after(async () => {
    await pool.closeAllPools();
    await db.end();
  });

  test("the transaction sets app.company_id and reverts it when it ends", async () => {
    const scope = adminScope();
    const inside = await withTenantScope(scope, async () => {
      const result = await tenantQuery(scope, {
        sql: "SELECT current_setting('app.company_id', true) AS guc FROM shops WHERE company_id = $1 LIMIT 1",
        shopScoped: false
      });
      return result.rows[0].guc;
    });
    assert.equal(inside, COMPANY_A);

    // pool.query() would have checked out a different connection per statement,
    // so a later RLS policy would evaluate against whatever the previous tenant
    // left behind. SET LOCAL inside one transaction is what makes that safe.
    const settingAfterCommit = await withUnscopedConnection(async (connection) => {
      const result = await connection.query("SELECT current_setting('app.company_id', true) AS guc");
      return result.rows[0].guc;
    });
    assert.notEqual(settingAfterCommit, COMPANY_A);
  });

  test("a scoped read sees only its own tenant, in both directions", async () => {
    const sql = "SELECT id FROM shops WHERE company_id = $1 ORDER BY name";

    const scopeA = adminScope();
    const rowsA = await withTenantScope(scopeA, async () => (await tenantQuery(scopeA, { sql, shopScoped: false })).rows);
    assert.deepEqual(
      rowsA.map((row) => row.id),
      [SHOP_A1]
    );

    const scopeB = createScope({
      kind: "tenant",
      userId: A_ADMIN,
      sessionId: SESSION,
      companyId: COMPANY_B,
      role: "company_admin",
      shopIds: [SHOP_B1],
      administeredShopIds: [SHOP_B1]
    });
    const rowsB = await withTenantScope(scopeB, async () => (await tenantQuery(scopeB, { sql, shopScoped: false })).rows);
    assert.deepEqual(
      rowsB.map((row) => row.id),
      [SHOP_B1]
    );
  });

  test("shopScoped binds the scope's own array", async () => {
    const scope = managerScope();
    const rows = await withTenantScope(scope, async () =>
      (
        await tenantQuery(scope, {
          sql: "SELECT id FROM shop_tables WHERE company_id = $1 AND shop_id = ANY($2)",
          shopScoped: "active"
        })
      ).rows
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      [TABLE_A1]
    );
  });

  test("an INSERT is written with the scope's company_id, not the caller's", async () => {
    const scope = adminScope();
    const created = await withTenantScope(scope, async () => {
      const result = await tenantQuery(
        scope,
        { sql: "INSERT INTO shop_tables (shop_id, label) VALUES ($2, $3) RETURNING id", shopScoped: false },
        [SHOP_A1, "T9"]
      );
      return result.rows[0].id;
    });

    const owner = await db.unscoped("SELECT company_id FROM shop_tables WHERE id = $1", [created]);
    assert.equal(owner.rows[0].company_id, COMPANY_A);
  });

  test("a throw rolls the transaction back and still releases the client", async () => {
    const scope = adminScope();
    await assert.rejects(
      () =>
        withTenantScope(scope, async () => {
          await tenantQuery(
            scope,
            { sql: "INSERT INTO shop_tables (shop_id, label) VALUES ($2, $3)", shopScoped: false },
            [SHOP_A1, "T8"]
          );
          throw new Error("handler exploded");
        }),
      /handler exploded/
    );

    const count = await db.unscoped("SELECT count(*)::int AS n FROM shop_tables WHERE label = 'T8'");
    assert.equal(count.rows[0].n, 0);

    const stats = pool.runtimePoolStats();
    assert.equal(stats.idleCount, stats.totalCount);
    assert.equal(stats.waitingCount, 0);
  });

  test("a declared constraint becomes the declared code and never leaks its name", async () => {
    const scope = adminScope();
    await assert.rejects(
      () =>
        withTenantScope(scope, async () =>
          tenantQuery(
            scope,
            {
              sql: "INSERT INTO shop_tables (shop_id, label) VALUES ($2, $3)",
              shopScoped: false,
              conflicts: { shop_tables_shop_label_active_key: "table_label_taken" }
            },
            [SHOP_A1, "1"]
          )
        ),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "table_label_taken");
        assert.equal(error.constraint, undefined);
        return true;
      }
    );
  });

  test("an undeclared constraint and an unmapped sqlstate both stay 500-shaped", async () => {
    const scope = adminScope();
    await assert.rejects(
      () =>
        withTenantScope(scope, async () =>
          tenantQuery(
            scope,
            { sql: "INSERT INTO shop_tables (shop_id, label) VALUES ($2, $3)", shopScoped: false },
            [SHOP_A1, "1"]
          )
        ),
      (error) => {
        assert.equal(error instanceof ApiError, false);
        assert.equal(error.code, "23505");
        return true;
      }
    );

    await assert.rejects(
      () =>
        withTenantScope(scope, async () =>
          tenantQuery(
            scope,
            { sql: "SELECT id FROM shops WHERE company_id = $1 AND id = $2", shopScoped: false },
            ["not-a-uuid"]
          )
        ),
      (error) => {
        assert.equal(error instanceof ApiError, false);
        assert.equal(error.code, "22P02");
        return true;
      }
    );
  });

  test("a nested withTenantScope joins the open transaction and refuses a different scope", async () => {
    const scope = adminScope();
    const joined = await withTenantScope(scope, async () =>
      withTenantScope(
        scope,
        async () =>
          (
            await tenantQuery(scope, {
              sql: "SELECT count(*)::int AS n FROM shops WHERE company_id = $1",
              shopScoped: false
            })
          ).rows[0].n
      )
    );
    assert.equal(joined, 1);

    await assert.rejects(
      () => withTenantScope(scope, async () => withTenantScope(adminScope(), async () => null)),
      /cannot open a second scope inside an open transaction/
    );
    await assert.rejects(
      () =>
        withTenantScope(scope, async () =>
          tenantQuery(adminScope(), { sql: "SELECT id FROM shops WHERE company_id = $1", shopScoped: false })
        ),
      /a different scope than the open transaction/
    );
  });

  test("withUnscopedConnection releases its client and opens no transaction", async () => {
    const value = await withUnscopedConnection(async (connection) => {
      const result = await connection.query("SELECT 1 AS one");
      return result.rows[0].one;
    });
    assert.equal(value, 1);

    await assert.rejects(
      () =>
        withUnscopedConnection(async () => {
          throw new Error("boom");
        }),
      /boom/
    );
    const stats = pool.runtimePoolStats();
    assert.equal(stats.idleCount, stats.totalCount);
    assert.equal(stats.waitingCount, 0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Export a maintenance DSN first — these subtests must actually run, or the step proves nothing:
bash `export CORE_API_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres`,
PowerShell `$env:CORE_API_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/postgres"`.

Run: `node --test apps/core-api/test/db-index.test.js`
Expected: FAIL in `a declared constraint becomes the declared code and never leaks its name` with
`AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: assert.ok(error instanceof ApiError)` —
`tenantQuery` currently rethrows the raw pg error.

- [ ] **Step 3: Write the minimal implementation**

Two edits to `apps/core-api/db/index.js`.

First, insert this function immediately above `async function withTenantScope`:

```js
// err.constraint is read to pick a declared code and is NEVER serialised, which
// keeps _key/_fkey/_check strings out of every response and decouples the API
// vocabulary from the DDL. An undeclared constraint stays a raw error so the
// top-level handler answers 500 rather than inventing a code.
function translatePgError(error, conflicts) {
  const mapped = pgErrorToHttp(error && error.code);
  if (mapped === null) return error;
  if (mapped.code !== null) return new ApiError(mapped.status, mapped.code);
  const declared =
    conflicts &&
    error &&
    typeof error.constraint === "string" &&
    Object.prototype.hasOwnProperty.call(conflicts, error.constraint)
      ? conflicts[error.constraint]
      : null;
  return declared === null ? error : new ApiError(mapped.status, declared);
}
```

and add its dependency to the requires at the top of the file, below `const pool = require("./pool");`:

```js
const { ApiError, pgErrorToHttp } = require("./errors");
```

Second, replace the whole existing `tenantQuery` function with:

```js
// The only way to issue SQL under a tenant scope.
async function tenantQuery(scope, descriptor, params = []) {
  const store = transactionStorage.getStore();
  if (store === undefined) {
    throw new Error("tenantQuery() must run inside withTenantScope()");
  }
  if (store.scope !== scope) {
    throw new Error("tenantQuery() was given a different scope than the open transaction");
  }

  const { text, values } = buildTenantStatement(scope, descriptor, params);
  try {
    return await store.client.query(text, values);
  } catch (error) {
    throw translatePgError(error, descriptor.conflicts);
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/db-index.test.js`  Expected: PASS.
Confirm in the TAP output that the nine subtests under `the choke point against a real database` report
as **run**, not skipped — the total pass count must be above the pure-test count. With
`CORE_API_SKIP_DB_TESTS=1` instead of a database URL the same command passes with those nine as visible
`# SKIP` lines; with neither variable set `cloneTemplate()` throws by design and the suite fails.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/index.js apps/core-api/test/db-index.test.js
git commit -m "feat(core-api): translate pg errors by SQLSTATE at the choke point"
```

---

### Task 37: `db/health.js` — the readiness probe and the bounded startup retry

**Files:**
- Create: `apps/core-api/db/health.js`
- Test: `apps/core-api/test/db-health.test.js`

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/db-health.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  probeReadiness,
  waitForDatabase,
  connectWithRetry,
  isRetryableConnectionError,
  fatalConnectionMessage,
  READINESS_STATEMENT_TIMEOUT_MS
} = require("../db/health");

function pgError(code) {
  const error = new Error(`simulated ${code}`);
  error.code = code;
  return error;
}

test("only transient connection failures are retryable", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "57P03"]) {
    assert.equal(isRetryableConnectionError(pgError(code)), true, code);
  }
  for (const code of ["28P01", "28000", "3D000", "42P01", undefined]) {
    assert.equal(isRetryableConnectionError(pgError(code)), false, String(code));
  }
  assert.equal(isRetryableConnectionError(null), false);
});

test("connectWithRetry returns the first success without sleeping", async () => {
  let calls = 0;
  const value = await connectWithRetry(
    async () => {
      calls += 1;
      return "connected";
    },
    { sleep: async () => assert.fail("must not sleep on success") }
  );
  assert.equal(value, "connected");
  assert.equal(calls, 1);
});

test("connectWithRetry recovers from a database that is still starting", async () => {
  // 57P03 is "the database system is starting up" — exactly what compose
  // produces when core-api wins the race against core-db's first initdb.
  let calls = 0;
  const delays = [];
  const value = await connectWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw pgError("57P03");
      return "connected";
    },
    { sleep: async (ms) => delays.push(ms) }
  );
  assert.equal(value, "connected");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("the retry is bounded at ten attempts one second apart", async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(
    () =>
      connectWithRetry(
        async () => {
          calls += 1;
          throw pgError("ECONNREFUSED");
        },
        { sleep: async (ms) => delays.push(ms) }
      ),
    /ECONNREFUSED/
  );
  assert.equal(calls, 10);
  assert.deepEqual(delays, new Array(9).fill(1000));
});

test("a rejected password fails immediately and names the rotation runbook", async () => {
  // Retrying a wrong password for ten seconds buries a deterministic failure
  // behind a timeout, and the operator reads it as "the database is down".
  let calls = 0;
  await assert.rejects(
    () =>
      connectWithRetry(
        async () => {
          calls += 1;
          throw pgError("28P01");
        },
        { variableName: "DATABASE_MIGRATION_URL", sleep: async () => assert.fail("must not sleep") }
      ),
    (error) => {
      assert.equal(
        error.message,
        'DATABASE_MIGRATION_URL was rejected by the server (28P01). If you rotated POSTGRES_PASSWORD, the running cluster still holds the old value — see apps/core-api/README.md "Rotating database passwords".'
      );
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("a missing database and a refused role are fatal too", async () => {
  assert.match(
    fatalConnectionMessage(pgError("28000"), "DATABASE_URL"),
    /^DATABASE_URL was rejected by the server \(28000\)/
  );
  assert.match(fatalConnectionMessage(pgError("3D000"), "DATABASE_URL"), /names a database that does not exist/);
  assert.equal(fatalConnectionMessage(pgError("ECONNREFUSED"), "DATABASE_URL"), null);
  assert.equal(fatalConnectionMessage(null, "DATABASE_URL"), null);

  let calls = 0;
  await assert.rejects(
    () =>
      connectWithRetry(
        async () => {
          calls += 1;
          throw pgError("3D000");
        },
        { sleep: async () => assert.fail("must not sleep") }
      ),
    /names a database that does not exist/
  );
  assert.equal(calls, 1);
});

test("an error that is neither transient nor named is raised as it is", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      connectWithRetry(
        async () => {
          calls += 1;
          throw pgError("42P01");
        },
        { sleep: async () => assert.fail("must not sleep") }
      ),
    /simulated 42P01/
  );
  assert.equal(calls, 1);
});

test("readiness reports a closed vocabulary, never an exception", async () => {
  // No runtime pool is open in this process, so this exercises the path the
  // deploy gate hits when core-db is gone. The word is for the request log; the
  // client still gets the ordinary opaque 503 envelope.
  assert.equal(await probeReadiness(), "unreachable");
  assert.equal(READINESS_STATEMENT_TIMEOUT_MS, 2000);
});

test("waitForDatabase really goes through the pool, and does not retry a closed one", async () => {
  // "the runtime pool is not open" carries no .code, so it is not retryable —
  // which is the proof that waitForDatabase is wired to withUnscopedConnection
  // and not to some injected stand-in.
  await assert.rejects(() => waitForDatabase({ attempts: 2, delayMs: 1 }), /runtime pool is not open/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/db-health.test.js`
Expected: FAIL with `Error: Cannot find module '../db/health'`

- [ ] **Step 3: Write the minimal implementation**

Create `apps/core-api/db/health.js`. The `28P01` message points at `apps/core-api/README.md`, not
`infra/README.md`: the README this plan creates is where the "Rotating database passwords" section
actually exists, and an error message naming a section that does not exist is worse than no message.

```js
const { withUnscopedConnection } = require("./index");

// The readiness probe's own ceiling. A readiness check that can hang is worse
// than one that fails: the deploy gate waits on it.
const READINESS_STATEMENT_TIMEOUT_MS = 2000;

// Transient: the cluster is coming up, DNS has not settled, the port is not
// bound yet. Every one of these is fixed by waiting a second.
const RETRYABLE_ERROR_CODES = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "57P03"];

function isRetryableConnectionError(error) {
  return error !== null && error !== undefined && RETRYABLE_ERROR_CODES.includes(error.code);
}

// Deterministic failures. Retrying them for ten seconds buries the real cause
// behind a timeout and makes a credential problem look like an outage.
function fatalConnectionMessage(error, variableName) {
  const code = error === null || error === undefined ? undefined : error.code;
  if (code === "28P01" || code === "28000") {
    return `${variableName} was rejected by the server (${code}). If you rotated POSTGRES_PASSWORD, the running cluster still holds the old value — see apps/core-api/README.md "Rotating database passwords".`;
  }
  if (code === "3D000") {
    return `${variableName} names a database that does not exist (3D000). Create it or fix the database name in the DSN — waiting cannot make it appear.`;
  }
  return null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `attempt` is any function that opens or uses a connection. Injecting `sleep`
// keeps the bound testable in milliseconds instead of ten real seconds.
async function connectWithRetry(attempt, options = {}) {
  const attempts = options.attempts === undefined ? 10 : options.attempts;
  const delayMs = options.delayMs === undefined ? 1000 : options.delayMs;
  const variableName = options.variableName === undefined ? "DATABASE_URL" : options.variableName;
  const sleep = options.sleep === undefined ? defaultSleep : options.sleep;
  const onRetry = options.onRetry === undefined ? () => {} : options.onRetry;

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await attempt();
    } catch (error) {
      const fatal = fatalConnectionMessage(error, variableName);
      if (fatal !== null) {
        const failure = new Error(fatal);
        failure.cause = error;
        throw failure;
      }
      if (!isRetryableConnectionError(error) || attemptNumber >= attempts) throw error;
      onRetry(attemptNumber, error);
      await sleep(delayMs);
    }
  }
}

// Step 11 of the §9.4 startup order: the runtime pool is open, prove it works
// before listen() rather than discovering it on the first request.
async function waitForDatabase({ attempts = 10, delayMs = 1000 } = {}) {
  await connectWithRetry(() => withUnscopedConnection((c) => c.query("SELECT 1")), {
    attempts,
    delayMs,
    variableName: "DATABASE_URL"
  });
}

// Returns one of the closed vocabulary "ready" | "timeout" | "unreachable".
// That word goes to the request log against the requestId; the client gets the
// ordinary opaque error envelope, because readiness detail is a precise "the
// database is down" signal and is not public.
async function probeReadiness() {
  try {
    return await withUnscopedConnection(async (connection) => {
      await connection.query("BEGIN");
      try {
        // SET LOCAL is the only form that reverts when the transaction ends; a
        // bare SET would leave this 2s ceiling on a pooled connection for
        // whatever request checks it out next.
        await connection.query(`SET LOCAL statement_timeout = ${READINESS_STATEMENT_TIMEOUT_MS}`);
        await connection.query("SELECT 1");
        await connection.query("COMMIT");
        return "ready";
      } catch (error) {
        try {
          await connection.query("ROLLBACK");
        } catch (rollbackError) {
          // The connection is already gone; the outer catch classifies it.
        }
        throw error;
      }
    });
  } catch (error) {
    return error !== null && error !== undefined && error.code === "57014" ? "timeout" : "unreachable";
  }
}

module.exports = {
  probeReadiness,
  waitForDatabase,
  connectWithRetry,
  isRetryableConnectionError,
  fatalConnectionMessage,
  READINESS_STATEMENT_TIMEOUT_MS
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/db-health.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/health.js apps/core-api/test/db-health.test.js
git commit -m "feat(core-api): add the readiness probe and the bounded startup retry"
```

---

### Task 38: `db/health.js` — `checkReadiness()`, the composed readiness verdict

**Sequencing:** this task requires `apps/core-api/db/migrate.js` to exist and export
`migrationsStatus(client, directory)` (migrations area), and its database half loads
`apps/core-api/testing/database.js` (test-harness area). If your plan has not created those yet, do
those tasks first. `server.js` and `http/routes/health.js` both name `checkReadiness`, so it cannot be
left to a later plan.

**Files:**
- Modify: `apps/core-api/db/health.js` (one require at the top, one function above `module.exports`, replace the export line)
- Test: `apps/core-api/test/db-health.test.js` (change the require block, append)

- [ ] **Step 1: Write the failing test**

Change the destructured `require("../db/health")` block at the top of
`apps/core-api/test/db-health.test.js` to include `checkReadiness`:

```js
const {
  probeReadiness,
  checkReadiness,
  waitForDatabase,
  connectWithRetry,
  isRetryableConnectionError,
  fatalConnectionMessage,
  READINESS_STATEMENT_TIMEOUT_MS
} = require("../db/health");
```

and append to the end of the file (the no-pool case must stay above the `describe`, because the hook
below opens a runtime pool that would change its answer):

```js
const path = require("node:path");
const { before, after, describe } = require("node:test");
const { openRuntimePool, closeAllPools } = require("../db");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

test("with no database the verdict is unreachable/pending and nothing throws", async () => {
  // /health/ready must answer, always. A probe that rejects turns a database
  // outage into an unhandled rejection inside the request pipeline.
  assert.deepEqual(await checkReadiness({ migrationsDir: MIGRATIONS_DIR }), {
    database: "unreachable",
    migrations: "pending"
  });
});

let healthDb;

describe("readiness against a real database", { skip: skipDatabaseTests() }, () => {
  before(async () => {
    healthDb = await cloneTemplate(__filename);
    openRuntimePool({ connectionString: healthDb.connectionString, max: 2 });
  });

  after(async () => {
    await closeAllPools();
    await healthDb.end();
  });

  test("a fully migrated database reports ready and current", async () => {
    assert.equal(await probeReadiness(), "ready");
    assert.deepEqual(await checkReadiness({ migrationsDir: MIGRATIONS_DIR }), {
      database: "ready",
      migrations: "current"
    });
    await waitForDatabase({ attempts: 2, delayMs: 1 });
  });

  test("an edited history reports checksum_mismatch while the database stays ready", async () => {
    // The two halves are independent on purpose: "the database answers but the
    // schema is not the one this image expects" is the state the deploy gate
    // exists to catch, and it is invisible if the probe returns one word.
    await healthDb.unscoped("UPDATE schema_migrations SET checksum = decode(repeat('00', 32), 'hex')");
    assert.deepEqual(await checkReadiness({ migrationsDir: MIGRATIONS_DIR }), {
      database: "ready",
      migrations: "checksum_mismatch"
    });
  });

  test("an empty ledger reports pending", async () => {
    await healthDb.unscoped("DELETE FROM schema_migrations");
    assert.deepEqual(await checkReadiness({ migrationsDir: MIGRATIONS_DIR }), {
      database: "ready",
      migrations: "pending"
    });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/db-health.test.js`
Expected: FAIL with `TypeError: checkReadiness is not a function`

- [ ] **Step 3: Write the minimal implementation**

Two edits to `apps/core-api/db/health.js`.

First, add this line below the existing `const { withUnscopedConnection } = require("./index");`:

```js
const { migrationsStatus } = require("./migrate");
```

Second, insert this function immediately above `module.exports`, and add `checkReadiness,` to the
export list right after `probeReadiness,`:

```js
// The whole readiness verdict, both halves of the closed vocabulary §6.3.6
// keeps out of public bodies. It NEVER throws: any failure degrades to the
// fail-closed pair, because the only thing a thrown readiness check achieves is
// a 500 where the caller needed a 503.
async function checkReadiness({ migrationsDir }) {
  const database = await probeReadiness();
  if (database !== "ready") {
    // No usable connection means no verdict on the ledger either, and "pending"
    // is the word that keeps the gate shut.
    return { database, migrations: "pending" };
  }
  try {
    const migrations = await withUnscopedConnection((connection) => migrationsStatus(connection, migrationsDir));
    return { database, migrations };
  } catch (error) {
    return { database: "unreachable", migrations: "pending" };
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/db-health.test.js`  Expected: PASS.
With `CORE_API_TEST_DATABASE_URL` set, confirm the three subtests under `readiness against a real
database` report as run; with `CORE_API_SKIP_DB_TESTS=1` they report as visible skips and the pure
tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/db/health.js apps/core-api/test/db-health.test.js
git commit -m "feat(core-api): compose the database and migration readiness verdict"
```

---

### Where this area stops

- **No authentication.** `createScope()` takes an already-materialised set of shop ids; the SQL that
  produces it (`repositories/auth/scope-materialize.js`, with `COALESCE(array_agg(...), '{}')` and
  `JOIN shops … status='active'`) belongs to Plan 3, as do session and bearer resolution.
- **No repositories.** `buildTenantStatement` is proved against `shops`/`shop_tables` in the test only.
  The `ARGUMENT_ROLES` maps and the eight-mode isolation sweep are Plan 3.
- **No platform escape hatch.** `dangerouslyQueryAcrossTenants(scope, sql, params)` needs to check the
  private stamp, so Plan 3 must add one export to `db/scope.js` (`assertPlatformScope(scope)`) rather
  than re-deriving a stamp elsewhere. Adding it now would be an unused export in Plan 1.
- **No migration runner, no HTTP, no server wiring.** `db/migrate.js` owns `runMigrations` and
  `migrationsStatus`; `http/routes/health.js` calls `checkReadiness({ migrationsDir })` and logs its two
  words against the requestId; `server.js` owns the §9.4 startup order and the fatal-exit shape. This
  area supplies exactly the functions those three name and nothing more.

---

## Part 5 — HTTP shell, health and process bootstrap

**Sequencing for the plan assembler.** Every task here needs `apps/core-api/package.json` to exist
already. `http/router.js` is the one file in the service allowed to `require("express")` (spec §3.2
rule 2, asserted by rule C3 and by the line-2155 definition-of-done grep), so
`apps/core-api/package.json` declares **`express` alongside `pg`** — `pg` is the only dependency new
to the *repository* (`apps/epaper-hub` already ships Express 4), which is how to read the spec's
"single dependency `pg`". The `sendError` task additionally needs `db/errors.js`; the `server.js`
tasks additionally need `config.js`, `env-file.js`, `db/index.js`, `db/migrate.js` and `db/health.js`.
Place the four `http/` tasks after the package.json task, and the three `server.js`/census tasks
after the db tasks.

Every `Run:` line is executed **from the repository root**.

---

### Task 39: `http/respond.js` — security headers and `sendJson`

Every response in this service carries `Cache-Control: no-store` plus a fixed security header set,
and the only way to guarantee that is to make the two send functions the only way to write a
response. This module is Tier-1 pure (spec §8.8): it touches no database, filesystem or network.

**Files:**
- Create: `apps/core-api/http/respond.js`
- Test: `apps/core-api/test/respond.test.js`

- [ ] **Step 1: Write the failing test**

```js
// "use strict" is load-bearing here, not decoration: assigning to a frozen object is a silent
// no-op in sloppy mode, so the Object.isFrozen test below would pass vacuously without it.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { SECURITY_HEADERS, sendJson } = require("../http/respond");

function createResponse() {
  return {
    statusCode: 0,
    ended: false,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = String(value);
    },
    end(chunk) {
      this.body = chunk === undefined ? "" : String(chunk);
      this.ended = true;
    }
  };
}

test("sendJson writes the status, the JSON body and an accurate Content-Length", () => {
  const res = createResponse();

  sendJson(res, 201, { ok: true, app: "core-api" });

  assert.equal(res.statusCode, 201);
  assert.equal(res.ended, true);
  assert.equal(res.body, '{"ok":true,"app":"core-api"}');
  assert.equal(res.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(res.headers["Content-Length"], String(Buffer.byteLength(res.body)));
});

test("every response carries no-store and the security headers", () => {
  const res = createResponse();

  sendJson(res, 200, { ok: true });

  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  assert.equal(res.headers["X-Frame-Options"], "DENY");
  assert.equal(res.headers["Content-Security-Policy"], "default-src 'none'; frame-ancestors 'none'");
});

test("SECURITY_HEADERS is frozen so no caller can weaken it for one route", () => {
  assert.equal(Object.isFrozen(SECURITY_HEADERS), true);
  assert.throws(() => {
    SECURITY_HEADERS["Cache-Control"] = "public";
  }, TypeError);
});

test("caller headers merge on top without dropping the base set", () => {
  const res = createResponse();

  sendJson(res, 405, { error: "x" }, { Allow: "GET, HEAD" });

  assert.equal(res.headers.Allow, "GET, HEAD");
  assert.equal(res.headers["Cache-Control"], "no-store");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/respond.test.js`
Expected: FAIL with `Error: Cannot find module '../http/respond'`

- [ ] **Step 3: Write the minimal implementation**

```js
"use strict";

// PURE (spec §8.8 Tier 1): no database, no filesystem, no network, no ambient clock.
// Every response in the service is written through this module, which is what makes
// "no-store and the security headers on EVERY response" a mechanism rather than a promise.
//
// The CSP here is correct for a JSON API. Phase 2 serves the admin UI same-origin at /admin;
// that static handler needs its own, looser policy and must not reuse this one.
// HSTS is deliberately absent — TLS is terminated by Nginx, so it belongs in infra/nginx/.
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
});

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.statusCode = status;
  res.end(text);
}

module.exports = { SECURITY_HEADERS, sendJson };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/respond.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/http/respond.js apps/core-api/test/respond.test.js
git commit -m "feat(core-api): add pure sendJson with no-store and security headers"
```

---

### Task 40: `http/respond.js` — `sendError`, the four-key allowlist and the code-vocabulary cross-check

Spec §6.3.6 mechanism 2: `sendError` serialises only `{code, message, requestId, errors?}` and the
message is looked up from a static table keyed by code — never taken from `Error.message`, never
interpolated with driver output. Mechanism 4(b) is the unit test that a future `ApiError` carrying
a `cause` cannot leak it.

The last test ties this table to `TOP_LEVEL_ERROR_CODES` in `db/errors.js`, so **this task must come
after `db/errors.js` exists**. Two independently hand-transcribed 31-entry tables would otherwise
drift, and the failure mode of a drift is silent: a code missing here degrades a real 409 to a
`500 internal_error` that no other test in Plan 1 would notice. Both modules are Tier-1 pure, so the
cross-check costs no database.

**Files:**
- Modify: `apps/core-api/http/respond.js:1-END`
- Test: `apps/core-api/test/respond.test.js` (append to the end of the file)

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/respond.test.js`:

```js
const { ERROR_MESSAGES, sendError } = require("../http/respond");
const { TOP_LEVEL_ERROR_CODES } = require("../db/errors");

// The scanner from spec §6.3.6 mechanism 4(a). Every error body produced anywhere in the
// suite is checked against it; asserting it here means a bad message string is caught by the
// unit that owns the table rather than by a database suite three plans from now.
const LEAK_SCANNER =
  /(SELECT|INSERT|UPDATE|DELETE|FROM |WHERE |pg_|_key\b|_fkey\b|_check\b|at Object\.|node:internal|\/app\/|scrypt\$|unreachable|checksum_mismatch)/i;

test("sendError serialises exactly the four-key allowlist and drops everything else", () => {
  const res = createResponse();
  const error = new Error("relation \"users\" does not exist");
  error.status = 409;
  error.code = "email_unavailable";
  error.constraint = "users_email_active_key";
  error.detail = "Key (email)=(a@b.test) already exists.";
  error.cause = new Error("pg: 23505");

  sendError(res, error, "k3f9x2ab");

  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId"]);
  assert.equal(body.error.code, "email_unavailable");
  assert.equal(body.error.requestId, "k3f9x2ab");
  assert.doesNotMatch(res.body, /users_email_active_key|does not exist|23505|a@b\.test/);
});

test("the message comes from the static table, never from Error.message", () => {
  const res = createResponse();

  sendError(res, { status: 404, code: "not_found", message: "shop aaaa-0001 is not yours" }, "abcd1234");

  assert.equal(JSON.parse(res.body).error.message, ERROR_MESSAGES.not_found);
  assert.doesNotMatch(res.body, /aaaa-0001|is not yours/);
});

test("errors[] appears only for validation_failed and is reduced to field and code", () => {
  const withErrors = createResponse();
  sendError(
    withErrors,
    { status: 422, code: "validation_failed", errors: [{ field: "timeZone", code: "invalid_time_zone", hint: "Asia/Tokyo" }] },
    "abcd1234"
  );
  const validation = JSON.parse(withErrors.body).error;
  assert.deepEqual(validation.errors, [{ field: "timeZone", code: "invalid_time_zone" }]);

  const without = createResponse();
  sendError(without, { status: 409, code: "shop_name_taken", errors: [{ field: "name", code: "duplicate" }] }, "abcd1234");
  assert.equal("errors" in JSON.parse(without.body).error, false);
});

test("an unknown code degrades to 500 internal_error instead of echoing it", () => {
  const res = createResponse();

  sendError(res, { status: 418, code: "ERR_INVALID_ARG_TYPE" }, "abcd1234");

  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error.code, "internal_error");
});

test("503 always carries Retry-After: 5 and 405 accepts an Allow header", () => {
  const unavailable = createResponse();
  sendError(unavailable, { status: 503, code: "service_unavailable" }, "abcd1234");
  assert.equal(unavailable.headers["Retry-After"], "5");

  const notAllowed = createResponse();
  sendError(notAllowed, { status: 405, code: "method_not_allowed" }, "abcd1234", { Allow: "GET, HEAD" });
  assert.equal(notAllowed.headers.Allow, "GET, HEAD");
  assert.equal(notAllowed.headers["Cache-Control"], "no-store");
});

test("no message in the static table trips the leak scanner", () => {
  // The trap this catches is real and non-obvious: the natural wording for scope_selected is
  // "Clear the SELECTed company", and /SELECT/i matches "selected".
  for (const [code, message] of Object.entries(ERROR_MESSAGES)) {
    assert.doesNotMatch(message, LEAK_SCANNER, `ERROR_MESSAGES.${code}`);
  }
});

test("ERROR_MESSAGES covers exactly the ApiError vocabulary and no code degrades to 500", () => {
  assert.deepEqual(Object.keys(ERROR_MESSAGES).sort(), Object.keys(TOP_LEVEL_ERROR_CODES).sort());

  for (const [code, status] of Object.entries(TOP_LEVEL_ERROR_CODES)) {
    const res = createResponse();
    sendError(res, { status, code }, "abcd1234");
    assert.equal(res.statusCode, status, `${code} silently degraded to ${res.statusCode}`);
    assert.equal(JSON.parse(res.body).error.code, code);
  }
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/respond.test.js`
Expected: FAIL with `TypeError: sendError is not a function`

- [ ] **Step 3: Write the minimal implementation**

Replace `apps/core-api/http/respond.js` entirely:

```js
"use strict";

// PURE (spec §8.8 Tier 1): no database, no filesystem, no network, no ambient clock.
// Every response in the service is written through this module, which is what makes
// "no-store and the security headers on EVERY response" a mechanism rather than a promise.
//
// The CSP here is correct for a JSON API. Phase 2 serves the admin UI same-origin at /admin;
// that static handler needs its own, looser policy and must not reuse this one.
// HSTS is deliberately absent — TLS is terminated by Nginx, so it belongs in infra/nginx/.
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
});

// The closed code vocabulary of spec §6.3.2, with the client-facing message for each. The key
// set is asserted equal to db/errors.js's TOP_LEVEL_ERROR_CODES, which owns the code -> status
// mapping; this table owns nothing but the wording.
//
// A code never changes meaning and a message is never derived from an exception, a driver string
// or user input. Messages are deliberately non-confirming: "email_unavailable" must not tell the
// caller whether the address exists (§5.8(b)). "Chosen", not "selected", in the scope messages —
// the §6.3.6 leak scanner matches /SELECT/i, and "selected" contains it.
const ERROR_MESSAGES = Object.freeze({
  invalid_json: "The request body is not valid JSON.",
  invalid_request: "The request could not be processed.",
  unauthenticated: "Authentication is required.",
  invalid_credentials: "Those sign-in details were not accepted.",
  pairing_failed: "That pairing code was not accepted.",
  forbidden: "You do not have access to that.",
  origin_not_allowed: "The request origin is not allowed.",
  password_change_required: "You must change your password before continuing.",
  self_modification_forbidden: "You cannot make that change to your own account.",
  current_password_invalid: "The current password is incorrect.",
  not_found: "Not found.",
  method_not_allowed: "That method is not allowed for this path.",
  company_name_taken: "That company name is already in use.",
  shop_name_taken: "That shop name is already in use.",
  table_label_taken: "That table label is already in use.",
  terminal_name_taken: "That terminal name is already in use.",
  email_unavailable: "That email address is not available.",
  last_platform_admin: "The last active platform administrator cannot be changed.",
  last_company_admin: "The last active company administrator cannot be changed.",
  role_not_shop_assignable: "That role cannot be assigned to shops.",
  terminal_suspended: "That terminal is suspended.",
  company_suspended: "That company is suspended.",
  scope_required: "Choose a company before using this endpoint.",
  scope_selected: "Clear the chosen company before using this endpoint.",
  acting_company_suspended: "The chosen company is suspended.",
  payload_too_large: "The request body is too large.",
  unsupported_media_type: "Content-Type must be application/json.",
  validation_failed: "The request could not be processed.",
  rate_limited: "Too many requests. Try again shortly.",
  internal_error: "Something went wrong.",
  service_unavailable: "The service is temporarily unavailable."
});

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.statusCode = status;
  res.end(text);
}

// `error` may be any object — an ApiError, a pg error, a plain Error. Only `status`, `code`
// and (for validation_failed) `errors` are ever read; every other property is dropped on the
// floor. That is the property spec §6.3.6 mechanism 4(b) exists to pin down.
//
// Retry-After is added for 503 only. 429 gets one per route in a later plan, because login and
// pair are the two 429s that must NOT carry it (§6.2).
function sendError(res, error, requestId, extraHeaders = {}) {
  const source = error || {};
  let code = typeof source.code === "string" ? source.code : "internal_error";
  let status = Number.isInteger(source.status) ? source.status : 500;
  if (!Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)) {
    code = "internal_error";
    status = 500;
  }

  const payload = { code, message: ERROR_MESSAGES[code], requestId: String(requestId) };
  if (code === "validation_failed" && Array.isArray(source.errors)) {
    payload.errors = source.errors.map((entry) => ({ field: String(entry.field), code: String(entry.code) }));
  }

  const headers = status === 503 ? { "Retry-After": "5", ...extraHeaders } : extraHeaders;
  sendJson(res, status, { error: payload }, headers);
}

module.exports = { SECURITY_HEADERS, ERROR_MESSAGES, sendJson, sendError };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/respond.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/http/respond.js apps/core-api/test/respond.test.js
git commit -m "feat(core-api): add sendError with the four-key allowlist and code vocabulary"
```

---

### Task 41: `http/router.js` — `route()` refuses an undeclared auth mode

Spec §3.2 rule 2 and §6.1: this is the only file in the service that may `require("express")` — which
is why `apps/core-api/package.json` declares `express` alongside `pg`, `pg` being the only dependency
new to the repository. `route()` throws at *registration* time when `auth` is missing. One way to
register a route means one place where authentication can be forgotten: Express's
`app.use('/api/terminal', mw)` boundary-matches on `/`, so a prefix middleware silently fails to
cover `/api/terminals/*`.

Express **4** specifically. Express 5 changes path-pattern syntax and the OPTIONS/HEAD fallbacks the
router tail depends on.

`route-auth.test.js` (last task in this area) asserts set *equality* over the production route table,
so it must not register anything of its own. Every test that needs a scratch route therefore lives in
this separate file, which `node --test` runs in its own process with its own module registry.

**Files:**
- Create: `apps/core-api/http/router.js`
- Test: `apps/core-api/test/router-registration.test.js`

- [ ] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { AUTH_MODES, route, listRoutes } = require("../http/router");
const { sendJson } = require("../http/respond");

// Scratch routes for this file only. They exist so the dispatch tests in later tasks have
// something to hit; route-auth.test.js deliberately registers nothing.
route("GET", "/__probe/ok", { auth: "public" }, (req, res) => sendJson(res, 200, { probe: "get" }));
route("POST", "/__probe/ok", { auth: "public", body: null, audit: "shop.updated" }, (req, res) =>
  sendJson(res, 201, { probe: "post" })
);
route("GET", "/__probe/items/:itemId", { auth: "public", params: { itemId: "uuid" } }, (req, res) =>
  sendJson(res, 200, { itemId: req.params.itemId })
);
route("GET", "/__probe/boom", { auth: "public" }, () => {
  const error = new Error('relation "users" does not exist in SELECT * FROM users');
  error.constraint = "users_email_active_key";
  throw error;
});

test("the three auth modes are the whole vocabulary", () => {
  assert.deepEqual([...AUTH_MODES].sort(), ["public", "terminal", "user"]);
});

test("route() throws when auth is absent — there is no default anywhere", () => {
  assert.throws(
    () => route("GET", "/__probe/undeclared", {}, () => {}),
    /must declare auth as one of user\|terminal\|public/
  );
});

test("route() throws for an auth value outside the vocabulary", () => {
  for (const bad of ["admin", "USER", null, true, ""]) {
    assert.throws(
      () => route("GET", "/__probe/undeclared", { auth: bad }, () => {}),
      /must declare auth as one of user\|terminal\|public/,
      `auth: ${JSON.stringify(bad)}`
    );
  }
});

test("route() throws when options is missing entirely", () => {
  assert.throws(() => route("GET", "/__probe/undeclared", undefined, () => {}), /needs an options object declaring auth/);
});

test("route() rejects an unknown method, a relative path and a missing handler", () => {
  assert.throws(() => route("get", "/__probe/x", { auth: "public" }, () => {}), /method must be one of/);
  assert.throws(() => route("OPTIONS", "/__probe/x", { auth: "public" }, () => {}), /method must be one of/);
  assert.throws(() => route("GET", "__probe/x", { auth: "public" }, () => {}), /path must be a string starting with/);
  assert.throws(() => route("GET", "/__probe/x", { auth: "public" }, null), /needs a handler function/);
});

test("route() rejects a duplicate method+path", () => {
  assert.throws(() => route("GET", "/__probe/ok", { auth: "public" }, () => {}), /duplicate registration for GET \/__probe\/ok/);
});

test("listRoutes() returns the registered entries with frozen options", () => {
  const entry = listRoutes().find((candidate) => candidate.key === "GET /__probe/ok");

  assert.ok(entry, "GET /__probe/ok should be registered");
  assert.equal(entry.method, "GET");
  assert.equal(entry.path, "/__probe/ok");
  assert.equal(entry.options.auth, "public");
  assert.equal(Object.isFrozen(entry.options), true);
  assert.equal(typeof entry.handler, "function");
});

test("listRoutes() hands back a copy, so a caller cannot mutate the table", () => {
  const before = listRoutes().length;
  listRoutes().push({ key: "GET /injected" });
  assert.equal(listRoutes().length, before);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/router-registration.test.js`
Expected: FAIL with `Error: Cannot find module '../http/router'`

- [ ] **Step 3: Write the minimal implementation**

```js
"use strict";

const express = require("express");

// Spec §3.2 rule 2: this is the ONLY file in the service that may require("express"), and
// source-structure.test.js rule C3 asserts that by name. One registration function means one
// place where authentication can be forgotten. Express 4 — Express 5 changes path-pattern
// syntax and the OPTIONS/HEAD fallbacks the tail below depends on.

const AUTH_MODES = Object.freeze(["user", "terminal", "public"]);
const METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const routes = [];

// Compiled here rather than borrowed from Express's internals because the 404/405 tail needs
// to answer "which methods are registered for this path" for a path that matched no route.
function pathToRegExp(pattern) {
  const source = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}/?$`);
}

function route(method, path, options, handler) {
  if (!METHODS.includes(method)) {
    throw new Error(`route(): method must be one of ${METHODS.join(", ")}, got ${JSON.stringify(method)}`);
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(`route(): path must be a string starting with "/", got ${JSON.stringify(path)}`);
  }
  if (options === null || typeof options !== "object") {
    throw new Error(`route(): ${method} ${path} needs an options object declaring auth`);
  }
  if (!AUTH_MODES.includes(options.auth)) {
    throw new Error(
      `route(): ${method} ${path} must declare auth as one of ${AUTH_MODES.join("|")}, got ${JSON.stringify(options.auth)}`
    );
  }
  if (typeof handler !== "function") {
    throw new Error(`route(): ${method} ${path} needs a handler function`);
  }

  const key = `${method} ${path}`;
  if (routes.some((entry) => entry.key === key)) {
    throw new Error(`route(): duplicate registration for ${key}`);
  }

  const entry = Object.freeze({
    key,
    method,
    path,
    options: Object.freeze({ ...options }),
    handler,
    pattern: pathToRegExp(path)
  });
  routes.push(entry);
  return entry;
}

function listRoutes() {
  return routes.slice();
}

module.exports = { AUTH_MODES, METHODS, route, listRoutes };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/router-registration.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/http/router.js apps/core-api/test/router-registration.test.js
git commit -m "feat(core-api): add route() that throws on an undeclared auth mode"
```

---

### Task 42: `http/router.js` — `validateRouteTable()`, the boot-time rules

Spec §8.5 lists ten rules. This task implements the ones that are structural invariants of *any*
table and that hold with only health registered; the rest are named in a comment with the plan
that activates them, so nobody has to re-derive why they are absent.

| Rule | Where it lives now |
| --- | --- |
| 1 auth in the vocabulary | boot (`validateRouteTable`) — also enforced by `route()` |
| 2 public set equals the settled four | **test only** (last task in this area). A boot-time census makes the service un-bootable at every intermediate commit; the teeth belong in `route-auth.test.js`, which asserts the Plan-1 subset and is widened by Plan 2. |
| 3 must-change-password exempt set | test only; asserted empty in Plan 1 |
| 4 no duplicates / `:param` has a `params` entry / non-GET declares `body` + `audit` | boot |
| 4 (audit value is a member of the §5.9 table; GET collections declare `query`) | **Plan 2** — the closed audit vocabulary and the §5.7 limiter roster arrive with the first non-GET route. Boot checks the *shape* `noun.verb` now so Plan 2 cannot invent free-form strings. |
| 5 terminal paths under `/api/terminal/`; `auth:'user'` declares roles from the four aliases | boot |
| 6 terminal-administration nesting | **Plan 2** (needs terminal routes to exist) |
| 7 a `Location` emitter has a registered GET | **Plan 2** (needs a 201 route) |
| 8 principal-keyed limit implies non-public auth | boot — spec §6.3.5 names this one a boot assertion explicitly |
| 9 HEAD/OPTIONS dispatch | next task (behaviour, not table validation) |
| 10 every entry declares a `sample` | test only |

**Files:**
- Modify: `apps/core-api/http/router.js:1-END`
- Test: `apps/core-api/test/router-registration.test.js` (append to the end of the file)

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/router-registration.test.js`:

```js
const { ROLE_ALIASES, validateRouteTable } = require("../http/router");

// validateRouteTable takes the entries as a parameter precisely so the rules can be exercised
// against synthetic tables without polluting the live registry that route-auth.test.js censuses.
function entry(method, path, options) {
  return { key: `${method} ${path}`, method, path, options };
}

test("the four role aliases of spec 5.4 are the whole vocabulary", () => {
  assert.deepEqual([...ROLE_ALIASES].sort(), ["anyUser", "companyAdmin", "manager", "platform"]);
});

test("validateRouteTable accepts the live table", () => {
  assert.equal(validateRouteTable().length, listRoutes().length);
});

test("rule 1: an auth mode outside the vocabulary is fatal at boot", () => {
  assert.throws(() => validateRouteTable([entry("GET", "/x", { auth: "sometimes" })]), /unknown auth mode/);
});

test("rule 4: a duplicate method+path is fatal at boot", () => {
  assert.throws(
    () => validateRouteTable([entry("GET", "/x", { auth: "public" }), entry("GET", "/x", { auth: "public" })]),
    /duplicate GET \/x/
  );
});

test("rule 4: a :param with no params entry is fatal", () => {
  assert.throws(
    () => validateRouteTable([entry("GET", "/shops/:shopId", { auth: "public" })]),
    /path parameter :shopId with no params entry/
  );
  assert.doesNotThrow(() => validateRouteTable([entry("GET", "/shops/:shopId", { auth: "public", params: { shopId: "uuid" } })]));
});

test("rule 4: a non-GET route must declare body and an audit action", () => {
  assert.throws(
    () => validateRouteTable([entry("POST", "/x", { auth: "public", audit: "shop.created" })]),
    /must declare body \(null when it takes none\)/
  );
  assert.throws(() => validateRouteTable([entry("POST", "/x", { auth: "public", body: null })]), /must declare an audit action/);
  assert.throws(
    () => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: "shopCreated" })]),
    /must declare an audit action/
  );
  assert.doesNotThrow(() => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: "shop.created" })]));
});

test("rule 5: an auth:'terminal' route outside /api/terminal/ is fatal", () => {
  assert.throws(() => validateRouteTable([entry("GET", "/api/admin/me", { auth: "terminal" })]), /is not under \/api\/terminal\//);
  assert.doesNotThrow(() => validateRouteTable([entry("GET", "/api/terminal/me", { auth: "terminal" })]));
});

test("rule 5: an auth:'user' route needs a non-empty roles list from the four aliases", () => {
  assert.throws(() => validateRouteTable([entry("GET", "/api/admin/shops", { auth: "user" })]), /must declare a non-empty roles array/);
  assert.throws(() => validateRouteTable([entry("GET", "/api/admin/shops", { auth: "user", roles: [] })]), /must declare a non-empty roles array/);
  assert.throws(
    () => validateRouteTable([entry("GET", "/api/admin/shops", { auth: "user", roles: ["shop_manager"] })]),
    /unknown role alias "shop_manager"/
  );
  assert.doesNotThrow(() => validateRouteTable([entry("GET", "/api/admin/shops", { auth: "user", roles: ["anyUser"] })]));
});

test("rule 8: a principal-keyed rate limit on a public route is fatal", () => {
  assert.throws(
    () =>
      validateRouteTable([
        entry("POST", "/api/terminal/pair", {
          auth: "public",
          body: null,
          audit: "terminal.paired",
          limit: { key: "user", name: "create-user" }
        })
      ]),
    /keys a rate-limit bucket on "user" but is auth:'public'/
  );
  assert.doesNotThrow(() =>
    validateRouteTable([
      entry("POST", "/api/terminal/pair", {
        auth: "public",
        body: null,
        audit: "terminal.paired",
        limit: { key: "ip", name: "pair-global" }
      })
    ])
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/router-registration.test.js`
Expected: FAIL with `TypeError: validateRouteTable is not a function`

- [ ] **Step 3: Write the minimal implementation**

Replace `apps/core-api/http/router.js` entirely:

```js
"use strict";

const express = require("express");

// Spec §3.2 rule 2: this is the ONLY file in the service that may require("express"), and
// source-structure.test.js rule C3 asserts that by name. One registration function means one
// place where authentication can be forgotten. Express 4 — Express 5 changes path-pattern
// syntax and the OPTIONS/HEAD fallbacks the tail below depends on.

const AUTH_MODES = Object.freeze(["user", "terminal", "public"]);
const METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// Spec §5.4. A scoped platform_admin materialises role 'platform_admin' (rank 3), so the rank
// lattice does the work and no fifth alias is needed.
const ROLE_ALIASES = Object.freeze(["platform", "companyAdmin", "manager", "anyUser"]);
// Spec §6.3.5: buckets keyed on a principal cannot exist before credential resolution.
const PRINCIPAL_LIMIT_KEYS = Object.freeze(["user", "terminal"]);
const AUDIT_ACTION_SHAPE = /^[a-z_]+\.[a-z_]+$/;

const routes = [];

// Compiled here rather than borrowed from Express's internals because the 404/405 tail needs
// to answer "which methods are registered for this path" for a path that matched no route.
function pathToRegExp(pattern) {
  const source = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}/?$`);
}

function route(method, path, options, handler) {
  if (!METHODS.includes(method)) {
    throw new Error(`route(): method must be one of ${METHODS.join(", ")}, got ${JSON.stringify(method)}`);
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(`route(): path must be a string starting with "/", got ${JSON.stringify(path)}`);
  }
  if (options === null || typeof options !== "object") {
    throw new Error(`route(): ${method} ${path} needs an options object declaring auth`);
  }
  if (!AUTH_MODES.includes(options.auth)) {
    throw new Error(
      `route(): ${method} ${path} must declare auth as one of ${AUTH_MODES.join("|")}, got ${JSON.stringify(options.auth)}`
    );
  }
  if (typeof handler !== "function") {
    throw new Error(`route(): ${method} ${path} needs a handler function`);
  }

  const key = `${method} ${path}`;
  if (routes.some((entry) => entry.key === key)) {
    throw new Error(`route(): duplicate registration for ${key}`);
  }

  const entry = Object.freeze({
    key,
    method,
    path,
    options: Object.freeze({ ...options }),
    handler,
    pattern: pathToRegExp(path)
  });
  routes.push(entry);
  return entry;
}

function listRoutes() {
  return routes.slice();
}

// Spec §8.5 rules 1, 4, 5 and 8 — the ones that are invariants of any table and hold with only
// health registered. Deliberately NOT here:
//   rule 2  (the public set equals the settled four) and rule 3 (the exempt set) — a census at
//           boot makes the service un-bootable at every intermediate commit; both live in
//           route-auth.test.js, which asserts set EQUALITY and so fails on an addition too.
//   rule 4's audit-vocabulary membership (§5.9) and the §5.7 limiter roster — Plan 2, with the
//           first non-GET route. The noun.verb shape is checked now so Plan 2 cannot invent
//           free-form strings and then have to reconcile them against the CHECK regex.
//   rule 6  (terminal-administration nesting) and rule 7 (a Location emitter has a GET) — Plan 2.
//   rule 9  is dispatch behaviour, in createApp(). Rule 10 is a test assertion.
// Takes `entries` as a parameter so the rules can be unit-tested on synthetic tables.
function validateRouteTable(entries = routes) {
  const seen = new Set();

  for (const item of entries) {
    const { method, path, options } = item;
    const where = `${method} ${path}`;

    if (!AUTH_MODES.includes(options.auth)) {
      throw new Error(`route table: ${where} declares an unknown auth mode ${JSON.stringify(options.auth)}`);
    }
    if (seen.has(item.key)) throw new Error(`route table: duplicate ${where}`);
    seen.add(item.key);

    for (const segment of path.split("/")) {
      if (!segment.startsWith(":")) continue;
      const name = segment.slice(1);
      if (!options.params || !Object.prototype.hasOwnProperty.call(options.params, name)) {
        throw new Error(`route table: ${where} has path parameter :${name} with no params entry`);
      }
    }

    if (method !== "GET") {
      if (!Object.prototype.hasOwnProperty.call(options, "body")) {
        throw new Error(`route table: ${where} must declare body (null when it takes none)`);
      }
      if (typeof options.audit !== "string" || !AUDIT_ACTION_SHAPE.test(options.audit)) {
        throw new Error(`route table: ${where} must declare an audit action of the form "noun.verb"`);
      }
    }

    if (options.auth === "terminal" && !path.startsWith("/api/terminal/")) {
      throw new Error(`route table: ${where} is auth:'terminal' but is not under /api/terminal/`);
    }

    if (options.auth === "user") {
      if (!Array.isArray(options.roles) || options.roles.length === 0) {
        throw new Error(`route table: ${where} is auth:'user' and must declare a non-empty roles array`);
      }
      for (const role of options.roles) {
        if (!ROLE_ALIASES.includes(role)) {
          throw new Error(`route table: ${where} declares unknown role alias ${JSON.stringify(role)}`);
        }
      }
    }

    if (options.limit && PRINCIPAL_LIMIT_KEYS.includes(options.limit.key) && options.auth === "public") {
      throw new Error(
        `route table: ${where} keys a rate-limit bucket on "${options.limit.key}" but is auth:'public' — that principal does not exist yet`
      );
    }
  }

  return entries;
}

module.exports = { AUTH_MODES, METHODS, ROLE_ALIASES, route, listRoutes, validateRouteTable };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/router-registration.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/http/router.js apps/core-api/test/router-registration.test.js
git commit -m "feat(core-api): validate the route table at boot"
```

---

### Task 43: `http/router.js` — `createApp()`, dispatch, the request log and the 404/405 tail

Three things earn their keep here.

**HEAD.** Spec §8.5 rule 9: the container healthcheck uses `wget --spider`, which issues HEAD. If
HEAD does not resolve through the same table as GET, the container is permanently unhealthy,
`depends_on: condition: service_healthy` never releases, and the failure presents as a database
problem. Because every route is dispatched by its own declaration rather than by a path-prefix
middleware, HEAD inherits GET's declaration for free — and the `Allow` computation must add HEAD
wherever GET is registered.

**The tail must be an `app.use` after the routes.** Express 4 has a built-in OPTIONS responder that
would answer `200 + Allow`; it only fires after the whole stack declines, so a tail registered last
pre-empts it and OPTIONS gets the 405 the spec asks for.

**The log line.** Spec §6.3.6: method, route *pattern*, status, duration, requestId, actor — never
the raw path, never the query string, never a body, never headers. This is the explicit rejection of
`morgan("combined")` at `apps/epaper-hub/server.js:32`, which writes the full URL including the
`?api_key=` that line 89 accepts.

**Files:**
- Modify: `apps/core-api/http/router.js:1-END`
- Test: `apps/core-api/test/router-registration.test.js` (append to the end of the file)

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/router-registration.test.js`:

```js
const { createApp } = require("../http/router");

// Plan 2 extracts this into testing/http.js when the explicit cookie jar arrives (spec §8.1);
// twelve duplicated lines is cheaper than a helper nothing else uses yet.
async function withServer(deps, run) {
  const app = createApp(deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function captureLog() {
  const lines = [];
  const log = (line) => lines.push(line);
  log.access = () => lines.map((line) => JSON.parse(line)).filter((record) => record.level === undefined);
  log.raw = () => lines;
  return log;
}

test("GET dispatches through the table and carries the base headers", async () => {
  await withServer({ log: captureLog() }, async (base) => {
    const response = await fetch(`${base}/__probe/ok`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { probe: "get" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
});

test("HEAD resolves through the same table as GET, with the body stripped", async () => {
  await withServer({ log: captureLog() }, async (base) => {
    const response = await fetch(`${base}/__probe/ok`, { method: "HEAD" });

    assert.equal(response.status, 200, "the wget --spider healthcheck issues HEAD");
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength('{"probe":"get"}')));
  });
});

test("a path parameter reaches the handler", async () => {
  await withServer({ log: captureLog() }, async (base) => {
    const response = await fetch(`${base}/__probe/items/abc123`);
    assert.deepEqual(await response.json(), { itemId: "abc123" });
  });
});

test("an unregistered method on a known path is 405 with Allow, and HEAD counts as GET", async () => {
  await withServer({ log: captureLog() }, async (base) => {
    for (const method of ["DELETE", "PATCH", "OPTIONS"]) {
      const response = await fetch(`${base}/__probe/ok`, { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("allow"), "GET, HEAD, POST", method);
      if (method !== "OPTIONS") continue;
      const body = await response.json();
      assert.equal(body.error.code, "method_not_allowed");
    }
  });
});

test("an unknown path is 404 not_found with an 8-character requestId", async () => {
  await withServer({ log: captureLog() }, async (base) => {
    const response = await fetch(`${base}/__probe/nowhere`);

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("allow"), null);
    const body = await response.json();
    assert.equal(body.error.code, "not_found");
    assert.match(body.error.requestId, /^[A-Za-z0-9_-]{8}$/);
  });
});

test("a throwing handler becomes an opaque 500 that leaks no driver text", async () => {
  await withServer({ log: captureLog() }, async (base) => {
    const response = await fetch(`${base}/__probe/boom`);

    assert.equal(response.status, 500);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, "internal_error");
    assert.doesNotMatch(text, /SELECT|users_email_active_key|does not exist|at Object\./);
  });
});

test("the request log records the route pattern, never the raw path or query string", async () => {
  const log = captureLog();
  await withServer({ log }, async (base) => {
    await fetch(`${base}/__probe/items/abc123?token=leaked-secret`);
  });

  const access = log.access();
  assert.equal(access.length, 1, "exactly one access line per request");
  assert.equal(access[0].route, "/__probe/items/:itemId");
  assert.equal(access[0].method, "GET");
  assert.equal(access[0].status, 200);
  assert.equal(access[0].actorKind, "anonymous");
  assert.equal(access[0].actorId, null);
  assert.equal(typeof access[0].durationMs, "number");
  assert.match(access[0].requestId, /^[A-Za-z0-9_-]{8}$/);
  for (const line of log.raw()) {
    assert.doesNotMatch(line, /leaked-secret|abc123/, "neither the query string nor the raw segment may be logged");
  }
});

test("the logged requestId is the one the client was given", async () => {
  const log = captureLog();
  let seen;
  await withServer({ log }, async (base) => {
    seen = (await (await fetch(`${base}/__probe/nowhere`)).json()).error.requestId;
  });

  assert.equal(log.access()[0].requestId, seen);
  assert.equal(log.access()[0].route, null, "an unmatched request has no pattern to log");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/router-registration.test.js`
Expected: FAIL with `TypeError: createApp is not a function`

- [ ] **Step 3: Write the minimal implementation**

Replace `apps/core-api/http/router.js` entirely:

```js
"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { sendError } = require("./respond");

// Spec §3.2 rule 2: this is the ONLY file in the service that may require("express"), and
// source-structure.test.js rule C3 asserts that by name. One registration function means one
// place where authentication can be forgotten. Express 4 — Express 5 changes path-pattern
// syntax and the OPTIONS/HEAD fallbacks the tail below depends on.

const AUTH_MODES = Object.freeze(["user", "terminal", "public"]);
const METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// Spec §5.4. A scoped platform_admin materialises role 'platform_admin' (rank 3), so the rank
// lattice does the work and no fifth alias is needed.
const ROLE_ALIASES = Object.freeze(["platform", "companyAdmin", "manager", "anyUser"]);
// Spec §6.3.5: buckets keyed on a principal cannot exist before credential resolution.
const PRINCIPAL_LIMIT_KEYS = Object.freeze(["user", "terminal"]);
const AUDIT_ACTION_SHAPE = /^[a-z_]+\.[a-z_]+$/;

const routes = [];

// Compiled here rather than borrowed from Express's internals because the 404/405 tail needs
// to answer "which methods are registered for this path" for a path that matched no route.
function pathToRegExp(pattern) {
  const source = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}/?$`);
}

function route(method, path, options, handler) {
  if (!METHODS.includes(method)) {
    throw new Error(`route(): method must be one of ${METHODS.join(", ")}, got ${JSON.stringify(method)}`);
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(`route(): path must be a string starting with "/", got ${JSON.stringify(path)}`);
  }
  if (options === null || typeof options !== "object") {
    throw new Error(`route(): ${method} ${path} needs an options object declaring auth`);
  }
  if (!AUTH_MODES.includes(options.auth)) {
    throw new Error(
      `route(): ${method} ${path} must declare auth as one of ${AUTH_MODES.join("|")}, got ${JSON.stringify(options.auth)}`
    );
  }
  if (typeof handler !== "function") {
    throw new Error(`route(): ${method} ${path} needs a handler function`);
  }

  const key = `${method} ${path}`;
  if (routes.some((entry) => entry.key === key)) {
    throw new Error(`route(): duplicate registration for ${key}`);
  }

  const entry = Object.freeze({
    key,
    method,
    path,
    options: Object.freeze({ ...options }),
    handler,
    pattern: pathToRegExp(path)
  });
  routes.push(entry);
  return entry;
}

function listRoutes() {
  return routes.slice();
}

// Spec §8.5 rules 1, 4, 5 and 8 — the ones that are invariants of any table and hold with only
// health registered. Deliberately NOT here:
//   rule 2  (the public set equals the settled four) and rule 3 (the exempt set) — a census at
//           boot makes the service un-bootable at every intermediate commit; both live in
//           route-auth.test.js, which asserts set EQUALITY and so fails on an addition too.
//   rule 4's audit-vocabulary membership (§5.9) and the §5.7 limiter roster — Plan 2, with the
//           first non-GET route. The noun.verb shape is checked now so Plan 2 cannot invent
//           free-form strings and then have to reconcile them against the CHECK regex.
//   rule 6  (terminal-administration nesting) and rule 7 (a Location emitter has a GET) — Plan 2.
//   rule 9  is dispatch behaviour, in createApp(). Rule 10 is a test assertion.
// Takes `entries` as a parameter so the rules can be unit-tested on synthetic tables.
function validateRouteTable(entries = routes) {
  const seen = new Set();

  for (const item of entries) {
    const { method, path, options } = item;
    const where = `${method} ${path}`;

    if (!AUTH_MODES.includes(options.auth)) {
      throw new Error(`route table: ${where} declares an unknown auth mode ${JSON.stringify(options.auth)}`);
    }
    if (seen.has(item.key)) throw new Error(`route table: duplicate ${where}`);
    seen.add(item.key);

    for (const segment of path.split("/")) {
      if (!segment.startsWith(":")) continue;
      const name = segment.slice(1);
      if (!options.params || !Object.prototype.hasOwnProperty.call(options.params, name)) {
        throw new Error(`route table: ${where} has path parameter :${name} with no params entry`);
      }
    }

    if (method !== "GET") {
      if (!Object.prototype.hasOwnProperty.call(options, "body")) {
        throw new Error(`route table: ${where} must declare body (null when it takes none)`);
      }
      if (typeof options.audit !== "string" || !AUDIT_ACTION_SHAPE.test(options.audit)) {
        throw new Error(`route table: ${where} must declare an audit action of the form "noun.verb"`);
      }
    }

    if (options.auth === "terminal" && !path.startsWith("/api/terminal/")) {
      throw new Error(`route table: ${where} is auth:'terminal' but is not under /api/terminal/`);
    }

    if (options.auth === "user") {
      if (!Array.isArray(options.roles) || options.roles.length === 0) {
        throw new Error(`route table: ${where} is auth:'user' and must declare a non-empty roles array`);
      }
      for (const role of options.roles) {
        if (!ROLE_ALIASES.includes(role)) {
          throw new Error(`route table: ${where} declares unknown role alias ${JSON.stringify(role)}`);
        }
      }
    }

    if (options.limit && PRINCIPAL_LIMIT_KEYS.includes(options.limit.key) && options.auth === "public") {
      throw new Error(
        `route table: ${where} keys a rate-limit bucket on "${options.limit.key}" but is auth:'public' — that principal does not exist yet`
      );
    }
  }

  return entries;
}

function allowedMethods(pathname) {
  const allowed = new Set();
  for (const entry of routes) {
    if (!entry.pattern.test(pathname)) continue;
    allowed.add(entry.method);
    // Spec §8.5 rule 9: HEAD resolves through the GET entry, so it belongs in Allow.
    if (entry.method === "GET") allowed.add("HEAD");
  }
  return [...allowed].sort();
}

function createApp(deps = {}) {
  validateRouteTable();

  const log = typeof deps.log === "function" ? deps.log : (line) => process.stdout.write(`${line}\n`);
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  // "simple" is node:querystring, not qs — nothing in this service reads req.query, and the
  // extended parser is prototype-pollution surface for no benefit.
  app.set("query parser", "simple");
  // Deliberately NOT app.set("trust proxy"): the client IP is derived explicitly from
  // TRUSTED_PROXY_HOPS in lib/client-ip.js (Plan 2). Two derivation paths is one too many.

  // Pipeline step 1 (spec §6.3.5): requestId first. The security headers and Cache-Control are
  // applied by http/respond.js on the way out, which covers every response including the tails.
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    req.core = {
      requestId: crypto.randomBytes(6).toString("base64url"),
      routePattern: null,
      actorKind: "anonymous",
      actorId: null,
      logExtra: {},
      deps
    };
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // One structured line per request. The route PATTERN, never req.originalUrl — that is the
      // explicit rejection of morgan("combined") at apps/epaper-hub/server.js:32, which writes
      // the full URL including the ?api_key= that line 89 accepts. Never a body, never headers.
      // logExtra is written only by handlers, and only with closed vocabularies.
      log(
        JSON.stringify({
          method: req.method,
          route: req.core.routePattern,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          requestId: req.core.requestId,
          actorKind: req.core.actorKind,
          actorId: req.core.actorId,
          ...req.core.logExtra
        })
      );
    });
    next();
  });

  for (const entry of routes) {
    app[entry.method.toLowerCase()](entry.path, (req, res, next) => {
      req.core.routePattern = entry.path;
      try {
        const result = entry.handler(req, res);
        if (result && typeof result.then === "function") result.then(undefined, next);
      } catch (error) {
        next(error);
      }
    });
  }

  // The 404/405 tail. It MUST be registered after every route: Express 4's built-in OPTIONS
  // responder only fires once the whole stack declines, so a tail registered last pre-empts it
  // and OPTIONS gets 405 + Allow rather than a silent 200.
  app.use((req, res) => {
    const allowed = allowedMethods(req.path);
    if (allowed.length === 0) {
      sendError(res, { status: 404, code: "not_found" }, req.core.requestId);
      return;
    }
    sendError(res, { status: 405, code: "method_not_allowed" }, req.core.requestId, { Allow: allowed.join(", ") });
  });

  // Four parameters is what marks this as Express's error handler; `next` is unused on purpose.
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = Number.isInteger(error && error.status) ? error.status : 500;
    if (status >= 500) {
      // The message goes to the LOG, never to the response — that asymmetry is the whole point
      // of the requestId. This is a second line for the same request, tagged with a level so the
      // access log stays one-line-per-request.
      log(
        JSON.stringify({
          level: "error",
          requestId: req.core.requestId,
          route: req.core.routePattern,
          status,
          message: String((error && error.message) || error)
        })
      );
    }
    sendError(res, error, req.core.requestId);
  });

  return app;
}

module.exports = { AUTH_MODES, METHODS, ROLE_ALIASES, route, listRoutes, validateRouteTable, createApp };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/router-registration.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/http/router.js apps/core-api/test/router-registration.test.js
git commit -m "feat(core-api): add createApp with HEAD-aware dispatch and the JSON 404/405 tail"
```

---

### Task 44: `http/routes/health.js` — `GET /health`

Spec §6.2: liveness touches no database, so a DB blip cannot mark the container unhealthy
mid-incident. The test asserts the probe is never called, which is the only way that property stays
true once Plan 2 starts adding dependencies to this file.

**Files:**
- Create: `apps/core-api/http/routes/health.js`
- Test: `apps/core-api/test/health.test.js`

- [ ] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const test = require("node:test");
require("../http/routes/health");
const { createApp } = require("../http/router");

// Spec §8.1: the real Express app on app.listen(0) driven by global fetch — a departure from
// server.inject() at apps/customer-order/server.js:350, whose fake res stores headers in a plain
// object and so cannot represent two Set-Cookie values of the same name. Plan 2 extracts this
// helper into testing/http.js when the explicit cookie jar arrives.
async function withServer(deps, run) {
  const app = createApp(deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function captureLog() {
  const lines = [];
  const log = (line) => lines.push(line);
  log.access = () => lines.map((line) => JSON.parse(line)).filter((record) => record.level === undefined);
  log.raw = () => lines;
  return log;
}

test("GET /health is 200 and never touches the database", async () => {
  let probeCalls = 0;
  const deps = {
    log: captureLog(),
    checkReadiness: async () => {
      probeCalls += 1;
      return { database: "ready", migrations: "current" };
    }
  };

  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, app: "core-api" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  assert.equal(probeCalls, 0, "liveness must not depend on the database — a DB blip cannot mark the container unhealthy");
});

test("HEAD /health is 200 with no body — this is what the container healthcheck issues", async () => {
  await withServer({ log: captureLog(), checkReadiness: async () => ({ database: "ready", migrations: "current" }) }, async (base) => {
    const response = await fetch(`${base}/health`, { method: "HEAD" });

    assert.equal(response.status, 200, "wget --spider issues HEAD; a 405 here makes the container permanently unhealthy");
    assert.equal(await response.text(), "");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/health.test.js`
Expected: FAIL with `Error: Cannot find module '../http/routes/health'`

- [ ] **Step 3: Write the minimal implementation**

```js
"use strict";

const { route } = require("../router");
const { sendJson } = require("../respond");

// Spec §6.2: liveness. Touches no database, so a database blip cannot mark the container
// unhealthy mid-incident. This is what the Docker healthcheck calls.
route("GET", "/health", { auth: "public" }, (req, res) => {
  sendJson(res, 200, { ok: true, app: "core-api" });
});
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/health.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/http/routes/health.js apps/core-api/test/health.test.js
git commit -m "feat(core-api): add GET /health liveness route"
```

---

### Task 45: `http/routes/health.js` — `GET /health/ready`

Spec §6.3.6: readiness is *inside* the leak rule, not outside it. The public 503 body is the ordinary
opaque envelope; the closed-vocabulary `checks` (`ready|unreachable|timeout`,
`current|pending|checksum_mismatch`) go to the request log against the same requestId. That
vocabulary is a precise "the database is down and a migration is mid-flight" signal — otherwise
protected only by one line in an Nginx file that startup validation cannot see and no test can
observe.

The probe itself is injected. `db/health.js` owns talking to Postgres; injecting it here is what
lets this suite assert the `checksum_mismatch` and `timeout` branches, which no real database can
be made to produce on demand.

**Files:**
- Modify: `apps/core-api/http/routes/health.js:1-END`
- Test: `apps/core-api/test/health.test.js` (append to the end of the file)

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/health.test.js`:

```js
function readyDeps(checks, log) {
  return { log, checkReadiness: async () => checks };
}

test("GET /health/ready is 200 when the database answers and the ledger is current", async () => {
  await withServer(readyDeps({ database: "ready", migrations: "current" }, captureLog()), async (base) => {
    const response = await fetch(`${base}/health/ready`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, app: "core-api" });
  });
});

test("every not-ready combination is 503 with the ordinary opaque envelope", async () => {
  const cases = [
    { database: "unreachable", migrations: "current" },
    { database: "timeout", migrations: "current" },
    { database: "ready", migrations: "pending" },
    { database: "ready", migrations: "checksum_mismatch" }
  ];

  for (const checks of cases) {
    await withServer(readyDeps(checks, captureLog()), async (base) => {
      const response = await fetch(`${base}/health/ready`);
      const text = await response.text();

      assert.equal(response.status, 503, JSON.stringify(checks));
      assert.equal(response.headers.get("retry-after"), "5");
      const body = JSON.parse(text);
      assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId"]);
      assert.equal(body.error.code, "service_unavailable");
      assert.doesNotMatch(text, /unreachable|timeout|pending|checksum_mismatch/, JSON.stringify(checks));
    });
  }
});

test("the checks vocabulary reaches the request log against the same requestId", async () => {
  const log = captureLog();
  let requestId;

  await withServer(readyDeps({ database: "ready", migrations: "checksum_mismatch" }, log), async (base) => {
    requestId = (await (await fetch(`${base}/health/ready`)).json()).error.requestId;
  });

  const access = log.access();
  assert.equal(access.length, 1);
  assert.equal(access[0].requestId, requestId);
  assert.equal(access[0].route, "/health/ready");
  assert.equal(access[0].status, 503);
  assert.deepEqual(access[0].checks, { database: "ready", migrations: "checksum_mismatch" });
});

test("a probe that throws is 503 with database unreachable, not a 500", async () => {
  const log = captureLog();

  await withServer(
    {
      log,
      checkReadiness: async () => {
        throw new Error("connect ECONNREFUSED 172.19.0.2:5432");
      }
    },
    async (base) => {
      const response = await fetch(`${base}/health/ready`);
      const text = await response.text();

      assert.equal(response.status, 503);
      assert.equal(JSON.parse(text).error.code, "service_unavailable");
      assert.doesNotMatch(text, /ECONNREFUSED|172\.19/);
    }
  );

  assert.deepEqual(log.access()[0].checks, { database: "unreachable" });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/health.test.js`
Expected: FAIL with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 404 !== 200` (the route is not registered, so the 404 tail answers)

- [ ] **Step 3: Write the minimal implementation**

Replace `apps/core-api/http/routes/health.js` entirely:

```js
"use strict";

const { route } = require("../router");
const { sendJson, sendError } = require("../respond");

// Spec §6.2: liveness. Touches no database, so a database blip cannot mark the container
// unhealthy mid-incident. This is what the Docker healthcheck calls.
route("GET", "/health", { auth: "public" }, (req, res) => {
  sendJson(res, 200, { ok: true, app: "core-api" });
});

// Spec §6.2: readiness — SELECT 1 with a 2s statement timeout plus schema_migrations against the
// on-disk file list. This is what the deploy gate calls, and Nginx 404s it publicly.
//
// Spec §6.3.6: readiness is INSIDE the leak rule. The 503 body is the ordinary opaque envelope;
// the closed-vocabulary checks (ready|unreachable|timeout, current|pending|checksum_mismatch) go
// to the request log against the same requestId and never to the client.
route("GET", "/health/ready", { auth: "public" }, async (req, res) => {
  let checks;
  try {
    checks = await req.core.deps.checkReadiness();
  } catch {
    // db/health.js's checkReadiness contract is "never throws"; if it does anyway, the database
    // is what is unreachable. `migrations` is omitted rather than guessed — the vocabulary
    // stays closed, and a contract violation degrades to 503 rather than to a 500.
    checks = { database: "unreachable" };
  }
  req.core.logExtra.checks = checks;

  if (checks.database === "ready" && checks.migrations === "current") {
    sendJson(res, 200, { ok: true, app: "core-api" });
    return;
  }
  sendError(res, { status: 503, code: "service_unavailable" }, req.core.requestId);
});
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/health.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/http/routes/health.js apps/core-api/test/health.test.js
git commit -m "feat(core-api): add GET /health/ready with an opaque 503 and logged checks"
```

---

### Task 46: `server.js` — `listenServer` and the `start()` bootstrap order

Spec §3.1 and §9.4: validate configuration → run migrations → open the runtime pool → listen, and
it fails closed. This mirrors `apps/customer-order/server.js:455-474`, where all twelve e-paper
displays are reset before the port accepts traffic. The order is the whole point: a process that
listens before migrating serves a half-migrated schema to the deploy gate, which then passes.

Two shapes here are easy to get wrong and both are asserted below.

**The migration pool is separate and short-lived.** Spec §9.4 steps 2 and 10: a dedicated `max: 1`
pool on the *owner* DSN, `end()`ed before `listen()`, so the process never holds an idle
DDL-capable connection for its whole lifetime.

**`runMigrations` takes an already-connected client FIRST**, not an options object.
`runMigrations(client, { directory, appRolePassword })` — it holds a session-level advisory lock and
a `BEGIN`/`COMMIT` that must live on one backend, which a pool cannot promise. `start()` therefore
opens the pool, checks out the client, and releases it in a `finally`.

**Files:**
- Create: `apps/core-api/server.js`
- Test: `apps/core-api/test/server-bootstrap.test.js`

- [ ] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { start } = require("../server");

const CONFIG = Object.freeze({
  port: 0,
  host: "127.0.0.1",
  nodeEnv: "test",
  databaseUrl: "postgres://core_api_app:app-secret@127.0.0.1:5433/core",
  databaseMigrationUrl: "postgres://core_api_owner:owner-secret@127.0.0.1:5433/core",
  databaseAppPassword: "app-secret",
  dbPoolMax: 12
});

// A stand-in for the pool checkout. Recording its identity is how the test pins runMigrations'
// CLIENT-FIRST signature: an implementation that passed a single options object would put an
// object with no `id` in position one and this string would not match.
function migrationClient(calls) {
  return { id: "migration-client", release: () => calls.push("release:migration-client") };
}

function collaborators(calls, overrides = {}) {
  return {
    config: CONFIG,
    env: {}, // a throwaway environment, so loadDotEnv cannot touch the real process.env
    migrationsDir: "/tmp/core-api-migrations",
    log: () => {},
    openMigrationPool: (options) => calls.push(`openMigrationPool:${options.connectionString}`),
    acquireMigrationClient: async () => {
      calls.push("acquireMigrationClient");
      return migrationClient(calls);
    },
    closeMigrationPool: async () => calls.push("closeMigrationPool"),
    runMigrations: async (client, options) => {
      calls.push(`runMigrations:${client.id}:${options.directory}:${options.appRolePassword}`);
    },
    openRuntimePool: (options) => calls.push(`openRuntimePool:${options.connectionString}:${options.max}`),
    waitForDatabase: async (options) => calls.push(`wait:${options.attempts}x${options.delayMs}`),
    checkReadiness: async () => ({ database: "ready", migrations: "current" }),
    listen: async (app, port, host) => {
      calls.push(`listen:${host}:${port}`);
      return { app, port, host };
    },
    ...overrides
  };
}

test("start() migrates on a dedicated client, closes that pool, then opens the runtime pool and listens", async () => {
  const calls = [];

  const result = await start(collaborators(calls));

  assert.deepEqual(calls, [
    `openMigrationPool:${CONFIG.databaseMigrationUrl}`,
    "acquireMigrationClient",
    "runMigrations:migration-client:/tmp/core-api-migrations:app-secret",
    "release:migration-client",
    "closeMigrationPool",
    `openRuntimePool:${CONFIG.databaseUrl}:12`,
    "wait:10x1000",
    "listen:127.0.0.1:0"
  ]);
  assert.equal(result.port, 0);
});

test("a failed migration means the port never opens, and the client is still released", async () => {
  const calls = [];

  await assert.rejects(
    start(
      collaborators(calls, {
        runMigrations: async () => {
          throw new Error("0002_add_menu.sql is pending");
        }
      })
    ),
    /0002_add_menu\.sql is pending/
  );

  assert.deepEqual(calls, [
    `openMigrationPool:${CONFIG.databaseMigrationUrl}`,
    "acquireMigrationClient",
    "release:migration-client",
    "closeMigrationPool"
  ]);
});

test("a database that never comes up means the port never opens", async () => {
  const calls = [];

  await assert.rejects(
    start(
      collaborators(calls, {
        waitForDatabase: async () => {
          throw new Error("database did not accept connections after 10 attempts");
        }
      })
    ),
    /did not accept connections/
  );

  assert.equal(calls.includes("listen:127.0.0.1:0"), false, "nothing after the readiness wait may run");
  assert.equal(calls.at(-1), `openRuntimePool:${CONFIG.databaseUrl}:12`);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/server-bootstrap.test.js`
Expected: FAIL with `Error: Cannot find module '../server'`

- [ ] **Step 3: Write the minimal implementation**

```js
"use strict";

const path = require("node:path");
const { startupConfiguration } = require("./config");
const { loadDotEnv } = require("./env-file");
const { runMigrations } = require("./db/migrate");
const {
  openRuntimePool,
  openMigrationPool,
  acquireMigrationClient,
  closeMigrationPool,
  closeAllPools
} = require("./db");
const { checkReadiness, waitForDatabase } = require("./db/health");
const { createApp } = require("./http/router");

function listenServer(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

// Spec §3.1 and §9.4. The order is fixed and fails closed: load .env → validate configuration →
// migrate on a dedicated owner connection → close that pool → open the runtime pool → wait for
// the database → listen. Listening before migrating would serve a half-migrated schema to the
// deploy gate, which would then pass.
// Every collaborator is overridable so the ORDER can be asserted without a database.
async function start(options = {}) {
  const environment = options.env || process.env;
  // Default file is apps/core-api/.env, owned by env-file.js; never overrides a set name.
  loadDotEnv(undefined, environment);

  const config = options.config || startupConfiguration(environment);
  const migrationsDir = options.migrationsDir || path.join(__dirname, "migrations");

  const migrate = options.runMigrations || runMigrations;
  const openMigration = options.openMigrationPool || openMigrationPool;
  const acquireMigration = options.acquireMigrationClient || acquireMigrationClient;
  const closeMigration = options.closeMigrationPool || closeMigrationPool;
  const openRuntime = options.openRuntimePool || openRuntimePool;
  const waitForDb = options.waitForDatabase || waitForDatabase;
  const readiness = options.checkReadiness || (() => checkReadiness({ migrationsDir }));
  const listen = options.listen || listenServer;

  // §9.4 steps 2 and 10: a dedicated max:1 pool on the OWNER dsn, end()ed before listen, so the
  // process never keeps an idle DDL-capable connection alive for its whole lifetime.
  // runMigrations takes the CLIENT first because it holds a session-level advisory lock and a
  // BEGIN/COMMIT that must live on one backend — a pool cannot promise that.
  await openMigration({ connectionString: config.databaseMigrationUrl });
  const client = await acquireMigration();
  try {
    await migrate(client, { directory: migrationsDir, appRolePassword: config.databaseAppPassword });
  } finally {
    client.release();
    await closeMigration();
  }

  await openRuntime({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  await waitForDb({ attempts: 10, delayMs: 1000 });

  const app = createApp({ checkReadiness: readiness, log: options.log });
  return listen(app, config.port, config.host);
}

module.exports = { createApp, start, listenServer };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/server-bootstrap.test.js`  Expected: PASS

- [ ] **Step 5: Prove the real require graph resolves**

Every collaborator above is injected, so a typo in a `require` path or a name `db/index.js` does not
actually export would stay green in the unit test and only fail in production. Load the module for
real, from the repository root:

```bash
node -e "const s = require('./apps/core-api/server.js'); const db = require('./apps/core-api/db'); if (typeof db.closeAllPools !== 'function' || typeof s.start !== 'function') process.exit(1)"
```

Expected: exit 0 with no output. A `MODULE_NOT_FOUND` here means a bad path; a non-zero exit with no
message means `db/index.js` is missing an export `server.js` destructures.

- [ ] **Step 6: Commit**

```bash
git add apps/core-api/server.js apps/core-api/test/server-bootstrap.test.js
git commit -m "feat(core-api): add start() with the migrate-then-listen bootstrap order"
```

---

### Task 47: `server.js` — the fatal-error exit shape

Spec §9.4 marks this a **DEPARTURE** from `apps/customer-order/server.js:501-504`, which uses
`process.exitCode = 1` and lets the loop drain. core-api cannot: by the time some checks fail an
open `pg.Pool` keeps the loop alive forever, so the container would neither listen nor exit,
`restart: unless-stopped` would never fire, and the failure would present as an indefinite hang with
one log line. `fatal()` is a named export so the "closes the pools, then really exits 1" contract is
unit-tested rather than asserted about three lines under `require.main`.

**Files:**
- Modify: `apps/core-api/server.js:1-END`
- Test: `apps/core-api/test/server-bootstrap.test.js` (append to the end of the file)

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/server-bootstrap.test.js`:

```js
const { fatal } = require("../server");

test("fatal() logs the message, closes the pools, then really exits 1", async () => {
  const calls = [];

  await fatal(new Error("DATABASE_URL is required"), {
    logError: (message) => calls.push(`log:${message}`),
    closeAllPools: async () => calls.push("close"),
    exit: (code) => calls.push(`exit:${code}`)
  });

  assert.deepEqual(calls, ["log:DATABASE_URL is required", "close", "exit:1"]);
});

test("fatal() exits even when closing the pools throws", async () => {
  const calls = [];

  await fatal(new Error("boom"), {
    logError: () => {},
    closeAllPools: async () => {
      throw new Error("pool already ended");
    },
    exit: (code) => calls.push(`exit:${code}`)
  });

  assert.deepEqual(calls, ["exit:1"], "an open pg.Pool keeps the loop alive forever — process.exit is not optional");
});

test("fatal() logs a bare thrown string without touching .message", async () => {
  const calls = [];

  await fatal("a bare string, not an Error", {
    logError: (message) => calls.push(message),
    closeAllPools: async () => {},
    exit: () => {}
  });

  assert.deepEqual(calls, ["a bare string, not an Error"]);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/server-bootstrap.test.js`
Expected: FAIL with `TypeError: fatal is not a function`

- [ ] **Step 3: Write the minimal implementation**

Replace `apps/core-api/server.js` entirely:

```js
"use strict";

const path = require("node:path");
const { startupConfiguration } = require("./config");
const { loadDotEnv } = require("./env-file");
const { runMigrations } = require("./db/migrate");
const {
  openRuntimePool,
  openMigrationPool,
  acquireMigrationClient,
  closeMigrationPool,
  closeAllPools
} = require("./db");
const { checkReadiness, waitForDatabase } = require("./db/health");
const { createApp } = require("./http/router");

function listenServer(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

// Spec §3.1 and §9.4. The order is fixed and fails closed: load .env → validate configuration →
// migrate on a dedicated owner connection → close that pool → open the runtime pool → wait for
// the database → listen. Listening before migrating would serve a half-migrated schema to the
// deploy gate, which would then pass.
// Every collaborator is overridable so the ORDER can be asserted without a database.
async function start(options = {}) {
  const environment = options.env || process.env;
  // Default file is apps/core-api/.env, owned by env-file.js; never overrides a set name.
  loadDotEnv(undefined, environment);

  const config = options.config || startupConfiguration(environment);
  const migrationsDir = options.migrationsDir || path.join(__dirname, "migrations");

  const migrate = options.runMigrations || runMigrations;
  const openMigration = options.openMigrationPool || openMigrationPool;
  const acquireMigration = options.acquireMigrationClient || acquireMigrationClient;
  const closeMigration = options.closeMigrationPool || closeMigrationPool;
  const openRuntime = options.openRuntimePool || openRuntimePool;
  const waitForDb = options.waitForDatabase || waitForDatabase;
  const readiness = options.checkReadiness || (() => checkReadiness({ migrationsDir }));
  const listen = options.listen || listenServer;

  // §9.4 steps 2 and 10: a dedicated max:1 pool on the OWNER dsn, end()ed before listen, so the
  // process never keeps an idle DDL-capable connection alive for its whole lifetime.
  // runMigrations takes the CLIENT first because it holds a session-level advisory lock and a
  // BEGIN/COMMIT that must live on one backend — a pool cannot promise that.
  await openMigration({ connectionString: config.databaseMigrationUrl });
  const client = await acquireMigration();
  try {
    await migrate(client, { directory: migrationsDir, appRolePassword: config.databaseAppPassword });
  } finally {
    client.release();
    await closeMigration();
  }

  await openRuntime({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  await waitForDb({ attempts: 10, delayMs: 1000 });

  const app = createApp({ checkReadiness: readiness, log: options.log });
  return listen(app, config.port, config.host);
}

// DEPARTURE from apps/customer-order/server.js:501-504, which sets process.exitCode = 1 and lets
// the loop drain. core-api cannot: by the time some checks fail an open pg.Pool keeps the loop
// alive forever, so the container would neither listen nor exit, restart: unless-stopped would
// never fire, and the failure would present as an indefinite hang with one log line.
async function fatal(error, options = {}) {
  const logError = options.logError || console.error;
  const close = options.closeAllPools || closeAllPools;
  const exit = options.exit || ((code) => process.exit(code));

  logError(error && error.message ? error.message : String(error));
  try {
    await close();
  } catch {
    // Closing is best effort; exiting is not.
  }
  exit(1);
}

module.exports = { createApp, start, fatal, listenServer };

if (require.main === module) {
  start()
    .then((server) => {
      const address = server.address();
      console.log(`core-api listening on http://${address.address}:${address.port}`);
    })
    .catch((error) => fatal(error));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/server-bootstrap.test.js`  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/server.js apps/core-api/test/server-bootstrap.test.js
git commit -m "feat(core-api): exit(1) on fatal startup errors instead of draining the loop"
```

---

### Task 48: `test/route-auth.test.js` — the route-table census, and wiring the routes into `server.js`

Spec §8.5. This is the file that asserts set *equality* over the production table, so it registers
nothing of its own — it loads every module under `http/routes/` and censuses what it finds. Rule 2's
equality is what makes adding a fifth public route fail as loudly as removing one; in Plan 1 the set
is the two health entries, and Plan 2 widens it to the settled four when login and pair land.

Rule 3 is written as an *intersection* rather than as `deepEqual(exempt, new Set())`. Empty-versus-
empty would be a tautology today and would have to be rewritten by hand in Plan 2; the intersection
form is empty now for exactly the right reason (neither settled route exists yet) and arms itself
the moment either one is registered.

The last assertion closes the gap that would otherwise void the whole file: a route module the test
loads but `server.js` never requires is a route the census covers and production does not serve.

**Files:**
- Create: `apps/core-api/test/route-auth.test.js`
- Modify: `apps/core-api/http/routes/health.js:1-END` (add `sample` to both route declarations)
- Modify: `apps/core-api/server.js:1-END` (add the route-module require)

- [ ] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { AUTH_MODES, listRoutes, validateRouteTable } = require("../http/router");

const appRoot = path.join(__dirname, "..");
const routesDirectory = path.join(appRoot, "http", "routes");

// Load every route module so the census covers the production table. This file registers
// NOTHING of its own — rule 2 asserts set equality, and a scratch route would break it.
const routeModules = fs.readdirSync(routesDirectory).filter((name) => name.endsWith(".js"));
for (const name of routeModules) require(path.join(routesDirectory, name));

const entries = listRoutes();
const keys = entries.map((entry) => entry.key);

test("the route table exists and passes boot validation", () => {
  assert.ok(routeModules.length > 0, "http/routes must contain at least one module");
  assert.ok(entries.length > 0, "no routes were registered");
  assert.doesNotThrow(() => validateRouteTable());
});

test("rule 1: every entry declares one of the three auth modes", () => {
  for (const entry of entries) {
    assert.ok(AUTH_MODES.includes(entry.options.auth), `${entry.key} declares auth ${JSON.stringify(entry.options.auth)}`);
  }
});

test("rule 2: the public set is exactly the Plan 1 set", () => {
  const publicKeys = new Set(entries.filter((entry) => entry.options.auth === "public").map((entry) => entry.key));

  // Set EQUALITY, not containment: adding a fifth fails and so does removing one.
  // Plan 2 adds "POST /api/admin/auth/login" and Plan 3 adds "POST /api/terminal/pair" here,
  // reaching the settled four of spec §6.1. Widen this literal in the same commit as the route.
  assert.deepEqual(publicKeys, new Set(["GET /health", "GET /health/ready"]));
});

test("rule 3: neither settled must-change-password exemption is declared before its route exists", () => {
  const exempt = new Set(entries.filter((entry) => entry.options.exemptFromPasswordChange === true).map((entry) => entry.key));

  // Spec §8.5 rule 3's target set. Intersected with what is actually registered, so this is
  // empty in Plan 1 and arms itself the moment either route lands: registering the password or
  // logout route WITHOUT the exemption flag then fails here, which is the regression that
  // locks a user out of the only two routes that can clear must_change_password.
  const SETTLED_EXEMPT = ["POST /api/admin/auth/password", "POST /api/admin/auth/logout"];
  assert.deepEqual(exempt, new Set(SETTLED_EXEMPT.filter((key) => keys.includes(key))));
});

test("rule 4: no duplicate method+path", () => {
  assert.deepEqual([...new Set(keys)].sort(), [...keys].sort());
});

test("rule 4: every path parameter has a params entry", () => {
  for (const entry of entries) {
    for (const segment of entry.path.split("/")) {
      if (!segment.startsWith(":")) continue;
      const name = segment.slice(1);
      assert.ok(entry.options.params && name in entry.options.params, `${entry.key} declares no params entry for :${name}`);
    }
  }
});

test("rule 4: every non-GET route declares body and audit", () => {
  for (const entry of entries.filter((candidate) => candidate.method !== "GET")) {
    assert.ok("body" in entry.options, `${entry.key} must declare body`);
    assert.match(entry.options.audit || "", /^[a-z_]+\.[a-z_]+$/, `${entry.key} must declare an audit action`);
  }
});

test("rule 5: terminal routes are nested and user routes declare roles", () => {
  for (const entry of entries) {
    if (entry.options.auth === "terminal") {
      assert.ok(entry.path.startsWith("/api/terminal/"), `${entry.key} is auth:'terminal' but is not nested`);
    }
    if (entry.options.auth === "user") {
      assert.ok(Array.isArray(entry.options.roles) && entry.options.roles.length > 0, `${entry.key} declares no roles`);
    }
  }
});

test("rule 8: no principal-keyed rate limit sits on a public route", () => {
  for (const entry of entries) {
    if (!entry.options.limit) continue;
    if (!["user", "terminal"].includes(entry.options.limit.key)) continue;
    assert.notEqual(entry.options.auth, "public", `${entry.key} keys a bucket on a principal it has not resolved`);
  }
});

test("rule 10: every entry declares a sample", () => {
  for (const entry of entries) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(entry.options, "sample"),
      `${entry.key} must declare a sample — the tenant-isolation route probe is driven off it`
    );
  }
});

test("server.js requires every route module, so this census covers what production serves", () => {
  const source = fs.readFileSync(path.join(appRoot, "server.js"), "utf8");

  for (const name of routeModules) {
    const specifier = `./http/routes/${name.replace(/\.js$/, "")}`;
    assert.ok(source.includes(`require("${specifier}")`), `server.js must require("${specifier}")`);
  }
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/route-auth.test.js`
Expected: FAIL with two failures — `AssertionError [ERR_ASSERTION]: GET /health must declare a sample — the tenant-isolation route probe is driven off it` and `AssertionError [ERR_ASSERTION]: server.js must require("./http/routes/health")`

- [ ] **Step 3: Add `sample` to both health routes**

Replace `apps/core-api/http/routes/health.js` entirely:

```js
"use strict";

const { route } = require("../router");
const { sendJson, sendError } = require("../respond");

// `sample` is spec §8.5 rule 10: the params and minimal body the tenant-isolation route probe
// replays against every route. Health takes neither, so it is empty — but it must be declared,
// because a missing sample means a route the probe silently skips.

// Spec §6.2: liveness. Touches no database, so a database blip cannot mark the container
// unhealthy mid-incident. This is what the Docker healthcheck calls.
route("GET", "/health", { auth: "public", sample: {} }, (req, res) => {
  sendJson(res, 200, { ok: true, app: "core-api" });
});

// Spec §6.2: readiness — SELECT 1 with a 2s statement timeout plus schema_migrations against the
// on-disk file list. This is what the deploy gate calls, and Nginx 404s it publicly.
//
// Spec §6.3.6: readiness is INSIDE the leak rule. The 503 body is the ordinary opaque envelope;
// the closed-vocabulary checks (ready|unreachable|timeout, current|pending|checksum_mismatch) go
// to the request log against the same requestId and never to the client.
route("GET", "/health/ready", { auth: "public", sample: {} }, async (req, res) => {
  let checks;
  try {
    checks = await req.core.deps.checkReadiness();
  } catch {
    // db/health.js's checkReadiness contract is "never throws"; if it does anyway, the database
    // is what is unreachable. `migrations` is omitted rather than guessed — the vocabulary
    // stays closed, and a contract violation degrades to 503 rather than to a 500.
    checks = { database: "unreachable" };
  }
  req.core.logExtra.checks = checks;

  if (checks.database === "ready" && checks.migrations === "current") {
    sendJson(res, 200, { ok: true, app: "core-api" });
    return;
  }
  sendError(res, { status: 503, code: "service_unavailable" }, req.core.requestId);
});
```

- [ ] **Step 4: Require the route module from `server.js`**

Replace `apps/core-api/server.js` entirely:

```js
"use strict";

const path = require("node:path");
const { startupConfiguration } = require("./config");
const { loadDotEnv } = require("./env-file");
const { runMigrations } = require("./db/migrate");
const {
  openRuntimePool,
  openMigrationPool,
  acquireMigrationClient,
  closeMigrationPool,
  closeAllPools
} = require("./db");
const { checkReadiness, waitForDatabase } = require("./db/health");
const { createApp } = require("./http/router");

// Route modules register themselves with route() at require time. server.js is the one place
// that pulls them in; route-auth.test.js asserts this list matches http/routes/ exactly, so a
// module that exists but is never required cannot ship as a silently unserved route.
require("./http/routes/health");

function listenServer(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

// Spec §3.1 and §9.4. The order is fixed and fails closed: load .env → validate configuration →
// migrate on a dedicated owner connection → close that pool → open the runtime pool → wait for
// the database → listen. Listening before migrating would serve a half-migrated schema to the
// deploy gate, which would then pass.
// Every collaborator is overridable so the ORDER can be asserted without a database.
async function start(options = {}) {
  const environment = options.env || process.env;
  // Default file is apps/core-api/.env, owned by env-file.js; never overrides a set name.
  loadDotEnv(undefined, environment);

  const config = options.config || startupConfiguration(environment);
  const migrationsDir = options.migrationsDir || path.join(__dirname, "migrations");

  const migrate = options.runMigrations || runMigrations;
  const openMigration = options.openMigrationPool || openMigrationPool;
  const acquireMigration = options.acquireMigrationClient || acquireMigrationClient;
  const closeMigration = options.closeMigrationPool || closeMigrationPool;
  const openRuntime = options.openRuntimePool || openRuntimePool;
  const waitForDb = options.waitForDatabase || waitForDatabase;
  const readiness = options.checkReadiness || (() => checkReadiness({ migrationsDir }));
  const listen = options.listen || listenServer;

  // §9.4 steps 2 and 10: a dedicated max:1 pool on the OWNER dsn, end()ed before listen, so the
  // process never keeps an idle DDL-capable connection alive for its whole lifetime.
  // runMigrations takes the CLIENT first because it holds a session-level advisory lock and a
  // BEGIN/COMMIT that must live on one backend — a pool cannot promise that.
  await openMigration({ connectionString: config.databaseMigrationUrl });
  const client = await acquireMigration();
  try {
    await migrate(client, { directory: migrationsDir, appRolePassword: config.databaseAppPassword });
  } finally {
    client.release();
    await closeMigration();
  }

  await openRuntime({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  await waitForDb({ attempts: 10, delayMs: 1000 });

  const app = createApp({ checkReadiness: readiness, log: options.log });
  return listen(app, config.port, config.host);
}

// DEPARTURE from apps/customer-order/server.js:501-504, which sets process.exitCode = 1 and lets
// the loop drain. core-api cannot: by the time some checks fail an open pg.Pool keeps the loop
// alive forever, so the container would neither listen nor exit, restart: unless-stopped would
// never fire, and the failure would present as an indefinite hang with one log line.
async function fatal(error, options = {}) {
  const logError = options.logError || console.error;
  const close = options.closeAllPools || closeAllPools;
  const exit = options.exit || ((code) => process.exit(code));

  logError(error && error.message ? error.message : String(error));
  try {
    await close();
  } catch {
    // Closing is best effort; exiting is not.
  }
  exit(1);
}

module.exports = { createApp, start, fatal, listenServer };

if (require.main === module) {
  start()
    .then((server) => {
      const address = server.address();
      console.log(`core-api listening on http://${address.address}:${address.port}`);
    })
    .catch((error) => fatal(error));
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `node --test apps/core-api/test/route-auth.test.js`  Expected: PASS

- [ ] **Step 6: Run all five files in this area together**

Run: `node --test apps/core-api/test/respond.test.js apps/core-api/test/router-registration.test.js apps/core-api/test/health.test.js apps/core-api/test/server-bootstrap.test.js apps/core-api/test/route-auth.test.js`
Expected: PASS — `# fail 0` and `# skip 0`. None of these five suites touches a database, so this is
green with Postgres stopped.

- [ ] **Step 7: Commit**

```bash
git add apps/core-api/test/route-auth.test.js apps/core-api/http/routes/health.js apps/core-api/server.js
git commit -m "test(core-api): assert the declared-auth route census and wire routes into server.js"
```

---

## What Plan 1 deliberately leaves to later plans

- No authentication of any kind: no lib/password.js, lib/tokens.js, lib/pairing-code.js, http/authenticate.js, http/cookies.js, http/csrf.js, and no repositories/auth/*. createScope supports the 'terminal' kind so Plan 2 can build one, but nothing mints one in Plan 1.
- No business routes and no repositories/ directory. tenantQuery and buildTenantStatement are fully implemented and tested against a real database, but health.js is the only route module that exists, so C2 (raw query outside db/), C4 (withUnscopedConnection caller allowlist) and C5 (cross-tenant needle) are written to arm themselves automatically and are vacuous today.
- assertPlatformScope() is deliberately NOT defined. Because the scope stamp is a module-private Symbol, Plan 3's repositories/platform/query.js must add that one export to db/scope.js rather than mint a second stamp.
- http/terminal-cors.js and the CORS responder are out. Until it is inserted ahead of the router tail, OPTIONS on every path — including /api/terminal/* — answers 405 with an Allow header. Spec 8.5 rule 9's three CORS outcomes and its second app instance with TERMINAL_ALLOWED_ORIGINS populated belong to the plan that adds it.
- No body reading, JSON parsing, 413 / invalid_json / invalid_request, Origin and Content-Type gates, credential resolution, or rate limiting in createApp — deliberately absent so nothing half-works.
- testing/http.js (app.listen(0) + fetch driver + explicit cookie jar + Headers.getSetCookie) is not created. The withServer helper is duplicated in the two HTTP test files; extract it to testing/http.js in the plan that needs the cookie jar.
- No Dockerfile, no docker-compose.yml, no CI workflow, no test/ci-contract.test.js. The COMPOSE_DEFAULTS and COMPOSE_CORE_API_ENVIRONMENT_KEYS tables in the scaffold-config area are literal transcriptions of spec 9.1 and must be replaced with a parse of the real compose file when Plan 5 lands — tell the Plan 5 task this explicitly.
- tenantQuery supports only single-row `INSERT INTO <table> (<columns>) VALUES (...)` and forbids shopScoped on an INSERT. INSERT ... SELECT, multi-row inserts and ON CONFLICT targets naming company_id all throw with a message saying so. If Plan 3 finds a real need, that is a deliberate extension to the helper, never a workaround at a call site.
- scripts/create-platform-admin.js is referenced by apps/core-api/README.md as a forward reference only; the CLI itself lands with the auth plan.
- C4's caller allowlist is asserted for length and 'no caller outside it' rather than deepEqual, and C6's export enumeration is a visible skip, because repositories/auth/* and repositories/platform/* do not exist. Plan 3 tightens both to full equality once those directories are populated.

## Known gaps carried into execution

Raised during review and deliberately not fixed here, with the reason.

- Spec line 1044 ('single dependency "pg"') stays literally contradicted by the express dependency. Resolved in favour of shipping express, because spec 3.2 rule 2, C3 and the line-2155 definition-of-done all require http/router.js to require it; the spec line should be amended to 'the only dependency new to the repository is pg'. The plan does not edit the spec.
- Spec line 2155's definition-of-done check `git grep -l 'require("pg")' -- apps/core-api → only apps/core-api/db/pool.js` will report two files, because testing/database.js requires pg directly and is exempt only via the source-structure walker's testing/ exclusion, which git grep does not honour. The alternative — a createMaintenanceClient export from db/pool.js — was rejected because it would force db/pool.js to expose a pg.Client, which it is specified never to do. The spec's checklist line should read 'only db/pool.js and testing/database.js'.
- infra/README.md has no 'Rotating database passwords' section and is not in Plan 1's file scope. db/health.js's fatal 28P01 message now points at apps/core-api/README.md instead; the verbatim wording in spec 9.4 therefore differs from what ships, and the infra document should gain that section in the deployment plan.
- The container-really-exits property of fatal() is still only unit-tested with an injected exit. The discriminating case (config valid, runtime pool opened, a later step fatal) needs a live Postgres and a spawned process; if a spawn-based smoke test is wanted it belongs with the migration suite, which already has a database. Left out to keep Plan 1's task count bounded.
- TRUSTED_PROXY_HOPS is validated as an integer >= 0 with no upper bound, TERMINAL_ALLOWED_ORIGINS entries are required to be https with no http-loopback relaxation, and config.js does not cross-check that DATABASE_URL and DATABASE_MIGRATION_URL name the same database. All three follow spec 9.12's literal wording; no rule was invented. The database cross-check, if wanted, belongs with the migration runner.
- The security header set (X-Content-Type-Options, Referrer-Policy, X-Frame-Options, default-src 'none' CSP) is not enumerated anywhere in the spec and was chosen by the HTTP area. HSTS is omitted because Nginx terminates TLS. The CSP is correct for a JSON API and will need a looser same-origin policy when the Phase-2 admin UI is served at /admin.

## Notes from each part

**Part 1 — Package scaffolding and configuration**

- FILE OWNERSHIP, restated for the concatenator: this area CREATES apps/core-api/test/source-structure.test.js with the single module header (node:assert/strict, node:fs, node:path, node:test), the constants appRoot/repoRoot, the helpers readText(...segments)/readJson(...segments), and exactly five tests (manifest contract, C12, .env.example contract, README greps, C11). The test-harness area must APPEND walk(), SOURCE_FILES, stripComments(), rule(), filesMatching(), C1-C10, C13 and the two walker meta-tests to this same file, reusing appRoot/repoRoot/readText and redeclaring nothing. It must NOT write its own C11 or C12 tests.
- SOLE OWNERSHIP of three repo-root files: /.gitattributes (created here with exactly `*.sql text eol=lf` and `*.sh text eol=lf`, no `*.js` rule), /.dockerignore (one line `apps/*/.env` appended after `.env`), and the root package.json scripts.test edit. The migrations and test-harness areas assert these and must never create or edit them. This area runs first in areaOrder, so .gitattributes lands before migrations commits 0001_init.sql.
- config.js now exports databaseAppPassword (the decoded password component of DATABASE_URL) next to postgresPassword. This is the value db/migrate.js's runMigrations(client, {appRolePassword: config.databaseAppPassword}) feeds to `ALTER ROLE core_api_app LOGIN PASSWORD <quote_literal($1)>` on every boot, exactly as the canonical server.js interface names it. Without it the role stays NOLOGIN on a fresh cluster and the documented rotation lever is a no-op.
- apps/core-api/package.json ships dependencies { express: ^4.21.2, pg: ^8.13.0 }. The manifest test asserts deepEqual(Object.keys(dependencies).sort(), ["express","pg"]) and doesNotMatch(/"express":\s*"\^?5/). Read spec line 1044's 'single dependency pg' as 'single dependency NEW to the repository' -- apps/epaper-hub already ships express@^4.21.2, and the manifest's description field says so. The install step is `npm --prefix apps/core-api install --no-workspaces` followed by two require() probes against apps/core-api/node_modules, because the repo root hoists express@4.22.2 and would otherwise mask an omitted dependency until the Docker build.
- loadDotEnv lives in apps/core-api/env-file.js with the two-argument signature (file = path.join(__dirname, '.env'), environment = process.env) and is tested only in test/env-file.test.js (3 tests). The server area requires it (`const { loadDotEnv } = require('./env-file');`) and must NOT reimplement it inline or re-test it in test/server-bootstrap.test.js. This is a deliberate departure from spec section 7's layout, stated in the task prose; it cannot live in config.js, which spec 8.8 pins to Tier 1 (no filesystem).
- Every Run: line is `node --test apps/core-api/test/<file>.test.js` from the repository root. The npm form is never used, because apps/core-api/package.json declares `pretest: node scripts/setup-template-db.js` from its first commit and that script does not exist until the test-harness area.
- SEQUENCING for the 'Wire npm test at the repository root' task: its Step 4 verifies only the structural assertion. The real end-to-end `npm test` at the repo root cannot be green until the test-harness area has committed apps/core-api/scripts/setup-template-db.js; the task prose says so and lists it as a follow-up. Whoever runs the plan should tick spec section 12's 'npm test at the repo root is green' item after the test-harness area lands.
- docker-compose.yml is Plan 5. The Compose-contract task's COMPOSE_DEFAULTS and COMPOSE_CORE_API_ENVIRONMENT_KEYS are literal tables transcribed from spec 9.1 and must be replaced with a parse of the real file when it lands; the assertions themselves do not change. The Plan 5 task should be told this explicitly.
- apps/core-api/README.md is created by this area (it was previously unassigned). It carries the spec 9.9 docker run recipe, the env contract table, CORE_API_TEST_DATABASE_URL / CORE_API_SKIP_DB_TESTS with bash AND PowerShell command forms, a `## Rotating database passwords` section (db/health.js's fatal 28P01 message points at that heading), and a clearly-labelled forward reference to scripts/create-platform-admin.js, which is NOT built in Plan 1. source-structure.test.js greps for create-platform-admin, CORE_API_TEST_DATABASE_URL, CORE_API_SKIP_DB_TESTS, the `## Rotating database passwords` heading and the 5433 port mapping.
- TERMINAL_ALLOWED_ORIGINS entries are required to be https unconditionally with no http-loopback relaxation (spec 9.12 words it as 'comma-separated absolute https origins'); the loopback relaxation applies to API_PUBLIC_ORIGIN only. TRUSTED_PROXY_HOPS is an integer >= 0 with no upper bound, matching spec 9.12's literal wording -- no maximum was invented.
- config.js deliberately does NOT cross-check that DATABASE_URL and DATABASE_MIGRATION_URL name the same database; spec 9.12 states no such rule. If it is ever wanted, it belongs with the migration runner, which is the code that would suffer from the mismatch.
- Test counts after this area: apps/core-api/test/source-structure.test.js has 5 tests (test-harness appends more), test/config.test.js has 25, test/env-file.test.js has 3. Local node is v22 while engines declares >=20 and the image is node:20-alpine; nothing here uses an API newer than Node 20 (Object.hasOwn is 16.9+, node --test with explicit file paths is 18+).

**Part 2 — Migration runner and `0001_init.sql`**

- VERIFIED against the real spec file: `sed -n '2176,2693p' docs/superpowers/specs/2026-07-29-core-api-phase1-design.md` yields exactly 518 lines / 26765 bytes / 11 `^CREATE TABLE` / 0 backtick fences / 4 `$$` tokens, and `tr -d '\r' | sha256sum` is 432e324975c3567411a78708f5fcfc65dbf675e67355b5eb79c78b9812c00385. Every constant in Task 1's test is a measured value, not a guess.
- `.gitattributes` is NOT created by this area. Task 1 Step 4 only runs `git check-attr text eol -- apps/core-api/migrations/0001_init.sql` and expects `text: set` / `eol: lf`. I confirmed the repo currently has no `.gitattributes` and `git config core.autocrlf` is `false` on this machine, so scaffold-config's file is what makes that check pass and what keeps a colleague with the installer default (autocrlf=true) from seeing a fatal checksum mismatch.
- ORDERING CONSTRAINT: this area's Task 3 onward requires `apps/core-api/testing/database.js` (test-harness area) at module load, because `skipDatabaseTests()` must be callable at test-declaration time. If the test-harness area is sequenced AFTER this one, its `createEmptyDatabase`/`skipDatabaseTests` half must land first (neither needs `runMigrations` — only `cloneTemplate`/`ensureTemplateDatabase` do). Tasks 1-2 are pure `node:fs` and run against nothing.
- testing/database.js requires `pg` DIRECTLY and is exempt from C1/C2/C4 because the source-structure walker excludes `testing/`. It does not route through db/pool.js — my earlier draft claimed otherwise and that claim is withdrawn.
- test/migrate.test.js never requires `pg` and never names a variable `client` or `pool` (it uses `database`, `session`, `holder`, `runner`, `stub`), so C1 and C2 cannot flag it whatever the walker's scope over `test/` turns out to be.
- The CLI task depends on three names owned by other areas: `startupConfiguration(env)` and the fields `config.databaseMigrationUrl` / `config.databaseAppPassword` from config.js, `loadDotEnv()` from env-file.js, and `openMigrationPool({connectionString})` / `acquireMigrationClient()` / `closeMigrationPool()` re-exported by db/index.js. All are in the canonical interface list; db/migrate.js requires them lazily inside the `require.main === module` block so the pure filename/checksum tests still load the module without pg or a validated environment. There is no require cycle: db/index.js does not require db/migrate.js.
- The CLI test builds its child environment from §9.12: NODE_ENV=test, POSTGRES_PASSWORD equal to the password component of DATABASE_MIGRATION_URL (the equality check is unconditional), DATABASE_MIGRATION_URL = the scratch database's DSN, DATABASE_URL = the same DSN with username core_api_app, API_PUBLIC_ORIGIN. It assumes CORE_API_TEST_DATABASE_URL points at localhost/127.0.0.1/core-db, since any other host triggers config's `sslmode=require` rule. That is the §9.9 local recipe and the CI service host.
- `migrationsStatus` guards the ledger read with `to_regclass('public.schema_migrations') IS NOT NULL` and returns an empty Map when the table is absent. Without that guard a never-migrated database raises 42P01 and checkReadiness would degrade it to `{database:'unreachable'}` — a reachable database reported as down. That is why I wrote a fourth test beyond the three the fix listed.
- `migrationsStatus` ranks checksum_mismatch above pending and treats a ledger row with no file on disk as `current`, matching §9.4's WARNING-not-fatal rule for the rolled-back-image case. It still lets `readMigrationFiles` throw on a malformed filename — that is a packaging defect that startup already rejected, and checkReadiness's own catch absorbs it.
- Test counts after each task are cumulative: 1, 5, 8, 9, 12, 16, 20, 22. Six are pure (Task 1's digest, Task 2's four, Task 3's version-gate stub) and sixteen need a database, so `CORE_API_SKIP_DB_TESTS=1` must print `# pass 6` / `# skip 16`.
- The role bootstrap issues CREATE ROLE, REVOKE ALL ON DATABASE and ALTER ROLE, so the migration DSN must belong to a superuser or the database owner — true for core_api_owner locally/in production and for `postgres` in CI. `core_api_app` is a CLUSTER-wide role, so Task 3's and Task 8's ALTER ROLE affect the whole test cluster; the CREATE is guarded by `EXCEPTION WHEN duplicate_object` for concurrent test files, and the password it sets is only ever a test value.
- `withDatabase` uses the frozen Handle exactly as specified: create, try/finally, `database.drop()`. Dedicated sessions come from `database.connect()` and are always released with `.end()` inside `withSession`'s finally, because drop() cannot remove a database that still has an open dedicated session. One-off assertions use `database.unscoped(text, params)`.

**Part 3 — Test harness and the enforcement suites**

- Contract assumed of scaffold-config: `readText(...segments)` joins its arguments with path.join and returns UTF-8 text with CRLF normalised to LF, so `readText(appRoot, ...file.split('/'))` reads a scanned source file and `readText(appRoot, 'migrations', file)` reads a migration. If scaffold-config instead implements readText as repoRoot-relative with no leading root argument, every readText call in my appended block needs a one-token edit. My block also assumes scaffold-config's header requires `node:assert/strict` as `assert`, `node:fs` as `fs`, `node:path` as `path` and `test` from `node:test` (not `describe` — I never use it in that file).
- Merged-plan ordering: this whole area is placed after server-http. The four source-structure tasks MUST be the last tasks in the plan. Caveat for the parent — if any earlier area's task writes a test that calls `cloneTemplate` (migrate.test.js and any db-index/tenant test would), the first two harness tasks ('Deterministic test-database names' and 'Clone the template') must be hoisted ahead of that area, since testing/database.js does not exist until then. Those two tasks depend only on db/migrate.js and migrations/0001_init.sql.
- Cross-area constraint from C3: `server.js` must obtain `createApp` from `http/router.js` (e.g. `const { createApp } = require('./http/router')`) rather than building the Express app itself. If server.js requires express or calls `app.use(...)`, C3's `deepEqual(filesMatching(EXPRESS_REQUIRE), ['http/router.js'])` goes red — which is the correct finding under spec 3.2 rule 2, but the server-http area should know the rule exists.
- The walker's scanned-count floor is `>= 15`, the exact merged Plan-1 count: config.js, env-file.js, server.js, db/{errors,health,index,migrate,pool,scope}.js, http/{respond,router}.js, http/routes/health.js, migrations/0001_init.sql, scripts/{reset-database,setup-template-db}.js. If any area lands an extra .js under apps/core-api (outside test/ and testing/), the floor still holds; if an area drops one, the meta-test prints the full scanned list so the discrepancy is one line to read.
- C4 is asserted as 'no caller outside the 9-entry allowlist' plus a length/uniqueness check on the list, not `deepEqual` against it, because `repositories/auth/*` arrives in a later plan. Tighten it to a full deepEqual in the plan that writes those six modules. Same for C5 and C9, which are vacuous today (no `repositories/platform/`, no `lib/`) but armed by construction and kept honest by the per-rule fixture meta-test.
- C13's write rule is 'a filesystem-write call may not name `migrations` unless it also names `tmp`'. This is a deliberate loosening of the spec's literal wording so `test/migrate.test.js` can build whole scenario directories under `os.tmpdir()` (spec 8.7 requires exactly that). The rule's own positive fixture is written as `'fs.write' + 'FileSync(...)'` so source-structure.test.js cannot match itself — do not un-splice it.
- `testing/fixtures/two-tenant.js` encodes password hashes as `scrypt$N=32768,r=8,p=1$<base64url salt>$<base64url key>` with the fixed salt `core-api-fixture`. A later plan's `lib/password.js` must parse base64url, not base64, or the seven fixture users will not authenticate; `auth-login.test.js` is the test that pins it. All seven share one password so scrypt runs once per module load.
- Not created here, and deliberately: `testing/http.js` (belongs to the plan that adds routes worth driving — Plan 1's health routes need no cookie jar), `test/ci-contract.test.js` (no CI in Plan 1; the skip hatch it guards is implemented here via `skipDatabaseTests()`), and `/.gitattributes`, `/.dockerignore`, root `package.json` (scaffold-config owns all three; my C10/C13 task asserts none of them, and C11/C12 stay scaffold-config's).
- `ensureTemplate` calls the production runner in its canonical client-first form: `withMaintenanceClient(maintenanceDsn(url, TEMPLATE_DATABASE_NAME), (conn) => runMigrations(conn, { directory: MIGRATIONS_DIR, log: { info(){}, warn: console.warn } }))`. The maintenance client holds advisory lock 4264071002 on the maintenance database while the runner takes 4264071001 on the template database — different databases, so no contention.
- `scripts/reset-database.js` requires `../testing/database` for `recreateDatabase`/`maintenanceDsn` and contains no `pg` require and no `.query(` call, which is what keeps C1 and C2 green with the walker scanning `scripts/`. `recreateDatabase(maintenanceConnectionString, databaseName)` takes no advisory lock and reads no environment, so it works against an operator DSN that has nothing to do with the test harness.

**Part 4 — The database choke point**

- Cross-area sequencing, hard requirement: the two tasks 'db/index.js — pg-error translation, proved against a real database' and 'db/health.js — checkReadiness()' are the ONLY tasks in this area that load another area's files. The first needs apps/core-api/testing/database.js (test-harness). The second needs apps/core-api/db/migrate.js exporting migrationsStatus (migrations) AND testing/database.js. Both carry a **Sequencing** line as the first line of the task. If the merged plan orders db-core before those areas, move exactly those two tasks after them — the other eight tasks in this area run against nothing but node:test and pg, in order, with no database at all.
- db/index.js now exports 12 names: withTenantScope, tenantQuery, withUnscopedConnection, buildTenantStatement plus the eight straight re-exports of db/pool.js (openRuntimePool, openMigrationPool, acquireRuntimeClient, acquireMigrationClient, isRuntimePoolOpen, runtimePoolStats, closeMigrationPool, closeAllPools). A test asserts Object.keys(dbSeam).sort() deep-equals that list AND that each re-export is the same function object as db/pool.js's, so a later refactor cannot wrap or drop one silently. server.js must destructure from require('./db'), never require('./db/pool').
- db/health.js exports six names: probeReadiness, checkReadiness, waitForDatabase, connectWithRetry, isRetryableConnectionError, fatalConnectionMessage, READINESS_STATEMENT_TIMEOUT_MS. checkReadiness({migrationsDir}) returns {database, migrations} and never throws; waitForDatabase({attempts=10, delayMs=1000}={}) returns Promise<void>. The health route must call checkReadiness (the object), not probeReadiness (the bare word).
- The 28P01/28000 message now names apps/core-api/README.md "Rotating database passwords" instead of the spec's literal infra/README.md, because Plan 1 creates that section in the core-api README and nowhere else. The scaffold-config area MUST include a heading with exactly that text — test/db-health.test.js asserts the full message string, and README.md's grep assertions are that area's. This is a deliberate departure from spec line 1532's verbatim text.
- Two test files are added that the spec's §7 file tree does not list: test/errors.test.js and test/db-health.test.js. Both are pure by default (no database) and both satisfy C13. The source-structure area must not assert §7's test-file list by equality.
- test/db-index.test.js is created by one task and appended to by four more. Module-scope identifiers, in order of introduction: pool, UNUSED_DSN (pool task); createScope, buildTenantStatement, COMPANY_A/COMPANY_B/SHOP_A1/SHOP_A3/A_ADMIN/SESSION, adminScope(), managerScope() (buildTenantStatement task); dbSeam plus the three destructured seam functions (seam task); before/after/describe, ApiError, cloneTemplate, skipDatabaseTests, TABLE_A1/TABLE_B1/SHOP_B1, let db (translation task). The seam module is bound to `dbSeam`, NOT `db` — `db` is the cloneTemplate Handle, per the assigned fix.
- Deviation from the §5.4 scope table, stated so nobody re-derives it: every scope carries `kind` — 'platform' | 'tenant' | 'terminal'. §5.4 shows kind on the platform row and omits it on the terminal row; a discriminator on all three is what lets assertTenantScope reject a platform scope with 'select a company first' instead of a generic 'missing shopIds'. The auth area must build terminal scopes as createScope({kind:'terminal', companyId, shopId, terminalId, terminalKind, tokenId}) — shopId SINGULAR in, shopIds out.
- tenantQuery supports only single-row INSERT INTO <table> (<columns>) VALUES (...), forbids shopScoped on an INSERT, and forbids company_id appearing anywhere in an INSERT or an UPDATE SET list. A shop-nested write resolves its :shopId with a scoped SELECT at pipeline step 10 and relies on the composite FK (shop_id, company_id) -> shops(id, company_id) to anchor the row. ON CONFLICT targets naming company_id are therefore unavailable in Phase 1; the sanctioned mechanism for a unique collision is the descriptor's `conflicts` map catching 23505.
- assertPlatformScope() is NOT defined in Plan 1. The stamp Symbol is module-private, so Plan 3's repositories/platform/query.js cannot check it from outside — it must add that one export to db/scope.js rather than minting a second stamp. Anyone tempted to make the stamp non-enumerable must not: test/scope.test.js builds its stamped-but-broken fixtures with { ...tenantScope() }, and a non-enumerable stamp turns those assertions into dead code that passes.
- Config contract this area depends on (config area owns it): server.js translates the frozen config into db/pool.js's argument shapes — openRuntimePool({ connectionString: config.databaseUrl, max: config.dbPoolMax }) and openMigrationPool({ connectionString: config.databaseMigrationUrl }). db/pool.js reads no process.env itself and takes no config object.

**Part 5 — HTTP shell, health and process bootstrap**

- CONTRACT CONFORMANCE: server.js now matches the canonical interface exactly — requires `{ openRuntimePool, openMigrationPool, acquireMigrationClient, closeMigrationPool, closeAllPools } = require("./db")`, `{ checkReadiness, waitForDatabase } = require("./db/health")`, `{ loadDotEnv } = require("./env-file")`; exports `{ createApp, start, fatal, listenServer }` (loadDotEnv is NOT re-exported); start() owns the migration-pool lifecycle with client.release() + closeMigrationPool() in a finally; runMigrations is called CLIENT-FIRST as runMigrations(client, {directory, appRolePassword}); the runtime pool is openRuntimePool({connectionString: config.databaseUrl, max: config.dbPoolMax}).
- BUG FOUND AND FIXED IN MY OWN DRAFT: two ERROR_MESSAGES strings contained the substring "selected", which matches the spec §6.3.6 leak scanner /(SELECT|...)/i and would have failed the very test in the same task. `scope_selected` and `acting_company_suspended` now read "Clear the chosen company..." / "The chosen company is suspended." The draft had only spotted the trap for `scope_required`.
- BUG FOUND AND FIXED: `test/respond.test.js` now opens with "use strict". The `assert.throws(() => { SECURITY_HEADERS[...] = ... }, TypeError)` test silently passes-as-fails in sloppy-mode CommonJS, because assigning to a frozen object is a no-op there. Without the directive that assertion would have failed against a correct implementation.
- DEPENDENCY ON db-core: the sendError task's cross-check requires `TOP_LEVEL_ERROR_CODES` from `apps/core-api/db/errors.js` to be a frozen plain object mapping each of the 31 §6.3.2 codes to its default HTTP status as a NUMBER (400 invalid_json/invalid_request; 401 unauthenticated/invalid_credentials/pairing_failed; 403 forbidden/origin_not_allowed/password_change_required/self_modification_forbidden/current_password_invalid; 404 not_found; 405 method_not_allowed; 409 the thirteen taken/last-admin/scope codes; 413 payload_too_large; 415 unsupported_media_type; 422 validation_failed; 429 rate_limited; 500 internal_error; 503 service_unavailable). If db-core shipped it as a Set or as {code: {status}}, that one test needs a one-line adjustment — the key-set half is unaffected.
- DEPENDENCY ON scaffold-config: `apps/core-api/env-file.js` (exporting loadDotEnv(file, environment)) and `apps/core-api/config.js` (exporting startupConfiguration(env) -> frozen {port, host, nodeEnv, databaseUrl, databaseMigrationUrl, databaseAppPassword, dbPoolMax}) must exist before the two server.js tasks. I deleted the inline loadDotEnv and both of its tests from this area per the fix, so nothing here duplicates it.
- PACKAGE.JSON (scaffold-config's file, asserted not created here): dependencies must be exactly {express ^4.21.2, pg ^8.13.0}. http/router.js requires express in three of my tasks. Express 4 specifically — my 405-on-OPTIONS behaviour depends on Express 4's built-in OPTIONS responder firing only after the whole stack declines, which is what lets a last-registered app.use tail pre-empt it.
- REQUIRE-GRAPH ASSUMPTION (stated because it is load-bearing and unasserted): requiring config.js, env-file.js, db/index.js, db/migrate.js or db/health.js must open no connection and read no environment variable at module load. test/server-bootstrap.test.js requires ../server, which pulls all five in. If any of them connects at load, that suite hangs. test/route-auth.test.js deliberately avoids requiring server.js for the same reason and greps its source with fs instead.
- NOT IN PLAN 1, deliberately absent from createApp so nothing half-works: body reading and JSON parsing (413/400), the Origin + Content-Type gates (403/415), credential resolution, rate limiting, and http/terminal-cors.js. Until the CORS responder is inserted ahead of the tail, OPTIONS on EVERY path — including /api/terminal/* — answers 405 + Allow. Spec §8.5 rule 9's three CORS outcomes and its second app instance with TERMINAL_ALLOWED_ORIGINS land in the plan that adds terminal-cors.js.
- SPEC §8.5 RULES DEFERRED, with the reason recorded in a code comment so nobody re-derives it: rules 2, 3 and 10 are test-only (a boot-time route census makes the service un-bootable at every intermediate commit); rules 6 and 7 and the §5.9 audit-vocabulary / §5.7 limiter-roster half of rule 4 need routes that do not exist until Plan 2. Boot enforces rules 1, 4 (structure), 5 and 8; the audit `noun.verb` SHAPE is checked now so Plan 2 cannot invent free-form strings.
- TWO TEST FILES BEYOND THE OBVIOUS ONES: test/router-registration.test.js registers four scratch /__probe/* routes because route-auth.test.js asserts set EQUALITY over the production table and must register nothing; test/server-bootstrap.test.js covers bootstrap order and fatal(). Both are database-free, as are all five files in this area — `node --test` over them is green with Postgres stopped.
- DUPLICATION ACCEPTED ON PURPOSE: the twelve-line `withServer` fetch driver appears in both health.test.js and router-registration.test.js. Spec §8.1 names testing/http.js as its eventual home; extract it there in the plan that adds the explicit cookie jar, since the jar is the reason that helper exists.
- SECURITY HEADER SET IS MY CHOICE, not the spec's: X-Content-Type-Options, Referrer-Policy, X-Frame-Options and a `default-src 'none'` CSP alongside the mandated Cache-Control: no-store. HSTS is omitted because Nginx terminates TLS. The CSP is right for a JSON API and will need a separate, looser policy for the Phase-2 admin UI served same-origin at /admin — noted in a comment in respond.js.
- NO SPAWNED-PROCESS TEST proves the container really exits when a pool is open: the discriminating case (config valid, runtime pool opened, a later step fatal) needs a live Postgres. fatal() is unit-tested for the exit-1-after-closing-pools contract and the require.main block is three lines that call it. If the db area adds a spawn-based smoke test to test/migrate.test.js, that is the natural home for it.
- I created, modified or asserted NOTHING owned by another area: no .gitattributes, no .dockerignore, no root package.json edit, no apps/core-api/package.json, no source-structure.test.js. Rule C11's root-package.json wiring and C12's repo-root files belong to scaffold-config.
