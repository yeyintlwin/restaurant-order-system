# core-api

The multi-tenant platform API: companies, shops, dining tables, users and terminals.
Express 4 + node-postgres, plain CommonJS JavaScript, tests via `node --test`.
Listens on port **3200**, behind Nginx in production.

`pg` is the only dependency new to this repository — `apps/epaper-hub` already ships
`express@^4.21.2`.

## Local Postgres

```sh
docker run -d --name core-db-dev -e POSTGRES_USER=core_api_owner -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=core -p 127.0.0.1:5433:5432 postgres:16-alpine
```

Port **5433**, not 5432, so a Postgres already installed on the machine cannot
shadow the container. `core_api_owner` is the owner role; the runtime role
`core_api_app` is created by the migration runner on first boot, so there is nothing
to create by hand.

## Environment

Copy `.env.example` to `.env` and fill in the four blanks. `apps/core-api/.env` is
gitignored by the repository's `apps/*/.env` rule and excluded from the image by
`.dockerignore`. `server.js` loads it through `env-file.js`; a variable already
present in the real environment always wins over the file.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | Selects the production branch of the origin, proxy-hop and DSN-username rules. |
| `PORT` | `3200` | Integer 1–65535. |
| `HOST` | `0.0.0.0` | Exactly `127.0.0.1`, `::1` or `0.0.0.0`. `0.0.0.0` is correct **inside** a container. |
| `TZ` | `UTC` | Set on both containers so logs, `now()` and psql agree. |
| `API_PUBLIC_ORIGIN` | **required** | Origin only — no path, query, fragment or userinfo. `https:` in production; `http://localhost` / `http://127.0.0.1` allowed outside it. |
| `TERMINAL_ALLOWED_ORIGINS` | `""` | Comma-separated absolute **https** origins for the `/api/terminal/*` OPTIONS responder. Empty means no CORS headers at all — the Phase 1 shape. |
| `TRUSTED_PROXY_HOPS` | `0` | Count from the **right** of `X-Forwarded-For`. **Required** when `NODE_ENV=production`; a wrong value fails silently in both directions. |
| `POSTGRES_PASSWORD` | **required** | Owner-role password. Must equal the password component of `DATABASE_MIGRATION_URL` in **every** environment. ≥ 24 characters when `NODE_ENV=production`. |
| `DATABASE_MIGRATION_URL` | **required** | The migration pool (`max: 1`), closed before `listen()`. Username must be `core_api_owner` when `NODE_ENV=production` (CI runs as `postgres`). |
| `DATABASE_URL` | **required** | The runtime pool. Username must be `core_api_app` in every environment, and the DSN must differ from `DATABASE_MIGRATION_URL`. |
| `CORE_API_TEST_DATABASE_URL` | unset | Maintenance DSN the test harness clones the template from. Never set in production. |
| `EPAPER_HUB_URL` | `http://epaper-hub:3000` | Base URL of the e-paper hub. Absolute `http:`/`https:`, no query or fragment; a path is allowed. Deliberately **not** held to the `API_PUBLIC_ORIGIN` rules — the hub is another container on the Compose `default` bridge. |
| `EPAPER_API_KEY` | unset | The hub's bearer — the same value `epaper-hub` reads as `API_KEY`. **Optional**: unset, the display route answers 503 and nothing else changes. |
| `TABLE_DISPLAY_SERVICE_TOKEN` | unset | The interim shared service token `customer-order` presents (§11.9). **Optional**, but ≥ 32 characters when set. |

### The display route, and why its two secrets are optional

`core-api` is the only permitted caller of `@restaurant/epaper-hub-sdk` (identity-slice
design §11.7). `epaper/hub-client.js` is the single file that requires it and
`POST /api/terminal/table-displays/:tableNumber` is the route that drives it;
`apps/customer-order` reaches a display only through that route.

Both credentials above are optional **in every environment**, and that is a decision rather
than an omission. This process migrates the database *before* it listens, so a required
secret missing from `~/core-api.env` would refuse to listen after the migration had already
applied and fail the deploy's 90-second readiness gate. Unconfigured, only the display route
is affected and it answers 503. The loud half of the pair is on the other side:
`customer-order` refuses to start without its copy of the token, so a half-configured deploy
presents as one crash-looping container rather than as silence. A token that *is* set must
be ≥ 32 characters — that one refuses to listen, because unlike a missing value it is a
decision somebody made.

