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
-- then queues behind IT. The REVOKE at the foot of this file takes a lock on
-- schema_migrations for the same reason. 0001 only ever created new tables --
-- it could block on nothing pre-existing -- and set these anyway.
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
