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
