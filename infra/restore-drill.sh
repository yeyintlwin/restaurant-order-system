#!/bin/sh
# Restore drill. Restores a dump into a SCRATCH database, proves it is not the wrong
# dump, proves the ledger matches the running image, prints row counts, and drops it.
#
#   ./config/restore-drill.sh                                 # newest nightly (normal)
#   ./config/restore-drill.sh ~/backups/pre-deploy-<ts>.dump   # deploy #2 onward only
#
# A backup nobody has restored is not a recovery plan. Run it ONCE BY HAND before the
# first core-api deploy is trusted, then monthly. It rehearses steps 1, 3, 4, 5 and 6 of
# the Scenario A runbook in infra/README.md under a scratch database name, so the
# rehearsal costs no downtime.
#
# IT RESTORES INTO THE CLUSTER PRODUCTION IS SERVING FROM. There is one Lightsail
# instance and spec 9.1 names the OOM killer as the top risk, so this doubles the data
# footprint plus WAL inside that same cluster. Run it outside service hours. The
# free-space gate below refuses when there is not room to do it safely.
set -eu

cd "$HOME/restaurant-order-system"
export CORE_ENV_FILE=../core-api.env
export EPAPER_ENV_FILE=../restaurant-order-system.env

DRILL_DB=core_restore_check
created=0

# psql inside core-db as the owner. Single quotes: PGPASSWORD is expanded by the shell
# INSIDE the container, so the password reaches no host process list. `sh -c '...' sh "$@"`
# passes this function's arguments through as $1, $2, ... without a second round of
# quoting. No `exec` before psql: a variable assignment prefixing a special built-in has
# shell-dependent export semantics, and a simple command's does not.
psql_drill() {
  docker compose exec -T core-db sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U core_api_owner "$@"' sh "$@"
}

# On success the scratch database is dropped. On FAILURE it is deliberately left in place:
# an operator who has just watched a restore fail needs to look inside it, and re-running
# the drill only reproduces the same failure.
on_exit() {
  status=$?
  if [ "$status" -eq 0 ]; then
    psql_drill -q -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;" > /dev/null
    echo "restore-drill: PASS - $DRILL_DB dropped"
  elif [ "$created" -eq 1 ]; then
    echo "restore-drill: FAIL (exit $status). $DRILL_DB was LEFT IN PLACE for inspection."
    echo "  inspect: docker compose exec core-db sh -c 'PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U core_api_owner -d $DRILL_DB'"
    echo "  drop:    docker compose exec -T core-db sh -c 'PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U core_api_owner -d postgres -c \"DROP DATABASE IF EXISTS $DRILL_DB;\"'"
  else
    echo "restore-drill: FAIL (exit $status) before the scratch database was created."
  fi
}
trap on_exit EXIT

if [ "$#" -ge 1 ]; then
  dump="$1"
else
  dump="$(ls -1t "$HOME"/backups/nightly-*.dump 2>/dev/null | head -n 1 || true)"
fi
if [ -z "$dump" ]; then
  echo "restore-drill: no $HOME/backups/nightly-*.dump yet."
  echo "  Run ./config/backup-core-db.sh first, or name a dump:"
  echo "  ./config/restore-drill.sh ~/backups/pre-deploy-<ts>.dump"
  exit 1
fi
test -r "$dump"

echo "restore-drill: dump    $dump"
echo "restore-drill: bytes   $(wc -c < "$dump" | tr -d '[:space:]')"

# 1. FREE-SPACE GATE, before anything is created or restored. $HOME and /var/lib/docker
#    are both on / on a stock Lightsail instance, so / is the filesystem that matters.
#    `df -Pk` is explicit about 1K blocks: plain `df -P` reports 512-byte blocks when
#    POSIXLY_CORRECT is set, which would silently double the apparent headroom.
size="$(wc -c < "$dump" | tr -d '[:space:]')"
need="$((size * 3))"
have="$(df -Pk / | awk 'NR==2 { printf "%d", $4 * 1024 }')"
used="$(df -Pk / | awk 'NR==2 { sub(/%/, "", $5); print $5 + 0 }')"
if [ "$have" -lt "$need" ] || [ "$used" -ge 70 ]; then
  echo "restore-drill: refusing, need $need bytes free, have $have (disk ${used}% used, limit 70%)"
  exit 1
