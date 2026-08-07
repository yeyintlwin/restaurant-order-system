-- 0003_admin_console.sql -- the columns the admin console's design needs, and
-- nothing that reads them yet.
--
-- Deliberately shipped ALONE, exactly as 0002 was: no route registered, no
-- repository written. The migration reaches production and is proved there
-- before a single line of code depends on it, so a schema problem surfaces as a
-- failed deploy of an unchanged API rather than as a broken admin screen.
--
-- The design this serves is docs/superpowers/specs/2026-08-06-admin-console-roles-design.md.
-- Additive only. Nothing here drops or renames.
--
-- Three columns end NOT NULL on tables that already hold rows. Each is added
-- nullable, backfilled, and only then constrained -- all inside the one
-- transaction the runner opens per file, so a backfill that cannot produce a
-- legal value rolls the whole file back and the schema is untouched. That is
-- the intended failure: a migration that stops loudly beats one that invents a
-- value nobody chose.

-- SET LOCAL is transaction-scoped and the runner opens a fresh BEGIN for EVERY
-- file, so neither 0001's nor 0002's settings are inherited. They matter more
-- here than in either: this file takes ACCESS EXCLUSIVE on companies, shops AND
-- users -- the three tables every authenticated request reads -- and holds all
-- three for the length of the backfills. Unbounded, one open transaction
-- touching users would queue the deploy behind it and every later reader behind
-- that.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- companies.slug -- the name that goes in an address
-- ---------------------------------------------------------------------------
-- A display name is for people and a URL name is for machines, and the two
-- cannot be one string: "Shwe Café" carries a space and an accent, and neither
-- survives a path.
--
-- Unique across the platform, and NOT partial on status the way
-- companies_name_active_key is. That difference is deliberate. A name is
-- released when a company is suspended so the words can be reused; an address
-- must not be, because links, bookmarks and printed material outlive the
-- company that owned them, and handing /sakura to somebody else silently
-- redirects them all.
ALTER TABLE companies
  ADD COLUMN slug text;

-- ---------------------------------------------------------------------------
-- shops -- the place, its address on the web, and how it is run
-- ---------------------------------------------------------------------------
-- Unique inside the company only, because the company's own name is already in
-- front of it: /sakura/bogyoke. Two chains can each have a downtown branch and
-- neither has to give way -- which is also what stops the uniqueness check
-- becoming an oracle for one company's branch names against another's.
ALTER TABLE shops
  ADD COLUMN slug text;

-- Optional, and it stays optional. A branch is often opened before anyone has
-- written down where it is, and refusing to record the shop until somebody does
-- is how a shop ends up recorded as "TBD".
ALTER TABLE shops
  ADD COLUMN address text
    CHECK (address IS NULL OR length(btrim(address)) BETWEEN 1 AND 200);

-- A chain can open a branch in another country, so money is a fact about the
-- BRANCH, not about the company above it. ISO 4217 alpha-3, upper case, with no
-- DEFAULT for the same reason 0001 removed the DEFAULTs from time_zone: the
-- currency a shop prices in is not something a schema should guess.
ALTER TABLE shops
  ADD COLUMN currency text
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');

-- What everyone at this shop STARTS in. Each person may then choose their own
-- (users.language below), so this is a default and not a rule. Short BCP-47:
-- 'en', 'my', 'th', 'zh-Hant'.
ALTER TABLE shops
  ADD COLUMN language text
    CHECK (language IS NULL OR language ~ '^[a-z]{2}(-[A-Za-z0-9]{2,8})*$');

-- The day-to-day three, owned by whoever runs the shop -- its manager, or the
-- CEO when there is no manager to have one. All nullable: a branch opens
-- without any of them and the receipt simply prints without them.
ALTER TABLE shops
  ADD COLUMN phone text
    CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 3 AND 40);
ALTER TABLE shops
  ADD COLUMN opening_hours text
    CHECK (opening_hours IS NULL OR length(btrim(opening_hours)) BETWEEN 1 AND 120);
ALTER TABLE shops
  ADD COLUMN receipt_footer text
    CHECK (receipt_footer IS NULL OR length(btrim(receipt_footer)) BETWEEN 1 AND 200);

-- The third answer to "who manages this shop?".
--
-- A manager is a row in user_shops, so the slot has always had two states:
-- somebody is assigned, or nobody is. That conflated two different situations
-- -- a new branch waiting for a hire, and a small shop the owner runs and always
-- will -- and the console could only show both as the same amber warning. A
-- warning that is permanently on is a warning nobody reads.
--
-- true means the CEO runs this branch themselves. It is a DECISION, and it is
-- what keeps that shop out of the "no manager yet" notice.
--
-- The invariant this column cannot express is that a shop must not be run by
-- its owner AND have an assigned manager at the same time: the manager lives in
-- another table, so a CHECK cannot see it. That belongs to the repository, and
-- it is written here so the next reader knows it was considered rather than
-- missed.
--
-- DEFAULT false is correct rather than convenient: a branch that has just been
-- opened is not owner-run, it is waiting. Every existing row wants it too.
ALTER TABLE shops
  ADD COLUMN run_by_owner boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- users -- reachable, and readable in their own language
