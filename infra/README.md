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

### `listen 443 ssl http2` is a per-socket option, so it changes the other vhosts too

Ubuntu 22.04 ships nginx 1.18 and 24.04 ships 1.24, so `api.conf` uses the
deprecated `listen 443 ssl http2;` form: `http2 on;` needs nginx >= 1.25.1 and
fails `nginx -t` on both, which would abort the deploy.

The consequence reaches past this vhost. `ssl http2` on a listen line is a
**per-socket** option, and Ubuntu's `nginx.conf` parses `conf.d/` *before*
`sites-enabled/`, so this file's listen line is the first to touch
`0.0.0.0:443` and its options apply to `order.yeyintlwin.com` and
`epaper-hub.yeyintlwin.com` as well. `nginx -t` says so exactly once:

```
nginx: [warn] protocol options redefined for 0.0.0.0:443
```

That warning is a decision, not noise. If the other two sites must stay on
HTTP/1.1, drop the `http2` token from both listen lines in `infra/nginx/api.conf`
and from the two matching assertions in
`apps/core-api/test/nginx-config.test.js`. Nothing in Phase 1 needs HTTP/2.
The other warning you may see, `the "listen ... http2" directive is deprecated`,
is harmless: `nginx -t` still exits 0 and the deprecated form is the only one
that also loads on 1.18 and 1.24.

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
exactly once no matter how many times it is included, which is why the second
count is 1 and not 4.

```sh
sudo nginx -t
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -c 'limit_req_zone .*zone=core_'                    # expect 3
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -cE 'proxy_set_header +X-Forwarded-For +\$proxy_add_x_forwarded_for'    # expect 1
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -E 'real_ip_header|set_real_ip_from|real_ip_recursive' || echo NONE
curl -s -o /dev/null -w '%{http_code}\n' -m 5 \
  --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health   # expect 200
```

`nginx -T` proves the directives are **loaded**. It does not prove a server block
matches `api.yeyintlwin.com`, that the certificate serves, or that `limit_req`
fires — which is what the `--resolve` curl and the deploy's burst probe are for.
