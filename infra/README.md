# Infrastructure

Deployment and infrastructure notes for the restaurant management system.

Production services:

- E-paper hub: `https://epaper-hub.yeyintlwin.com`
- Customer ordering: `https://order.yeyintlwin.com`
- Host: AWS Lightsail Ubuntu
- Runtime: Docker Compose

The deployed project folder is `~/restaurant-order-system`. It should contain only `docker-compose.yml` and optional `config/`. Runtime secrets stay in `~/restaurant-order-system.env`.

Docker publishes the hub at `127.0.0.1:3000` and customer ordering at `127.0.0.1:3100`; Nginx terminates HTTPS for both subdomains. Inside Compose, customer ordering uses `EPAPER_HUB_URL=http://epaper-hub:3000`. On every customer-order startup, tables 1 through 12 are reset to `WELCOME` before port 3100 begins accepting traffic.

## Secure Table QR Runtime Values

Customer-order refuses to start unless these are present, so add them to `~/restaurant-order-system.env` **before** deploying the secure-QR release. `SHOP_ID` must be exactly `1`, `BUSINESS_TIME_ZONE` exactly `Asia/Tokyo`, and `BUSINESS_DAY_ROLLOVER_HOUR` exactly `6`; any other value aborts startup before the service listens.

```dotenv
SHOP_ID=1
CHECKOUT_API_KEY=<independent-random-secret>
BUSINESS_TIME_ZONE=Asia/Tokyo
BUSINESS_DAY_ROLLOVER_HOUR=6
```

Compose supplies `BUSINESS_TIME_ZONE` and `BUSINESS_DAY_ROLLOVER_HOUR` as non-secret defaults. `SHOP_ID` and `CHECKOUT_API_KEY` must come from the external runtime environment file, which stays outside the deploy folder at mode `600`.

`CHECKOUT_API_KEY` is an independent 32-byte secret — not `TABLE_DISPLAY_API_KEY` and not the hub's `EPAPER_API_KEY`. It authorizes the server-to-server route `POST /api/tables/{tableNumber}/checkout`, which revokes a table's QR and all enrolled phone sessions and then renders a replacement `Welcome` QR.

Each table display shows an opaque visit URL, `https://order.yeyintlwin.com/t/AAAAAAAAAAAAAAAAAAAAAA`, whose trailing 22 Base64URL characters are the table's only credential. Visits expire at the next `06:00 Asia/Tokyo` rollover, when a scheduled reconciliation rotates every expired table to a fresh `Welcome` QR. Never log or echo raw tokens, `rsid` cookies, or `CHECKOUT_API_KEY`.

## Core API runtime: two secrets files and core-net

- Core API: `https://api.yeyintlwin.com`, published by Docker at `127.0.0.1:3200`; Nginx terminates HTTPS.
- Database: `core-db` (`postgres:16-alpine`), reachable **only** over the Compose network `core-net`.

`docker-compose.yml` lives at the repository root and is copied to
`~/restaurant-order-system/docker-compose.yml` by the deploy.

### Two secrets files, not one

| File | Read by | Holds |
| --- | --- | --- |
| `~/restaurant-order-system.env` | `epaper-hub`, `customer-order` | `EPAPER_API_KEY`, `SHOP_ID`, `CHECKOUT_API_KEY`, … |
| `~/core-api.env` | `core-db`, `core-api` | `POSTGRES_PASSWORD`, `DATABASE_MIGRATION_URL`, `DATABASE_URL` |

Both are mode `600`, owned by the deploy user, and both stay **outside** the deploy folder —
`deploy.yml` deletes everything in `~/restaurant-order-system` except `docker-compose.yml` and
`config/` on every push. The deploy passes them as `EPAPER_ENV_FILE=../restaurant-order-system.env`
and `CORE_ENV_FILE=../core-api.env`; Compose reads them as `${EPAPER_ENV_FILE:-.env}` and
`${CORE_ENV_FILE:-.env}`. The deploy also refuses to continue when `~/core-api.env` is missing,
because a compose file whose `env_file` cannot be resolved is one that **no** subcommand can load —
not `up`, not `config`, not `exec`.

