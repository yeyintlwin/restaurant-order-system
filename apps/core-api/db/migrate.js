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
