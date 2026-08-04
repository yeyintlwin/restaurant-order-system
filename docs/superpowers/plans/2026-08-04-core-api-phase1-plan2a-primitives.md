# Core API Phase 1 — Plan 2a: Credential Primitives and the Identity Schema

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `0002_identity` migration and the five pure credential modules
plus the pre-tenant audit writer that every later route in the identity slice
depends on — with no HTTP route added, so the migration reaches production before
anything reads it.

**Architecture:** Everything new is either a migration file, a Tier-1 **pure**
module under `lib/` (no filesystem, no network, no database, no ambient clock —
`source-structure.test.js` rule C9 enforces the require graph), or the one
pre-tenant repository that `withUnscopedConnection`'s nine-entry allowlist already
names. No route registers, so `route-auth.test.js`'s public-set literal does not
move and the deploy pipeline's block-4 probe still expects its 404.

**Tech Stack:** Node 20 (CommonJS, plain JavaScript), `node:crypto` (`scrypt`,
`randomBytes`, `createHash`, `timingSafeEqual`), PostgreSQL 16, `node --test` +
`node:assert/strict`. **No new npm dependency** — `nodemailer` arrives in Plan 2d.

**Spec:** [2026-08-04-core-api-identity-slice-design.md](../specs/2026-08-04-core-api-identity-slice-design.md).
Bare section references (§5.1, §8.5) point at the **parent** spec,
[2026-07-29-core-api-phase1-design.md](../specs/2026-07-29-core-api-phase1-design.md).

---

## Execution log

**Status: 3 of 11 tasks done.**

Append one row per working session. A task counts as finished only when all of its
steps are ticked and its commit exists.

| Date | Session did | Tasks finished | Commits | Next |
| --- | --- | --- | --- | --- |
| 2026-08-04 | Task 1. `0002_identity.sql` plus its content test. Two review rounds: spec compliance passed first pass; code quality found four Important and three Minor gaps, ALL of which were plan/spec gaps rather than executor errors, and all seven are fixed. The migration now repeats `SET LOCAL lock_timeout`/`statement_timeout` (SET LOCAL is transaction-scoped and the runner opens a fresh BEGIN per file, so 0001s are NOT inherited -- and this is the first migration to ALTER a pre-existing table), names the `users` row as the one to lock at every mint site, carries the two end-state CHECKs 0001 enforces on both sibling credential tables, adds the sweep index, and bounds `sent_to_email`. Reviewer retracted one of its own claims -- REVOKE takes no lock on its target relation -- and I measured that myself before removing the clause. Plan and spec reconciled to the committed files. | **1/11** | `7fa8861`, `ab2e25b`, `947c258`, (this commit) | Task 2 |

---
| 2026-08-04 | Task 2. The migration-set pins. The plan said five sites; there are SIX -- `assert.equal(ledger.rowCount, 1)` is the only one that is not an array literal, so a grep for the literal finds five of six. The implementer escalated rather than guessing. Confirming that escalation surfaced a worse defect the plan had introduced: both multi-row ledger queries had NO `ORDER BY`, while the new two-element deepEqual and three `rows[0]` accesses had just made row order load-bearing. It would have passed every run until a HOT update or autovacuum reordered the heap. Review found one further real hole -- the pending-migration stderr assertion matched only the first filename, so it had stopped verifying that 0002 is reported at all. 23 pass, 0 fail. | **2/11** | `9d268e6`, (this commit) | Task 3 |
| 2026-08-04 | Task 3. The plan named three files; there were SIX. Two sites the implementer found and fixed (a comma count over TRUNCATE_STATEMENT, a stale count in a test name), and one they escalated on instead of touching: `infra/restore-drill.sh` hand-mirrors S1 in SQL, and `backup-restore.test.js` regex-extracts the node list to cross-check it. With 0002 applied, the drill would RAISE on a GOOD restore -- a production defect, proved two-sided by deleting the name and watching the exception fire. Review then found the mirror is ONE-DIRECTIONAL: the loops prove node subset drill, nothing proved the reverse, and for an EXEMPTION list the unchecked direction is fail-open -- a bogus name added to the drill alone passed 12/0. Closed with a deepEqual, mutation-tested. 294 tests, 293 pass, 0 fail, 1 skip. | **3/11** | `3db26d9`, `732cc5f`, (this commit) | Task 4 |

## How to pick this up

**The checkboxes are the state.** Tick them as you go and commit the plan file
with the code. There is no other progress tracker.

**Every command below runs from the repository root**, not from `apps/core-api`.