The split is not tidiness. `epaper-hub` is internet-facing, authenticates with `req.query.api_key`
and logs every request through `morgan("combined")`. If it shared an env file with `core-db`, any
code-execution or SSRF bug in it would read `DATABASE_MIGRATION_URL` and connect to `core-db` as
`core_api_owner` — which is `COPY ... TO PROGRAM`, i.e. a shell inside the database container, plus
every tenant's rows and every scrypt hash. Before this, the worst outcome of an epaper-hub
compromise was twelve e-paper screens. `core-net` is the second half of the same control: only
`core-db` and `core-api` join it, and `core-db` joins nothing else.

Create `~/core-api.env` **before** core-api's first production deploy:

```dotenv
POSTGRES_PASSWORD=<24+ chars; avoid / + = so the DSN needs no escaping>
DATABASE_MIGRATION_URL=postgres://core_api_owner:<the same password>@core-db:5432/core
DATABASE_URL=postgres://core_api_app:<a second password>@core-db:5432/core
```

`POSTGRES_PASSWORD` must be byte-identical to the password inside `DATABASE_MIGRATION_URL`;
`core-api` refuses to listen if they differ, which is exactly how "somebody edited one line and not
the other" is caught. Rotation is `apps/core-api/README.md`, "Rotating database passwords".

### `core-db` publishes no host port

`core-db` has **no `ports:` key at all** — not a loopback-only publish, which differs from a public
one by a single deletion. **Docker installs published ports as DNAT rules in the `nat` table,
evaluated before ufw's filter chains, so a published port bypasses ufw: it stays reachable from the
internet even when `ufw status` says the port is denied.** Nothing needs one — `core-api` reaches
the database over `core-net`, and `psql`/`pg_dump` go through `docker compose exec`. It is also
what makes the bootstrap design safe: `DATABASE_URL` is exploitable only from inside the host.

Every compose subcommand needs **both** env variables, because Compose validates every service's
`env_file` on every invocation — not just the services you name:

```sh
cd ~/restaurant-order-system && CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec core-db psql -U core_api_owner -d core
```

**Never run `docker compose config` on this box without `--quiet` or `--services`** — Compose
interpolates env_file contents into its output, so a bare `docker compose config` prints
POSTGRES_PASSWORD and both DSNs in cleartext, to your terminal and into your shell's scrollback.

## Core API: Nginx for api.yeyintlwin.com

`apps/core-api` is published by Compose on `127.0.0.1:3200` — never on a public
interface — and Nginx terminates HTTPS for `api.yeyintlwin.com`, the same shape
the hub (`127.0.0.1:3000`) and customer ordering (`127.0.0.1:3100`) already use.
Two files in `infra/nginx/` are the whole of it, and the deploy installs both:

| Repo file | Installed to | Why there |
| --- | --- | --- |
| `infra/nginx/api.conf` | `/etc/nginx/conf.d/api.yeyintlwin.com.conf` | `limit_req_zone` is an `http{}`-scope-only directive, and Ubuntu's stock `nginx.conf` carries `include /etc/nginx/conf.d/*.conf;` inside `http{}`. In a `server{}` block `nginx -t` fails with `"limit_req_zone" directive is not allowed here`. Installing to `conf.d/` needs **zero edits to `nginx.conf`**, so there is no hand-edited system file to lose on a package reinstall. |
| `infra/nginx/core-api-proxy.conf` | `/etc/nginx/snippets/core-api-proxy.conf` | `proxy_pass` and `proxy_set_header` are `location`-scope, so every proxying `location` `include`s this snippet. Including it at `server{}` scope fails `nginx -t`. |

Both are scp'd to `/tmp` on the box and installed from there, never into
`~/restaurant-order-system/`: the deploy's
`find ~/restaurant-order-system -mindepth 1 -maxdepth 1 ! -name docker-compose.yml ! -name config -exec rm -rf {} +`
would delete anything else in that folder before `docker compose up -d`.

