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
