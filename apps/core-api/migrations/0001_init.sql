-- ===========================================================================
-- 0001_init.sql -- core-api Phase 1: tenant model, user auth, terminal pairing.
--
-- Requires PostgreSQL >= 14. The migration runner asserts server_version_num
-- before applying anything, wraps this file in one transaction together with
-- its schema_migrations row, and holds pg_advisory_lock for the whole run.
-- The runner sends each file as ONE query string (it must never split on
-- semicolons -- the dollar-quoted bodies below would be cut in half).
--
-- Conventions enforced below and asserted by test/schema-invariants.test.js:
--   * Every tenant-owned table carries company_id uuid NOT NULL.
--   * Every ownership/containment FK is composite and includes company_id, so
--     a cross-tenant reference is rejected by Postgres, not by discipline.
--   * Attribution columns (created_by_user_id, revoked_by_user_id) are plain
--     single-column FKs with ON DELETE RESTRICT and are listed by name in the
--     test's exception list. No FK anywhere uses ON DELETE SET NULL: on a
--     composite FK that action nulls *every* referencing column, which would
--     always fail against NOT NULL company_id.
--   * Credential digests are bytea(32), never hex text, so binding a raw
--     credential by mistake raises "invalid input syntax for type bytea"
--     instead of silently matching zero rows.
-- ===========================================================================

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- Infrastructure (not tenant-owned)
-- ---------------------------------------------------------------------------

-- The runner creates this with identical DDL before it reads any file, so this
-- statement is a no-op on a fresh database. It lives here as well so the schema
-- is fully described by the migration history.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY CHECK (filename ~ '^[0-9]{4}_[a-z0-9_]+\.sql$'),
  checksum    bytea       NOT NULL CHECK (octet_length(checksum) = 32),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer     NOT NULL DEFAULT 0 CHECK (duration_ms >= 0)
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- companies -- tenant root
-- ---------------------------------------------------------------------------

CREATE TABLE companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  status     text        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX companies_name_active_key
  ON companies (lower(btrim(name))) WHERE status = 'active';

CREATE TRIGGER companies_set_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- users -- humans who log in with a password
--
-- platform_admin is a role value here, not a separate table. The table CHECK
-- below is what makes that safe: promoting a tenant user to platform_admin
-- requires nulling company_id in the same statement, and no tenant-scoped
-- repository ever writes company_id (tenantQuery binds it from the caller's
-- credential and refuses SQL that names it in an INSERT column list or an
-- UPDATE SET list). A stray "UPDATE users SET role = 'platform_admin'"
-- therefore fails with a check violation rather than escalating.
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid REFERENCES companies (id) ON DELETE RESTRICT,
  role                 text NOT NULL
                         CHECK (role IN ('platform_admin', 'company_admin',
                                         'shop_manager', 'staff')),
  email                text NOT NULL
                         CHECK (email = lower(btrim(email))
                            AND length(email) BETWEEN 3 AND 254
                            AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  display_name         text NOT NULL
                         CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  -- Self-describing PHC-style string: scrypt$N=32768,r=8,p=1$<salt>$<key>.
  -- The prefix CHECK means this column cannot physically hold a plaintext
  -- password or a bare SHA-256 hex digest.
  password_hash        text NOT NULL
                         CHECK (password_hash LIKE 'scrypt$%'
                            AND length(password_hash) BETWEEN 40 AND 512),
  must_change_password boolean     NOT NULL DEFAULT false,
  -- Single bulk-invalidation lever. Bumped on password change, suspension and
  -- "sign out everywhere"; the session resolver requires
  -- user_sessions.created_at >= users.sessions_valid_from, so revocation is a
  -- fail-closed UPDATE that cannot miss a row.
  sessions_valid_from  timestamptz NOT NULL DEFAULT now(),
  failed_login_count   integer     NOT NULL DEFAULT 0
                         CHECK (failed_login_count >= 0),
  locked_until         timestamptz,
  last_login_at        timestamptz,
  status               text        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'suspended')),
  created_by_user_id   uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_platform_admin_has_no_company
    CHECK ((role = 'platform_admin') = (company_id IS NULL)),
  -- FK anchor for user_shops. company_id is NULL for platform_admin, and under
  -- MATCH SIMPLE a child row (whose company_id is NOT NULL) can never match
  -- such a row -- which is exactly right: platform admins are not
  -- shop-assignable, and that is now a constraint rather than a convention.
  CONSTRAINT users_id_company_key UNIQUE (id, company_id)
);

