-- 0004_logos.sql -- a mark for a company, and a different one for a branch.
--
-- WHY A BRANCH GETS ITS OWN. A chain does not always trade under one name. The name
-- that works at home can be unusable in another country -- wrong reading, wrong
-- connotation, already taken -- so the Bangkok branch of a Yangon chain may need a
-- different mark on its receipts and its table screens. The company's logo is the
-- rule; the branch's is the exception, and the exception has to be expressible or the
-- branch quietly prints the wrong thing.
--
-- So: companies.logo_key is the one everybody falls back to, and shops.logo_key is
-- NULL for almost every branch and set for the few that need it. "Which logo does
-- this branch use" is COALESCE(shop, company) and is resolved when the row is read,
-- never stored -- a stored copy would be right until somebody changed the company's.

BEGIN;

-- THE KEY IS THE CONTENT, not the record. It is the SHA-256 of the bytes plus an
-- extension, so:
--
--   * the same image uploaded twice is one file on disk;
--   * "is this file still needed" is a question about these two columns and nothing
--     else -- no reference count to drift, no sweeper guessing from timestamps;
--   * replacing a logo cannot overwrite a file another record is pointing at.
--
-- The CHECK is what makes the key safe to join onto a filesystem path. 64 hex
-- characters, a dot, and a known extension: no slash, no dot-dot, no absolute path,
-- nothing that leaves the directory it is read from. The storage layer refuses
-- anything this would reject too, and that is deliberate belt-and-braces -- this
-- constraint is the one that survives a bug in the storage layer.
CREATE DOMAIN logo_key AS text
  CHECK (VALUE ~ '^[0-9a-f]{64}\.(png|jpg|webp)$');

ALTER TABLE companies ADD COLUMN logo_key logo_key;
ALTER TABLE shops     ADD COLUMN logo_key logo_key;

-- NULLABLE, and the company's is required anyway -- by the console and by the route,
-- not by the column.
--
-- It cannot be NOT NULL and that is not a compromise. A company is created before it
-- has an id, and a file cannot be attached to a row that does not exist yet; the
-- upload is necessarily a second request. A NOT NULL column would make the first one
-- impossible. The console asks for the logo in the same dialog and the Companies row
-- flags a company that has none, which is the same shape as a company with no CEO.
--
-- Every company that existed before this migration also has none, and inventing one
-- for them is not something a migration can do.

-- Both columns are looked up by VALUE when a file is deleted: "does any row still
-- point at this key". Two small indexes rather than a sequential scan of both tables
-- on every logo change.
CREATE INDEX companies_logo_key_idx ON companies (logo_key) WHERE logo_key IS NOT NULL;
CREATE INDEX shops_logo_key_idx     ON shops     (logo_key) WHERE logo_key IS NOT NULL;

COMMIT;