**Database-backed tests need a live Postgres and are a HARD FAILURE without one** —
that is deliberate (*"a silently skipped tenant-isolation suite is worse than a red
one"*). Before Task 2, start one and export the URL:

```bash
docker run -d --name core-db-dev -p 5433:5432 \
  -e POSTGRES_PASSWORD=devpassword -e POSTGRES_USER=core_api_owner \
  postgres:16-alpine
export CORE_API_TEST_DATABASE_URL=postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres
```

PowerShell:

```powershell
$env:CORE_API_TEST_DATABASE_URL = 'postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
```

Tasks 1, 3–8 and 10 need no database. Tasks 2, 9 and 11 do.

### Standing rule: every list in this repository is mirrored somewhere

This plan undercounted its own edit sites **three times** — Task 2 named five pins
where there were six, Task 3 named three files where there were four, and Task 3's
list of sites was still short by two after that. The pattern is not carelessness in
any one task; it is that this codebase deliberately pins invariants in more than
one place so a change cannot land quietly, and the mirrors are not co-located with
what they mirror.

`schema-invariants.test.js`'s exception lists are re-derived by
`backup-restore.test.js`, which cross-checks them against a **shell script** in
`infra/`. `FIXTURE_TABLES` is pinned by a `deepEqual`, a `length`, a comma count in
a different suite, and two test names. None of that is discoverable from the file
being edited.

**So: before editing any list, grep for its name and for the spelled-out count
across `apps/`, `infra/` and `docs/` — and treat a site the plan does not mention
as a finding to report, not a decision to make.** The tasks below give the greps
where they are known.

### Two things this plan will NOT let you do

**1. `0001_init.sql` is untouchable.** It is applied in production with its
SHA-256 recorded in `schema_migrations`. Editing one byte yields
`checksum_mismatch`, which is fatal, and `/health/ready` answers 503 forever. Every
schema change goes in `0002_identity.sql`.

**2. Nothing here may `require("node:net")`.** Rule C9's `IMPURE_REQUIRE` pattern
bans `node:fs`, `node:http`, `node:https`, `node:net`, `pg` and `../db/*` under
`lib/`. The parent spec §5.7 says the client-IP derivation validates with
`net.isIP()`; Task 8 therefore takes `isIP` as an **argument**, and the HTTP layer
supplies `require("node:net").isIP` in Plan 2b. `node:crypto` is not banned.

---

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `apps/core-api/migrations/0002_identity.sql` | `users.email_verified_at`, `user_email_tokens`, the ledger REVOKE | 1 |
| `apps/core-api/lib/tokens.js` | Mint a 22-char credential; hash one to `bytea(32)` | 3 |
| `apps/core-api/lib/password.js` | scrypt PHC hashing and verification | 4, 5 |
| `apps/core-api/lib/semaphore.js` | Bounded concurrency with shed-on-full | 6 |
| `apps/core-api/lib/client-ip.js` | `X-Forwarded-For` derivation, fail-closed | 7 |
| `apps/core-api/lib/audit-vocabulary.js` | The closed §5.9 action table, pure | 8 |
| `apps/core-api/repositories/auth/audit.js` | The pre-tenant audit writer | 9 |

Test files mirror these under `apps/core-api/test/`, one per module.

`lib/audit-vocabulary.js` is separate from the writer on purpose: Plan 2b's
boot-time route check (§8.5 rule 4) and this writer must agree, and one table
consulted by both is the only way that stays true.

---

## Part 1 — The migration

### Task 1: Write `0002_identity.sql`

**Files:**

- Create: `apps/core-api/migrations/0002_identity.sql`
- Test: `apps/core-api/test/source-structure.test.js` (already covers it via C10)

- [x] **Step 1: Write the failing test**

Add to `apps/core-api/test/migrate.test.js`, immediately after the existing
`test("0001_init.sql is installed verbatim from the design appendix", …)` block:

```js
test("0002_identity.sql adds the identity schema and locks the ledger", () => {
  const text = fs.readFileSync(path.join(MIGRATIONS_DIR, "0002_identity.sql"), "utf8");

  assert.equal(text.includes("\r\n"), false, "0002_identity.sql must be stored with LF endings");

  // The three changes, each asserted by the thing that would break if it were
  // dropped rather than by a substring of the prose around it.
  assert.match(text, /ALTER TABLE users\s+ADD COLUMN email_verified_at timestamptz;/);
  assert.match(text, /CREATE TABLE user_email_tokens \(/);
  assert.match(text, /REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM core_api_app;/);

  // SET LOCAL is transaction-scoped and every file gets its own BEGIN, so this
  // is NOT inherited from 0001. Unlike 0001 this file ALTERs a pre-existing
  // table, taking ACCESS EXCLUSIVE on users; unbounded, that queues behind any
  // open transaction and every later reader of users queues behind it.
  assert.match(text, /SET LOCAL lock_timeout/);

  // The live-token index MUST be partial on the two nullable columns and MUST
  // NOT mention expires_at: now() cannot appear in an index predicate, and a
  // developer "fixing" the expired-token case by adding it gets a silent
  // 42P17 at apply time.
  const liveIndex = text.match(/CREATE UNIQUE INDEX user_email_tokens_live_key[\s\S]*?;/);
  assert.ok(liveIndex, "user_email_tokens_live_key is missing");
  // Whitespace-loose: the neighbouring delivery_due index wraps its predicate
  // across lines, so reformatting this one to match is a semantics-free change
  // that must not turn this red. The token_hash assertion below stays exact --
  // there the precise spelling IS the thing under test.
  assert.match(liveIndex[0], /WHERE\s+consumed_at IS NULL\s+AND\s+revoked_at IS NULL/);
  assert.doesNotMatch(liveIndex[0], /expires_at|now\(\)/);

  // 'swept' is an allowed revoked_reason, so an expiry sweep will run against
  // expires_at. Without this index that is a seq scan over every token ever
  // minted; 0001 builds the same thing for all three of its expiring tables.
  const sweepIndex = text.match(/CREATE INDEX user_email_tokens_sweep_idx[\s\S]*?;/);
  assert.ok(sweepIndex, "user_email_tokens_sweep_idx is missing");
  assert.match(sweepIndex[0], /\(expires_at\)/);
  assert.match(sweepIndex[0], /WHERE\s+consumed_at IS NULL\s+AND\s+revoked_at IS NULL/);

  // Both end-state invariants are enforced by Postgres, not by discipline --
  // the house rule 0001 states in its header. Without the second, a row with
  // revoked_reason set but revoked_at NULL claims to be dead while still
  // occupying the live_key slot.
  assert.match(
    text,
    /CONSTRAINT user_email_tokens_single_end_state\s+CHECK \(consumed_at IS NULL OR revoked_at IS NULL\)/
  );
  assert.match(
    text,
    /CONSTRAINT user_email_tokens_revocation_is_explained\s+CHECK \(\(revoked_at IS NULL\) = \(revoked_reason IS NULL\)\)/
  );

  // bytea(32), never hex text -- binding a raw credential by mistake must raise
  // "invalid input syntax for type bytea" rather than matching zero rows.
  assert.match(text, /token_hash\s+bytea NOT NULL CHECK \(octet_length\(token_hash\) = 32\)/);

  // No company_id: this table is read in order to DISCOVER the tenant. Asserted
  // against the DDL with `--` comments stripped, because the comment standing
  // over the table names the absent column in order to explain why it is absent
  // -- an assertion on the raw text would forbid ever writing that explanation.
  // No string literal in this file contains `--`, so the naive strip is exact.
  assert.doesNotMatch(text.replace(/--.*$/gm, ""), /company_id/);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test apps/core-api/test/migrate.test.js`

Expected: FAIL — `ENOENT: no such file or directory, open '…migrations/0002_identity.sql'`.

- [x] **Step 3: Write the migration**

Create `apps/core-api/migrations/0002_identity.sql`. **Save it with LF line
endings** — `.gitattributes` already pins `*.sql` to `eol=lf`, and the runner
CRLF-normalises before checksumming, but the test above asserts the stored bytes.

```sql
-- 0002_identity.sql -- credential recovery, and the ledger lockdown 0001 could
-- not perform on itself.
--
-- Additive only. Nothing here drops or renames, and the column added to an
-- existing table is nullable, so no existing row is rewritten.

-- SET LOCAL is transaction-scoped and the runner opens a fresh BEGIN for EVERY
-- file, so 0001's settings are NOT inherited -- they have to be repeated here.
-- They bind harder in this file than they did in 0001: ALTER TABLE users takes
-- ACCESS EXCLUSIVE on a table that ALREADY EXISTS, so with no bound it queues
-- behind any open transaction touching users, and every later reader of users
-- then queues behind IT. 0001 only ever created new tables -- it could block on
-- nothing pre-existing -- and set these anyway.
--
-- The ALTER is the whole reason. The three CREATE INDEX statements build on a
-- table created in this same transaction, which no other session can see, and
-- the REVOKE at the foot takes NO lock on schema_migrations at all -- it
-- rewrites pg_class.relacl under a catalog lock and queues no reader. Measured,
-- not assumed.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- users.email_verified_at
-- ---------------------------------------------------------------------------
-- NULL means unverified. No backfill is possible or needed: this migration and
-- scripts/create-platform-admin.js ship in the same slice, so the table is empty
-- when this runs. ADD COLUMN with no DEFAULT does not rewrite the table.
--
-- Verification gates ONE thing: forgot-password. An unverified user signs in,
-- changes their password and works normally. The column exists because a
-- reset link is mailed to whatever address an administrator typed, and if that
-- address was a typo the link is delivered to a stranger.
ALTER TABLE users
  ADD COLUMN email_verified_at timestamptz;

-- ---------------------------------------------------------------------------
-- user_email_tokens
-- ---------------------------------------------------------------------------
-- Pre-tenant, like user_sessions: an unauthenticated caller presents the token,
-- so the user -- and therefore the company -- is discovered BY the lookup. That
-- is why there is no company_id here, and why schema-invariants.test.js names
-- this table in TENANT_COLUMN_EXCEPTIONS.
CREATE TABLE user_email_tokens (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose             text NOT NULL
                        CHECK (purpose IN ('password_reset', 'email_verify')),
  token_hash          bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  -- The address this token was actually sent to, snapshotted. Consumption
  -- requires it to still equal users.email, so a token minted before an
  -- address correction cannot be redeemed after one.
  sent_to_email       text NOT NULL
                        CHECK (length(sent_to_email) BETWEEN 3 AND 254),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  consumed_from_ip    inet,
  revoked_at          timestamptz,
  revoked_reason      text
                        CHECK (revoked_reason IS NULL
                           OR revoked_reason IN ('superseded', 'delivery_retry',
                                                 'delivery_exhausted', 'password_changed',
                                                 'user_suspended', 'swept')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_from_ip     inet,
  -- Delivery state. The RAW token is never stored anywhere, so a retry cannot
  -- re-send this row -- it revokes this one and mints a successor carrying
  -- delivery_attempts + 1. Storing the rendered message instead would put live
  -- reset tokens into the pre-deploy dump, which is uploaded as a 14-day
  -- GitHub artifact.
  delivery_attempts   integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivery_next_at    timestamptz,
  delivery_sent_at    timestamptz,
  delivery_last_error text
                        CHECK (delivery_last_error IS NULL
                           OR length(delivery_last_error) <= 500),
  CONSTRAINT user_email_tokens_expires_after_creation
    CHECK (expires_at > created_at),
  -- A row reaches its end state once: consumed or revoked, never both. Named
  -- ..._single_end_state rather than ..._single_terminal_state like its
  -- pairing-code sibling, because "terminal" means a physical device
  -- everywhere else in this schema.
  CONSTRAINT user_email_tokens_single_end_state
    CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  -- Revocation always records why, and a reason always implies a revocation.
  -- Without this, revoked_reason = 'superseded' with revoked_at still NULL is a
  -- row that claims to be dead while it goes on occupying the live_key slot.
  CONSTRAINT user_email_tokens_revocation_is_explained
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE UNIQUE INDEX user_email_tokens_hash_key
  ON user_email_tokens (token_hash);

-- One live token per (user, purpose). This carries the pairing-code trap
-- verbatim: now() cannot appear in an index predicate, so an EXPIRED but
-- unconsumed row still occupies the slot and would permanently brick that
-- user's recovery. Every mint site therefore runs
--   SELECT ... FROM users WHERE id = $1 FOR UPDATE; revoke any live row; INSERT
-- inside ONE transaction. The USERS row lock is what stops two concurrent mints
-- from racing into a 23505 -- locking the token rows would find NOTHING to lock
-- in the common case where none is live, and both callers would sail through.
-- It serialises both purposes for one user, which is acceptable at this volume.
-- Do not "fix" the expiry case by adding expires_at to this predicate --
-- Postgres rejects it as not IMMUTABLE.
CREATE UNIQUE INDEX user_email_tokens_live_key
  ON user_email_tokens (user_id, purpose)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- The sweeper's driving index: rows owed a delivery attempt.
CREATE INDEX user_email_tokens_delivery_due_idx
  ON user_email_tokens (delivery_next_at)
  WHERE delivery_sent_at IS NULL
    AND consumed_at IS NULL
    AND revoked_at IS NULL;

-- The expiry sweep's driving index, same predicate shape as
-- terminal_pairing_codes_sweep_idx. 'swept' is an allowed revoked_reason, so
-- something WILL run WHERE expires_at <= now() AND consumed_at IS NULL AND
-- revoked_at IS NULL -- without this it is a seq scan over every token ever
-- minted, and an expired row holds a live_key slot until it is swept.
CREATE INDEX user_email_tokens_sweep_idx
  ON user_email_tokens (expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Lock the migration ledger against the application role
-- ---------------------------------------------------------------------------
-- 0001_init.sql grants DML on ALL tables in public, which includes
-- schema_migrations. A compromised app role could therefore forge or delete a
-- ledger row and make the next deploy skip or re-apply a migration. 0001 cannot
-- be edited -- its checksum is recorded in production -- so the correction
-- belongs here. The migration runner connects as the OWNER, not as
-- core_api_app, so it is unaffected.
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM core_api_app;
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test apps/core-api/test/migrate.test.js apps/core-api/test/source-structure.test.js`

Expected: the new `0002_identity.sql` test PASSES and C10 PASSES. **The five
database-backed tests listed in Task 2 now FAIL** — that is expected and is Task
2's job. If you have no `CORE_API_TEST_DATABASE_URL` exported, every DB test fails
with the "hard failure on purpose" message instead; that is also fine here.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/migrations/0002_identity.sql apps/core-api/test/migrate.test.js
git commit -m "feat(core-api): 0002_identity - verification column, token table, ledger REVOKE"
```

---

### Task 2: Widen the single-migration pins and order the ledger query

**Files:**

- Modify: `apps/core-api/test/migrate.test.js:104`, `:358`, `:364`, `:365`, `:372`, `:599`
- Modify: the two multi-row ledger queries at `:362` and `:601`

**Six** assertions encode "there is exactly one migration". Every one fails on file
existence alone. They are not a bug — they are what stops a migration arriving
unnoticed — so they widen deliberately, in one commit.

The sixth, `assert.equal(ledger.rowCount, 1)` at `:364`, is easy to miss because it
is the only one that is not an array literal, so a `grep` for `["0001_init.sql"]`
finds five of the six.

> **Line numbers are post-Task-1.** Task 1 inserts 63 lines near the top of this
> file, so `:104` is unmoved but the other four shifted. If they have drifted
> again, find them by content — they are the only `["0001_init.sql"]` literals in
> the file:
> `grep -n '\["0001_init.sql"\]' apps/core-api/test/migrate.test.js`

- [x] **Step 1: Confirm exactly which assertions fail**

Run: `node --test apps/core-api/test/migrate.test.js 2>&1 | grep "^not ok"`

Expected, with `CORE_API_TEST_DATABASE_URL` exported: five failures, named
`creates the ledger before it reads any file`, `applies 0001_init.sql once and
re-runs as a no-op`, `sends each file as ONE string, so dollar-quoted bodies
survive`, `a ledger row with no file on disk is a WARNING, not a failure`, and
`node db/migrate.js applies the migration set and exits 0`.

- [x] **Step 2: Widen each literal**

Line 104 — the on-disk set:

```js
  assert.deepEqual(fs.readdirSync(MIGRATIONS_DIR).sort(), ["0001_init.sql", "0002_identity.sql"]);
```

Line 358 — what a first run applies:

```js
      assert.deepEqual(first.applied, ["0001_init.sql", "0002_identity.sql"]);
```

Line 365 — the ledger's first row. Ordering is by `filename`, so `0001` stays
first; assert both rather than only the head, or the second row is unpinned:

```js
      assert.deepEqual(
        ledger.rows.map((row) => row.filename),
        ["0001_init.sql", "0002_identity.sql"]
      );
```

Line 372 — what a second run skips:

```js
      assert.deepEqual(second.skipped, ["0001_init.sql", "0002_identity.sql"]);
```

Line 599 — the CLI's resulting ledger:

```js
    assert.deepEqual(
      ledger.rows.map((row) => row.filename),
      ["0001_init.sql", "0002_identity.sql"]
    );
```

Line 364 — the sixth site, and the only one a `grep` for the array literal misses:

```js
      assert.equal(ledger.rowCount, 2);
```

Keep it rather than deleting it as now-redundant: it checks the driver's result
metadata, which is a different thing from the array contents asserted below it.

- [x] **Step 2b: Order the two multi-row ledger queries**

This is the part of Task 2 that is not bookkeeping.

`:362` and `:601` both `SELECT … FROM schema_migrations` with **no `ORDER BY`**,
and PostgreSQL guarantees no row order without one. That was harmless while a
single row could not be misordered. It stops being harmless the moment `:365`
asserts a two-element `deepEqual` over `rows.map(…)` — and the three assertions
below it index `rows[0]` expecting `0001` for the checksum, the duration and
`applied_at`.

A two-row table scanned in physical order returns insertion order on every run,
which is exactly what makes this dangerous: it would pass until a HOT update, an
autovacuum or a plan change reordered it, then surface as an inexplicable flake
long after anyone remembered this change.

```js
      // ORDER BY is load-bearing now that there is more than one row: the
      // assertions below index rows[0] expecting 0001, and Postgres guarantees no
      // order without it.
      const ledger = await database.unscoped(
        "SELECT filename, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY filename"
      );
```

```js
    // ORDER BY is load-bearing now that there is more than one row: the deepEqual
    // below is order-sensitive, and Postgres guarantees no order without it.
    const ledger = await database.unscoped("SELECT filename FROM schema_migrations ORDER BY filename");
```

**Leave the other four ledger queries alone**, identified by content because line
numbers in this file have already drifted twice: the one filtered
`WHERE filename = '0001_init.sql'`, and the three `SELECT count(*)::int AS n`
aggregates. None can be order-dependent, and all three counts assert **zero** —
after a rolled-back file, and twice after check mode applied nothing — so they are
invariant to the size of the migration set and cannot go stale as it grows.

```bash
grep -n "FROM schema_migrations" apps/core-api/test/migrate.test.js
```

- [x] **Step 3: Run the suite to verify it passes**

Run: `node --test apps/core-api/test/migrate.test.js`

Expected: PASS, 0 fail. If `applies 0001_init.sql once and re-runs as a no-op`
still fails on a **checksum mismatch**, your local template database was built
before `0002` existed — drop it and let `pretest` rebuild:

```bash
npm --prefix apps/core-api run db:reset
```

- [x] **Step 4: Verify the schema actually landed**

Run:

```bash
node --test apps/core-api/test/schema-invariants.test.js 2>&1 | grep "^not ok"
```

Expected: failures naming `user_email_tokens` in S1, S2 and S2b. That is Task 3.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/test/migrate.test.js
git commit -m "test(core-api): the migration set is two files, not one"
```

---

### Task 3: Widen the three invariant lists and the fixture truncate set

**Files:**

- Modify: `apps/core-api/test/schema-invariants.test.js` — three lists, one test name, plus the existing S1 positive-assertion test
- Modify: `apps/core-api/testing/database.js` — `FIXTURE_TABLES`
- Modify: `apps/core-api/test/testing-database.test.js` — the `deepEqual`, the `length`, and the test name
- Modify: `apps/core-api/test/testing-database-clone.test.js` — a **comma count** and two test names
- Modify: `infra/restore-drill.sh` — the S1 `NOT IN` list and its comment
- Modify: `apps/core-api/test/backup-restore.test.js` — the exception-count pin

**Six files.** The last two are the ones nothing in `apps/core-api/test/` points
at: `backup-restore.test.js` regex-extracts `TENANT_COLUMN_EXCEPTIONS` out of
`schema-invariants.test.js` and cross-checks every name against
`infra/restore-drill.sh`.

⚠️ **The drill edit is a production fix, not test bookkeeping.**
`restore-drill.sh` re-implements S1 in SQL and raises
`S1: tables without company_id uuid NOT NULL: …` for any base table lacking the
column. `user_email_tokens` lacks it by design, so once `0002_identity.sql` is
applied **the drill fails on a perfectly good restore** — and a drill that goes red
on success is worse than no drill, because it teaches whoever reads it to ignore
the result.

`testing-database-clone.test.js` also asserts the `TRUNCATE` statement's comma
count directly — `TRUNCATE_STATEMENT.match(/,/g).length` — which is a site no
grep for `FIXTURE_TABLES` will find.

Do **not** touch `docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md`,
which contains the same SQL. That is a historical record of what Plan 5 shipped.

**Four files, seven sites.** `FIXTURE_TABLES` is pinned harder than it looks:
`testing-database.test.js` carries a full `deepEqual` over the list, an
`assert.equal(FIXTURE_TABLES.length, 10)`, and a test named *"the truncate set
names all ten non-infrastructure tables"* — so the count appears three times in
one test, plus once more in a neighbouring suite's test name. Find every site by
content rather than by line number, which has drifted twice already in this plan:

```bash
grep -rn "FIXTURE_TABLES\|ten tenant tables\|ten non-infrastructure" \
  apps/core-api/testing apps/core-api/test
```

**Why the fixture set is here.** `TRUNCATE` is issued **without `CASCADE`**, over a
hardcoded ten-table list. `user_email_tokens` carries a foreign key to `users`, so
truncating `users` now fails with `0A000 cannot truncate a table referenced in a
foreign key constraint` — taking all eleven subtests of
`fixtures-two-tenant.test.js` and two of `testing-database-clone.test.js` with it.

That is the mechanism **working**, not breaking. The comment above the list says
so, and the parent spec says so: *"Omitting `CASCADE` is the point: when Phase 2
adds `menu_items`, this fails loudly instead of leaving a table silently
un-reset."* A new table joins the list deliberately or its rows survive a reseed
and poison the next test.

- [x] **Step 1: Add the new positive assertion first**

S1 requires that **each** tenant-column exception carries its own positive
assertion, so a bare list entry is a hole.

Two shape notes that will otherwise cost you a debugging session:

- The catalog is `catalog.tables[tableName][columnName]` — there is **no
  `.columns` level**. Each column value is `{ type, notNull, isPrimaryKey, … }`.
- `catalog` is declared at `:121` **inside a `describe` block** and populated by
  its `before` hook at `:123`. Assertions that read it must live inside that same
  block, or `catalog.tables` is `{}` at assertion time.

Append to the **existing** test named `S1: each named exception carries its own
positive assertion instead` (`:193`), after the `audit_events` assertions:

```js
    // user_email_tokens is pre-tenant: the token is presented by an
    // unauthenticated caller, so the company is discovered BY this lookup
    // rather than being known before it. Same class as user_sessions.
    assert.equal(
      catalog.tables.user_email_tokens.company_id,
      undefined,
      "user_email_tokens must have no company_id at all"
    );

    // The single link to a tenant, NOT NULL so no row can float free of a user.
    assert.equal(catalog.tables.user_email_tokens.user_id.type, "uuid");
    assert.equal(catalog.tables.user_email_tokens.user_id.notNull, true);

    // Credential digest as bytea, never hex text: binding a raw credential by
    // mistake must raise "invalid input syntax for type bytea", not match zero rows.
    assert.equal(catalog.tables.user_email_tokens.token_hash.type, "bytea");
    assert.ok(catalog.constraintNames.has("user_email_tokens_expires_after_creation"));
```

- [x] **Step 2: Run it to verify it fails**

Run: `node --test apps/core-api/test/schema-invariants.test.js`

Expected: this test PASSES already (the table exists from Task 1), while S1, S2
and S2b still FAIL because the lists have not moved. That is the correct
intermediate state: the positive assertion is written before the exemption it
justifies.

- [x] **Step 3: Widen the three lists**

`:9` — `TENANT_COLUMN_EXCEPTIONS`, five entries to six, alphabetical:

```js
const TENANT_COLUMN_EXCEPTIONS = [
  "audit_events",
  "companies",
  "schema_migrations",
  "user_email_tokens",
  "user_sessions",
  "users"
];
```

Update its header comment, which says "Five entries":

```js
// S1. Six entries, not the two the settled text names. Each one's own positive
```

`:20` — `COMPOSITE_FK_EXCEPTIONS`, one new entry:

```js
  "user_email_tokens.user_id": "pre-tenant: read in order to DISCOVER the tenant",
```

`:40` — `CASCADE_FKS`, three to four, and its comment:

```js
// S2b. CASCADE is permitted for exactly four FKs and nothing else.
const CASCADE_FKS = new Set([
  "user_shops.user_id,company_id",
  "user_sessions.user_id",
  "user_sessions.acting_company_id",
  // Same class as user_sessions.user_id: an ephemeral credential, not history.
  // A deleted user must not be blocked by a dead reset token, and unlike an
  // audit row the token has no accountability value once its subject is gone.
  "user_email_tokens.user_id"
]);
```

- [x] **Step 4: Add the table to the fixture truncate set**

In `apps/core-api/testing/database.js`, add the new table to `FIXTURE_TABLES`.
**Order matters for readability only** — `TRUNCATE` is a single statement over all
of them — but keep children before parents to match the existing convention:

```js
const FIXTURE_TABLES = [
  "audit_events",
  "terminal_tokens",
  "terminal_pairing_codes",
  "terminals",
  "user_email_tokens",
  "user_sessions",
  "user_shops",
  "shop_tables",
  "shops",
  "users",
  "companies"
];
```

Then the three pins in `apps/core-api/test/testing-database.test.js`, all inside
one test:

- the test's own name — *"the truncate set names all ten non-infrastructure
  tables"* → **eleven**
- the `assert.deepEqual(FIXTURE_TABLES, [ … ])` list — add `"user_email_tokens"`
  in the same position as above
- `assert.equal(FIXTURE_TABLES.length, 10)` → **11**

And one test name in `apps/core-api/test/testing-database-clone.test.js` —
*"resetFixtures empties the ten tenant tables and leaves the ledger alone"* →
**eleven**. That test's body counts no tables, so the name is the only site.

- [x] **Step 5: Run every suite the change touches**

Run:

```bash
node --test apps/core-api/test/schema-invariants.test.js \
            apps/core-api/test/fixtures-two-tenant.test.js \
            apps/core-api/test/testing-database-clone.test.js \
            apps/core-api/test/testing-database.test.js
```

Expected: PASS, 0 fail. Before this task those three suites contributed thirteen
failures with `0A000 cannot truncate a table referenced in a foreign key
constraint`; all thirteen must now be green.

- [x] **Step 6: Commit**

```bash
git add apps/core-api/test/schema-invariants.test.js \
        apps/core-api/testing/database.js \
        apps/core-api/test/testing-database-clone.test.js
git commit -m "test(core-api): user_email_tokens joins the exception lists and the reseed set"
```

---

## Part 2 — Pure credential primitives

### Task 4: `lib/tokens.js` — mint and hash

**Files:**

- Create: `apps/core-api/lib/tokens.js`
- Test: `apps/core-api/test/tokens.test.js`

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/tokens.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { mintToken, hashToken, TOKEN_LENGTH } = require("../lib/tokens");

test("a minted token is 22 Base64URL characters", () => {
  assert.equal(TOKEN_LENGTH, 22);
  for (let i = 0; i < 200; i += 1) {
    const token = mintToken();
    assert.equal(token.length, 22);
    // Base64URL only: no +, no /, no =. A token that reaches a URL fragment
    // must survive it without escaping.
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  }
});

test("minted tokens do not repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i += 1) seen.add(mintToken());
  assert.equal(seen.size, 1000);
});