The deploy snapshots **both** installed files — `/tmp/api.conf.bak` and
`/tmp/core-api-proxy.conf.bak` — installs both, runs `nginx -t`, and **restores
both and exits 1 if the test fails**, before it ever reloads. Snapshotting only
the vhost would not be a rollback: a bad snippet survives it, the rollback's own
`nginx -t` fails too, and the box is left holding a config it cannot load.
Installing first and validating second is the same defect one step earlier — the
running Nginx keeps its in-memory config, so nothing looks wrong until certbot's
renew hook or a reboot reloads it, days later, taking `order.yeyintlwin.com` and
`epaper-hub.yeyintlwin.com` down with it.

### One-time prerequisite order — not negotiable

1. DNS A record: `api.yeyintlwin.com` → the Lightsail instance.
2. `sudo certbot certonly --nginx -d api.yeyintlwin.com`
3. Only then push, so the deploy installs `api.conf`.

`ssl_certificate` is read at **parse** time. With no certificate on disk,
`nginx -t` fails with
`cannot load certificate "/etc/letsencrypt/live/api.yeyintlwin.com/fullchain.pem"`,
the deploy restores both files and exits 1 — and the deploy is the only thing
that installs them, so there is nothing half-installed to repair by hand.

`certbot` renews over HTTP-01, which is why the port-80 block keeps
`/.well-known/acme-challenge/` reachable instead of redirecting everything.

### `api.conf` enables no HTTP/2, on purpose — it is a per-socket option

`api.conf` uses a plain `listen 443 ssl;`. Neither HTTP/2 form is used, and both
exclusions are deliberate.

`http2 on;` is not available: it needs nginx >= 1.25.1 and this box runs
**1.24.0**, where it is an unknown directive and `nginx -t` fails outright —
which the deploy treats as fatal, so that one line would abort the cutover.

The deprecated `listen 443 ssl http2;` form *would* load, but it reaches past
this vhost. `ssl http2` on a listen line is a **per-socket** option, and
Ubuntu's `nginx.conf` parses `conf.d/` *before* `sites-enabled/`, so this file's
listen line is the first to touch `0.0.0.0:443` and its options would apply to
**every** vhost sharing that socket. On this box that is seven others —
`airpaste-api`, `n8n`, `myanmyanlearn`, `epaper-hub`, `order`, `inkwire`,
`lopaka` and the apex — none of which enable HTTP/2 today, and **three of which
proxy WebSocket upgrades** (`airpaste-api`, `n8n`, `myanmyanlearn`). nginx does
not implement RFC 8441, so WebSockets over HTTP/2 are unavailable; browsers
normally fall back to an HTTP/1.1 ALPN connection for the handshake, but that is
an untested protocol change to unrelated production services bought for no
Phase-1 benefit.

If you ever add the token back you will see `nginx -t` say so exactly once:

```
nginx: [warn] protocol options redefined for 0.0.0.0:443
```

That warning is a decision, not noise. Nothing in Phase 1 needs HTTP/2. If a
later phase does, enable it on the socket deliberately and re-test those three
WebSocket sites first.

### `/health` is loopback-only, `/health/ready` is 404

`GET /health` is proxied but wrapped in `allow 127.0.0.1; allow ::1; deny all;`,
because the deploy gate curls it through the real TLS chain with `--resolve`
from the box itself and `curl -fsS` exits 22 on any 4xx. Returning 404 there
would abort **every** deploy, after the migration had already applied. From the
internet it answers 403. `/health/ready` returns 404 unconditionally: it names
the database and the migration ledger, and nothing off-box needs it — the
container healthcheck calls `/health`.

### `TRUSTED_PROXY_HOPS=1`, and the four ways it breaks silently

`core-api-proxy.conf` sets the forwarded-for header to
`$proxy_add_x_forwarded_for`. That variable is the client's incoming
`X-Forwarded-For` with `$remote_addr` appended **on the right**, so counting
**one** entry from the right yields the address Nginx actually saw. A client
sending `X-Forwarded-For: 1.2.3.4` produces `1.2.3.4, <real ip>` and the real IP
still wins. That is why the value is `1`, and it is correct only for the
topology described here: one Nginx, on the same host, in front of core-api.

Four ways this breaks with no error and no log line:

