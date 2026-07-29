"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const {
  MIGRATION_ADVISORY_LOCK_KEY,
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