fi
echo "restore-drill: free    $have bytes, disk ${used}% used"

# 2. Prove the file is an archive at all before touching the cluster. This reads the TOC
#    only; the restore in step 4 is the full read, so nothing is gained by decompressing
#    the whole file twice here.
docker compose exec -T core-db pg_restore --list < "$dump" > /dev/null

# 3. A fresh scratch database from template0, so nothing that may have been added to
#    template1 can make the restore look cleaner than it is.
psql_drill -q -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;"
psql_drill -d postgres -c "CREATE DATABASE $DRILL_DB OWNER core_api_owner TEMPLATE template0;"
created=1

# 4. Restore all-or-nothing, and deliberately WITHOUT --no-owner: the owner/app split is
#    the point of this schema, and this is the only place it is ever proved to survive a
#    restore. The runbook's Scenario A omits --no-owner for exactly the same reason.
docker compose exec -T core-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U core_api_owner -d "$1" --exit-on-error --single-transaction' \
  sh "$DRILL_DB" < "$dump"

# 5. NOT THE WRONG DUMP. A dump of an EMPTY or of the WRONG database restores perfectly
#    cleanly and every step above reports success. This runs BEFORE the ledger check on
#    purpose: migrate.js --check would reject such a dump first, with "pending
#    migration(s) never applied", which reads like version skew rather than "you
#    restored the wrong file".
tables="$(psql_drill -tAq -d "$DRILL_DB" -c \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'" \
  | tr -d '[:space:]')"
if [ "$tables" -lt 11 ]; then
  echo "restore-drill: only $tables base tables restored; expected at least 11"
  exit 1
fi
present="$(psql_drill -tAq -d "$DRILL_DB" -c \
  "SELECT to_regclass('public.schema_migrations') IS NOT NULL" | tr -d '[:space:]')"
if [ "$present" != "t" ]; then
  echo "restore-drill: no schema_migrations table; this dump is not a core dump"
  exit 1
fi
ledger="$(psql_drill -tAq -d "$DRILL_DB" -c "SELECT count(*) FROM schema_migrations" | tr -d '[:space:]')"
if [ "$ledger" -lt 1 ]; then
  echo "restore-drill: schema_migrations is empty"
  exit 1
fi

# 6. The ledger must match the RUNNING IMAGE -- this is runbook step 6, the one everybody
#    gets wrong, done by machine. Reuses the production runner in --check mode rather than
#    re-deriving digests in SQL, so the drill cannot disagree with the runner during an
#    incident. Only the DSN's path is rewritten, so config.js's unconditional
#    POSTGRES_PASSWORD == DATABASE_MIGRATION_URL password check still holds, as does the
#    production "username must be core_api_owner" assertion.
#
#    Two side effects, both deliberate and both harmless: --check applies no migration, and
#    the runner's role bootstrap re-issues ALTER ROLE core_api_app with the password already
#    in DATABASE_URL -- the same statement it issues on every boot. Its advisory lock is
#    taken in core_restore_check, and advisory locks are scoped to a database, so the drill
#    cannot block a deploy migrating core.
#
#    A file in the image with no ledger row exits 1 with "pending migration(s) never
#    applied": the dump is OLDER than the image. A row with no file only warns: that is the
#    rolled-back-image shape, and it is a real recovery path.
docker compose exec -T -e DRILL_DB="$DRILL_DB" core-api sh -c \
  'export DATABASE_MIGRATION_URL="$(node -e "$0")"; exec node apps/core-api/db/migrate.js --check' \
  'const u = new URL(process.env.DATABASE_MIGRATION_URL); u.pathname = "/" + process.env.DRILL_DB; process.stdout.write(u.toString());'

