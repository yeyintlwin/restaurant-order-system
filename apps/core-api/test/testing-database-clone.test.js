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

test("the truncate statement names eleven tables, restarts identity and has no CASCADE", () => {
  assert.equal(TRUNCATE_STATEMENT.match(/,/g).length, 10);
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

  test("resetFixtures empties the eleven tenant tables and leaves the ledger alone", async () => {
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