-- Unconditional, not partial on status: email is identity. Freeing a suspended
-- user's address for reuse would let a second row shadow the first in the login
-- lookup. Operational labels (shop/terminal/table names) use partial-on-active
-- indexes instead; identities do not.
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_company_role_idx ON users (company_id, role)
  WHERE status = 'active';

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE companies
  ADD COLUMN created_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- shops
--
-- time_zone and business_day_rollover_hour have NO DEFAULT on purpose. A
-- default of 'Asia/Tokyo'/6 is this deployment's configuration, and a shop
-- created in Yangon with a silently-inherited Tokyo clock is a bug that would
-- not surface until Phase 3 computes its first business_date on live orders.
-- ---------------------------------------------------------------------------

CREATE TABLE shops (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                 uuid NOT NULL
                               REFERENCES companies (id) ON DELETE RESTRICT,
  name                       text NOT NULL
                               CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- IANA name. Not CHECK-able in the database: zone resolution is STABLE, not
  -- IMMUTABLE. The repository validates with Intl.DateTimeFormat and also
  -- proves the (time_zone, rollover_hour) pair resolves to exactly one instant
  -- on every day of the next 400 days before writing.
  time_zone                  text     NOT NULL
                               CHECK (length(time_zone) BETWEEN 3 AND 64),
  business_day_rollover_hour smallint NOT NULL
                               CHECK (business_day_rollover_hour BETWEEN 0 AND 23),
  status                     text     NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'suspended')),
  created_by_user_id         uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  -- Redundant against the PK, and that is the point: it is the anchor that
  -- lets every child declare FOREIGN KEY (shop_id, company_id).
  CONSTRAINT shops_id_company_key UNIQUE (id, company_id)
);

CREATE UNIQUE INDEX shops_company_name_active_key
  ON shops (company_id, lower(btrim(name))) WHERE status = 'active';
CREATE INDEX shops_company_idx ON shops (company_id) WHERE status = 'active';

CREATE TRIGGER shops_set_updated_at
  BEFORE UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- shop_tables -- one physical dining table
--
-- Named shop_tables, not tables: the bare word collides with SQL vocabulary,
-- information_schema.tables and \dt in a repo that writes raw SQL everywhere.
-- The FK column in later phases is shop_table_id.
--
-- label is uppercase A-Z, 0-9, space and dash, at most 8 characters. That is
-- not arbitrary: packages/epaper-hub-sdk/table-template.js FONT contains
-- exactly that glyph set and drawText() uppercases its input, so any other
-- character would render as blanks on a real panel with no error.
-- ---------------------------------------------------------------------------

CREATE TABLE shop_tables (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL,
  shop_id            uuid NOT NULL,
  label              text NOT NULL CHECK (label ~ '^[A-Z0-9][A-Z0-9 -]{0,7}$'),
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'archived')),
  created_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, company_id)
    REFERENCES shops (id, company_id) ON DELETE RESTRICT,
  -- Anchor for the Phase-3 table_visits/orders composite FK. Created now,
  -- while the table is empty, so that migration takes no lock on live data.
  CONSTRAINT shop_tables_id_shop_company_key UNIQUE (id, shop_id, company_id)
);

-- Partial on 'active': archiving a renumbered table must release its label, or
-- a renovated floor plan can never reuse "5" and archiving becomes useless for
-- the one case it exists for.
CREATE UNIQUE INDEX shop_tables_shop_label_active_key
  ON shop_tables (shop_id, label) WHERE status = 'active';
CREATE INDEX shop_tables_shop_idx ON shop_tables (company_id, shop_id)
  WHERE status = 'active';

CREATE TRIGGER shop_tables_set_updated_at
  BEFORE UPDATE ON shop_tables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- user_shops -- which shops a shop_manager or staff user may act on