1. **`real_ip_header` or `set_real_ip_from` added to this server block.** Either
   rewrites `$remote_addr` *before* the forwarded-for chain is built, so a
   forged header is appended to itself and the one-from-the-right read returns
   the attacker's value — a total bypass. The same directives make
   `allow 127.0.0.1` on `/health` honour a forged header too, publishing the
   surface the 403 exists to hide. *Checked:*
   `apps/core-api/test/nginx-config.test.js` asserts neither directive appears
   in either file.
2. **A `location` that proxies without the include.** Written without the
   snippet, it sets no `X-Forwarded-For` at all, so Nginx forwards the client's
   own header untouched. *Checked:* the same test pins the include count at four
   and asserts `api.conf` never carries `proxy_pass` at all — the snippet is the
   only file in `infra/nginx/` allowed to proxy.
3. **Adding a proxy in front (a CDN, a load balancer) without changing the
   number.** Every entry shifts one place to the left, the value read becomes
   attacker-controlled, and one attacker can lock out every account on the
   platform through the login limiter. Nothing can check this from a file:
   change `TRUSTED_PROXY_HOPS` in the same commit that adds the proxy, and
   re-run the deploy's XFF probe.
4. **`proxy_set_header X-Forwarded-For $remote_addr`.** It produces the right
   answer today at `hops=1` and discards the chain, so the day breaker 3
   happens there is nothing left to count. *Checked:* the snippet test asserts
   this form does not appear.

Code side: when `X-Forwarded-For` is absent, has fewer than
`TRUSTED_PROXY_HOPS` entries, or the selected entry fails `net.isIP()`, core-api
treats the derivation as untrusted — the rate-limit bucket collapses to a single
shared `"unknown"` key (strictest, fail-closed), `source_ip` is written NULL
(fail-soft), and it logs at error level on **every** occurrence. A burst of
those lines means the topology and the number disagree.

### Verify the proxy on the box

`nginx -T` prints every configuration file verbatim, comments included, and
`api.conf` deliberately **names the directives it forbids** — so every grep
below strips comment lines first, or it matches the warning instead of the
directive and can never report a clean result. `nginx -T` dumps each file
exactly once no matter how many times it is included, which is why the
`limit_req_zone` count is 3 and not 12.

**The X-Forwarded-For count is NOT 1, and an earlier version of this section said
it was.** Measured on the box 2026-08-03: it is **9**, because
`$proxy_add_x_forwarded_for` is what every reverse-proxy vhost sets, and eight
others share this instance — `airpaste-api`, `default`, `epaper-hub`, `inkwire`,
`lopaka`, `myanmyanlearn`, `n8n`, `order`. Counting the whole dump answers a
question about the box, not about core-api. **Attribute it to files instead**, and
require exactly one from the snippet:

```sh
sudo nginx -t
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -c 'limit_req_zone .*zone=core_'                    # expect 3
# One per file, and core-api-proxy.conf must be in the list exactly once. The total
# grows with every other proxying vhost on the box and means nothing on its own.
sudo nginx -T | awk '/^# configuration file/ {f=$4} /proxy_set_header/ && /X-Forwarded-For/ && /proxy_add_x_forwarded_for/ && !/^[[:space:]]*#/ {print f}' | sort | uniq -c   # core-api-proxy.conf: exactly 1
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -E 'real_ip_header|set_real_ip_from|real_ip_recursive' || echo NONE
curl -s -o /dev/null -w '%{http_code}\n' -m 5 \
  --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health   # expect 200
```

`nginx -T` proves the directives are **loaded**. It does not prove a server block
matches `api.yeyintlwin.com`, that the certificate serves, or that `limit_req`
fires — which is what the `--resolve` curl and the deploy's burst probe are for.

## core-db backups

`config/backup-core-db.sh` runs at **03:17 UTC** from the deploy user's crontab, installed by
`deploy.yml`. It writes `~/backups/nightly-<ts>.dump` (custom format, mode 600), keeps **14**,
and touches `~/backups/LAST_OK` only after the dump has been read end to end.