-- ---------------------------------------------------------------------------
-- In a restaurant the phone is how you actually reach somebody; the email
-- address is only how the system recognises them. The console requires one of
-- every person it creates.
--
-- Nullable here even so, and the gap is the point: rows already exist -- the
-- production platform administrator among them -- and inventing a number for
-- somebody is worse than recording that we do not have one. The API enforces it
-- on the way in from here on; this column records the truth about the past.
ALTER TABLE users
  ADD COLUMN phone text
    CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 3 AND 40);

-- NULL means "follow my shop", and that is a state, not a missing value. Store
-- the resolved language instead and the link dies silently the day a shop's
-- default changes: everyone who never chose would stay behind, and nobody would
-- find out until half a branch was reading the wrong language.
ALTER TABLE users
  ADD COLUMN language text
    CHECK (language IS NULL OR language ~ '^[a-z]{2}(-[A-Za-z0-9]{2,8})*$');

-- ---------------------------------------------------------------------------
-- Backfill, then constrain
-- ---------------------------------------------------------------------------
-- Every existing company and shop needs a URL name before the column can be
-- NOT NULL, and the only material available is the display name.
--
-- The fold is deliberately narrow: lower case, common Latin accents flattened,
-- every remaining run of non-[a-z0-9] collapsed to one hyphen, hyphens trimmed
-- from both ends, capped at 24 characters and trimmed again in case the cap
-- landed on one.
--
-- A name written in Burmese folds to nothing at all, which is correct and
-- expected -- the script maps to no ASCII. Those rows, and any row whose folded
-- name collides with another in the same scope, take a slug derived from the
-- primary key instead. It is ugly and it is unique, and a human renames it from
-- the console afterwards.
--
-- If a key-derived slug ever collided with a real one, the UNIQUE index below
-- would fail and this whole file would roll back with nothing applied. That is
-- the right outcome and it is why the index is created in this same
-- transaction: a loud stop, not a silent duplicate.
WITH folded AS (
  SELECT id,
         nullif(
           regexp_replace(
             left(
               regexp_replace(
                 regexp_replace(
                   translate(
                     lower(btrim(name)),
                     'áàâäãåéèêëíìîïóòôöõúùûüýñçšž',
                     'aaaaaaeeeeiiiiooooouuuuyncsz'
                   ),
                   '[^a-z0-9]+', '-', 'g'
                 ),
                 '^-+|-+$', '', 'g'
               ),
               24
             ),
             '-+$', ''
           ),
           ''
         ) AS base
    FROM companies
),
ranked AS (
  SELECT id, base,
         row_number() OVER (PARTITION BY base ORDER BY id) AS rn
    FROM folded
)
UPDATE companies AS c
   SET slug = CASE
         WHEN r.base IS NULL OR length(r.base) < 2 OR r.rn > 1
           THEN 'c' || left(replace(c.id::text, '-', ''), 8)
         ELSE r.base
       END
  FROM ranked AS r
 WHERE r.id = c.id;

-- The same fold, scoped per company: a branch's name only has to be unlike its
-- siblings.
WITH folded AS (
  SELECT id, company_id,
         nullif(
           regexp_replace(
             left(
               regexp_replace(
                 regexp_replace(
                   translate(
                     lower(btrim(name)),
                     'áàâäãåéèêëíìîïóòôöõúùûüýñçšž',
                     'aaaaaaeeeeiiiiooooouuuuyncsz'
                   ),
                   '[^a-z0-9]+', '-', 'g'
                 ),
                 '^-+|-+$', '', 'g'
               ),
               24
             ),
             '-+$', ''
           ),
           ''
         ) AS base
    FROM shops
),
ranked AS (
  SELECT id, base,
         row_number() OVER (PARTITION BY company_id, base ORDER BY id) AS rn
    FROM folded
)
UPDATE shops AS s
   SET slug = CASE
         WHEN r.base IS NULL OR length(r.base) < 2 OR r.rn > 1
           THEN 's' || left(replace(s.id::text, '-', ''), 8)
         ELSE r.base
       END
  FROM ranked AS r
 WHERE r.id = s.id;

-- MMK and English are what every row in this deployment actually is, and saying
-- so once here is honest. They are written as a BACKFILL and not as a column
-- DEFAULT on purpose: from here on the API must state a currency and a language
-- for every branch it opens, because the next branch may be in Bangkok.
UPDATE shops SET currency = 'MMK' WHERE currency IS NULL;
UPDATE shops SET language = 'en'  WHERE language IS NULL;

-- The shape rule, in one expression that forbids four things at once: a leading
-- digit, a trailing hyphen, two hyphens in a row, and anything outside
-- [a-z0-9-]. Length is separate so the message can be separate.
ALTER TABLE companies
  ADD CONSTRAINT companies_slug_shape
    CHECK (slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 24);
ALTER TABLE shops
  ADD CONSTRAINT shops_slug_shape
    CHECK (slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 24);

ALTER TABLE companies ALTER COLUMN slug     SET NOT NULL;
ALTER TABLE shops     ALTER COLUMN slug     SET NOT NULL;
ALTER TABLE shops     ALTER COLUMN currency SET NOT NULL;
ALTER TABLE shops     ALTER COLUMN language SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Uniqueness
-- ---------------------------------------------------------------------------
-- Neither index is partial on status, unlike the two name indexes beside them.
-- See the note on companies.slug above: an address outlives the thing it points
-- at, so suspending a company or a shop must not release its URL to the next
-- caller.
CREATE UNIQUE INDEX companies_slug_key ON companies (slug);
CREATE UNIQUE INDEX shops_company_slug_key ON shops (company_id, slug);
