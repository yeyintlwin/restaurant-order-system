const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// Every read normalises CRLF. The developer machine is win32 and CI is ubuntu, so a
// `$`-anchored regex against raw bytes passes on one and fails on the other for
// reasons that have nothing to do with the rule being asserted.
function readText(...segments) {
  return fs.readFileSync(path.join(...segments), "utf8").replace(/\r\n/g, "\n");
}

// In a backup script ORDER is the property, not presence. "verify, then rename, then
// mark" written in any other order still contains every line a presence check looks for,
// and ships a truncated dump under a good name with LAST_OK saying it went fine.
function positionsOf(source, needles) {
  return needles.map((needle) => {
    const at = source.indexOf(needle);
    assert.notEqual(at, -1, `not found in the script: ${needle}`);
    return at;
  });
}

function assertAscending(source, needles) {
  const positions = positionsOf(source, needles);
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      positions[i - 1] < positions[i],
      `out of order: "${needles[i - 1]}" must come before "${needles[i]}"`
    );
  }
}

// The -T rule applies to lines that EXECUTE docker, not to comments and not to the
// operator hints the drill echoes on failure -- those name a deliberately TTY-attached
// `docker compose exec core-db … psql` for a human to paste, and must survive.
function executableDockerLines(script) {
  return script.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("echo")) return false;
    return trimmed.includes("docker compose exec");
  });
}

const backup = () => readText(repoRoot, "infra", "backup-core-db.sh");