Verification is two-stage, and the second stage is the one that matters. `pg_dump -Fc` writes
the table of contents **first**, so `pg_restore --list` is satisfied by the first few kilobytes:
a dump truncated at 80% by a full disk passes it. `pg_restore --data-only -f /dev/null`
decompresses every data block and writes the SQL nowhere, so it is the only check that actually
reaches the end of the file.

`LAST_OK` is the nightly's **only** failure signal — `set -eu` exits the script early, its
output goes to `~/backups/backup.log` which nobody reads, and cron's `MAILTO` goes to a local
mailbox on a box with no MTA. The deploy therefore checks it, but not from day one: when it
first installs the crontab line it writes a bootstrap marker `~/backups/CRON_INSTALLED_AT`, and
only once **that** marker is more than 48 hours old does a missing or stale `LAST_OK` fail the
build. Before then the gate is deliberately quiet, because the nightly has legitimately had no
chance to run. If a deploy prints `no successful core-db nightly in 48h`, read `backup.log` from
the bottom; the usual causes are a full disk and an OOM-killed `pg_dump`.

The deploy also takes a **pre-deploy dump** (`~/backups/pre-deploy-<ts>.dump`) before every
migration, gated on the *volume* rather than on a running container, and uploads it as a GitHub
Actions artifact with 14-day retention. **Deploy #1's pre-deploy dump is a dump of an empty
`core`** — the volume is created moments earlier and the dump is taken before the service has
ever migrated — so it is not a useful drill target and `migrate.js --check` will correctly
reject it. From deploy #2 onward it is the dump Scenario A restores.

**What this protects, and what it does not:**

| Failure | Covered? |
| --- | --- |
| Bad migration, bad `DELETE`, logical corruption | **Yes** — the pre-deploy dump plus up to 14 nightlies |
| Volume deleted, filesystem corruption | **Yes**, back to the last nightly: up to 24 hours of loss |
| Instance lost | **Only back to the last deploy.** The nightlies live on the instance they protect; the pre-deploy artifact is the sole off-box copy |
| Point-in-time recovery | **No.** There is no WAL archive. The recovery point is the last nightly, not the last transaction. Deferred to Phase 3 by decision |

Said out loud: the uploaded artifact contains **email addresses, IP addresses and scrypt
hashes**, readable by anyone with access to this repository. For a private personal repo that
is an acceptable trade against having no off-box copy at all; the upgrade path is a write-only
bucket.

The cheapest complement is a checkbox, not code: enable **Lightsail automatic instance
snapshots**, understanding that a snapshot is crash-consistent, not logical. The cluster is
initialised with `--data-checksums`, which is what makes a corrupt restored page loud instead of
silent.

`AUDIT_RETENTION_DAYS` configures nothing until `scripts/sweep-expired.js` ships in **Plan 2**;
`audit_events` grows without trimming until then, and the deploy installs only the backup
crontab line.

### The restore drill

```sh
cd ~/restaurant-order-system
./config/restore-drill.sh                                 # newest nightly -- the normal case
./config/restore-drill.sh ~/backups/pre-deploy-<ts>.dump  # a specific dump, deploy #2 onward
```

It restores into `core_restore_check`, refuses to start without headroom, proves the dump is not
an empty or wrong one, asserts the migration ledger against the running image using the
production runner in `--check` mode, mirrors the schema invariants, prints a row count per table
and drops the scratch database. On failure it leaves the scratch database in place and prints
the commands to inspect and drop it. **It never touches `core`.**

It restores into the **same cluster production is serving from** — there is one instance — so it
doubles the data footprint plus WAL alongside live traffic. Run it **outside service hours**,
for the same reason the deploy window exists. It refuses outright unless at least three times
the dump size is free on `/` and the disk is under 70% used, printing
`restore-drill: refusing, need <n> bytes free, have <m>`.

Run it **once by hand before the first core-api deploy is trusted**, then monthly. A backup
nobody has restored is not a recovery plan.

### Scenario A — roll back a bad migration

Every quote below is a real `'`. Paste it as written.