Everything else — the session, pairing, rate-limit, scrypt and pool tunables — is
defaulted in `config.js` (`DEFAULTS`) to the same value `docker-compose.yml` sets,
so `node server.js` with only a `.env` file behaves like the container.
`test/config.test.js` asserts the two tables agree.

## Running

```sh
npm --prefix apps/core-api install --no-workspaces
npm --prefix apps/core-api run migrate      # apply migrations by hand (start() also does this)
npm --prefix apps/core-api start
```

`GET /health` answers as soon as the process is listening. `GET /health/ready`
reports the database and migration status and is what the deploy gate calls.

`npm --prefix apps/core-api run db:reset` is the only script in this repository that
destroys data. It refuses when `NODE_ENV=production`, refuses when the
`DATABASE_MIGRATION_URL` host is not `localhost` / `127.0.0.1` / `::1`, and requires
`--yes` on argv after printing host, port and database. It is also the sanctioned
answer to a local checksum surprise.

## Tests

```sh
npm --prefix apps/core-api test
```

The suite needs a Postgres it can create databases on. Set
`CORE_API_TEST_DATABASE_URL` to a **maintenance** database on that cluster:

```dotenv
CORE_API_TEST_DATABASE_URL=postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres
```

`pretest` builds a template database once and each test **file** clones it, so files
run in parallel without sharing rows. When `CORE_API_TEST_DATABASE_URL` is unset the
database suites **throw** rather than skip — a missing value must never silently
disable the tenant-isolation sweep.

The single deliberate escape hatch, for a laptop with no Postgres at all, is
`CORE_API_SKIP_DB_TESTS=1`. It turns `pretest` into a no-op exit 0 and makes the
database suites report **visible** TAP skips, so the pure suites still run:

```sh
# bash / CI
CORE_API_SKIP_DB_TESTS=1 npm --prefix apps/core-api test

# PowerShell (the development machine)
$env:CORE_API_SKIP_DB_TESTS = "1"; npm --prefix apps/core-api test
```

CI never sets it, and `test/ci-contract.test.js` asserts that.

A single pure suite can always be run straight from the repository root with no
database and no `pretest`:

```sh
node --test apps/core-api/test/config.test.js
```

## Rotating database passwords

The two credentials rotate by different mechanisms, and mixing them up is what the
startup equality check exists to catch.

**`core_api_app` (`DATABASE_URL`) — automatic.** The migration runner issues
`ALTER ROLE core_api_app LOGIN PASSWORD …` on **every** boot, using the password
component of `DATABASE_URL`. To rotate: edit `DATABASE_URL` in the secrets file and
restart. Nothing else is required.

**`core_api_owner` (`POSTGRES_PASSWORD` + `DATABASE_MIGRATION_URL`) — manual, and
the cluster must be told.** `POSTGRES_PASSWORD` is only read by `initdb`, so editing
it does **not** change the password of a cluster that already exists. Change the
role in the running cluster first, then update *both* lines in the secrets file in
the same edit — `config.js` refuses to listen if `POSTGRES_PASSWORD` and the
password inside `DATABASE_MIGRATION_URL` disagree, which is precisely how "somebody
edited one line and not the other" is caught.

If startup dies with:

> `DATABASE_MIGRATION_URL was rejected by the server (28P01). If you rotated
> POSTGRES_PASSWORD, the running cluster still holds the old value — see
> apps/core-api/README.md 'Rotating database passwords'.`

then the secrets file was rotated and the cluster was not. `28P01` is fatal with no
retry on purpose: retrying a wrong password for ten seconds buries a deterministic
failure behind a timeout.

## Bootstrapping the first platform administrator

Run once per instance, on the box, after the first deploy is green. This is the step
that turns a deployed service into a usable one: until it runs there is no account, and
core-api logs a warning at boot saying so rather than refusing to listen.

```sh
cd ~/restaurant-order-system
CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec core-api \
  node apps/core-api/scripts/create-platform-admin.js you@example.com
```

`docker compose exec`, **never `exec -T`**: `scripts/create-platform-admin.js` reads
the password from stdin with echo disabled and refuses to run when
`process.stdin.isTTY` is false, so a password can never reach shell history. It
connects with `DATABASE_URL` (`core_api_app`), not the owner. There is no `--force`;
a second run exits non-zero even if the first admin row is deleted, because the
guard reads the monotonic audit trail rather than current state.