# 7. The schema-invariant assertions, MIRRORED. apps/core-api/test/schema-invariants.test.js
#    cannot be aimed at this database: it takes its connection from cloneTemplate(__filename),
#    which builds a template by RUNNING the migrations -- that tests migrations/, not a
#    restored dump. So the rules are restated here as SQL that raises on violation, and
#    apps/core-api/test/backup-restore.test.js fails if the two exception lists ever drift.
#
# NOT MIRRORED: S2, S2b, S6. S6 is what step 6 above already did, with the runner's own
#    digests. S2/S2b's composite-FK rule carries a thirteen-entry exception list that would
#    become a second source of truth and rot. Mirrored here: S1, S3, S4, S5, S7 -- plus the
#    owner/app GRANT split, which the node suite deliberately does NOT assert because
#    0001_init.sql's grant block is guarded on pg_roles so a single-role dev database applies
#    it unchanged. Both roles exist here, so this is the only place that split is ever proved.
docker compose exec -T core-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U core_api_owner -d "$1" -f -' \
  sh "$DRILL_DB" <<'SQL'
-- S1. Every base table carries company_id uuid NOT NULL, or is one of the six named
-- exceptions -- each of which has its own positive assertion in the node suite.
-- user_email_tokens is the sixth, and is pre-tenant: the token is presented by an
-- unauthenticated caller, so the tenant is discovered BY that lookup and cannot be
-- a column on the row. It could not be one even if that were not so -- a platform
-- admin's users.company_id is NULL by users_platform_admin_has_no_company, so
-- company_id uuid NOT NULL here would be unfillable for their password reset.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname NOT IN ('audit_events', 'companies', 'schema_migrations',
                           'user_email_tokens', 'user_sessions', 'users')
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
          AND a.attnotnull AND format_type(a.atttypid, a.atttypmod) = 'uuid');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'S1: tables without company_id uuid NOT NULL: %', bad;
  END IF;
END $$;

-- S3. The four composite anchors, by name, with exact ordered column lists. Postgres
-- refuses a composite FK without a matching UNIQUE, so the assertion with teeth is the
-- reverse one: a dropped anchor leaves the next table unable to declare one.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(x.name, ', ' ORDER BY x.name) INTO bad
    FROM (VALUES
      ('users_id_company_key',            'id,company_id'),
      ('shops_id_company_key',            'id,company_id'),
      ('shop_tables_id_shop_company_key', 'id,shop_id,company_id'),
      ('terminals_id_shop_company_key',   'id,shop_id,company_id')
    ) AS x(name, cols)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint con
      WHERE con.conname = x.name AND con.contype = 'u'
        AND (SELECT string_agg(att.attname::text, ',' ORDER BY u.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum) = x.cols);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'S3: missing or reshaped anchors: %', bad;
  END IF;
END $$;

-- S4. Every %_hash column is bytea with an octet_length = 32 CHECK, except
-- users.password_hash, which stores a PHC-style scrypt string by design.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(t.tbl || '.' || t.col, ', ' ORDER BY t.tbl || '.' || t.col) INTO bad
    FROM (
      SELECT c.relname AS tbl, a.attname AS col,
             format_type(a.atttypid, a.atttypmod) AS typ,
             COALESCE(string_agg(pg_get_constraintdef(con.oid), ' '), '') AS checks
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_constraint con
          ON con.conrelid = c.oid AND con.contype = 'c' AND a.attnum = ANY (con.conkey)
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname LIKE '%\_hash'
       GROUP BY c.relname, a.attname, a.atttypid, a.atttypmod) t
   WHERE CASE WHEN t.tbl || '.' || t.col = 'users.password_hash'
              THEN t.typ <> 'text' OR position('''scrypt$%''' in t.checks) = 0
              ELSE t.typ <> 'bytea' OR position('octet_length(' || t.col || ') = 32' in t.checks) = 0
         END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'S4: hash columns with the wrong shape: %', bad;
  END IF;
