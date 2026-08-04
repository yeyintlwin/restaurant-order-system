-- 0002_identity.sql -- credential recovery, and the ledger lockdown 0001 could
-- not perform on itself.
--
-- Additive only. Nothing here drops or renames, and the one new NOT NULL column
-- lives on a new table, so no existing row is rewritten.

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
  sent_to_email       text NOT NULL,
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
    CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX user_email_tokens_hash_key
  ON user_email_tokens (token_hash);

-- One live token per (user, purpose). This carries the pairing-code trap
-- verbatim: now() cannot appear in an index predicate, so an EXPIRED but
-- unconsumed row still occupies the slot and would permanently brick that
-- user's recovery. Every mint site therefore runs
--   SELECT ... FOR UPDATE; revoke any live row; INSERT
-- inside ONE transaction. Do not "fix" the expiry case by adding expires_at to
-- this predicate -- Postgres rejects it as not IMMUTABLE.
CREATE UNIQUE INDEX user_email_tokens_live_key
  ON user_email_tokens (user_id, purpose)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- The sweeper's driving index: rows owed a delivery attempt.
CREATE INDEX user_email_tokens_delivery_due_idx
  ON user_email_tokens (delivery_next_at)
  WHERE delivery_sent_at IS NULL
    AND consumed_at IS NULL
    AND revoked_at IS NULL;

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