--
-- The sharpest control in the schema: both FKs are anchored on the SAME
-- company_id column, so assigning a user of company A to a shop of company B
-- would require two different values in one column. Postgres rejects it.
-- ---------------------------------------------------------------------------

CREATE TABLE user_shops (
  company_id         uuid NOT NULL,
  user_id            uuid NOT NULL,
  shop_id            uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, shop_id),
  FOREIGN KEY (user_id, company_id)
    REFERENCES users (id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, company_id)
    REFERENCES shops (id, company_id) ON DELETE RESTRICT
);

CREATE INDEX user_shops_shop_idx ON user_shops (company_id, shop_id, user_id);

-- ---------------------------------------------------------------------------
-- user_sessions
--
-- acting_company_id is the tenant the session is operating inside. For every
-- tenant role it must equal users.company_id (the resolver joins and requires
-- it, so a mismatch kills the session). For platform_admin it is the company
-- selected via POST /api/admin/scope, or NULL for platform-level routes. That
-- is what lets a platform admin drive ordinary tenant repositories under an
-- ordinary tenant scope, with the selection recorded in audit_events, instead
-- of maintaining a duplicated cross-tenant repository layer.
-- ---------------------------------------------------------------------------

CREATE TABLE user_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  acting_company_id   uuid  REFERENCES companies (id) ON DELETE CASCADE,
  token_hash          bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_ip        inet,
  -- Sliding idle window. The writer MUST clamp:
  --   SET expires_at = LEAST(now() + <idle>, absolute_expires_at)
  -- The CHECK is the backstop, not the clamp -- an unclamped bump would raise
  -- a check violation for the whole final idle window of every session.
  expires_at          timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  CONSTRAINT user_sessions_idle_within_absolute
    CHECK (expires_at <= absolute_expires_at),
  CONSTRAINT user_sessions_absolute_after_creation
    CHECK (absolute_expires_at > created_at)
);

CREATE UNIQUE INDEX user_sessions_token_hash_key ON user_sessions (token_hash);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
-- Sweeper predicate is expires_at, not absolute_expires_at: an idle-dead
-- session must be collectable without waiting out the absolute cap.
CREATE INDEX user_sessions_expiry_idx ON user_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- terminals -- shared devices bound to one shop
--
-- The terminal row is created by a named human BEFORE any device connects, so
-- kind and shop_id are fixed by an administrator and a device can never choose
-- its own shop or elevate its kind. The row is the durable identity; tokens are
-- replaceable credentials attached to it, so swapping broken hardware keeps the
-- name, the pairing history and (Phase 5) the sales attribution.
-- ---------------------------------------------------------------------------

CREATE TABLE terminals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL,
  shop_id            uuid NOT NULL,
  kind               text NOT NULL
                       CHECK (kind IN ('kitchen_display', 'cashier_counter',
                                       'epaper_hub')),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  status             text NOT NULL DEFAULT 'unpaired'
                       CHECK (status IN ('unpaired', 'active', 'suspended')),
  paired_at          timestamptz,
  last_seen_at       timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, company_id)
    REFERENCES shops (id, company_id) ON DELETE RESTRICT,
  -- Three-column anchor: a pairing code or token cannot drift to a terminal in
  -- another SHOP, not merely another company.
  CONSTRAINT terminals_id_shop_company_key UNIQUE (id, shop_id, company_id)
);

CREATE UNIQUE INDEX terminals_shop_name_live_key
  ON terminals (shop_id, lower(btrim(name))) WHERE status <> 'suspended';
CREATE INDEX terminals_shop_kind_idx
  ON terminals (company_id, shop_id, kind) WHERE status <> 'suspended';

CREATE TRIGGER terminals_set_updated_at
  BEFORE UPDATE ON terminals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- terminal_pairing_codes
--
-- No attempt_count column: a wrong guess matches no row, so a per-row counter
-- can never be incremented by an attacker and would only cap resubmission of a
-- code they already hold. Brute force is bounded by 50 bits of entropy, the
-- 15-minute TTL, single use, the network rate limit, and an audit_events row
-- written on every failed redemption.
-- ---------------------------------------------------------------------------