> **Never rehearse Scenario A verbatim on the box — step 3 drops the production database.**
> To rehearse, substitute `core_scenario_a` for `core` in steps 3–5 and leave a dated receipt
> at `~/backups/SCENARIO_A_REHEARSED`. `config/restore-drill.sh` already rehearses steps 1, 3,
> 4, 5 and 6 against a scratch database, which is why running it costs no downtime.

```sh
cd ~/restaurant-order-system
export CORE_ENV_FILE=../core-api.env
export EPAPER_ENV_FILE=../restaurant-order-system.env

# 0. STOP THE WRITER FIRST, or you get a database half old and half new.
docker compose stop core-api

# 1. Prove the dump is READABLE before destroying anything.
ls -la ~/backups
docker compose exec -T core-db pg_restore --list < ~/backups/pre-deploy-<ts>.dump | head -30

# 2. Dump the CURRENT (broken) state anyway. Step 3 is irreversible.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d core -Fc' \
  > ~/backups/before-restore-$(date -u +%Y%m%dT%H%M%SZ).dump

# 3. Lock out reconnects, terminate, then drop. THREE separate -c invocations: chaining a
#    terminate ahead of a DROP in one psql call means ON_ERROR_STOP aborts halfway, leaving
#    the app stopped and the restore not started. ALLOW_CONNECTIONS goes FIRST so nothing --
#    including a `restart: unless-stopped` container -- can reconnect between the terminate
#    and the drop.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "ALTER DATABASE core WITH ALLOW_CONNECTIONS false;"'
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '"'"'core'"'"' AND pid <> pg_backend_pid();"'
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS core;" -c "CREATE DATABASE core OWNER core_api_owner;"'

# 4. Restore, all-or-nothing. Do NOT pass --no-owner: the owner/app split is the point of
#    this schema and --no-owner collapses it.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U core_api_owner -d core \
  --exit-on-error --single-transaction' < ~/backups/pre-deploy-<ts>.dump

# 5. VERIFY BEFORE STARTING THE APP.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d core \
  -c "SELECT filename, applied_at FROM schema_migrations ORDER BY filename;" \
  -c "SELECT role, status, count(*) FROM users GROUP BY 1,2 ORDER BY 1,2;"'
```

The freshly created `core` allows connections by default, so nothing needs undoing from step 3.

**Step 6 is the one everybody gets wrong.** Read that ledger against the migrations in the
running image:

- Dump **older** than the image (a file on disk with no row): the runner will **re-apply** it on
  the next start. If that migration is what broke you, you have restored nothing — roll the
  image back in the same operation with
  `CORE_API_IMAGE=core-api:<previous-sha> docker compose up -d core-api`.
- Dump **newer** than the image (a row with no file): the runner logs a WARNING and starts. That
  is deliberate, and this is the moment the decision earns its keep.

Then `docker compose up -d core-api`, `docker compose logs -f --tail 100 core-api`, and
`curl -fsS http://127.0.0.1:3200/health/ready`.

### Scenario B — a fresh instance

The dump contains grants referencing `core_api_app` but **not the role itself**. Skipping this
step yields a wall of *"role core_api_app does not exist"* and, with `--single-transaction`, a
full rollback — loud, which is correct.

```sh
docker compose up -d core-db     # initdb creates core_api_owner from POSTGRES_PASSWORD
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE core_api_app LOGIN NOINHERIT PASSWORD '"'"'<the password inside DATABASE_URL>'"'"';"'
```

Then run Scenario A from step 4.

If there is **no dump at all** — a genuinely new deployment — the database is empty and the first
platform administrator is created with `apps/core-api/scripts/create-platform-admin.js`. **That
script ships in Plan 2.** Until it does, a fresh instance has no way to create the first user,
which is one more reason the pre-deploy artifact matters.

### Rotating database passwords

The *why* is in `apps/core-api/README.md`, "Rotating database passwords". The order below is not
negotiable, because **`POSTGRES_PASSWORD` is read by the image only when it creates the data
directory** — editing it afterwards changes nothing, and an operator who does only that will
believe the credential rotated for months.

