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
