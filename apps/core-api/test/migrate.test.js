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