```sh
# 1. Change the role in the RUNNING cluster first.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE core_api_owner PASSWORD '"'"'<new>'"'"';"'

# 2. Then edit ~/core-api.env in BOTH places, in one edit: POSTGRES_PASSWORD and the password
#    inside DATABASE_MIGRATION_URL. core-api refuses to listen if they disagree -- that check
#    exists precisely to catch "somebody edited one line and not the other".
chmod 600 ~/core-api.env

# 3. Restart.
cd ~/restaurant-order-system && CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose up -d
```

The **app** password needs none of this: edit `DATABASE_URL` and redeploy, because the migration
runner issues `ALTER ROLE core_api_app … PASSWORD` on every boot.

If startup dies with `DATABASE_MIGRATION_URL was rejected by the server (28P01)`, the secrets
file was rotated and the cluster was not. Go back to step 1.

## Before core-api's first production deploy

Tick these on the box, in this order. They are host state, not repository state, so nothing in
CI can check them for you.

- [x] `~/core-api.env` exists at mode 600 with `POSTGRES_PASSWORD`, `DATABASE_MIGRATION_URL` and
      `DATABASE_URL`, and `~/restaurant-order-system.env` is untouched
- [x] `~/backups` exists at mode 700
- [x] `config/backup-core-db.sh` has been run by hand once and left one `nightly-*.dump` at mode
      600, a `LAST_OK`, and no `*.part`
- [x] **`config/restore-drill.sh` has been run by hand once, with NO argument — against that
      nightly — and exited 0.** Not against deploy #1's `pre-deploy-*.dump`: that is a dump of an
      empty `core` taken before the service had ever migrated, and the drill will correctly
      reject it. This work is not finished until this box is ticked. Do not skip it because it
      is the day everything worked — that is exactly when it is cheap
- [ ] Scenario A rehearsed against `core_scenario_a`, never against `core`, with a dated receipt
      at `~/backups/SCENARIO_A_REHEARSED`
- [ ] `crontab -l | grep -q backup-core-db.sh` exits 0

## The client-IP chain