CREATE TABLE terminal_pairing_codes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid  NOT NULL,
  shop_id            uuid  NOT NULL,
  terminal_id        uuid  NOT NULL,
  code_hash          bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  consumed_from_ip   inet,
  revoked_at         timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (terminal_id, shop_id, company_id)
    REFERENCES terminals (id, shop_id, company_id) ON DELETE RESTRICT,
  CONSTRAINT terminal_pairing_codes_expiry CHECK (expires_at > created_at),
  CONSTRAINT terminal_pairing_codes_single_terminal_state
    CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX terminal_pairing_codes_hash_key
  ON terminal_pairing_codes (code_hash);

-- At most one live code per terminal. now() cannot appear in an index
-- predicate, so an expired-but-unconsumed code still holds the slot. The mint
-- endpoint therefore takes SELECT ... FROM terminals WHERE id = $1 FOR UPDATE,
-- revokes any live code, and inserts -- all in one transaction. The row lock is
-- what stops two concurrent issuances from racing into a 23505.
CREATE UNIQUE INDEX terminal_pairing_codes_one_live_key
  ON terminal_pairing_codes (terminal_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX terminal_pairing_codes_terminal_idx
  ON terminal_pairing_codes (company_id, shop_id, terminal_id, created_at DESC);
CREATE INDEX terminal_pairing_codes_sweep_idx
  ON terminal_pairing_codes (expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- terminal_tokens
--
-- expires_at is NOT NULL from day one (90 days at mint). A nullable "no expiry"
-- default is not a free upgrade path: turning expiry on later means backfilling
-- the whole fleet, which bricks every device on one day.
--
-- There is deliberately no "exactly one live token per terminal" partial unique
-- index. Rotation (POST /api/terminal/token/rotate, authenticated by the
-- current token) mints a successor and shortens the predecessor to
-- LEAST(expires_at, now() + 10 minutes) rather than revoking it outright, so a
-- device that loses the response on flaky kitchen Wi-Fi self-heals on retry.
-- That overlap is unrepresentable under a one-live-token index. "Kill every
-- token for this terminal" stays a single set-based UPDATE that cannot miss a
-- row, which is the property the index was standing in for.
-- ---------------------------------------------------------------------------

CREATE TABLE terminal_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid  NOT NULL,
  shop_id            uuid  NOT NULL,
  terminal_id        uuid  NOT NULL,
  token_hash         bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  pairing_code_id    uuid REFERENCES terminal_pairing_codes (id) ON DELETE RESTRICT,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  last_seen_at       timestamptz,
  last_seen_ip       inet,
  revoked_at         timestamptz,
  revoked_reason     text CHECK (revoked_reason IN
                       ('rotated', 'repaired', 'admin_revoke',
                        'terminal_suspended', 'suspected_leak')),
  revoked_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  FOREIGN KEY (terminal_id, shop_id, company_id)
    REFERENCES terminals (id, shop_id, company_id) ON DELETE RESTRICT,
  CONSTRAINT terminal_tokens_expiry CHECK (expires_at > issued_at),
  -- Revocation always records why. System revocation (rotation, re-pair,
  -- cascade from suspension) leaves revoked_by_user_id NULL but is still
  -- self-describing, so a revoked token is never an unexplained dead end.
  CONSTRAINT terminal_tokens_revocation_is_explained
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE UNIQUE INDEX terminal_tokens_hash_key ON terminal_tokens (token_hash);
CREATE INDEX terminal_tokens_terminal_live_idx
  ON terminal_tokens (company_id, shop_id, terminal_id) WHERE revoked_at IS NULL;
CREATE INDEX terminal_tokens_sweep_idx ON terminal_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- audit_events -- append-only, the only accountability mechanism in Phase 1
--
-- company_id is nullable here and only here: a failed login against an unknown
-- email cannot be attributed to a tenant, and inventing one would be worse than
-- recording none. The table is named in the schema-invariants test's explicit
-- exception list rather than being caught by a category rule.
--
-- Every FK is RESTRICT. ON DELETE SET NULL would let a DELETE elsewhere
-- silently rewrite history -- and would collide with the meaning this schema
-- already assigns to a NULL actor (anonymous). actor_label carries the actor's
-- email or terminal name as of the event, so attribution survives regardless.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  company_id        uuid REFERENCES companies (id) ON DELETE RESTRICT,
  shop_id           uuid,
  actor_kind        text NOT NULL
                      CHECK (actor_kind IN ('user', 'terminal', 'system',
                                            'anonymous')),
  actor_user_id     uuid REFERENCES users (id) ON DELETE RESTRICT,
  actor_terminal_id uuid REFERENCES terminals (id) ON DELETE RESTRICT,
  actor_label       text CHECK (actor_label IS NULL OR length(actor_label) <= 254),
  action            text NOT NULL
                      CHECK (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
                         AND length(action) <= 64),
  outcome           text NOT NULL DEFAULT 'success'
                      CHECK (outcome IN ('success', 'failure')),
  target_kind       text CHECK (target_kind IS NULL
                                OR target_kind ~ '^[a-z][a-z0-9_]*$'),
  -- No FK: a target may legitimately be gone, and this value is never used to
  -- derive scope.
  target_id         text CHECK (target_id IS NULL OR length(target_id) <= 64),
  source_ip         inet,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Composite like every other shop reference in the schema. MATCH SIMPLE skips
  -- the check when company_id is NULL, which is exactly right for
  -- platform-level rows; the CHECK below forbids the one combination that would
  -- otherwise slip through unvalidated.
  FOREIGN KEY (shop_id, company_id)
    REFERENCES shops (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_shop_implies_company
    CHECK (shop_id IS NULL OR company_id IS NOT NULL),
  CONSTRAINT audit_events_actor_arc CHECK (
        (actor_kind = 'user')     = (actor_user_id IS NOT NULL)
    AND (actor_kind = 'terminal') = (actor_terminal_id IS NOT NULL)
    AND (actor_kind IN ('system', 'anonymous'))
        = (num_nonnulls(actor_user_id, actor_terminal_id) = 0)
  ),
  CONSTRAINT audit_events_target_pair
    CHECK ((target_kind IS NULL) = (target_id IS NULL)),
  -- detail is a FLAT map of scalars. This is what makes the credential-name
  -- check below exhaustive: the jsonb ? family only inspects top-level keys, so
  -- without this constraint a handler that wrote {request: req.body} would
  -- persist a plaintext password and pass.
  CONSTRAINT audit_events_detail_is_flat_object CHECK (
    jsonb_typeof(detail) = 'object'
    AND NOT jsonb_path_exists(detail,
          '$.* ? (@.type() == "object" || @.type() == "array")')
  ),
  CONSTRAINT audit_events_detail_no_credentials CHECK (
    NOT (detail ?| array['password', 'token', 'code', 'secret', 'cookie',
                         'authorization', 'token_hash', 'code_hash',
                         'password_hash', 'session', 'sid'])
  )
);

CREATE INDEX audit_events_company_time_idx
  ON audit_events (company_id, occurred_at DESC);
CREATE INDEX audit_events_actor_time_idx
  ON audit_events (actor_user_id, occurred_at DESC);
CREATE INDEX audit_events_action_time_idx
  ON audit_events (action, occurred_at DESC);
-- Serves the retention sweep, which the company_id index cannot for the
-- untenanted rows.
CREATE INDEX audit_events_time_idx ON audit_events (occurred_at);

-- ---------------------------------------------------------------------------
-- Runtime role grants
--
-- Two roles exist from day one: core_api_owner owns the schema and runs
-- migrations, core_api_app connects at runtime with DML only. A table owner
-- bypasses RLS unless FORCE ROW LEVEL SECURITY is set, so a single all-powerful
-- role would quietly defeat the later RLS migration this schema is shaped to
-- allow. Guarded so a single-role local dev database still applies this file
-- unchanged.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_api_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO core_api_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO core_api_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO core_api_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_api_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO core_api_app';
  END IF;
END
$$;
