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

# 7. (schema-invariant assertions are inserted here by the next task)

# 8. Row counts. query_to_xml runs a real count(*) per table, so this self-maintains as
#    Plan 2 adds tables. n_live_tup would read 0 everywhere on a freshly restored database
#    that has never been ANALYZEd -- reporting an empty restore as a healthy one.
psql_drill -d "$DRILL_DB" -c "
  SELECT c.relname AS table_name,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname),
                             false, true, '')))[1]::text::bigint AS rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY 1;"