Nginx terminates TLS for `api.yeyintlwin.com` and proxies to `127.0.0.1:3200` with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`, which appends the address
Nginx actually saw to the **right** of whatever the client sent. `TRUSTED_PROXY_HOPS=1`
therefore means **count one from the right**: a client forging
`X-Forwarded-For: 1.2.3.4` produces `1.2.3.4, <real ip>` and still loses. That derived
address keys the login rate-limit buckets and is what lands in `audit_events.source_ip`.

**Live topology, updated whenever it changes:** browser → Nginx (same host) →
`127.0.0.1:3200`. One hop. `TRUSTED_PROXY_HOPS=1`.

The four ways this breaks with no error and no log line — `set_real_ip_from` or
`real_ip_header` rewriting `$remote_addr`, a `location` proxying without including
`core-api-proxy.conf`, a CDN in front without raising the number, and
`proxy_set_header X-Forwarded-For $remote_addr` throwing the chain away — are set out
with what checks each one under **`TRUSTED_PROXY_HOPS=1`, and the four ways it breaks
silently** above. Not repeated here: this would be the copy that goes stale.

**What the pipeline actually proves today.** The deploy and
`apps/core-api/test/nginx-config.test.js` assert those directives at the **config
layer** — `sudo nginx -T` over the loaded configuration, the include count, and the ban
on a bare `proxy_pass`. That checks the files, not the behaviour. The behavioural probe
of spec §9.5 step 4 — POST a login carrying `X-Forwarded-For: 203.0.113.99`, then read
the `audit_events` row back by `detail->>'email'` — needs a row written by
`POST /api/admin/auth/login`, and neither that route nor any writer for that table
exists yet. It is the first thing **Plan 2** adds to the deploy heredoc. **Until it
lands, nothing in the pipeline proves the derived address is unforgeable.** What ships
today is a routing probe that proves core-api answered, plus a read of
`TRUSTED_PROXY_HOPS` out of the running process.

`core-db` publishes **no** host port — Docker's published ports install DNAT rules that
**bypass ufw**, so `5432:5432` would put the database on the internet. Reasoning under
**`core-db` publishes no host port** above.

The three secrets — `POSTGRES_PASSWORD`, `DATABASE_MIGRATION_URL` and `DATABASE_URL` —
live in `~/core-api.env` and nowhere else; creation, mode and rationale are under
**Core API runtime: two secrets files and core-net** above.

## Deploy window

Every push to `main` rebuilds `epaper-hub` and `customer-order` with a fresh commit tag
and recreates both containers, which **resets all twelve e-paper
displays to `Welcome`** and drops every in-memory order session. A table mid-order at
that moment loses its cart and has to rescan.

This is not new with core-api, but core-api **lengthens the window**: a database
migration now runs before anything starts, and the deploy will not proceed until
`/health/ready` answers, which the gate allows up to 90 seconds. **Deploy outside service
hours.** There is no way to shorten it in this phase short of not deploying.

**What a push destroys on disk, and what it spares.** Before Compose is invoked the
deploy runs

```sh
find ~/restaurant-order-system -mindepth 1 -maxdepth 1 ! -name docker-compose.yml ! -name config -exec rm -rf {} +
```

so everything directly inside `~/restaurant-order-system` is deleted **except**
`docker-compose.yml` and `config/`. That is exactly why the two host scripts are
installed as `config/backup-core-db.sh` and `config/restore-drill.sh`, and why the Nginx
files are scp'd to `/tmp` and then `install`ed into `/etc/nginx` rather than dropped
"next to the compose file". And it is the real reason `~/core-api.env` sits one directory
**up**, outside the deploy folder entirely: a bad edit to that `find` can never reach it.

`business_date` is the related trap for whoever reads the numbers afterwards. It is
computed from the shop's `time_zone` and `business_day_rollover_hour` and **stored at
write time, never recomputed**. Correcting a shop's timezone later is the right thing to
do, and yesterday's rows keep their original bucket — that is correct accounting, not a
bug. Every such change writes a `shop.updated` audit row, so it stays attributable.

## Cutover checklist

Once, before the first core-api deploy. The exact commands and their expected output are
in the Plan 5 deployment plan under **MANUAL VERIFICATION — cutover**; the order below is
not negotiable.

1. DNS `A` record for `api.yeyintlwin.com` → the Lightsail instance.
2. `sudo certbot certonly --nginx -d api.yeyintlwin.com`. The deploy's `nginx -t` fails
   without the certificate, and it fails *after* the migration has already applied.
3. Host prerequisites: 2 GB swap and `vm.swappiness=10`; paste `free -m` and
   `docker stats --no-stream` into the baseline block below; confirm the deploy user has
   passwordless `sudo` for `install`, `nginx -t` and `systemctl reload nginx`. A password
   prompt there hangs the deploy until it times out.
4. Create `~/core-api.env` at mode 600 — see **Core API runtime: two secrets files and
   core-net** — and confirm `~/restaurant-order-system.env` is untouched.
5. Merge the compose move as ONE commit, outside service hours; it recreates every
   container.
6. Push, and watch the health gate. On failure, `docker compose logs core-api`: the
   migration runner prints the file, both digests and its verdict.
7. Bootstrap the first platform administrator — **Plan 2**.
   `apps/core-api/scripts/create-platform-admin.js` needs the `users` table,
   `lib/password.js` and the audit writer, none of which exist yet. Until then core-api
   serves `/health` and `/health/ready` and nothing else, so there is no login to verify.
   The runbook entry is already in `apps/core-api/README.md`.
8. Record the live client-IP topology in **The client-IP chain** above. The behavioural
   forged-XFF probe needs the login route and an audit writer, so it arrives with Plan 2;
   today the check is at the config layer (`sudo nginx -T`).
9. Run `~/restaurant-order-system/config/restore-drill.sh` against the first dump you
   have. On the very first deploy there is none — the pre-deploy dump is gated on the
   `core-db` volume, which did not exist yet — so the first dump appears either at
   03:17 UTC that night (the nightly) or on the second push (that push's pre-deploy
   dump), whichever comes first. Do not skip it because it is the day everything worked;
   that is exactly when a restore drill is cheap.

**Host baseline, recorded at cutover:**

```text
free -m                  : (paste here)
docker stats --no-stream : (paste here)
```