END $$;

-- S5. Every table with updated_at has a non-internal BEFORE UPDATE set_updated_at() trigger.
-- Conditional on the column, so the rule self-maintains. The function is matched without
-- the EXECUTE FUNCTION prefix because pg_get_triggerdef schema-qualifies the name whenever
-- public is not in the connection's search_path.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'updated_at' AND NOT a.attisdropped)
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
          AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE ON %'
          AND pg_get_triggerdef(t.oid) LIKE '%set_updated_at()%');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'S5: tables with updated_at but no set_updated_at() trigger: %', bad;
  END IF;
END $$;

-- S7. Exact names only: password_hash and token_hash are the shapes this schema wants, and
-- a substring rule would forbid them.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname || '.' || a.attname) INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND a.attname IN ('password', 'token', 'code', 'secret', 'session_id');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'S7: plaintext-shaped columns: %', bad;
  END IF;
END $$;

-- GRANTS. Not in the node suite by design, and therefore only ever checked here.
DO $$
DECLARE bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_api_app') THEN
    RAISE EXCEPTION 'GRANTS: role core_api_app does not exist - see infra/README.md, Scenario B';
  END IF;

  -- ONE PRIVILEGE PER ROW, deliberately. has_table_privilege() treats a comma list
  -- as OR, not AND: it returns true when the role holds ANY of the named
  -- privileges. So the earlier form -- NOT has_table_privilege(c.oid,
  -- 'SELECT, INSERT, UPDATE, DELETE') -- fired only when core_api_app had lost all
  -- FOUR, and a table that silently lost INSERT while keeping SELECT sailed
  -- through the one check that exists to catch exactly that. Measured, not
  -- assumed: a role holding SELECT alone returns true for that list.
  --
  -- schema_migrations is the one deliberate asymmetry. 0002_identity.sql REVOKEs
  -- INSERT/UPDATE/DELETE on the ledger so a compromised app role cannot forge or
  -- delete a migration row and make the next deploy skip or re-apply one. It is
  -- expected to hold SELECT and nothing else.
  SELECT string_agg(c.relname || ' (' || p.priv || ')', ', ' ORDER BY c.relname, p.priv) INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p(priv)
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND NOT (c.relname = 'schema_migrations' AND p.priv <> 'SELECT')
     AND NOT has_table_privilege('core_api_app', c.oid, p.priv);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'GRANTS: core_api_app is missing DML on: %', bad;
  END IF;

  -- And the ledger lockdown POSITIVELY, since the block above can only prove a
  -- privilege is present. A restore that predates 0002_identity.sql, or one taken
  -- with --no-privileges, hands the app role its INSERT back and nothing else here
  -- would notice.
  IF has_table_privilege('core_api_app', 'public.schema_migrations', 'INSERT') THEN
    RAISE EXCEPTION 'GRANTS: core_api_app can INSERT into schema_migrations - 0002_identity.sql''s REVOKE did not survive the restore';
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND pg_get_userbyid(c.relowner) <> 'core_api_owner';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'GRANTS: tables not owned by core_api_owner (a --no-owner restore looks exactly like this): %', bad;
  END IF;
END $$;
SQL

# 8. Row counts. query_to_xml runs a real count(*) per table, so this self-maintains as
#    later migrations add tables -- 0002_identity added user_email_tokens and this needed
#    no edit, which is the claim being made rather than a prediction about it.
#    n_live_tup would read 0 everywhere on a freshly restored database that has never been
#    ANALYZEd -- reporting an empty restore as a healthy one.
psql_drill -d "$DRILL_DB" -c "
  SELECT c.relname AS table_name,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname),
                             false, true, '')))[1]::text::bigint AS rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY 1;"