test("hashToken returns a 32-byte Buffer, not hex text", () => {
  const digest = hashToken("abc");
  assert.ok(Buffer.isBuffer(digest), "hashToken must return a Buffer so pg binds bytea");
  assert.equal(digest.length, 32);
});

test("hashToken is the plain SHA-256 of the raw value", () => {
  // Pinned against a known vector, so a future "improvement" to a salted or
  // keyed digest cannot land silently and orphan every stored row.
  assert.equal(
    hashToken("abc").toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("hashToken is deterministic and input-sensitive", () => {
  assert.deepEqual(hashToken("same"), hashToken("same"));
  assert.notDeepEqual(hashToken("a"), hashToken("b"));
});

test("hashToken refuses a non-string, so a Buffer or null cannot hash to a constant", () => {
  for (const bad of [null, undefined, 42, Buffer.from("x"), {}]) {
    assert.throws(() => hashToken(bad), /hashToken requires a string/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/core-api/test/tokens.test.js`

Expected: FAIL — `Cannot find module '../lib/tokens'`.

- [ ] **Step 3: Write the implementation**

Create `apps/core-api/lib/tokens.js`:

```js
"use strict";

// PURE (Tier 1): no database, no filesystem, no network, no ambient clock.
// node:crypto is permitted -- C9's IMPURE_REQUIRE bans node:fs, node:http(s),
// node:net, pg and ../db/*, and a CSPRNG is none of those.
//
// The house credential shape, used by user_sessions, terminal_tokens and
// user_email_tokens alike: 16 random bytes rendered as 22 Base64URL characters,
// with only the SHA-256 ever stored.
//
// SHA-256 is correct HERE and catastrophically wrong for passwords. The
// distinction is the preimage space: a fast hash over 2^128 random bits is not
// brute-forceable, while the same hash over a ~30-bit human password is. See
// lib/password.js.
const crypto = require("node:crypto");

const TOKEN_BYTES = 16;
const TOKEN_LENGTH = 22;

function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

// Returns a Buffer, never hex text. The column is bytea(32), so binding a raw
// credential by mistake raises "invalid input syntax for type bytea" instead of
// silently matching zero rows -- a loud failure rather than a quiet one.
function hashToken(raw) {
  if (typeof raw !== "string") {
    throw new Error(`hashToken requires a string, got ${raw === null ? "null" : typeof raw}`);
  }
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

module.exports = { mintToken, hashToken, TOKEN_BYTES, TOKEN_LENGTH };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/core-api/test/tokens.test.js`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/lib/tokens.js apps/core-api/test/tokens.test.js
git commit -m "feat(core-api): lib/tokens - the 22-char credential and its bytea digest"
```

---

### Task 5: `lib/password.js` — hashing

**Files:**

- Create: `apps/core-api/lib/password.js`
- Test: `apps/core-api/test/password.test.js`

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/password.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  hashPassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  SCRYPT_PARAMS
} = require("../lib/password");

test("the parameters are the ones the spec fixed", () => {
  assert.deepEqual(SCRYPT_PARAMS, { N: 32768, r: 8, p: 1, dkLen: 32 });
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  assert.equal(PASSWORD_MAX_LENGTH, 256);
});

test("a hash is a self-describing PHC-style string the column CHECK accepts", async () => {
  const stored = await hashPassword("correct horse battery staple");

  // users.password_hash CHECK: LIKE 'scrypt$%' AND length BETWEEN 40 AND 512.
  assert.ok(stored.startsWith("scrypt$"));
  assert.ok(stored.length >= 40 && stored.length <= 512, `length was ${stored.length}`);

  const [scheme, params, salt, key] = stored.split("$");
  assert.equal(scheme, "scrypt");
  assert.equal(params, "N=32768,r=8,p=1");
  // 16-byte salt and 32-byte key, both Base64URL.
  assert.match(salt, /^[A-Za-z0-9_-]{22}$/);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
});

test("the salt is random, so two hashes of one password differ", async () => {
  const a = await hashPassword("correct horse battery staple");
  const b = await hashPassword("correct horse battery staple");
  assert.notEqual(a, b);
});

test("the policy is enforced at both ends", async () => {
  await assert.rejects(() => hashPassword("short"), /too_short/);
  await assert.rejects(() => hashPassword("a".repeat(257)), /too_long/);
  // Exactly at the bounds is accepted.
  assert.ok(await hashPassword("a".repeat(12)));
  assert.ok(await hashPassword("a".repeat(256)));
});

test("a non-string is refused rather than coerced", async () => {
  for (const bad of [null, undefined, 12345678901234, {}]) {
    await assert.rejects(() => hashPassword(bad), /hashPassword requires a string/);
  }
});

test("the input is NFKC-normalised, so two spellings of one password agree", async () => {
  // U+FF41 FULLWIDTH LATIN SMALL LETTER A normalises to "a" under NFKC. Without
  // normalisation a password typed on a Japanese IME would hash differently
  // from the same password typed on an ASCII keyboard.
  const wide = "ａ".repeat(12);
  const stored = await hashPassword(wide);
  const [, , salt] = stored.split("$");
  const again = await hashPassword("a".repeat(12), Buffer.from(salt, "base64url"));
  assert.equal(stored, again);
});

test("maxmem is raised, or scrypt throws at exactly these parameters", async () => {
  // 128 * N * r is exactly 33,554,432 bytes and Node's default maxmem is
  // exactly 32 MiB. This test is the regression guard for the one-line trap.
  assert.equal(128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r, 33554432);
  await assert.doesNotReject(() => hashPassword("a".repeat(12)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/core-api/test/password.test.js`

Expected: FAIL — `Cannot find module '../lib/password'`.

- [ ] **Step 3: Write the implementation**

Create `apps/core-api/lib/password.js`:

```js
"use strict";

// PURE (Tier 1). node:crypto only.
//
// A deliberate DEPARTURE from the repository's single-round SHA-256 credential
// convention, and the departure is the point. SHA-256 is correct for the 128-bit
// random tokens in lib/tokens.js -- a fast hash over a 2^128 preimage space is
// not brute-forceable -- and catastrophically wrong for a ~30-bit human
// password. scrypt is memory-hard, ships in node:crypto, and runs on the libuv
// threadpool rather than the event loop.
const crypto = require("node:crypto");

const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, dkLen: 32 });

// 128 * N * r is exactly 33,554,432 bytes and Node's default scrypt maxmem is
// exactly 32 MiB, so the call throws at these parameters unless maxmem is
// raised. This is the single most likely way to ship a service that hashes
// nothing.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const SALT_BYTES = 16;
const PASSWORD_MIN_LENGTH = 12;
// The maximum exists to bound scrypt work reachable from an unauthenticated
// route, not because long passwords are bad.
const PASSWORD_MAX_LENGTH = 256;

class PasswordPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "PasswordPolicyError";
    this.code = code;
  }
}

function normalise(password) {
  if (typeof password !== "string") {
    throw new Error(
      `hashPassword requires a string, got ${password === null ? "null" : typeof password}`
    );
  }
  // NFKC before measuring AND before hashing, so the length policy and the
  // digest agree about what the password is.
  const normalised = password.normalize("NFKC");
  if (normalised.length < PASSWORD_MIN_LENGTH) throw new PasswordPolicyError("too_short");
  if (normalised.length > PASSWORD_MAX_LENGTH) throw new PasswordPolicyError("too_long");
  return normalised;
}

function derive(password, salt) {
  const { N, r, p, dkLen } = SCRYPT_PARAMS;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, dkLen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (error, key) =>
      error ? reject(error) : resolve(key)
    );
  });
}

// `salt` is a parameter so the test can prove normalisation without reaching
// into the module. Production callers pass nothing and get a random salt.
async function hashPassword(password, salt = crypto.randomBytes(SALT_BYTES)) {
  const normalised = normalise(password);
  const key = await derive(normalised, salt);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$N=${N},r=${r},p=${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

module.exports = {
  hashPassword,
  PasswordPolicyError,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  SCRYPT_PARAMS,
  SCRYPT_MAXMEM,
  SALT_BYTES
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/core-api/test/password.test.js`

Expected: PASS, 7 tests. Each `hashPassword` call takes roughly 100 ms at these
parameters, so the file takes a few seconds — that is the cost working as
intended.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/lib/password.js apps/core-api/test/password.test.js
git commit -m "feat(core-api): lib/password - scrypt hashing with the PHC-style stored form"
```

---

### Task 6: `lib/password.js` — verification

**Files:**

- Modify: `apps/core-api/lib/password.js`
- Modify: `apps/core-api/test/password.test.js`

Verification parses `N`/`r`/`p` **out of the stored value**, never out of the
current constants, so the parameters can be raised later and every old hash still
verifies.

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/password.test.js`:

```js
const { verifyPassword } = require("../lib/password");

test("a correct password verifies and a wrong one does not", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("verification reads the parameters from the stored value, not from the constants", async () => {
  // A hash written under WEAKER parameters must still verify, which is what
  // makes raising SCRYPT_PARAMS later a one-line change rather than a forced
  // reset of every account.
  const salt = Buffer.alloc(16, 7);
  const key = await new Promise((resolve, reject) =>
    crypto.scrypt("correct horse battery staple", salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) =>
      e ? reject(e) : resolve(k)
    )
  );
  const legacy = `scrypt$N=16384,r=8,p=1$${salt.toString("base64url")}$${key.toString("base64url")}`;

  assert.equal(await verifyPassword("correct horse battery staple", legacy), true);
  assert.equal(await verifyPassword("wrong", legacy), false);
});

test("a malformed stored value is false, never a throw", async () => {
  // A throw here would turn one corrupt row into a 500 on a public route, and
  // the difference between 500 and 401 is an oracle.
  for (const bad of [
    "",
    "not-a-hash",
    "scrypt$",
    "scrypt$N=32768,r=8,p=1$onlythree",
    "scrypt$N=abc,r=8,p=1$AAAA$BBBB",
    "bcrypt$N=32768,r=8,p=1$AAAA$BBBB",
    "scrypt$N=32768,r=8,p=1$AAAA$", // empty key
    null,
    undefined,
    12345
  ]) {
    assert.equal(await verifyPassword("correct horse battery staple", bad), false);
  }
});

test("verification does not apply the length policy", async () => {
  // The policy guards what is WRITTEN. Applying it on the read path would mean
  // that tightening the minimum later locks out every existing account, and it
  // would make "password too short" observable from an unauthenticated route.
  const stored = await hashPassword("aaaaaaaaaaaa");
  assert.equal(await verifyPassword("short", stored), false);
  assert.equal(await verifyPassword("a".repeat(300), stored), false);
  assert.equal(await verifyPassword("aaaaaaaaaaaa", stored), true);
});
```

Add `const crypto = require("node:crypto");` to the top of the test file if it is
not already there.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/core-api/test/password.test.js`

Expected: FAIL — `verifyPassword is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `apps/core-api/lib/password.js`, above `module.exports`:

```js
const STORED_PATTERN = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

// Never throws. A malformed row, a wrong password and an unknown scheme are all
// `false`, because the caller is an unauthenticated route whose failure modes
// must be indistinguishable -- a 500 where a 401 belongs is an oracle.
//
// The length policy is deliberately NOT applied here. It guards what is
// written; applying it on the read path would lock out every existing account
// the day the minimum is raised.
async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;

  const match = STORED_PATTERN.exec(stored);
  if (match === null) return false;

  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  const salt = Buffer.from(match[4], "base64url");
  const expected = Buffer.from(match[5], "base64url");

  // A row claiming absurd parameters must not be allowed to allocate them.
  // 128 * N * r must stay inside SCRYPT_MAXMEM, and N must be a power of two
  // greater than one or scrypt rejects it with a less legible error.
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return false;
  if (128 * N * r > SCRYPT_MAXMEM) return false;
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = await new Promise((resolve, reject) => {
      crypto.scrypt(
        password.normalize("NFKC"),
        salt,
        expected.length,
        { N, r, p, maxmem: SCRYPT_MAXMEM },
        (error, key) => (error ? reject(error) : resolve(key))
      );
    });
  } catch {
    return false;
  }

  // Both buffers are the same length by construction above, which is what
  // timingSafeEqual requires -- it throws on a length mismatch rather than
  // returning false.
  return crypto.timingSafeEqual(actual, expected);
}
```

Then add `verifyPassword` to the exported object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/core-api/test/password.test.js`

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/lib/password.js apps/core-api/test/password.test.js
git commit -m "feat(core-api): lib/password - verification that reads its parameters from the row"
```

---

### Task 7: `lib/semaphore.js` — bounded concurrency that sheds

**Files:**

- Create: `apps/core-api/lib/semaphore.js`
- Test: `apps/core-api/test/semaphore.test.js`

scrypt is the only CPU-bound path in the service and it is reachable
unauthenticated from two routes. A request that would exceed the queue is **shed
immediately**, never queued: a lengthening queue converts a CPU limit into a
timeout storm.

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/semaphore.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createSemaphore, SemaphoreFullError } = require("../lib/semaphore");

test("slots run immediately, up to the limit", async () => {
  const semaphore = createSemaphore({ slots: 2 });
  assert.equal(semaphore.stats().running, 0);

  await semaphore.acquire();
  await semaphore.acquire();
  assert.deepEqual(semaphore.stats(), { running: 2, queued: 0, slots: 2, queueDepth: 8 });
});

test("the queue depth defaults to four times the slot count", () => {
  assert.equal(createSemaphore({ slots: 2 }).stats().queueDepth, 8);
  assert.equal(createSemaphore({ slots: 3 }).stats().queueDepth, 12);
  assert.equal(createSemaphore({ slots: 2, queueDepth: 5 }).stats().queueDepth, 5);
});

test("a waiter beyond the slots queues rather than running", async () => {
  const semaphore = createSemaphore({ slots: 1 });
  await semaphore.acquire();

  let entered = false;
  const waiting = semaphore.acquire().then(() => {
    entered = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, false, "the second acquire ran while the only slot was held");
  assert.deepEqual(semaphore.stats(), { running: 1, queued: 1, slots: 1, queueDepth: 4 });

  semaphore.release();
  await waiting;
  assert.equal(entered, true);
});

test("a request beyond the queue is shed, not queued", async () => {
  const semaphore = createSemaphore({ slots: 1, queueDepth: 2 });
  await semaphore.acquire();
  const queued = [semaphore.acquire(), semaphore.acquire()];

  await assert.rejects(() => semaphore.acquire(), SemaphoreFullError);
  // The rejection must not have disturbed the queue.
  assert.deepEqual(semaphore.stats(), { running: 1, queued: 2, slots: 1, queueDepth: 2 });

  semaphore.release();
  semaphore.release();
  semaphore.release();
  await Promise.all(queued);
});

test("the shed error carries the code and the Retry-After the route needs", async () => {
  const semaphore = createSemaphore({ slots: 1, queueDepth: 0 });
  await semaphore.acquire();
  await assert.rejects(() => semaphore.acquire(), (error) => {
    assert.ok(error instanceof SemaphoreFullError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "service_unavailable");
    return true;
  });
});

test("waiters are served in arrival order", async () => {
  const semaphore = createSemaphore({ slots: 1 });
  await semaphore.acquire();

  const order = [];
  const all = [0, 1, 2].map((n) => semaphore.acquire().then(() => order.push(n)));

  for (let i = 0; i < 4; i += 1) {
    semaphore.release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(all);
  assert.deepEqual(order, [0, 1, 2]);
});

test("releasing more than was acquired throws rather than inventing capacity", async () => {
  const semaphore = createSemaphore({ slots: 1 });
  await semaphore.acquire();
  semaphore.release();
  assert.throws(() => semaphore.release(), /released more slots than were acquired/);
});

test("the slot count is validated", () => {
  for (const bad of [0, -1, 1.5, "2", null]) {
    assert.throws(() => createSemaphore({ slots: bad }), /slots must be a positive integer/);
  }
});

test("a rejected acquire never occupies a slot", async () => {
  const semaphore = createSemaphore({ slots: 1, queueDepth: 0 });
  await semaphore.acquire();
  await assert.rejects(() => semaphore.acquire(), SemaphoreFullError);
  semaphore.release();
  // If the shed had taken a slot, this would queue forever instead of resolving.
  await semaphore.acquire();
  assert.deepEqual(semaphore.stats(), { running: 1, queued: 0, slots: 1, queueDepth: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/core-api/test/semaphore.test.js`

Expected: FAIL — `Cannot find module '../lib/semaphore'`.

- [ ] **Step 3: Write the implementation**

Create `apps/core-api/lib/semaphore.js`:

```js
"use strict";

// PURE (Tier 1): no database, no filesystem, no network, no clock. The queue is
// in-process state, which is correct -- it bounds THIS process's CPU, and there
// is exactly one replica.
//
// Why shedding rather than queueing without limit: scrypt is the only CPU-bound
// path in the service and it is reachable from two unauthenticated routes. A
// queue that grows without bound converts a CPU limit into a timeout storm, in
// which every caller waits and then fails anyway.

class SemaphoreFullError extends Error {
  constructor() {
    super("service_unavailable");
    this.name = "SemaphoreFullError";
    // Shaped so a route can rethrow it untouched: http/respond.js reads only
    // `status` and `code`, and adds Retry-After: 5 for any 503.
    this.status = 503;
    this.code = "service_unavailable";
  }
}

function createSemaphore({ slots, queueDepth } = {}) {
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error(`createSemaphore: slots must be a positive integer, got ${JSON.stringify(slots)}`);
  }
  const depth = queueDepth === undefined ? slots * 4 : queueDepth;
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(
      `createSemaphore: queueDepth must be a non-negative integer, got ${JSON.stringify(queueDepth)}`
    );
  }

  let running = 0;
  const waiters = [];

  function acquire() {
    if (running < slots) {
      running += 1;
      return Promise.resolve();
    }
    if (waiters.length >= depth) {
      // Reject BEFORE touching `running`, so a shed request never consumes the
      // capacity it was denied.
      return Promise.reject(new SemaphoreFullError());
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    if (running === 0) {
      throw new Error("semaphore: released more slots than were acquired");
    }
    const next = waiters.shift();
    if (next === undefined) {
      running -= 1;
      return;
    }
    // The slot transfers directly to the waiter: `running` does not dip, so a
    // third caller arriving in this tick cannot slip past the limit.
    next();
  }

  function stats() {
    return { running, queued: waiters.length, slots, queueDepth: depth };
  }

  return { acquire, release, stats };
}

module.exports = { createSemaphore, SemaphoreFullError };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/core-api/test/semaphore.test.js`

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/lib/semaphore.js apps/core-api/test/semaphore.test.js
git commit -m "feat(core-api): lib/semaphore - bounded scrypt concurrency that sheds instead of queueing"
```

---

### Task 8: `lib/client-ip.js` — the `X-Forwarded-For` derivation

**Files:**

- Create: `apps/core-api/lib/client-ip.js`
- Test: `apps/core-api/test/client-ip.test.js`

core-api answers behind Nginx, so `req.socket.remoteAddress` is `127.0.0.1` for
every request on earth. Both naive implementations fail in **opposite**
directions: keying on the socket puts every request in one global bucket, so 60
bad logins per minute lock out every staff member in every company; keying on a
raw `X-Forwarded-For` lets the client forge a fresh bucket per request, removing
the throttle entirely.

**`isIP` is an argument.** Rule C9 bans `require("node:net")` under `lib/`, and
the parent spec's `net.isIP()` prescription would violate it. The HTTP layer
supplies the real one in Plan 2b.

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/client-ip.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const { isIP } = require("node:net");
const { test } = require("node:test");

const { deriveClientIp, UNTRUSTED_BUCKET_KEY } = require("../lib/client-ip");

const derive = (header, hops) => deriveClientIp({ header, trustedProxyHops: hops, isIP });

test("one trusted hop takes the rightmost entry", () => {
  assert.deepEqual(derive("203.0.113.9", 1), {
    ip: "203.0.113.9",
    bucketKey: "203.0.113.9",
    trusted: true
  });
  // The attacker prepends; the rightmost entry is the one Nginx wrote.
  assert.deepEqual(derive("1.1.1.1, 203.0.113.9", 1), {
    ip: "203.0.113.9",
    bucketKey: "203.0.113.9",
    trusted: true
  });
});

test("two trusted hops take the second from the right", () => {
  assert.deepEqual(derive("9.9.9.9, 203.0.113.9, 10.0.0.1", 2), {
    ip: "203.0.113.9",
    bucketKey: "203.0.113.9",
    trusted: true
  });
});

test("forging cannot move the selected entry", () => {
  // Whatever the client prepends, one hop always selects what the proxy appended.
  for (const forged of ["", "8.8.8.8", "8.8.8.8, 9.9.9.9", "not-an-ip", ", ,"]) {
    const header = forged === "" ? "203.0.113.9" : `${forged}, 203.0.113.9`;
    assert.equal(derive(header, 1).ip, "203.0.113.9");
  }
});

test("an absent header is untrusted, and fails CLOSED for the bucket", () => {
  for (const header of [undefined, null, "", "   "]) {
    assert.deepEqual(derive(header, 1), {
      // NULL in the audit row: fail-soft, because a wrong address is worse
      // than a missing one.
      ip: null,
      // One shared bucket: fail-CLOSED, so an attacker cannot escape the
      // throttle by stripping the header.
      bucketKey: UNTRUSTED_BUCKET_KEY,
      trusted: false
    });
  }
});

test("fewer entries than the hop count is untrusted", () => {
  assert.deepEqual(derive("203.0.113.9", 2), {
    ip: null,
    bucketKey: UNTRUSTED_BUCKET_KEY,
    trusted: false
  });
});

test("a selected entry that is not an IP is untrusted", () => {
  // The failure this prevents: writing the raw comma-separated header into an
  // inet column raises "invalid input syntax for type inet" INSIDE the login
  // transaction, failing login outright for anyone behind two proxies.
  for (const bad of ["banana", "203.0.113.9:443", "203.0.113.999", "<script>"]) {
    assert.deepEqual(derive(`1.1.1.1, ${bad}`, 1), {
      ip: null,
      bucketKey: UNTRUSTED_BUCKET_KEY,
      trusted: false
    });
  }
});

test("IPv6 is accepted, and surrounding whitespace is tolerated", () => {
  assert.deepEqual(derive("  2001:db8::1  ", 1), {
    ip: "2001:db8::1",
    bucketKey: "2001:db8::1",
    trusted: true
  });
});

test("zero hops is untrusted for every input", () => {
  // TRUSTED_PROXY_HOPS=0 means "no proxy is trusted", so no entry may be
  // believed. config.js allows 0 as the development default.
  assert.equal(derive("203.0.113.9", 0).trusted, false);
  assert.equal(derive("203.0.113.9", 0).bucketKey, UNTRUSTED_BUCKET_KEY);
});

test("an array-valued header is refused rather than stringified", () => {
  // Node exposes a repeated header as an array. String(["a","b"]) is "a,b",
  // which would silently invent an entry that no proxy wrote.
  assert.deepEqual(derive(["1.1.1.1", "203.0.113.9"], 1), {
    ip: null,
    bucketKey: UNTRUSTED_BUCKET_KEY,
    trusted: false
  });
});

test("the hop count is validated", () => {
  for (const bad of [-1, 1.5, "1", null, undefined]) {
    assert.throws(
      () => deriveClientIp({ header: "203.0.113.9", trustedProxyHops: bad, isIP }),
      /trustedProxyHops must be a non-negative integer/
    );
  }
});

test("isIP must be supplied, because lib/ may not require node:net", () => {
  assert.throws(
    () => deriveClientIp({ header: "203.0.113.9", trustedProxyHops: 1 }),
    /isIP must be a function/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/core-api/test/client-ip.test.js`

Expected: FAIL — `Cannot find module '../lib/client-ip'`.

- [ ] **Step 3: Write the implementation**

Create `apps/core-api/lib/client-ip.js`:

```js
"use strict";

// PURE (Tier 1). `isIP` is an ARGUMENT rather than a require, because rule C9
// bans node:net under lib/ and the validation still has to be the real one --
// a hand-written IPv6 matcher is exactly the kind of thing that is subtly wrong
// for years. http/ supplies require("node:net").isIP.

// One shared bucket for every request whose address could not be derived. This
// is the STRICTEST option and it is deliberate: an attacker who strips the
// header lands in the same bucket as every other such request, so removing the
// header cannot be used to escape a throttle.
const UNTRUSTED_BUCKET_KEY = "unknown";

const UNTRUSTED = Object.freeze({ ip: null, bucketKey: UNTRUSTED_BUCKET_KEY, trusted: false });

// Counted from the RIGHT: entries to the left of the trusted hops are whatever
// the client sent, and the rightmost `trustedProxyHops` entries are what our own
// proxies appended.
function deriveClientIp({ header, trustedProxyHops, isIP }) {
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0) {
    throw new Error(
      `deriveClientIp: trustedProxyHops must be a non-negative integer, got ${JSON.stringify(
        trustedProxyHops
      )}`
    );
  }
  if (typeof isIP !== "function") {
    throw new Error("deriveClientIp: isIP must be a function (lib/ may not require node:net)");
  }

  // No proxy is trusted, so no entry may be believed.
  if (trustedProxyHops === 0) return UNTRUSTED;

  // A repeated header arrives as an array. Stringifying it would join with a
  // comma and invent an entry boundary no proxy wrote.
  if (typeof header !== "string") return UNTRUSTED;

  const entries = header.split(",").map((entry) => entry.trim());
  if (entries.length < trustedProxyHops) return UNTRUSTED;

  const candidate = entries[entries.length - trustedProxyHops];
  if (candidate === undefined || isIP(candidate) === 0) return UNTRUSTED;

  return { ip: candidate, bucketKey: candidate, trusted: true };
}

module.exports = { deriveClientIp, UNTRUSTED_BUCKET_KEY };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/core-api/test/client-ip.test.js`

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/lib/client-ip.js apps/core-api/test/client-ip.test.js
git commit -m "feat(core-api): lib/client-ip - fail-closed X-Forwarded-For derivation"
```

---

## Part 3 — The audit vocabulary and its writer

### Task 9: `lib/audit-vocabulary.js` — the closed §5.9 table

**Files:**

- Create: `apps/core-api/lib/audit-vocabulary.js`
- Test: `apps/core-api/test/audit-vocabulary.test.js`

One table, consulted by two callers: Plan 2b's boot-time route check (§8.5 rule 4)
and Task 10's writer. Two copies would disagree the first time somebody adds an
action.

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/audit-vocabulary.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { AUDIT_ACTIONS, assertAuditEvent } = require("../lib/audit-vocabulary");

// The regex on audit_events.action in 0001_init.sql. Every declared action must
// satisfy it, or the row is rejected at write time rather than at review time.
const DDL_ACTION_SHAPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

test("every action satisfies the DDL's shape and length limit", () => {
  const names = Object.keys(AUDIT_ACTIONS);
  assert.ok(names.length >= 5, `only ${names.length} actions declared`);
  for (const name of names) {
    assert.match(name, DDL_ACTION_SHAPE, `${name} does not match the audit_events CHECK`);
    assert.ok(name.length <= 64, `${name} exceeds the 64-character limit`);
  }
});

test("the vocabulary is sorted, so a diff adding one is readable", () => {
  const names = Object.keys(AUDIT_ACTIONS);
  assert.deepEqual(names, [...names].sort());
});

test("the five identity-slice actions are declared", () => {
  for (const action of [
    "auth.email_send_failed",
    "auth.email_verified",
    "auth.email_verify_requested",
    "auth.password_reset_completed",
    "auth.password_reset_requested"
  ]) {
    assert.ok(AUDIT_ACTIONS[action], `${action} is not declared`);
  }
});

test("no declared detail key is credential-shaped", () => {
  // audit_events_detail_no_credentials rejects these at the database. Catching
  // it here means the failure is a test, not a 500 in production.
  const banned = ["password", "token", "code", "secret", "cookie",
                  "authorization", "token_hash", "code_hash",
                  "password_hash", "session", "sid"];
  for (const [action, entry] of Object.entries(AUDIT_ACTIONS)) {
    for (const key of entry.detail) {
      assert.ok(!banned.includes(key), `${action} declares the credential-shaped key ${key}`);
    }
  }
});

test("assertAuditEvent accepts a well-formed event", () => {
  assert.doesNotThrow(() =>
    assertAuditEvent({
      action: "auth.password_reset_requested",
      actorKind: "anonymous",
      outcome: "failure",
      detail: { email: "nobody@example.test" }
    })
  );
});

test("assertAuditEvent rejects an undeclared action", () => {
  assert.throws(
    () => assertAuditEvent({ action: "auth.invented", actorKind: "user", outcome: "success" }),
    /is not in the audit vocabulary/
  );
});

test("assertAuditEvent rejects an actor kind the action does not permit", () => {
  assert.throws(
    () => assertAuditEvent({ action: "auth.email_verify_requested", actorKind: "terminal", outcome: "success" }),
    /actorKind "terminal" is not permitted/
  );
});

test("assertAuditEvent rejects an outcome the action does not permit", () => {
  assert.throws(
    () => assertAuditEvent({ action: "auth.email_verified", actorKind: "anonymous", outcome: "failure" }),
    /outcome "failure" is not permitted/
  );
});

test("assertAuditEvent rejects an undeclared detail key", () => {
  assert.throws(
    () =>
      assertAuditEvent({
        action: "auth.email_verified",
        actorKind: "anonymous",
        outcome: "success",
        detail: { email: "someone@example.test" }
      }),
    /detail key "email" is not declared/
  );
});

test("assertAuditEvent rejects a non-scalar detail value", () => {
  // audit_events_detail_is_flat_object rejects it at the database; the jsonb ?
  // family inspects top-level keys only, so a nested object would smuggle a
  // password past the credential-name CHECK.
  assert.throws(
    () =>
      assertAuditEvent({
        action: "auth.password_reset_requested",
        actorKind: "anonymous",
        outcome: "failure",
        detail: { email: { nested: true } }
      }),
    /detail\.email must be a scalar/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/core-api/test/audit-vocabulary.test.js`

Expected: FAIL — `Cannot find module '../lib/audit-vocabulary'`.

- [ ] **Step 3: Write the implementation**

Create `apps/core-api/lib/audit-vocabulary.js`:

```js
"use strict";

// PURE (Tier 1). No requires at all.
//
// Spec 5.9's closed vocabulary. It exists so that roughly twenty-five action
// strings are not invented at implementation time, and so that
// audit_events_detail_no_credentials is protecting a set somebody chose rather
// than whatever a handler happened to pass.
//
// This slice declares only the actions its own routes emit. Plan 2b and 2c add
// theirs; the sorted-order test keeps each addition a readable diff.

function entry(actorKinds, outcomes, targetKind, detail) {
  return Object.freeze({
    actorKinds: Object.freeze(actorKinds),
    outcomes: Object.freeze(outcomes),
    targetKind,
    detail: Object.freeze(detail)
  });
}

const AUDIT_ACTIONS = Object.freeze({
  // system, because the sweeper writes it, and the actor arc CHECK requires
  // both actor id columns NULL for 'system'.
  "auth.email_send_failed": entry(["system"], ["failure"], "user", ["purpose", "attempts"]),
  // anonymous: the caller presented a mailed token, not a session.
  "auth.email_verified": entry(["anonymous"], ["success"], "user", []),
  "auth.email_verify_requested": entry(["user"], ["success"], "user", []),
  "auth.password_reset_completed": entry(["anonymous"], ["success"], "user", []),
  // The one row whose target is CONDITIONAL. When the probed address matches no
  // row there is no user to name, and audit_events_target_pair requires
  // (target_kind IS NULL) = (target_id IS NULL) -- so both are NULL and the
  // address survives only in detail.email.
  "auth.password_reset_requested": entry(["anonymous"], ["success", "failure"], "user", ["email"])
});

function assertAuditEvent(event) {
  const { action, actorKind, outcome, detail } = event;

  const declared = Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, action)
    ? AUDIT_ACTIONS[action]
    : null;
  if (declared === null) {
    throw new Error(`audit: "${String(action)}" is not in the audit vocabulary`);
  }
  if (!declared.actorKinds.includes(actorKind)) {
    throw new Error(
      `audit: ${action} actorKind "${String(actorKind)}" is not permitted (expected ${declared.actorKinds.join(
        " | "
      )})`
    );
  }
  if (!declared.outcomes.includes(outcome)) {
    throw new Error(
      `audit: ${action} outcome "${String(outcome)}" is not permitted (expected ${declared.outcomes.join(
        " | "
      )})`
    );
  }

  for (const [key, value] of Object.entries(detail || {})) {
    if (!declared.detail.includes(key)) {
      throw new Error(`audit: ${action} detail key "${key}" is not declared`);
    }
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      throw new Error(`audit: ${action} detail.${key} must be a scalar, not ${typeof value}`);
    }
  }

  return declared;
}

module.exports = { AUDIT_ACTIONS, assertAuditEvent };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/core-api/test/audit-vocabulary.test.js`

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/lib/audit-vocabulary.js apps/core-api/test/audit-vocabulary.test.js
git commit -m "feat(core-api): lib/audit-vocabulary - the closed action table, checked before the DDL sees it"
```

---

### Task 10: `repositories/auth/audit.js` — the pre-tenant writer

**Files:**

- Create: `apps/core-api/repositories/auth/audit.js`
- Test: `apps/core-api/test/audit-writer.test.js`

`repositories/auth/audit.js` is **already named** in `source-structure.test.js`'s
nine-entry `UNSCOPED_ALLOWLIST`, so this path is fixed — do not rename it. The
writer is pre-tenant because a failed login has no tenant: it writes
`company_id = NULL` and the row is still the only evidence the attempt happened.

- [ ] **Step 1: Write the failing test**

Three details of the test harness that are easy to get wrong, and each produces a
confusing failure rather than an obvious one:

- **`cloneTemplate` takes `__filename`.** The database name is derived from it, so
  omitting it collides with another suite's clone.
- **The handle's raw query method is `unscoped(text, params)`, not `query`.** It
  deliberately bypasses the repositories, which is what a fixture needs.
- **`appendAuditEvent` goes through `withUnscopedConnection`, which uses the
  RUNTIME POOL.** The clone is a different database, so the test must open the
  runtime pool against `db.connectionString` or the call fails with *"runtime pool
  is not open"*. Close it before dropping.

Create `apps/core-api/test/audit-writer.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");

const { closeAllPools, openRuntimePool } = require("../db");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const { appendAuditEvent } = require("../repositories/auth/audit");

describe("the pre-tenant audit writer", { skip: skipDatabaseTests() }, () => {
  let database;

  before(async () => {
    database = await cloneTemplate(__filename);
    // appendAuditEvent reaches the database through withUnscopedConnection,
    // which checks out of the runtime pool. Point that pool at the clone.
    openRuntimePool({ connectionString: database.connectionString, max: 4 });
  });

  after(async () => {
    await closeAllPools();
    if (database) await database.drop();
  });

  test("writes an anonymous failure with no tenant and no target", async () => {
    await appendAuditEvent({
      action: "auth.password_reset_requested",
      actorKind: "anonymous",
      outcome: "failure",
      sourceIp: "203.0.113.9",
      detail: { email: "nobody@example.test" }
    });

    const { rows } = await database.unscoped(
      "SELECT * FROM audit_events WHERE action = 'auth.password_reset_requested'"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].company_id, null);
    assert.equal(rows[0].actor_user_id, null);
    assert.equal(rows[0].target_kind, null);
    assert.equal(rows[0].target_id, null);
    assert.equal(rows[0].source_ip, "203.0.113.9");
    assert.deepEqual(rows[0].detail, { email: "nobody@example.test" });
  });

  test("a null source_ip is written, not omitted", async () => {
    // The untrusted derivation is fail-SOFT for the audit row: a missing
    // address is honest, and a wrong one is not.
    await appendAuditEvent({
      action: "auth.password_reset_requested",
      actorKind: "anonymous",
      outcome: "failure",
      sourceIp: null,
      detail: { email: "nulled@example.test" }
    });

    const { rows } = await database.unscoped(
      "SELECT source_ip FROM audit_events WHERE detail->>'email' = 'nulled@example.test'"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_ip, null);
  });

  test("an undeclared action is refused before it reaches the database", async () => {
    await assert.rejects(
      () => appendAuditEvent({ action: "auth.invented", actorKind: "anonymous", outcome: "success" }),
      /is not in the audit vocabulary/
    );
    const { rows } = await database.unscoped("SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.invented'");
    assert.equal(rows[0].n, 0);
  });

  test("a nested detail value is refused before the flat-object CHECK sees it", async () => {
    await assert.rejects(
      () =>
        appendAuditEvent({
          action: "auth.password_reset_requested",
          actorKind: "anonymous",
          outcome: "failure",
          detail: { email: { smuggled: "password" } }
        }),
      /must be a scalar/
    );
  });

  test("the actor arc is satisfied for a user actor", async () => {
    const { rows: users } = await database.unscoped(
      `INSERT INTO users (company_id, role, email, display_name, password_hash)
       VALUES (NULL, 'platform_admin', 'audit-actor@example.test', 'Audit Actor',
               'scrypt$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
       RETURNING id`
    );

    await appendAuditEvent({
      action: "auth.email_verify_requested",
      actorKind: "user",
      actorUserId: users[0].id,
      actorLabel: "audit-actor@example.test",
      outcome: "success",
      targetKind: "user",
      targetId: users[0].id
    });

    const { rows } = await database.unscoped(
      "SELECT * FROM audit_events WHERE action = 'auth.email_verify_requested'"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_user_id, users[0].id);
    assert.equal(rows[0].actor_label, "audit-actor@example.test");
    assert.equal(rows[0].target_kind, "user");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/core-api/test/audit-writer.test.js`

Expected: FAIL — `Cannot find module '../repositories/auth/audit'`.

- [ ] **Step 3: Write the implementation**

Create `apps/core-api/repositories/auth/audit.js`:

```js
"use strict";

// PRE_TENANT_REASON: a failed login, a redeemed reset link and a swept token all
// have to be recorded before -- or without -- any company_id existing. This is
// one of the nine files source-structure.test.js rule C4 sanctions to call
// withUnscopedConnection, and the path is pinned by that allowlist.
const PRE_TENANT_REASON =
  "audit rows are written for anonymous and system actors, which have no tenant scope";

const { withUnscopedConnection } = require("../../db");
const { assertAuditEvent } = require("../../lib/audit-vocabulary");

// Append only. Nothing in the service updates or deletes an audit row; the
// nightly sweep deletes by retention window and nothing else.
const INSERT = `
  INSERT INTO audit_events
    (company_id, shop_id, actor_kind, actor_user_id, actor_terminal_id, actor_label,
     action, outcome, target_kind, target_id, source_ip, detail)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
  RETURNING id
`;

async function appendAuditEvent(event) {
  // Vocabulary first: an undeclared action, actor kind, outcome or detail key
  // must fail as a programming error here rather than as a 23514 check
  // violation inside somebody else's transaction.
  assertAuditEvent(event);

  const {
    companyId = null,
    shopId = null,
    actorKind,
    actorUserId = null,
    actorTerminalId = null,
    actorLabel = null,
    action,
    outcome,
    targetKind = null,
    targetId = null,
    sourceIp = null,
    detail = {}
  } = event;

  return withUnscopedConnection(async (client) => {
    const { rows } = await client.query(INSERT, [
      companyId,
      shopId,
      actorKind,
      actorUserId,
      actorTerminalId,
      actorLabel,
      action,
      outcome,
      targetKind,
      targetId,
      sourceIp,
      JSON.stringify(detail)
    ]);
    return rows[0].id;
  });
}

module.exports = { appendAuditEvent, PRE_TENANT_REASON };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/core-api/test/audit-writer.test.js`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/repositories/auth/audit.js apps/core-api/test/audit-writer.test.js
git commit -m "feat(core-api): repositories/auth/audit - the pre-tenant append-only writer"
```

---

## Part 4 — Structural bookkeeping

### Task 11: Raise the walker floor and close the area gate

**Files:**

- Modify: `apps/core-api/test/source-structure.test.js` (the `>= 15` floor and its sentinels)

The walker's floor exists so that a walker returning `[]` cannot make every
"no file matches X" rule pass vacuously. It must rise with each plan.

- [ ] **Step 1: Confirm the new file count**

Run:

```bash
node -e "const{execSync}=require('child_process');" \
     -e "console.log(execSync('git ls-files apps/core-api/lib apps/core-api/repositories apps/core-api/migrations').toString())"
```

Expected: seven new paths — `lib/audit-vocabulary.js`, `lib/client-ip.js`,
`lib/password.js`, `lib/semaphore.js`, `lib/tokens.js`,
`migrations/0002_identity.sql`, `repositories/auth/audit.js`.

- [ ] **Step 2: Raise the floor and add a sentinel**

In `apps/core-api/test/source-structure.test.js`, replace the floor block:

```js
  // Requirement 2: a floor plus sentinels. Without it, a walker returning []
  // makes every "no file matches X" rule below pass. Plan 1 ended with fifteen
  // scanned files. Plan 2a adds seven: lib/{audit-vocabulary,client-ip,password,
  // semaphore,tokens}.js, migrations/0002_identity.sql and
  // repositories/auth/audit.js. Raise this floor in each later plan as
  // repositories/ and http/routes/ fill in.
  assert.ok(
    SOURCE_FILES.length >= 22,
    `scanned only ${SOURCE_FILES.length} files: ${SOURCE_FILES.join(", ")}`
  );

  for (const sentinel of [
    "db/index.js",
    "http/routes/health.js",
    "migrations/0001_init.sql",
    // Plan 2a's sentinels: one per NEW area, so a walker that silently stops
    // descending into lib/ or repositories/ fails here rather than passing C9
    // and C4 vacuously.
    "lib/tokens.js",
    "repositories/auth/audit.js",
    "migrations/0002_identity.sql"
  ]) {
    assert.ok(SOURCE_FILES.includes(sentinel), `sentinel ${sentinel} was not scanned`);
  }
```

- [ ] **Step 3: Run the structural suite**

Run: `node --test apps/core-api/test/source-structure.test.js`

Expected: PASS. In particular C9 (`nothing under lib/ touches the filesystem, the
network or the database`) now has five real files to check rather than none — if
it fails, something under `lib/` requires `node:fs`, `node:net`, `pg` or `../db`.

- [ ] **Step 4: Run the whole area gate with a real database**

Run:

```bash
npm --prefix apps/core-api test
```

Expected: PASS with 0 failures. The count should be roughly 285 + the ~53 tests
this plan adds. **One visible skip remains** — C6's
`repositories/platform/ does not exist yet`, which arms itself in Plan 2c.

Then confirm nothing else in the monorepo moved:

```bash
npm test
```

Expected: all four workspace suites green.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/test/source-structure.test.js docs/superpowers/plans/2026-08-04-core-api-phase1-plan2a-primitives.md
git commit -m "test(core-api): raise the walker floor to 22 and sentinel the two new areas"
```

---

## Where this plan stops

Deliberately **not** built here, and the plan that owns each:

| Not here | Plan |
| --- | --- |
| Any HTTP route, any middleware, `http/csrf.js`, `http/authenticate.js` | 2b |
| The limiter roster constant and `route()`'s `limit.name` boot check | 2b |
| `repositories/auth/{users,sessions,scope-materialize}.js` | 2b |
| `scripts/create-platform-admin.js` | 2b |
| Every deploy-pipeline and nginx edit — block 4, the forged-XFF probe, the new zone | 2b |
| `repositories/platform/*` and C6's ten-export deepEqual | 2c |
| `mail/*`, `nodemailer`, the eleven SMTP config knobs, `sendHtml` | 2d |
| `scripts/sweep-expired.js` | 2d |

**The public route set does not move in this plan.** No route registers, so
`route-auth.test.js`'s two-element literal stays as it is and the deploy
pipeline's block-4 probe still correctly expects its 404. That is the whole reason
the migration ships on its own: it reaches production, applies, and is verified by
`/health/ready` before a single route depends on it.
