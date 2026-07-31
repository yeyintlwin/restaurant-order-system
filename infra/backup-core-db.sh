#!/bin/sh
# Nightly logical backup of core-db. The deploy scp's this to
# ~/restaurant-order-system/config/backup-core-db.sh -- config/ is the one directory
# deploy.yml's `find ... -exec rm -rf {} +` preserves -- and installs the 03:17 UTC
# crontab entry that runs it.
#
# POSIX sh on purpose: cron runs it through /bin/sh, which on Ubuntu is dash.
set -eu
# No `set -o pipefail`: dash does not have it, and the retention pipeline's `ls`
# legitimately exits non-zero on the first night, when no nightly exists yet.

cd "$HOME/restaurant-order-system"
# The compose file interpolates ${CORE_ENV_FILE:-.env} and the deploy folder has no
# .env, so without this export every docker compose call below fails to resolve
# env_file before it ever reaches Postgres.
export CORE_ENV_FILE=../core-api.env
export EPAPER_ENV_FILE=../restaurant-order-system.env

mkdir -p "$HOME/backups"; chmod 700 "$HOME/backups"
ts="$(date -u +%Y%m%dT%H%M%SZ)"; out="$HOME/backups/nightly-$ts.dump"

# `exec -T` IS LOAD-BEARING: without it docker allocates a TTY and CRLF translation
# silently corrupts the binary custom-format dump.
# The single quotes are load-bearing too: PGPASSWORD is expanded by the shell INSIDE
# core-db, so the password appears in no host process list and no cron log.
docker compose exec -T core-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d core -Fc' > "$out.part"
test -s "$out.part"

# Two-stage verification, because an OOM kill or a full disk mid-dump produces a
# truncated file that pg_dump exits 0 on often enough to matter.
#   --list reads only the TOC, which pg_dump -Fc writes FIRST. It is the cheap "is this
#   an archive at all" check, and it PASSES on a dump truncated at 80%.
docker compose exec -T core-db pg_restore --list < "$out.part" > /dev/null
#   --data-only -f /dev/null decompresses every data block and writes the SQL nowhere,
#   so it is the only check that actually reaches the end of the file. It costs one
#   full decompression pass; that is the price of knowing the dump is complete.
docker compose exec -T core-db pg_restore --data-only -f /dev/null < "$out.part" > /dev/null

# Only now does the file take its real name. That is the whole .part discipline: a
# truncated dump never replaces a good one, and never counts toward the retention
# trim below -- whose glob ends in .dump precisely so a .part cannot match it.
# A failed run leaves its .part behind; the deploy's `rm -f ~/backups/*.part` sweeps it.
mv "$out.part" "$out"; chmod 600 "$out"
ls -1t "$HOME"/backups/nightly-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f

# LAST_OK means "a dump completed AND was read end to end". It is the ONLY failure
# signal this script has: set -eu exits early, output goes to a log nobody reads, and
# cron's MAILTO goes to a local mailbox on a box with no MTA. The deploy fails the build
# when this marker is stale -- see the backup-health block in deploy.yml.
touch "$HOME/backups/LAST_OK"