test("the nightly is POSIX sh, exits on error, and reads the second secrets file", () => {
  const script = backup();

  // cron runs it through /bin/sh, which on Ubuntu is dash. A bashism here fails at
  // 03:17 with nobody watching.
  assert.match(script, /^#!\/bin\/sh$/m);
  assert.doesNotMatch(script, /^#!.*bash/m);
  assert.doesNotMatch(script, /\[\[/);
  assert.match(script, /^set -eu$/m);

  assert.match(script, /^cd "\$HOME\/restaurant-order-system"$/m);
  // Without this, compose cannot resolve ${CORE_ENV_FILE:-.env}: the deploy folder has
  // no .env, so every docker compose call fails before it ever reaches Postgres.
  assert.match(script, /^export CORE_ENV_FILE=\.\.\/core-api\.env$/m);
  // And BOTH are required. compose interpolates every env_file in the project, not
  // only the service being addressed, so a missing EPAPER_ENV_FILE fails at project
  // load -- before Postgres is reached, with no LAST_OK written and nothing to see
  // until the backup-health gate has been silent for weeks.
  assert.match(script, /^export EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env$/m);

  assert.match(script, /mkdir -p "\$HOME\/backups"/);
  assert.match(script, /chmod 700 "\$HOME\/backups"/);
});

test("the nightly reads the whole dump before it takes its real name, and marks LAST_OK only after", () => {
  const script = backup();

  // `exec -T` is load-bearing: without it docker allocates a TTY and CRLF translation
  // silently corrupts the binary custom-format dump.
  assert.match(script, /docker compose exec -T core-db/);
  for (const line of executableDockerLines(script)) {
    assert.match(line, /docker compose exec -T\b/, `docker compose exec without -T: ${line.trim()}`);
  }
  assert.match(script, /pg_dump -U core_api_owner -d core -Fc/);
  assert.doesNotMatch(script, /--no-owner|pg_dumpall/);

  // pg_dump -Fc writes the TOC FIRST, so `--list` is satisfied by the first few
  // kilobytes: a dump truncated at 80% by a full disk passes it. The data-only read
  // decompresses every block, so it is the check that reaches the end of the file.
  assertAscending(script, [
    '> "$out.part"',
    'test -s "$out.part"',
    "pg_restore --list",
    "pg_restore --data-only -f /dev/null",
    'mv "$out.part" "$out"',
    'touch "$HOME/backups/LAST_OK"'
  ]);

  // The retention glob ends in .dump precisely so a leftover .part can never count
  // toward the fourteen kept nightlies.
  assert.match(script, /ls -1t "\$HOME"\/backups\/nightly-\*\.dump/);
  assert.match(script, /tail -n \+15/);
  assert.match(script, /chmod 600 "\$out"/);
});

test("the nightly keeps the password inside the container and is committed executable", () => {
  const script = backup();

  // SINGLE quotes: the expansion happens in the shell INSIDE core-db, so the password
  // reaches no host process list and no cron log. Double quotes would make the HOST
  // expand it -- to an empty string, because ~/core-api.env is never sourced here.
  assert.match(script, /'PGPASSWORD="\$POSTGRES_PASSWORD" pg_dump/);
  assert.doesNotMatch(script, /"PGPASSWORD=/);
  assert.doesNotMatch(script, /\$\([^)]*POSTGRES_PASSWORD/);

  // git on win32 runs with core.filemode=false, so `chmod +x` does not stick. The mode
  // in the INDEX is what ubuntu-latest checks out and what scp copies to the host, and
  // cron cannot run a 644 file.
  const listed = spawnSync("git", ["ls-files", "-s", "infra/backup-core-db.sh"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(
    listed.stdout,
    /^100755 /,
    "infra/backup-core-db.sh is not executable in git's index: git add --chmod=+x it"
  );
});

const drill = () => readText(repoRoot, "infra", "restore-drill.sh");

test("the drill restores into a scratch database and can never touch core", () => {
  const script = drill();

  assert.match(script, /^#!\/bin\/sh$/m);
  assert.doesNotMatch(script, /^#!.*bash/m);
  assert.match(script, /^set -eu$/m);
  assert.match(script, /^DRILL_DB=core_restore_check$/m);

  // Both env files, for the same reason the nightly needs both: compose interpolates
  // every env_file in the project at load time, so one missing variable fails the
  // drill before it reaches Postgres -- and a drill that never runs looks exactly
  // like a drill that passes.
  assert.match(script, /^export CORE_ENV_FILE=\.\.\/core-api\.env$/m);
  assert.match(script, /^export EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env$/m);

  // The one assertion that matters most: no line may drop anything but the scratch
  // database. A typo here is not a failed drill, it is the outage the drill exists to
  // rehearse for.
  for (const line of script.split("\n")) {
    if (!/DROP DATABASE/.test(line)) continue;
    assert.match(
      line,
      /\$DRILL_DB|core_restore_check/,
      `a DROP DATABASE that is not the scratch database: ${line.trim()}`
    );
  }
  assert.doesNotMatch(script, /-d\s+"?core"?(?![-_\w])/);

  // template0, so nothing that may have been added to template1 can make a restore look
  // cleaner than it is.
  assert.match(script, /CREATE DATABASE \$DRILL_DB OWNER core_api_owner TEMPLATE template0/);

  // All-or-nothing, and WITHOUT --no-owner: the owner/app split is the point of this
  // schema and --no-owner collapses it. This is the only place that split is ever proved
  // to survive a restore.
  assert.match(script, /pg_restore -U core_api_owner -d "\$1" --exit-on-error --single-transaction/);
  assert.doesNotMatch(script, /pg_restore[^\n]*--no-owner/);

  // Same two container-side disciplines as the nightly. The -T rule is scoped to lines
  // that execute docker: the failure hint the drill echoes names a deliberately
  // TTY-attached psql for a human to paste, and must survive.
  for (const line of executableDockerLines(script)) {
    assert.match(line, /docker compose exec -T\b/, `docker compose exec without -T: ${line.trim()}`);
  }
  assert.match(script, /'PGPASSWORD="\$POSTGRES_PASSWORD"/);
  assert.doesNotMatch(script, /"PGPASSWORD=/);
  assert.doesNotMatch(script, /\$\([^)]*POSTGRES_PASSWORD/);

  // An optional dump argument. The normal case is no argument at all.
  assert.match(script, /if \[ "\$#" -ge 1 \]; then/);
  assert.match(script, /ls -1t "\$HOME"\/backups\/nightly-\*\.dump/);
});

test("the drill refuses without headroom, rejects the wrong dump, then checks the ledger with the production runner", () => {
  const script = drill();

  // It doubles the data footprint plus WAL inside the cluster production is serving
  // from, on the one instance where spec 9.1 names the OOM killer as the top risk.
  assert.match(script, /restore-drill: refusing, need \$need bytes free, have \$have/);
  assert.match(script, /need="\$\(\(size \* 3\)\)"/);
  assert.match(script, /\[ "\$used" -ge 70 \]/);
  // The gate must come before anything is created or restored.
  assertAscending(script, [
    "restore-drill: refusing",
    "CREATE DATABASE $DRILL_DB",
    "pg_restore -U core_api_owner"
  ]);

  // A dump of an EMPTY or of the WRONG database restores perfectly cleanly. This check
  // must come BEFORE the ledger check: migrate.js --check would reject such a dump first
  // with "pending migration(s) never applied", which reads like version skew rather than
  // "you restored the wrong file".
  assertAscending(script, [
    "expected at least 11",
    "schema_migrations is empty",
    "node apps/core-api/db/migrate.js --check"
  ]);
  assert.match(script, /to_regclass\('public\.schema_migrations'\)/);

  // db/migrate.js --check recomputes each file's CRLF-normalised digest exactly the way
  // the applied rows were written. A second implementation in SQL would drift from the
  // runner on the first refactor and then disagree during an incident.
  assert.match(script, /node apps\/core-api\/db\/migrate\.js --check/);
  // Pointed at the scratch database by rewriting ONLY the DSN's path, so config.js's
  // unconditional POSTGRES_PASSWORD == DATABASE_MIGRATION_URL password check still holds.
  assert.match(script, /u\.pathname = "\/" \+ process\.env\.DRILL_DB/);

  // Row counts via a real count(*) per table. n_live_tup reads 0 everywhere on a freshly
  // restored database that has never been ANALYZEd -- which is the exact failure this
  // drill exists to notice, reported as success.
  assert.match(script, /query_to_xml/);
  // Scoped to EXECUTABLE lines. The script names n_live_tup in a comment, to say why it
  // is not used; a bare /n_live_tup/ forbids the script from explaining itself and the
  // task fails its own assertion. Fourth time this shape has appeared in this plan --
  // see must-fix 2 (--no-owner) and Task 2 (pg-native).
  const drillCode = script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(drillCode, /n_live_tup/);
});

// The exception lists in schema-invariants.test.js are the source of truth. Extracting them
// by regex is the same technique source-structure.test.js uses (pure fs + regex, no parser),
// and every extractor asserts it MATCHED, because an extractor that silently returns [] makes
// every loop below pass vacuously.
function arrayLiteral(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `${name} is no longer a plain array literal in schema-invariants.test.js`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0);
}

function objectKeys(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(match, `${name} is no longer a plain object literal in schema-invariants.test.js`);
  return (match[1].match(/^\s*([a-z0-9_]+):/gm) || []).map((line) => line.trim().replace(":", ""));
}

test("the exception-list extractors fail loudly rather than vacuously", () => {
  assert.deepEqual(arrayLiteral('const X = ["a", "b"];', "X"), ["a", "b"]);
  assert.deepEqual(objectKeys("const Y = {\n  a_b: [1],\n  c_d: [2]\n};", "Y"), ["a_b", "c_d"]);
  assert.throws(() => arrayLiteral('const X = ["a"];', "MISSING"), /MISSING/);
  assert.throws(() => objectKeys("const Y = {};", "MISSING"), /MISSING/);
});

test("the drill mirrors S1, S3, S4, S5 and S7 with the same exception lists", () => {
  const invariants = readText(appRoot, "test", "schema-invariants.test.js");
  const script = drill();

  const tenantExceptions = arrayLiteral(invariants, "TENANT_COLUMN_EXCEPTIONS");
  assert.equal(tenantExceptions.length, 5, "S1's exception list changed shape");
  for (const table of tenantExceptions) {
    assert.ok(script.includes(`'${table}'`), `S1 exception ${table} is missing from the drill`);
  }

  const anchors = objectKeys(invariants, "ANCHORS");
  assert.equal(anchors.length, 4, "S3's anchor list changed shape");
  for (const anchor of anchors) {
    assert.ok(script.includes(`'${anchor}'`), `S3 anchor ${anchor} is missing from the drill`);
  }

  const textHashes = arrayLiteral(invariants, "TEXT_HASH_EXCEPTIONS");
  assert.equal(textHashes.length, 1, "S4's exception list changed shape");
  for (const column of textHashes) {
    assert.ok(script.includes(column), `S4 exception ${column} is missing from the drill`);
  }

  const plaintext = arrayLiteral(invariants, "PLAINTEXT_COLUMN_NAMES");
  assert.equal(plaintext.length, 5, "S7's column list changed shape");
  for (const column of plaintext) {
    assert.ok(script.includes(`'${column}'`), `S7 name ${column} is missing from the drill`);
  }

  assert.match(script, /set_updated_at\(\)/);
  for (const invariant of ["S1:", "S3:", "S4:", "S5:", "S7:"]) {
    assert.ok(script.includes(invariant), `the drill raises no ${invariant} message`);
  }
});

test("the drill declares what it does not mirror, and asserts the grants the node suite cannot", () => {
  const script = drill();

  // An omission that is written down is a decision; an omission that is not is a hole.
  assert.match(script, /^# NOT MIRRORED: S2, S2b, S6\./m);

  // 0001's grant block is guarded on pg_roles so a single-role dev database applies it
  // unchanged, which is why schema-invariants.test.js cannot assert grants at all. Both
  // roles exist on the production cluster, so this is the only place the owner/app split
  // is ever verified -- and it is precisely what --no-owner would collapse.
  assert.match(script, /has_table_privilege\('core_api_app'/);
  assert.match(script, /pg_get_userbyid\(c\.relowner\) <> 'core_api_owner'/);
  assert.match(script, /a --no-owner restore looks exactly like this/);

  // The heredoc delimiter must stay QUOTED, or the shell expands $$ to its own PID and
  // every DO block becomes a syntax error.
  assert.match(script, /<<'SQL'/);
});

const infraReadme = () => readText(repoRoot, "infra", "README.md");

// infra/README.md is append-only and shared by four areas of this plan. Counting a psql
// invocation across the WHOLE document sees five, not three: Scenario B's CREATE ROLE and
// the rotation recipe's ALTER ROLE use the same invocation. Anchor to the slice.
function section(document, startHeading, endHeading) {
  const start = document.indexOf(startHeading);
  assert.notEqual(start, -1, `missing heading: ${startHeading}`);
  const end = document.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(end, -1, `missing heading: ${endHeading}`);
  return document.slice(start, end);
}

function countOccurrences(source, needle) {
  let count = 0;
  let at = source.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = source.indexOf(needle, at + needle.length);
  }
  return count;
}

test("the restore runbook stops the writer, proves the dump, and drops in three psql calls", () => {
  const doc = infraReadme();
  const scenarioA = section(doc, "### Scenario A", "### Scenario B");

  // Step 0. Restore into a live writer and you get a database half old and half new.
  assert.match(scenarioA, /docker compose stop core-api/);
  // Step 1. Prove the dump is readable BEFORE destroying anything.
  assert.match(scenarioA, /pg_restore --list < ~\/backups\/pre-deploy-<ts>\.dump/);
  // Step 2. Step 3 is irreversible, so dump the broken state too.
  assert.match(scenarioA, /before-restore-\$\(date -u \+%Y%m%dT%H%M%SZ\)\.dump/);

  // Step 3. THREE separate -c invocations, in this order. Chaining a terminate ahead of a
  // DROP in one psql call means ON_ERROR_STOP aborts halfway, leaving the app stopped and
  // the restore not started. ALLOW_CONNECTIONS goes FIRST so nothing can reconnect between
  // the terminate and the drop.
  assert.equal(
    countOccurrences(scenarioA, "psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1"),
    3,
    "the drop sequence must be three separate psql invocations"
  );
  assertAscending(scenarioA, [
    "ALTER DATABASE core WITH ALLOW_CONNECTIONS false;",
    "SELECT pg_terminate_backend(pid)",
    "DROP DATABASE IF EXISTS core;"
  ]);
  const invocations = scenarioA.split("docker compose exec -T").slice(1);
  for (const statement of [
    "ALTER DATABASE core WITH ALLOW_CONNECTIONS false;",
    "SELECT pg_terminate_backend(pid)",
    "DROP DATABASE IF EXISTS core;"
  ]) {
    assert.equal(
      invocations.filter((chunk) => chunk.includes(statement)).length,
      1,
      `"${statement}" must appear in exactly one docker compose exec -T invocation`
    );
  }

  // Step 4. All-or-nothing, and NOT --no-owner.
  assert.match(scenarioA, /pg_restore -U core_api_owner -d core [\s\S]{0,80}--exit-on-error --single-transaction/);
  assert.doesNotMatch(doc, /pg_restore[^\n]*--no-owner/);

  // Step 5/6. Verify before starting the app, and read the ledger against the image.
  assert.match(scenarioA, /SELECT filename, applied_at FROM schema_migrations ORDER BY filename;/);
  assert.match(doc, /curl -fsS http:\/\/127\.0\.0\.1:3200\/health\/ready/);

  // Spec 12 forbids rehearsing this verbatim: step 3 drops the production database.
  assert.match(scenarioA, /Never rehearse Scenario A verbatim/);
  assert.match(scenarioA, /core_scenario_a/);
});

test("the runbook covers a fresh instance and the password-rotation ordering", () => {
  const doc = infraReadme();

  // Scenario B: the dump carries grants referencing core_api_app but not the role itself.
  assert.match(doc, /CREATE ROLE core_api_app LOGIN NOINHERIT PASSWORD/);
  assert.match(doc, /role core_api_app does not exist/);
  // create-platform-admin.js is Plan 2 and the runbook must not pretend otherwise.
  assert.match(doc, /create-platform-admin\.js[\s\S]{0,200}Plan 2/);

  // POSTGRES_PASSWORD is read by initdb ONLY, so editing it changes nothing on an existing
  // cluster. ALTER ROLE first, env file second. Spec 12's last checklist line greps for it.
  assert.match(doc, /ALTER ROLE core_api_owner PASSWORD/);
  // \s+, not a literal space: this file is hard-wrapped prose and the phrase straddles the
  // wrap. A literal space here is must-fix 10's shape in a markdown file instead of a
  // column-aligned conf -- an assertion that reports a correct runbook as broken. It still
  // has teeth: deleting the sentence turns it red.
  assert.match(doc, /only when it creates the data\s+directory/i);
  assert.match(doc, /DATABASE_MIGRATION_URL/);
  assert.match(doc, /apps\/core-api\/README\.md/);
});

test("the docs state what the backup does and does not protect, and how the gate behaves", () => {
  const doc = infraReadme();

  assert.match(doc, /bad migration/i);
  // The nightlies live on the instance they protect.
  assert.match(doc, /instance[\s\S]{0,120}last deploy/i);
  // No WAL archive: the recovery point is the last nightly, not the last transaction.
  assert.match(doc, /point-in-time|PITR/i);
  assert.match(doc, /Phase 3/);
  // The artifact is the only off-box copy, and it is readable by anyone with repo access.
  // \s+ for the same wrap reason as the rotation assertion above.
  assert.match(doc, /scrypt\s+hashes/);
  assert.match(doc, /data-checksums/);

  // The gate is NOT "every deploy fails on a 48-hour-old marker": before CRON_INSTALLED_AT
  // is itself 48 hours old the nightly has legitimately had no chance to run.
  assert.match(doc, /CRON_INSTALLED_AT/);
  assert.doesNotMatch(doc, /Every deploy fails the build if that marker is more than 48 hours\s*\n?\s*old/);

  // The drill runs inside the production cluster, so it is a service-hours decision.
  assert.match(doc, /same cluster production is serving from/i);
  assert.match(doc, /outside service hours/);

  // Deploy #1's pre-deploy dump is a dump of an empty core and cannot be drilled.
  assert.match(doc, /deploy #1[\s\S]{0,240}empty/i);

  assert.match(doc, /AUDIT_RETENTION_DAYS[\s\S]{0,120}Plan 2/);
});

test("infra/README.md carries the pre-cutover checklist, drill included", () => {
  const doc = infraReadme();

  assert.match(doc, /^## Before core-api's first production deploy$/m);
  for (const item of [
    /- \[[ x]\] `~\/core-api\.env` exists/,
    /- \[[ x]\] `~\/backups` exists at mode 700/,
    /- \[[ x]\] `config\/backup-core-db\.sh` has been run by hand/,
    /- \[[ x]\] \*\*`config\/restore-drill\.sh` has been run by hand once, with NO argument/,
    /- \[[ x]\] Scenario A rehearsed against `core_scenario_a`/,
    /- \[[ x]\] `crontab -l \| grep -q backup-core-db\.sh` exits 0/
  ]) {
    assert.match(doc, item);
  }

  // The order is the point: the drill needs a nightly, and deploy #1's pre-deploy dump is
  // a dump of an empty core that migrate.js --check correctly rejects.
  assertAscending(doc, [
    "`config/backup-core-db.sh` has been run by hand",
    "`config/restore-drill.sh` has been run by hand once, with NO argument"
  ]);

  // The drill is the gate, not a nice-to-have, and the README says so in words an operator
  // reading it at 02:00 cannot talk themselves out of.
  assert.match(doc, /not finished until this box is ticked/i);
});
