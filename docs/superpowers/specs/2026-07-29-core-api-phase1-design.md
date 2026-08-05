# Core API — Phase 1 Design

Central control-plane service for the restaurant platform: tenant model, user
authentication, and terminal pairing.

## 1. Why this exists

Today the system has no database. Order sessions and table visits live in
process memory in `apps/customer-order`, the menu is hardcoded in
`menu-data.js`, and the e-paper hub is driven directly from the customer
ordering service. `SHOP_ID` must be exactly `"1"` or the process refuses to
start.

The target is a multi-tenant SaaS: many companies, each with many shops, all
administered from one place, with orders, users, shops and e-paper updates
owned by a central API rather than scattered across the front-end apps.

Getting there is eight phases of work. This document specifies **Phase 1
only**: a new `apps/core-api` service, PostgreSQL, and the two credential
systems everything later depends on. No existing app changes in Phase 1.

### In scope

- New service `apps/core-api` (Express + `pg`), port 3200.
- PostgreSQL in Docker Compose, with a migration runner that runs before the
  server listens.
- Tenant model: `companies`, `shops`, `shop_tables`.
- User authentication: login, session, roles, shop assignment, password change.
- Terminal pairing: create a terminal, issue a one-time code, exchange it for a
  long-lived token, rotate, revoke.
- Bootstrap path for the first `platform_admin`.
- Audit trail for authentication and authorization actions.

### Out of scope for Phase 1

`apps/customer-order` and `apps/epaper-hub` are not touched. No menu, no
orders, no table visits, no e-paper orchestration, no admin UI, no realtime.
Section 10 lists everything deliberately deferred and the phase it belongs to.

### The phase roadmap this fits into

| Phase | Content |
| --- | --- |
| **1** | **This document.** core-api skeleton, Postgres, tenant model, user auth, terminal pairing. |
| 2 | Menu in the database + admin CRUD + admin UI. `customer-order` reads the menu from core-api; `menu-data.js` is deleted. |
| 3 | Orders, table visits and e-paper orchestration move into core-api. `customer-order` becomes a thin front end. `epaper-hub` becomes tenant-aware. Largest and riskiest phase. |
| 4 | Kitchen display app (realtime order push). |
| 5 | Cashier counter (checkout, split bill, barcode). |
| 6 | Admin reports and transaction history. |
| 7 | Captive portal. |
| 8 | Billing and plans. |

## 2. Settled decisions

Each of these was an explicit fork. They are recorded here so nobody
re-derives them.

| # | Decision | Rejected alternative |
| --- | --- | --- |
| 1 | Multi-tenant SaaS: companies → shops → tables. Billing deferred to Phase 8. | Single shop; multi-shop under one company. |
| 2 | PostgreSQL, **shared schema**, tenant columns on rows. | Schema-per-tenant; database-per-tenant. |
| 3 | Tenant isolation enforced by repository discipline + tests. **Postgres RLS deferred**, but the schema is shaped so it can be added later. See §3.3 for the precise limit of that promise. | RLS from day one. |
| 4 | Plain JavaScript, Express, `pg`, ordered `.sql` migrations, `node --test`. | TypeScript + Fastify + Prisma; TypeScript + NestJS. |
| 5 | `epaper-hub` stays a separate service and becomes tenant-aware in Phase 3. core-api owns business logic and calls it through the SDK. | Fold the hub into core-api; per-shop on-premise gateway. |
| 6 | Two credential classes: **users** (humans, password + cookie) and **terminals** (shared devices, paired once, bearer token). Customers have no account. | Users only; full permission-table RBAC. |
| 7 | Build phased, cut over once. No data migration burden — nothing is persisted today. | Endpoint-by-endpoint strangler; fresh repository. |
| 8 | Login email is **globally unique**. The collision oracle is bounded by mechanism, not by schema — see §5.8(b). | `UNIQUE (company_id, email)`, which forces the login form to identify the tenant before authenticating. |
| 9 | `platform_admin` is a role value on `users` with `company_id NULL`, guarded by a table CHECK. | A separate `platform_admins` table with its own sessions and audit trail. |
| 10 | A dining table is identified by a **free-text label** (`A1`, `TERRACE 2`), charset derived from the e-paper font. | Integer `table_number` per shop. |
| 11 | The admin UI (Phase 2) is served **same-origin** from core-api at `/admin`. | `admin.` subdomain, which needs CORS with credentials. |
| 12 | The kitchen-display and cashier-counter apps (Phases 4–5) get **their own subdomains**. core-api therefore ships a narrow CORS responder for `/api/terminal/*` only. See §6.5. | Same-origin `/kitchen` and `/counter`, which would need no CORS at all. |
| 13 | Postgres cluster runs with the **C ctype** of `postgres:16-alpine`. Case-insensitive uniqueness on company and shop names is therefore ASCII-only. | Debian image with an ICU locale. |
| 14 | The pre-deploy database dump is uploaded as a **GitHub Actions artifact**, retention 14 days. Move it to a write-only bucket the moment the first tenant who is not the developer onboards — at that point the artifact holds another party's staff addresses and password hashes, and "anyone with repository access" stops being an acceptable audience. | A write-only S3 bucket from day one. |
| 15 | Public origin stays `https://api.yeyintlwin.com` for now. The name is acknowledged as a poor fit — the service also serves UIs — and is expected to change. | `console.`, `core.`, `manage.`, or a separate registrable domain. |

**On decision 15.** The origin is a single config value, `API_PUBLIC_ORIGIN`,
plus one Nginx server block. Changing it later costs one environment edit, one
certificate, and every session being logged out. Nothing in the design depends
on the name. A separate registrable domain would be a genuine security
improvement — the control plane would stop being a sibling of
`order.yeyintlwin.com` and of the Phase-7 captive portal that serves untrusted
guest devices — and remains available as a later move.

## 3. Architecture

### 3.1 Service shape

`apps/core-api` listens on port 3200 and binds `0.0.0.0` **inside the
container**; the "not reachable except through Nginx" property is delivered by
the Compose mapping `127.0.0.1:3200:3200`, not by the in-process bind. A process
bound to `127.0.0.1` inside a container is unreachable from `docker-proxy` and
answers nothing — see the `HOST` entry in §9.12. It sits behind Nginx at
`api.yeyintlwin.com`. `epaper-hub` (3000) and `customer-order` (3100) are
unchanged and stay on their own subdomains.

Startup order is fixed and fails closed: validate configuration → run
migrations → open the runtime pool → listen. This mirrors the existing pattern
in `apps/customer-order/server.js`, where all twelve e-paper displays are reset
before the port accepts traffic.

### 3.2 Module boundaries

Three rules, each enforced by a test rather than by convention:

1. **`db/pool.js` is the only file that may `require("pg")`**, and it never
   exports a `Pool`. Everything else goes through `db/index.js`.
2. **`http/router.js` is the only file that may `require("express")`.** One way
   to register a route means one place where authentication can be forgotten.
3. **Everything under `lib/` is pure** — no database, no filesystem, no
   network. The clock and the trusted-hop count are arguments, never ambient
   reads.

Rule 2 is not stylistic. Express's `app.use('/api/terminal', mw)` boundary-matches
on `/`, so it does not cover `/api/terminals/*`. A developer following the only
visible sibling route can ship a fully unauthenticated endpoint that no
repository test catches, because the handler underneath calls a correctly
scoped repository — the scope simply came from nowhere.

### 3.3 Tenant isolation

Isolation rests on four mechanisms, in decreasing order of strength.

**(a) Composite foreign keys — enforced by Postgres, not by discipline.**
Every ownership foreign key between tenant tables includes `company_id`. In
`user_shops`, both foreign keys are anchored on the *same* `company_id` column,
so assigning a user of company A to a shop of company B would require one
column to hold two values, and Postgres rejects the row. `terminals` carries a
three-column anchor, `UNIQUE (id, shop_id, company_id)`, because the real
privilege boundary is the **shop**, not the company: without `shop_id` in the
anchor, a `shop_manager` assigned only to shop 1 could mint a pairing code
against shop 2's cashier terminal and hold a Phase-5 checkout credential for a
shop they were never assigned.

**(b) One choke point.** `db/index.js` exports `withTenantScope(scope, fn)`,
which checks out one client, opens a transaction, sets `app.company_id`, runs
`fn`, and commits. Inside it, `tenantQuery(scope, descriptor, params)` is the
only way to issue SQL. The descriptor form —
`{ sql, shopScoped: false | 'active' | 'administered', conflicts }` — exists
because binding two leading parameters unconditionally breaks every statement
that references only `$1`: Postgres derives the parameter count from the
highest `$n` in the text, so `WHERE company_id = $1` would fail with *"bind
message supplies 2 parameters, but prepared statement requires 1"*. The helper
asserts the SQL contains `company_id = $1`, and `shop_id = ANY($2)` when
shop-scoped, binds those itself, and starts caller parameters after them.

`shopScoped: 'active'` binds `scope.shopIds`; `shopScoped: 'administered'` binds
`scope.administeredShopIds` — the status-independent set a company admin needs in
order to read or un-suspend a suspended shop. Either way the helper asserts the
chosen value is a real `uuid[]` before binding, so a missing set is a throw
rather than a `NULL` that widens the query. There is no third option and no
caller-supplied array: a repository cannot choose which shops it sees, only
which of the two scope-derived sets applies.

For `INSERT` and `UPDATE` the caller's SQL **may not name `company_id` at
all** — the helper injects the column and the scope's value. Requiring only
that it *appear* is not enough: a helper reused between a platform route
(which legitimately names a target company) and a tenant-facing invite route
would let a `company_admin` who learned another company's UUID create a
`role='company_admin'` row inside it with a password of their choosing, while
every read-side isolation fixture stays green.

**(c) Materialised scope. There is no "null means all" sentinel.** This is the
single largest correction the design review produced; three independent
reviewers found it in three different drafts. Two failure modes, both
fail-*open*:

- A terminal scope carries `shopId` singular, so `scope.shopIds` is
  `undefined`, so `scope.shopIds ?? null` binds `$2 = NULL`, so
  `($2::uuid[] IS NULL OR shop_id = ANY($2))` short-circuits to true — and a
  correctly paired kitchen tablet at shop A1 is served shop A2's data on its
  first call.
- `array_agg` over zero rows returns `NULL`, not `'{}'`, so a staff user whose
  last shop assignment was *just revoked* gets a scope byte-identical to a
  company admin's. **Revocation escalates privilege.**

Therefore `createScope()` always emits a real `uuid[]`; `COALESCE(array_agg(…), '{}')`
is mandatory; the scope object is frozen and stamped with a module-private
Symbol; and `assertTenantScope()` throws on anything unstamped, on any scope
missing `shopIds`, and on any `company_admin` or scoped-`platform_admin` scope
missing `administeredShopIds` — so `?? null` can never paper over a gap.

**(d) Enforcement tests.** Specified in §8.

**The precise limit of the RLS-later promise.** Adding row-level security is a
pure migration for the **six RLS-ready tables only** — `shops`, `shop_tables`,
`user_shops`, `terminals`, `terminal_pairing_codes`, `terminal_tokens`: the
tables that carry `company_id uuid NOT NULL` and are reached only after a scope
exists. `users`, `user_sessions` and `terminal_tokens`' pre-tenant lookup path
are read in order to *discover* the tenant, before any `app.company_id` could be
set, so a uniform equality policy on them is not possible; `audit_events` is
neither, because its `company_id` is nullable by design. Separately,
`withTenantScope()` is what makes even the ten-table case real: `pool.query()`
checks out a connection per call, so a later `SET app.company_id` followed by a
`SELECT` would land on two different connections and the policy would evaluate
against whatever a previous tenant's request left behind — the policy added to
prevent leakage becomes the mechanism causing it. Introducing the boundary now,
at six repository functions instead of two hundred, is what keeps the option
open. The GUC is set but inert until then.

## 4. Data model

Eleven tables. Full DDL in Appendix A.

| Table | Purpose |
| --- | --- |
| `schema_migrations` | Ledger of applied migration files, keyed by filename with a SHA-256 of the file bytes. |
| `companies` | Tenant root; every tenant-owned row in the database carries this id directly. |
| `users` | Every human who logs in, including platform admins, with role and company membership on the row. |
| `shops` | A physical restaurant belonging to one company; owns the business-day clock. |
| `shop_tables` | One physical dining table in a shop, identified by a human label. |
| `user_shops` | Assigns a shop_manager or staff user to a specific shop; company_admin and platform_admin never appear here. |
| `user_sessions` | Server-side browser sessions; only the SHA-256 of the cookie value is stored, never the raw value. |
| `terminals` | A shared device bound to one shop (kitchen_display, cashier_counter, epaper_hub), paired once, no human login. |
| `terminal_pairing_codes` | Short-lived, single-use, human-typeable code a device exchanges once for a long-lived token. |
| `terminal_tokens` | Long-lived bearer credential held by a paired terminal, individually revocable and self-rotating. |
| `audit_events` | Append-only record of authentication and authorization actions; the only accountability mechanism in Phase 1. |

Shape notes — the one non-obvious decision per table:

**`schema_migrations`** — The runner treats "applied in the DB but missing from disk" as a loud WARNING, not a fatal error — one draft made it fatal, which is wrong here: push-to-main goes straight to production with no staging tier, and image rollback is the only recovery lever there is. Making the newer-database case fatal deletes that lever at exactly the moment it is needed. Checksum mismatch stays fatal (history was edited) and a pending migration stays fatal (the server would serve against a schema it does not expect); those two are recoverable only by fixing, not by continuing. Safety comes instead from an additive-only discipline: never rename, drop, or add NOT NULL without a default inside a single release.

**`companies`** — No slug column. Two drafts had one and neither Phase-1 code path reads it; Phase 2 admin routing and Phase 7 captive-portal hosts are the first real consumers, and decision 7 says no persistent data exists, so backfilling a unique slug across single-digit rows later is a five-minute job. Cutting it also deletes an entire family of problems the reviewers found (per-shop branded origins being squattable by a sibling tenant, guessable public handles inviting a developer to derive scope from a request path). Suspension is enforced at auth time via a join, so suspending a company kills every session and every terminal token for it on the next request with no cleanup job.

**`users`** — platform_admin is a role value, not a separate platform_operators table. The security case for splitting was that a weak 'update user role' handler lets a company_admin write role='platform_admin' — but the table CHECK ((role = 'platform_admin') = (company_id IS NULL)) turns that into a database-enforced check violation, because the escalating UPDATE would also have to null company_id, and no tenant-scoped repository is permitted to write that column. Meanwhile splitting costs two session tables, a UNION login with undefined actor-class precedence, a split audit trail, and cross-table email disjointness that three separate reviewers showed is unenforceable under READ COMMITTED (a BEFORE trigger cannot see another transaction's uncommitted row). One table, one namespace, one unique index, no race.

**`shops`** — time_zone and business_day_rollover_hour are NOT NULL with no DEFAULT. Two drafts defaulted them to 'Asia/Tokyo'/6, which bakes this deployment's configuration into a multi-tenant table: a Yangon shop created through a Phase-2 form that does not yet expose the advanced settings would silently inherit a Tokyo clock and only reveal it in Phase 3, on live bills, as orders filed under the wrong business day and QRs rotating mid-service. Everything else money-shaped (currency, minor unit, service fee, tax rate, order origin) is cut to the phase that first reads it. UNIQUE (id, company_id) is redundant against the PK on purpose: it is the anchor that lets every child declare a composite FK.

**`shop_tables`** — A single text label rather than an integer table_number plus a nullable display label. Two identifiers means the unique one is the one nobody says out loud and the human one is the one nothing enforces — a cashier searching 'B1' in Phase 5 finds no unique match. The charset (^[A-Z0-9][A-Z0-9 -]{0,7}$) is derived from packages/epaper-hub-sdk/table-template.js, whose FONT map contains exactly A-Z, 0-9, space and dash and whose drawText() uppercases input, so anything else renders as blank glyphs on a real panel with no error. The uniqueness index is partial on status='active' so a renovated floor plan can reuse '5'; an unconditional index would make the archived state useless for the one case it exists for.

**`user_shops`** — Both foreign keys are anchored on the SAME company_id column, so assigning a user of company A to a shop of company B would require two different values in one column and Postgres rejects the row outright. A platform_admin (company_id NULL) can never be inserted at all, because MATCH SIMPLE cannot match users(id, NULL) from a child whose company_id is NOT NULL — the correct outcome, since platform scope is role-derived, and it is now a constraint rather than a convention. Natural composite PK (user_id, shop_id), not a surrogate uuid: the pair is the identity and a surrogate would permit duplicate grants.

**`user_sessions`** — acting_company_id, not a mirror of users.company_id. The mirror was in two drafts and it is the column that makes a platform admin's demotion, or a null-vs-pinned ambiguity, silently widen or silently empty their scope. Here it is the company the session is operating inside: for tenant roles the resolver requires it to equal users.company_id (a mismatch is a WHERE-clause failure, so the session simply dies), and for a platform admin it is the company they selected via POST /api/admin/scope. That single column is what lets a platform admin drive the ordinary tenant repositories under an ordinary tenant scope — with the selection audited — instead of maintaining a parallel cross-tenant repository layer that grows quietly with every later phase.

**`terminals`** — UNIQUE (id, shop_id, company_id) is a three-column anchor, not two. Pairing codes and tokens hang off it, so a code or token cannot drift to a terminal in another SHOP, not merely another company. That matters because the shop is the real privilege boundary: without it a shop_manager assigned only to shop 1 could mint a pairing code against shop 2's cashier terminal (the company predicate passes) and redeem it on their own device, acquiring a Phase-5 checkout credential for a shop they were never assigned. The name index is partial on status <> 'suspended' so a dead 'Kitchen 1' does not permanently burn that label.

**`terminal_pairing_codes`** — No attempt_count column, even though two drafts had one and cited it as a control justifying the reduced entropy. It is inert: a wrong guess matches no row, so it increments nothing and can only cap resubmission of a code the attacker already holds — the case where they have already won. The real bounds are 50 bits, the 15-minute TTL, single-use consumption, the network rate limit, and an audit row on every failed redemption. The one-live-code-per-terminal partial index is kept, but the mint endpoint must take SELECT ... FROM terminals ... FOR UPDATE and revoke-then-insert in one transaction, or an expired unconsumed code permanently bricks the terminal (now() cannot appear in an index predicate) and a double-clicked button surfaces a raw 23505.

**`terminal_tokens`** — There is no "exactly one live token per terminal" partial unique index, which every draft wanted. Rotation must overlap: the terminal mints a successor and the predecessor is shortened to now() + 10 minutes rather than revoked, so a device that loses the response on flaky kitchen Wi-Fi self-heals on its next retry instead of being bricked until a human walks over with a new pairing code. That overlap is literally unrepresentable under a one-live-token index. The property the index was standing in for — mass revocation — is a single set-based UPDATE that cannot miss a row, which is strictly stronger than an index. expires_at is NOT NULL from day one because a nullable 'no expiry' default is not a free upgrade path: switching expiry on later means backfilling the whole fleet, which kills every terminal in every shop on the same day.

**`audit_events`** — detail is constrained to a FLAT map of scalars, and that is what makes the credential-name check real. Every draft wrote NOT (detail ? 'password' ...), but the jsonb ? family inspects top-level keys only, so a handler writing {request: req.body} passes the check and persists a plaintext password for the life of the retention window. Flattening makes the key check exhaustive. Separately, every FK is ON DELETE RESTRICT, never SET NULL: SET NULL lets a DELETE elsewhere silently rewrite history, and it collides with the meaning this schema already assigns to a NULL actor (an anonymous failed login), so a scrubbed row and a genuine attack signal become indistinguishable. actor_label snapshots the actor's email or terminal name so attribution survives regardless.


### 4.1 Conventions asserted by tests

- Every tenant-owned table carries `company_id uuid NOT NULL`.
- Every ownership foreign key includes `company_id`; every such parent carries
  the matching `UNIQUE` anchor.
- **No foreign key anywhere uses `ON DELETE SET NULL`.** On a composite key that
  action nulls *every* referencing column, which would always fail against a
  `NOT NULL company_id`. Attribution columns (`created_by_user_id`,
  `revoked_by_user_id`) are plain single-column keys with `ON DELETE RESTRICT`
  and are named individually in the test's exception list.
- Credential digests are `bytea(32)`, never hex text, so binding a raw
  credential by mistake raises *"invalid input syntax for type bytea"* instead
  of silently matching zero rows.
- `shops.time_zone` and `shops.business_day_rollover_hour` are `NOT NULL` **with
  no `DEFAULT`**. Defaulting them to `Asia/Tokyo`/`6` bakes this deployment's
  configuration into a multi-tenant table: a Yangon shop created through a
  Phase-2 form that does not yet expose the advanced settings would silently
  inherit a Tokyo clock, and it would only surface in Phase 3, on live bills, as
  orders filed under the wrong business day.

## 5. Authentication and authorization

### 5.1 Passwords

`scrypt` from `node:crypto` — no dependency, memory-hard, async on the libuv
threadpool. Parameters `N=32768, r=8, p=1, dkLen=32`, 16-byte random salt.

This is a deliberate **departure** from the repository's single-round SHA-256
credential convention, and the departure is the point: SHA-256 is correct for
the 128-bit random tokens in `table-visit-store.js` — a fast hash over a 2^128
preimage space is not brute-forceable — and catastrophically wrong for a
~30-bit human password.

> **Implementation trap.** `128 × N × r` is exactly 33,554,432 bytes and Node's
> default `scrypt` `maxmem` is exactly 32 MB. The call must pass
> `maxmem: 64 * 1024 * 1024` or it throws at runtime.

Stored as one self-describing PHC-style string,
`scrypt$N=32768,r=8,p=1$<salt>$<key>`. Verification parses `N`/`r`/`p` out of
the stored value rather than the current constants, so parameters can be raised
later and every old hash still verifies. A column CHECK on the `scrypt$` prefix
means the column cannot physically hold a plaintext password or a bare SHA-256
digest.

**Policy.** Minimum 12 characters, maximum 256 — the maximum exists to bound
scrypt work reachable from an unauthenticated route. NFKC-normalised before
hashing. No composition rule and no denylist in Phase 1. The server-minted
`initialPassword` is the 22-character Base64URL value from `lib/tokens.js`, so it
satisfies the policy by construction. Violations are `422 validation_failed`
with field code `too_short` / `too_long`.

**Concurrency.** scrypt is the only CPU-bound path in the service and it is
reachable unauthenticated, so `lib/semaphore.js` gates it: `SCRYPT_SLOTS`
concurrent hashes (compose default 2, integer 1–8) with a queue depth of
`4 × SCRYPT_SLOTS`. A request that would exceed the queue is shed immediately
with `503 service_unavailable` and `Retry-After: 5` rather than queued — a
lengthening queue converts a CPU limit into a timeout storm. The slot is
acquired at pipeline step 5 (§6.3.5), immediately before the scrypt call, and
released in a `finally`.

**`LOGIN_TIME_BUDGET_MS` is measured from slot acquisition, not from request
arrival.** Queue wait sits outside the budget. That is precisely why
`LOGIN_RATE_PER_MINUTE` sheds *before* the queue rather than lengthening it: if
queue time counted, a burst would stretch every login past the budget and the
byte-identical-outcome property — the thing that keeps "unknown email" and
"wrong password" indistinguishable — would leak through timing.

### 5.2 User sessions

Opaque credential, preserving the existing convention exactly:
`crypto.randomBytes(16).toString('base64url')` → 22 Base64URL characters, only
the SHA-256 stored and looked up, raw value appearing only in a `Set-Cookie`
header. Unlike `customer-order`, which deliberately retains raw table tokens in
a private `Map` so QR codes can be re-rendered, core-api retains no raw
credential in memory at all.

**The cookie is `__Host-core_session`, not `core_session`.** Host-only scoping
controls only what *this* server sets. Any sibling under `yeyintlwin.com` —
`order.`, `epaper-hub.`, the Phase-7 captive portal serving untrusted guest
devices, the Phase-4/5 terminal subdomains, or a network attacker answering
plain HTTP for a non-existent `*.yeyintlwin.com` name — can set
`core_session=<value>; Domain=yeyintlwin.com`. The `__Host-` prefix is what
makes that impossible at the browser.

`users.sessions_valid_from` is the bulk-invalidation lever, bumped on password
change, suspension and "sign out everywhere". The resolver requires
`user_sessions.created_at >= users.sessions_valid_from`, so revocation is a
fail-closed `UPDATE` that cannot miss a row.

Sliding renewal runs **after** the request succeeds, at most once per 60
seconds. The invariant is: **a rejected request never extends a session.**
Without it, a script on a same-site sibling — `order.yeyintlwin.com`, which has
already needed XSS hardening (commit `da5ed83`) — can `fetch(…, {credentials:'include'})`
every five minutes, collect `403 origin_not_allowed` each time, and hold an
unattended till session alive to the 7-day absolute cap instead of letting it
die at the 8-hour idle horizon.

### 5.3 Channel binding and CSRF

CSRF is gated on the **authentication channel**, not the HTTP verb.

The obvious rule — "every state-changing request must carry an allowlisted
`Origin`" — breaks Phase 1's headline feature. `POST /api/terminal/pair` is an
unsafe, unauthenticated method called by kiosks, native shells and `curl`, none
of which send `Origin`, so every non-browser terminal would receive a 403; and
because pairing failures are deliberately opaque, the operator would read it as
a bad code and burn through reissues. The blanket rule is also a departure from
the code it claims to copy: `apps/customer-order/server.js` applies the
`Origin`/`Content-Type` pair only inside the two `rsid`-cookie routes
(lines 305 and 334) and deliberately not to the bearer-authenticated checkout
route at line 288.

**The rule:** a request authenticated by the `__Host-core_session` cookie, plus
the unauthenticated login route, must carry `Origin === API_PUBLIC_ORIGIN`
(else 403) and `Content-Type: application/json` (else 415). Bearer-authenticated
and unauthenticated device routes are exempt.

What makes the exemption safe is **strict channel binding**, enforced in the
same middleware: a session cookie is never accepted from an `Authorization`
header, a terminal token is never accepted from a cookie or a query string, and
presenting both credentials does not widen access. That last clause explicitly
rejects the pattern at `apps/epaper-hub/server.js:89`, which reads the
credential from `req.query.api_key` and then lets `morgan("combined")` write it
into the access log.

No CSRF token table. `SameSite=Lax` is the second layer and the `__Host-`
prefix is the third.

### 5.4 Authorization

**Rule zero: tenant scope is derived from the credential, never from a
request.** There is no `companyId` path parameter, body field or query
parameter anywhere in the tenant-facing API. `GET /shops` means the shops of
*my* company.

`createScope()` emits:

| Actor | Scope — every key it carries |
| --- | --- |
| `platform_admin`, no company selected | `{ kind: 'platform', userId, sessionId }` — reaches only platform routes |
| `platform_admin`, company selected | `{ userId, sessionId, companyId, role: 'platform_admin', shopIds: every active shop of the acting company, administeredShopIds: every shop of it (status-independent), auditCrossTenant: true }` |
| `company_admin` | `{ userId, sessionId, companyId, role, shopIds: every active shop of the company, administeredShopIds: every shop of the company (status-independent) }` |
| `shop_manager` / `staff` | `{ userId, sessionId, companyId, role, shopIds: from user_shops JOIN shops WHERE shops.status = 'active' }` — no `administeredShopIds` |
| terminal | `{ companyId, shopIds: [shopId], terminalId, terminalKind, tokenId }` |

`administeredShopIds` is what makes suspension **reversible**: a suspended shop
must disappear from its manager's world while staying reachable by the company
admin who has to un-suspend it. `userId` is required because
`terminals.created_by_user_id` is `NOT NULL` and the `audit_events` actor
constraint demands an actor.

**Role aliases used by the §6.2 route table.** A scoped `platform_admin`
materialises `role: 'platform_admin'` — rank 3, above `company_admin` — so the
rank lattice does the work and no alias needs a special case. This is what makes
the documented tenant bootstrap possible: a platform admin selects scope and
creates the company's first `company_admin` through the ordinary
`POST /api/admin/users` route.

| Alias | Admits |
| --- | --- |
| `platform` | `platform_admin` with no company selected |
| `companyAdmin` | `company_admin`, scoped `platform_admin` |
| `manager` | `shop_manager`, `company_admin`, scoped `platform_admin` |
| `anyUser` | `staff`, `shop_manager`, `company_admin`, scoped `platform_admin` |

**Cross-tenant access has no branch.** There is no `if (scope.kind === 'platform') skip the filter`
inside any tenant repository. A platform admin selects a company via
`POST /api/admin/scope`, which records `user_sessions.acting_company_id` and
writes an audit row; from that point they drive the ordinary tenant
repositories under an ordinary tenant scope. `repositories/platform/` holds
only genuinely cross-tenant operations and exports
`dangerouslyQueryAcrossTenants(scope, sql, params)` — **with** a scope
parameter, throwing unless the scope is symbol-stamped and `kind === 'platform'`.
A version taking no scope would be structurally incapable of checking anything.

Privilege rules live in one module, unit-tested by name:

- **Role lattice.** An actor may only create or modify a user *strictly below*
  its own role. Left to prose, the consequence is a `shop_manager` POSTing
  `{ role: 'company_admin' }`: every constraint is satisfied, the response
  carries the one-time password, and they own the company.
- **Shop containment for user operations.** `users` has no `shop_id`, so the
  mechanical predicate cannot express it. A `shop_manager` may read or mutate a
  target user only if they share an assignment, and never a target with zero
  assignments. Without this, a manager at branch A1 can list every user in the
  company — harvesting addresses for the lockout attack — and suspend A2's staff
  mid-service.
- Nobody modifies their own role, status or assignments. Nobody creates a user
  at or above their own role. (`POST /api/platform/admins` is the single named
  exception; see §6.2.)
- Promoting a user to `company_admin` or `platform_admin` deletes their
  `user_shops` rows in the same transaction, and demotion starts from an empty
  set — otherwise a year-old assignment silently resurrects on demotion.
- Refuse to suspend the last active `platform_admin`, and the last active
  `company_admin` of a company.
- `must_change_password` is enforced **in the resolver**, not the UI: while
  true, every route except `POST /api/admin/auth/password` and
  `POST /api/admin/auth/logout` returns 403.
- A shop not in scope returns 404, never 403.

### 5.5 Terminal pairing

Administration routes are **nested under their shop**:
`/api/admin/shops/:shopId/terminals…`. Flat `/terminals/:id/…` routes cannot be
shop-checked before the handler runs — the terminal's shop is only discoverable
after a database read, so the frozen scope necessarily has no `shopId` and the
mechanical predicate degrades to company-only.

1. **Create.** A `company_admin`, or a `shop_manager` assigned to that shop,
   POSTs `{ kind, name }`. The row is inserted with `status='unpaired'`. No
   credential is created or returned. Because a human fixes `kind` and `shop_id`
   before any device connects, a device can never choose its own shop or elevate
   its kind — that is what bounds a leaked token's blast radius.

2. **Issue a code.** One transaction: `SELECT … FOR UPDATE`; revoke any live
   code; insert the new one with `expires_at = now() + 15 minutes`. The row lock
   is required — without it two concurrent issuances both fail to see each
   other's insert and the second surfaces a raw `23505` to the operator, on the
   one screen whose entire purpose is displaying a credential that must be typed
   correctly the first time.

   **The mint also revokes any live token and sets `status` back to
   `'unpaired'`.** Documenting "issue a new pairing code" as the lost-tablet
   remedy while revoking nothing until the new code is redeemed means a tablet
   stolen at 19:00 on a Friday keeps full shop-scoped access all weekend while
   the terminal list shows it healthy. The display going dark until re-pairing
   is the correct trade.

   The code is **10 characters of Crockford base32** (no I, L, O, U) — 50 bits —
   displayed as `XXXXX-XXXXX`. This is a deliberate departure from the
   22-character house convention: the person typing is standing at a kitchen
   tablet's on-screen keyboard, and 22 mixed-case Base64URL characters get
   mistyped repeatedly and get written down. Input is folded before hashing
   (uppercase, strip dashes and whitespace, `I`/`L`→`1`, `O`→`0`). Only the
   SHA-256 is stored. The raw code appears in exactly one response, with
   `Cache-Control: no-store`, and can never be re-read — only re-issued.

3. **Redeem.** The device POSTs `/api/terminal/pair { code }`, unauthenticated,
   no `Origin` requirement. The transaction's first statement is the single-use
   guard:

   ```sql
   UPDATE terminal_pairing_codes SET consumed_at = now(), consumed_from_ip = $2
   WHERE code_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
   RETURNING terminal_id, shop_id, company_id
   ```

   Zero rows aborts the transaction — that is what makes concurrent double
   redemption impossible rather than merely unlikely. Every failure mode
   (unknown, expired, consumed, revoked, terminal not pairable, shop or company
   suspended) returns one identical 401 and writes an audit row, mirroring the
   existing rule that malformed, unknown, expired and rotated table tokens are
   indistinguishable to the client. On success, still inside the transaction: a
   token is minted (16 random bytes → 22 Base64URL characters, SHA-256 stored,
   90-day expiry), `status` becomes `'active'`, and the audit row is written.

4. **Use.** `Authorization: Bearer <22 chars>` on every later call — never a
   cookie, never a query parameter. Resolution is one indexed probe on
   `token_hash` **joined all the way up**: `terminal_tokens → terminals → shops
   → companies`, requiring the token live and unexpired and all three parents
   `active`. Described as a bare `token_hash` lookup, archiving or suspending a
   terminal — the intuitive lost-device action in an admin UI — revokes nothing,
   and the stolen device keeps authenticating.

   `crypto.timingSafeEqual` is deliberately **not** used here, and is still used
   for configured shared secrets: comparing against one known value needs
   constant time; an indexed exact-match lookup on a 128-bit digest does not.

5. **Rotate.** `POST /api/terminal/token/rotate`, authenticated by the current
   token, mints a successor and shortens the predecessor to
   `LEAST(expires_at, now() + 10 minutes)` — so a device that loses the response
   on flaky kitchen Wi-Fi, or during the few seconds of connection refusal a
   compose recreate causes, self-heals on retry rather than bricking. Terminals
   rotate when fewer than 14 days remain. Without this, turning on a 90-day
   expiry means every terminal in every shop dies on the same day.

   Rotation never refuses on supersession grounds. `superseded_at` and
   `replaced_by_token_id` were cut from the schema (§10), the only available
   approximation — testing whether `expires_at` was already shortened — bricks
   the exact device the 10-minute overlap exists to save, and the residual
   (orphaned successor tokens) is recorded in §11.2. The
   reuse-detection state machine was cut because its crash-retry branch is
   attacker-steerable — an attacker polling `rotate` with a stolen token lands
   inside the window where the legitimate successor has not yet been seen, is
   classified as a crash retry, and is handed a fresh 90-day token while the
   real tablet is locked out with no alarm. Leak containment is instead a
   set-based statement that cannot miss a row:
   `UPDATE terminal_tokens SET revoked_at = now(), revoked_reason = 'suspected_leak' WHERE terminal_id = $1 AND revoked_at IS NULL`.

### 5.6 Bootstrap

**CLI only.** No bootstrap HTTP endpoint, no bootstrap token, no seeded user
row in a migration, and no `BOOTSTRAP_ADMIN_PASSWORD` environment variable.

The environment-variable variant was rejected outright. Its defence — "anyone
who can read that file already has `DATABASE_URL`" — does not hold in this
deployment: Postgres runs inside Compose with **no published host port**, so
`DATABASE_URL` is exploitable only from inside the host, while a bootstrap
email/password pair is a cross-tenant credential usable from any browser on the
internet. Those are not the same trust level. And because Phase 1 ships no admin
UI, the value would in practice never be changed: it leaks by any ordinary route
— a host backup tarball, `docker inspect` output pasted into an issue, a crash
reporter dumping `process.env` — and the only defence is a startup log line.

Invocation, guards and the reason the script refuses a non-TTY stdin are in
§9.10.

### 5.7 Rate limiting

**The client IP must be derived explicitly, or none of this works.** core-api
binds `127.0.0.1` behind Nginx, so `req.socket.remoteAddress` is `127.0.0.1`
for every request on earth. There is no existing IP handling in this repository
to copy, and both naive implementations fail in opposite directions: keying on
the socket address puts every request in one global bucket, so an attacker's 60
bad logins per minute lock out every staff member in every company; keying on a
raw `X-Forwarded-For` lets the client forge a fresh bucket per request, removing
the throttle entirely and with it the only bound on pairing-code guessing.

Therefore a `TRUSTED_PROXY_HOPS` config value, counted from the **right** of
`X-Forwarded-For`, validated at startup — the server refuses to listen if it is
unset in production. If the header is absent, has fewer entries than the hop
count, or the selected entry fails `net.isIP()`, the derivation is *untrusted*:
the bucket key becomes a single shared `"unknown"` (strictest, fail-closed),
`source_ip` is written `NULL` (fail-soft), and it logs at error level on every
occurrence. Writing the raw comma-separated header into an `inet` column raises
*"invalid input syntax for type inet"* inside the login transaction, failing
login outright for anyone behind two proxies.

Buckets are keyed on `users.id`, not on the session. A session-keyed bucket
resets on demand: the caller holds valid credentials, `POST /api/admin/auth/login`
is public so a presented cookie is ignored, and there is no cap on concurrent
sessions per user — so a stated "20 probes per 10 minutes" ceiling is off by
whatever the login rate allows.

**Per-account backoff on failed login.** Failures 1–2 carry no delay; from the
third, `locked_until = now() + min(2^(n-3) minutes, 15 minutes)`, reset to zero
on any successful login. A correct password therefore always eventually works.

**The limiter roster — seven, defined once here and nowhere else.** Steps 4a and
5b in §6.3.5 refer to this table; `validateRouteTable()` rejects at boot any route
whose `limit` names a limiter absent from it, or whose `limit.key` disagrees with
the key declared here. The table itself lives in `apps/core-api/lib/rate-limit.js`
as `LIMITERS`; this section and that constant are the same list, and it is read by
the boot check and by the request pipeline so the two cannot drift.

*Amended by Plan 2b (Task 2).* This paragraph described a check that did not exist
until then; `validateRouteTable` now performs it, and three tests in
`apps/core-api/test/router-registration.test.js` hold it — an unknown `limit.name`
is fatal, a `limit.key` disagreeing with the roster is fatal, and every name in the
roster is accepted (without that third one, a check that rejected everything would
pass the first two and make the roster unusable). Identity-slice §7.1 records why it
could not land in Plan 2a: a closed set authored ahead of the routes that populate it
either blocks those routes or is padded with names for routes that do not exist.

| Limiter | Bucket key | Window | Ceiling | `Retry-After`? | Config |
| --- | --- | --- | --- | --- | --- |
| `login-global` | client IP (credential-independent) | 1 min | `LOGIN_RATE_PER_MINUTE` (30) | **no** — would confirm the bucket | `LOGIN_RATE_PER_MINUTE` |
| `pair-global` | client IP (credential-independent) | 1 min | `PAIR_RATE_PER_MINUTE` (20) | **no** — pairing failures are uniform | `PAIR_RATE_PER_MINUTE` |
| `create-user` | `users.id` of the caller | 10 min | `ADMIN_MINT_RATE_PER_10MIN` (20) | yes | `ADMIN_MINT_RATE_PER_10MIN` |
| `password-reset` | `users.id` of the caller | 10 min | shares the `create-user` bucket | yes | `ADMIN_MINT_RATE_PER_10MIN` |
| `pairing-code-mint` | `users.id` of the caller | 10 min | `PAIRING_MINT_RATE_PER_10MIN` (30) | yes | `PAIRING_MINT_RATE_PER_10MIN` |
| `password-change-abuse` | `users.id` of the caller | 1 h | 5 consecutive `current_password_invalid`, then the presenting session is deleted (§5.8(a)) | yes | `PASSWORD_ABUSE_THRESHOLD` |
| `token-rotate` | `terminals.id` | 1 h | 5 | yes | `ROTATE_RATE_PER_HOUR` |

`create-user` and `password-reset` deliberately share one bucket: they mint the
same credential, and separating them would double the email-probing ceiling
§5.8(b) exists to bound.

**Every failed login writes an `audit_events` row** with
`actor_kind = 'anonymous'`, `outcome = 'failure'`, the derived `source_ip`, and
the probed address in `detail.email`. That row is not only for forensics: it is
the only externally observable evidence of what the server derived as the client
IP, and the deploy gate in §9.5 asserts against it.

### 5.8 Two corrections to earlier drafts

Recorded because both were stated the other way round during design and should
not be re-derived.

**(a) `POST /api/admin/auth/password` must not write `users.failed_login_count`
or `users.locked_until`.** Those columns belong to the unauthenticated login
credential. Throttling the authenticated route on them lets a stolen session
drive the legitimate owner's *login* lockout: three 403s, `locked_until` climbs
to the 15-minute cap, one request every 14 minutes holds it there forever, and
the victim reads their own uniform `401 invalid_credentials` as a typo while the
attacker's session slides its idle window on every request. Instead: an own
per-`users.id` bucket, and on the Nth consecutive `current_password_invalid`,
delete the presenting session and write an audit row — punishing the credential
actually being abused. `403 current_password_invalid` rather than 401 stands:
the session credential *is* valid, and a client's global "401 → drop session and
redirect" handler would otherwise let a stolen session grief the real user out
of theirs.

**(b) Create-user returns `409 email_unavailable`.** The proposed "identical
response whether or not the email collides" is unimplementable: the caller
issues `GET /api/admin/users?email=…` immediately afterwards and sees whether
the row exists, so a fabricated 201 closes the oracle for exactly zero requests
while handing an administrator credentials that will never work. The gap is
closed with mechanism instead — a non-confirming message ("That email address is
not available."), a per-`users.id` bucket of 20 create/reset calls per 10
minutes, and an audit row with `outcome='failure'` carrying the probed address.
The residual is recorded in §11. For `POST /api/platform/admins` the 409 is not
an oracle at all: platform admins have global visibility by construction.

### 5.9 Audit vocabulary

`audit_events.action` carries a CHECK regex and every non-GET route declares an
`audit` value (§8.5 rule 4). This table is the closed vocabulary; §8.5 additionally
asserts that every declared `audit` value is a member of it. Without it, roughly
twenty-five action strings would be invented at implementation time — and with
them, the question of what `audit_events_detail_no_credentials` is actually
protecting.

`detail` is a flat map of scalars. Only the keys listed may appear; no key may be
named after a credential (`password`, `token`, `code`, `secret`, `session`), which
is what the flat-map constraint makes checkable — the jsonb `?` operator inspects
top-level keys only, so a nested `{request: req.body}` would slip a plaintext
password past a non-flat check.

| `action` | `actor_kind` | `outcome` | `target_kind` | permitted `detail` keys |
| --- | --- | --- | --- | --- |
| `auth.login` | `user` | success | `user` | — |
| `auth.login_failed` | `anonymous` | failure | — | `email` |
| `auth.logout` | `user` | success | `user` | — |
| `auth.logout_all` | `user` | success | `user` | `revokedSessionCount` |
| `auth.password_changed` | `user` | success | `user` | — |
| `user.password_change_abuse` | `user` | failure | `user` | `consecutiveFailures` |
| `scope.selected` | `user` | success, failure | `company` | — |
| `scope.cleared` | `user` | success | — | — |
| `company.created` | `user` | success | `company` | `name` |
| `company.updated` | `user` | success | `company` | `name`, `status` |
| `shop.created` | `user` | success | `shop` | `name`, `timeZone`, `businessDayRolloverHour` |
| `shop.updated` | `user` | success | `shop` | `name`, `status`, `timeZone`, `businessDayRolloverHour` |
| `table.created` | `user` | success | `shop_table` | `label` |
| `table.updated` | `user` | success | `shop_table` | `label`, `status` |
| `user.created` | `user` | success, failure | `user` | `email`, `role` |
| `user.updated` | `user` | success | `user` | `displayName`, `status`, `role` |
| `user.shops_replaced` | `user` | success | `user` | `shopCount` |
| `user.password_reset` | `user` | success, failure | `user` | `email` |
| `terminal.created` | `user` | success | `terminal` | `kind`, `name` |
| `terminal.updated` | `user` | success | `terminal` | `name`, `status` |
| `terminal.pairing_code_issued` | `user` | success | `terminal` | `expiresAt`, `revokedLiveToken` |
| `terminal.paired` | `anonymous` | success | `terminal` | `kind` |
| `terminal.pair_failed` | `anonymous` | failure | — | — |
| `terminal.tokens_revoked` | `user`, `system` | success | `terminal` | `reason`, `revokedCount` |
| `terminal.token_rotated` | `terminal` | success | `terminal` | `expiresAt` |
| `platform.admin_created` | `user`, `system` | success | `user` | `email` |

`terminal.pair_failed` carries no `detail` at all — recording *which* code was
tried, or why it failed, would reconstruct in the audit trail exactly the
distinction §5.5 step 3 works to deny the client. `system` is the actor for the
CLI scripts and for the expiry sweep.

*Amended by Plan 2b (Task 3).* The membership check this section relies on is no
longer a test-only rule: `validateRouteTable` refuses at boot any route whose
declared `audit` action is outside `apps/core-api/lib/audit-vocabulary.js`, with the
**shape** check running first so a malformed action reports its real fault rather
than "not in the vocabulary". Held by three tests in
`apps/core-api/test/router-registration.test.js`, and by *"the nine actions Plan 2b's
routes and CLI emit are declared"* in `apps/core-api/test/audit-vocabulary.test.js`.
The vocabulary is still partial by design — each plan declares the actions its own
routes emit, so the check and the routes land together; identity-slice §11.6 records
why landing it in Plan 2a would have forced twenty entries for routes that did not
exist.

## 6. HTTP surface

### 6.1 Route registration

Deny by default, and **declared, not derived from path prefixes**. Every route
is registered as `route(method, path, { auth: 'user' | 'terminal' | 'public', … }, handler)`,
and `route()` throws at registration time if `auth` is absent or not one of the
three. There is no default anywhere.

The public set is asserted as set *equality*, so adding an entry fails and so does
removing one — and the literal moves with the routes rather than being fixed for the
phase. *Amended by Plan 2b (Task 14);* the earlier text said "exactly four entries"
and named `POST /api/terminal/pair`, which no plan has yet registered.

**Three after Plan 2b:** `GET /health`, `GET /health/ready`,
`POST /api/admin/auth/login`. It grows to **eight** when Plan 2d adds
`forgot-password`, `reset-password`, `verify-email`, `GET /admin/reset-password` and
`GET /admin/verify-email` — identity-slice §6.2 settles that enumeration — and to
**nine** when the terminal plan adds `POST /api/terminal/pair`. Widen the literal in
the same commit as the route; that is the whole point of an equality assertion.

### 6.2 Route table

| Method | Path | Auth | Roles | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | public | — | Liveness. Touches no database, so a DB blip cannot mark the container unhealthy mid-incident. This is what the Docker healthcheck calls. |
| `GET` | `/health/ready` | public | — | Readiness: SELECT 1 with a 2s statement_timeout plus schema_migrations vs on-disk file list. This is what the deploy gate calls. |
| `POST` | `/api/admin/auth/login` | public | — | Exchange email+password for a __Host-core_session cookie. Fixed wall-clock budget, byte-identical failure for every cause. |
| `POST` | `/api/admin/auth/logout` | user | `platform` + `anyUser` (exempt from the must_change_password gate) | Delete the presenting session row. |
| `POST` | `/api/admin/auth/logout-all` | user | `platform` + `anyUser` | DELETE every session for this user. The only in-band lever against a stolen session in Phase 1. |
| `GET` | `/api/admin/auth/me` | user | `platform` + `anyUser` | Re-read identity and materialised scope. Deliberately NOT exempt from the must_change_password gate — the 403 is self-describing and login already returned mustChangePassword. |
| `POST` | `/api/admin/auth/password` | user | `platform` + `anyUser` (exempt from the must_change_password gate) | Change own password. Requires currentPassword in all cases including the forced-change flow; writes the hash, bumps sessions_valid_from, deletes every session, mints a fresh one. |
| `POST` | `/api/admin/scope` | user | role === 'platform_admin' (scoped or unscoped) | Select or clear the company a platform admin acts inside; writes user_sessions.acting_company_id and an audit row. Body is `{"companyId": "&lt;uuid&gt;" or null}` — the key is required and explicitly nullable; null clears the selection, and a missing key is 422 validation_failed [field: companyId, code: required]. Audit action is scope.selected for a uuid, scope.cleared for null. |
| `GET` | `/api/platform/companies` | user | platform | List every company on the platform. `?status=` `active` / `suspended` / `all` (default all), ?limit, ?cursor. |
| `POST` | `/api/platform/companies` | user | platform | Create a tenant. Its first company_admin is then created by selecting scope and using the ordinary user route — rank 3 > rank 2 permits it, so no special route exists. |
| `GET` | `/api/platform/companies/:companyId` | user | platform | Read one company. |
| `PATCH` | `/api/platform/companies/:companyId` | user | platform | Rename or suspend/un-suspend. The ONLY rename path — there is no tenant-facing company rename, because companies_name_active_key is global and a 409 there would be a cross-tenant existence oracle for every authenticated user. |
| `GET` | `/api/platform/admins` | user | platform | List platform admins. ?status, ?email (exact match), ?limit, ?cursor. |
| `POST` | `/api/platform/admins` | user | platform | The sole route in the system that creates a peer, and an explicit named exception to 'nobody creates at or above their own role'. Justified because scripts/create-platform-admin.js is monotonic, so a platform with one admin otherwise has no second recovery path. platform_admin role stays immutable via the API. |
| `GET` | `/api/platform/admins/:userId` | user | platform | Read one platform admin. Exists so every 201 Location is followable and so the documented lost-response repair (409 → GET ?email= → password-reset) is actually executable. |
| `PATCH` | `/api/platform/admins/:userId` | user | platform | Rename or suspend a platform admin. role is not patchable here or anywhere. |
| `POST` | `/api/platform/admins/:userId/password-reset` | user | platform | Mint a new one-time password AND clear failed_login_count/locked_until. There is no separate unlock route: the remedy that helps a locked-out operator is a working password. |
| `GET` | `/api/admin/shops` | user | anyUser | List shops in scope. `?status=` `active` / `suspended` / `all` (default active) is honoured only for companyAdmin; shop_manager/staff are driven by the active-only scope.shopIds, so ?status=suspended returns [] rather than 403. Also ?limit, ?cursor. |
| `POST` | `/api/admin/shops` | user | companyAdmin | Create a shop. name, timeZone and businessDayRolloverHour are all required with no server-side default, because 0001_init.sql deliberately removed the DEFAULTs. |
| `GET` | `/api/admin/shops/:shopId` | user | anyUser | Read one shop. Resolved against scope.administeredShopIds for companyAdmin (status-independent) and against the active-only scope.shopIds for shop_manager/staff — so a suspended shop stays invisible to its manager but remains reachable by its company admin. |
| `PATCH` | `/api/admin/shops/:shopId` | user | companyAdmin | Rename, re-clock, suspend or UN-SUSPEND. Resolved against scope.administeredShopIds, which is what makes suspension reversible through the API. There is no DELETE; every child FK is RESTRICT. |
| `GET` | `/api/admin/shops/:shopId/tables` | user | anyUser | List dining tables. `?status=` `active` / `archived` / `all` (default active), ?limit, ?cursor. Order is label ASC, id ASC — '10' before '2' is a known Phase-2 gap, cut with shop_tables.sort_order. |
| `POST` | `/api/admin/shops/:shopId/tables` | user | manager | Create one dining table. No bulk create: twelve tables is twelve POSTs. label is folded (btrim, collapse whitespace, uppercase) then matched against ^[A-Z0-9][A-Z0-9 -]{0,7}$, and the folded value is echoed back. |
| `GET` | `/api/admin/shops/:shopId/tables/:tableId` | user | anyUser | Read one dining table. |
| `PATCH` | `/api/admin/shops/:shopId/tables/:tableId` | user | manager | Relabel or archive. Archiving releases the label because shop_tables_shop_label_active_key is partial on status='active'. |
| `GET` | `/api/admin/users` | user | manager | List users in scope. ?role, ?status, ?shopId, ?email (exact match), ?limit, ?cursor. Containment for shop_manager is an EXISTS semi-join plus u.role='staff' — never an INNER JOIN, which duplicates a user assigned to two of the caller's shops and silently truncates the page. |
| `POST` | `/api/admin/users` | user | manager | Create a user below the caller's rank. shopIds is required and non-empty for shop_manager/staff — a zero-assignment tenant user reaches nothing AND is untouchable by any shop_manager. |
| `GET` | `/api/admin/users/:userId` | user | manager | Read one user. user.shopIds in the response is intersected with the caller's own scope.shopIds, so a shop_manager never receives an out-of-scope shop uuid. |
| `PATCH` | `/api/admin/users/:userId` | user | manager | Update a user. Rank must be strictly below BEFORE and AFTER. Demotion must supply shopIds in the same request; promotion to company_admin DELETEs user_shops in the same transaction. Self-targeting is allowed for displayName only. A body carrying `role` or `shopIds` additionally requires companyAdmin — that is a **body-dependent** check performed at pipeline step 10 by `lib/authorization.js` raising 403 forbidden, not a static route declaration, and it is covered by a named case in `authorization.test.js`. |
| `PUT` | `/api/admin/users/:userId/shops` | user | companyAdmin | Full-set replacement of a user's shop assignments. companyAdmin-only because full-set replacement combined with a shop_manager's partial visibility is a silent-data-loss shape. |
| `POST` | `/api/admin/users/:userId/password-reset` | user | manager | Mint a new one-time password and clear failed_login_count/locked_until. This is the repair for a lost create response and for a locked-out cashier. |
| `GET` | `/api/admin/shops/:shopId/terminals` | user | manager | List terminals in one shop. Nested under the shop so shopId is validated against the caller's materialised scope BEFORE any terminal row is read. ?kind, ?status, ?limit, ?cursor. |
| `POST` | `/api/admin/shops/:shopId/terminals` | user | manager | Create a terminal row with status='unpaired'. No credential is created or returned. A human fixes kind and shop_id before any device connects. |
| `GET` | `/api/admin/shops/:shopId/terminals/:terminalId` | user | manager | Read one terminal, including pendingPairingCode:{expiresAt}|null so the UI can warn before re-minting. |
| `PATCH` | `/api/admin/shops/:shopId/terminals/:terminalId` | user | manager | Rename or suspend/un-suspend. →suspended revokes every live token with revoked_reason='terminal_suspended' in the same transaction. Un-suspending sets status='unpaired', paired_at=NULL — 'active' means paired, so it is not a settable value. |
| `POST` | `/api/admin/shops/:shopId/terminals/:terminalId/pairing-codes` | user | manager | Mint a 10-char Crockford base32 code (50 bits, XXXXX-XXXXX, 15-min TTL, single use). One transaction: SELECT … FOR UPDATE; revoke any live code; revoke every live token with reason 'repaired'; status='unpaired'; INSERT. Returns 201 with NO Location — the code is not addressable and never will be. |
| `POST` | `/api/admin/shops/:shopId/terminals/:terminalId/revoke` | user | manager | Kill every live token AND every live pairing code for this terminal. Sets status='unpaired' ONLY when the current status is 'active'; a 'suspended' terminal stays 'suspended'. Idempotent by construction — a second call revokes zero rows and still returns 200. |
| `POST` | `/api/terminal/pair` | public | — | Redeem a pairing code once for a 90-day bearer token. No Origin and no Content-Type requirement; safety comes from strict channel binding instead. Single-use guard is the transaction's first statement. |
| `POST` | `/api/terminal/token/rotate` | terminal | — | Always mints a successor and shortens the presenting token to LEAST(expires_at, now()+10 minutes). It NEVER refuses on supersession grounds — superseded_at was cut from the schema, so that rule can only be approximated by the shortened expiry, which bricks the exact device the overlap exists to save. |
| `GET` | `/api/terminal/me` | terminal | — | Who am I, for the device shell. Deliberately omits timeZone and businessDayRolloverHour — nothing in Phase 1 reads them; they arrive with the Phase-3 code that computes a business date. |

*Amended by Plan 2b (Task 15): the four `/api/admin/auth/` identity rows above read
`anyUser` and now read `platform` + `anyUser`.* §5.4's alias table excludes an
**unscoped** `platform_admin` from `anyUser`, and login always materialises
`actingCompanyId: null` for a platform admin — so under `anyUser` alone the only
account `scripts/create-platform-admin.js` can create is 403'd out of reading its own
identity, signing out, and changing the password the CLI just set. §5.4 and §6.2
disagreed; it is settled **in §6.2's direction, for these four rows only**, by
declaring both aliases on routes that bind no company, and **not** by widening
`anyUser` inside `permits()` — which would admit an unscoped platform admin to the
roughly twenty tenant routes registered at `anyUser`. Identity-slice §11.11 carries
the full reasoning and the rejected repairs.

Success and error responses per route:

- **`GET /health`** → 200 {"ok":true,"app":"core-api"}
  - Errors: none beyond the baseline
- **`GET /health/ready`** → 200 {"ok":true,"app":"core-api"}
  - Errors: 503 service_unavailable — body is the ordinary opaque error envelope; the checks vocabulary goes to the request log against requestId, never to the client
- **`POST /api/admin/auth/login`** → 200 me-document + Set-Cookie
  - Errors: 401 invalid_credentials (uniform: unknown email, wrong password, locked, suspended user, suspended company); 403 origin_not_allowed; 415; 422 validation_failed; 429 rate_limited with NO Retry-After
- **`POST /api/admin/auth/logout`** → 200 {"ok":true} + clearing Set-Cookie
  - Errors: none beyond the baseline
- **`POST /api/admin/auth/logout-all`** → 200 {"ok":true,"revokedSessionCount":n} + clearing Set-Cookie
  - Errors: none beyond the baseline
- **`GET /api/admin/auth/me`** → 200 me-document
  - Errors: none beyond the baseline
- **`POST /api/admin/auth/password`** → 200 me-document + new Set-Cookie
  - Errors: 403 current_password_invalid; 422 validation_failed; 429 rate_limited (+Retry-After). MUST NOT write users.failed_login_count or users.locked_until — see §6.3.7(a)
- **`POST /api/admin/scope`** → 200 me-document
  - Errors: 403 forbidden (not a platform admin); 404 not_found (unknown company); 409 company_suspended
- **`GET /api/platform/companies`** → 200 {"companies":[…],"nextCursor":null}
  - Errors: 409 scope_selected
- **`POST /api/platform/companies`** → 201 {"company":{…}} + Location
  - Errors: 409 company_name_taken; 409 scope_selected
- **`GET /api/platform/companies/:companyId`** → 200 {"company":{…}}
  - Errors: 404 not_found; 409 scope_selected
- **`PATCH /api/platform/companies/:companyId`** → 200 {"company":{…}}
  - Errors: 404 not_found; 409 company_name_taken; 409 scope_selected
- **`GET /api/platform/admins`** → 200 {"users":[…],"nextCursor":null}
  - Errors: 409 scope_selected
- **`POST /api/platform/admins`** → 201 {"user":{…},"initialPassword":"<22 chars>"} + Location
  - Errors: 409 email_unavailable; 409 scope_selected; 429 rate_limited (+Retry-After)
- **`GET /api/platform/admins/:userId`** → 200 {"user":{…}}
  - Errors: 404 not_found; 409 scope_selected
- **`PATCH /api/platform/admins/:userId`** → 200 {"user":{…}}
  - Errors: 403 self_modification_forbidden; 404 not_found; 409 last_platform_admin; 409 scope_selected; 422 validation_failed [field: role / companyId, code: immutable]
- **`POST /api/platform/admins/:userId/password-reset`** → 200 {"ok":true,"userId":"…","initialPassword":"<22 chars>"}
  - Errors: 403 self_modification_forbidden; 404 not_found; 409 scope_selected; 429 rate_limited (+Retry-After)
- **`GET /api/admin/shops`** → 200 {"shops":[…],"nextCursor":null}
  - Errors: 409 scope_required; 409 acting_company_suspended
- **`POST /api/admin/shops`** → 201 {"shop":{…}} + Location
  - Errors: 409 shop_name_taken; 422 validation_failed [field: timeZone, code: invalid_time_zone / field: businessDayRolloverHour, code: ambiguous_business_day]
- **`GET /api/admin/shops/:shopId`** → 200 {"shop":{…}}
  - Errors: 404 not_found; 409 scope_required
- **`PATCH /api/admin/shops/:shopId`** → 200 {"shop":{…}}
  - Errors: 404 not_found; 409 shop_name_taken; 422 validation_failed [field: timeZone, code: invalid_time_zone / field: businessDayRolloverHour, code: ambiguous_business_day]
- **`GET /api/admin/shops/:shopId/tables`** → 200 {"tables":[…],"nextCursor":null}
  - Errors: 404 not_found (shop)
- **`POST /api/admin/shops/:shopId/tables`** → 201 {"table":{…}} + Location
  - Errors: 404 not_found (shop); 409 table_label_taken; 422 validation_failed [field: label, code: pattern]
- **`GET /api/admin/shops/:shopId/tables/:tableId`** → 200 {"table":{…}}
  - Errors: 404 not_found
- **`PATCH /api/admin/shops/:shopId/tables/:tableId`** → 200 {"table":{…}}
  - Errors: 404 not_found; 409 table_label_taken; 422 validation_failed [field: label, code: pattern]
- **`GET /api/admin/users`** → 200 {"users":[…],"nextCursor":null}
  - Errors: 409 scope_required
- **`POST /api/admin/users`** → 201 {"user":{…},"initialPassword":"<22 chars>"} + Location
  - Errors: 403 forbidden (rank); 409 email_unavailable; 422 validation_failed [field: shopIds, code: required]; 429 rate_limited (+Retry-After, bucket keyed on users.id)
- **`GET /api/admin/users/:userId`** → 200 {"user":{…}}
  - Errors: 404 not_found
- **`PATCH /api/admin/users/:userId`** → 200 {"user":{…}}
  - Errors: 403 forbidden (rank, or role/shopIds attempted by a shop_manager); 403 self_modification_forbidden; 404 not_found; 409 last_company_admin; 409 role_not_shop_assignable; 422 validation_failed [field: shopIds, code: required - on demotion]
- **`PUT /api/admin/users/:userId/shops`** → 200 {"user":{…}}
  - Errors: 403 forbidden; 404 not_found; 409 role_not_shop_assignable; 422 validation_failed [field: shopIds[i], code: not_found]
- **`POST /api/admin/users/:userId/password-reset`** → 200 {"ok":true,"userId":"…","initialPassword":"<22 chars>"}
  - Errors: 403 forbidden (rank); 403 self_modification_forbidden; 404 not_found; 429 rate_limited (+Retry-After)
- **`GET /api/admin/shops/:shopId/terminals`** → 200 {"terminals":[…],"nextCursor":null}
  - Errors: 404 not_found (shop)
- **`POST /api/admin/shops/:shopId/terminals`** → 201 {"terminal":{…}} + Location
  - Errors: 404 not_found (shop); 409 terminal_name_taken
- **`GET /api/admin/shops/:shopId/terminals/:terminalId`** → 200 {"terminal":{…}}
  - Errors: 404 not_found
- **`PATCH /api/admin/shops/:shopId/terminals/:terminalId`** → 200 {"terminal":{…}}
  - Errors: 404 not_found; 409 terminal_name_taken (un-suspend can collide on terminals_shop_name_live_key); 422 validation_failed [field: kind, code: immutable - even when unchanged / field: status, code: not_in_enum for 'active']
- **`POST /api/admin/shops/:shopId/terminals/:terminalId/pairing-codes`** → 201 {"code":"XXXXX-XXXXX","expiresAt","terminalId","revokedPreviousCode":bool,"revokedTokenCount":n}
  - Errors: 404 not_found; 409 terminal_suspended; 429 rate_limited (+Retry-After, bucket keyed on users.id)
- **`POST /api/admin/shops/:shopId/terminals/:terminalId/revoke`** → 200 {"ok":true,"terminalId","status":"&lt;the terminal's actual status after the call&gt;","revokedTokenCount","revokedPairingCodeCount"} — `unpaired` when it was `active`, unchanged when it was `suspended`
  - Errors: 404 not_found; 422 validation_failed [field: reason, code: not_in_enum - admin_revoke or suspected_leak only; rotated/repaired/terminal_suspended are system-only]
- **`POST /api/terminal/pair`** → 200 {"token":"<22 chars>","expiresAt","terminal":{"id","kind","name"},"shop":{"id","name"}}
  - Errors: 401 pairing_failed for EVERY semantic failure including a malformed or missing code — the one declared exception to 'shape failures are 422'; 400 invalid_json only for unparseable JSON; 413; 429 rate_limited with NO Retry-After
- **`POST /api/terminal/token/rotate`** → 200 {"token":"<22 chars>","expiresAt","previousTokenExpiresAt"}
  - Errors: 401 unauthenticated (token invalid/revoked/expired, or terminal, shop or company not active); 429 rate_limited (+Retry-After, 5/hour per terminal)
- **`GET /api/terminal/me`** → 200 {"terminal":{"id","kind","name","status"},"shop":{"id","name"},"token":{"expiresAt"}}
  - Errors: 401 unauthenticated (uniform)

**Pagination, specified once.** `limit` defaults to 50 and is capped at 200;
beyond that it is `422 validation_failed` with field code `out_of_range`.
`cursor` is an opaque base64url encoding of the previous page's last
`(sortKey, id)` — keyset, not offset, so a row inserted mid-scan cannot shift a
page. An unparseable cursor is `422 validation_failed` with field code `pattern`.
Order is `created_at ASC, id ASC` for companies, platform admins and users;
`name ASC, id ASC` for shops and terminals; `label ASC, id ASC` for tables
(`'10'` sorting before `'2'` is a known gap, cut to Phase 2 alongside
`shop_tables.sort_order`). `nextCursor` is `null` on the last page. Every
collection route in the table above accepts `?limit` and `?cursor`.

**The me-document**, returned by `POST /api/admin/auth/login`,
`GET /api/admin/auth/me`, `POST /api/admin/auth/password` and
`POST /api/admin/scope`:

```json
{ "user":    { "id", "email", "displayName", "role", "companyId", "mustChangePassword" },
  "scope":   { "kind", "companyId", "shopIds", "administeredShopIds" },
  "session": { "expiresAt", "absoluteExpiresAt" } }
```

`shopIds` is always an array and never `null`, so the response exercises the
§3.3(c) materialised-scope rule end to end and a regression is visible from
outside the process. `administeredShopIds` is present only for `company_admin`
and scoped `platform_admin`. `user.companyId` is `null` for an unscoped platform
admin, and `scope.kind` is the field the Phase-2 UI branches on to show the
company selector.

**`POST /api/platform/admins` is the one named exception to "nobody creates a
peer."** It is justified because `scripts/create-platform-admin.js` is
monotonic, so a platform with one admin would otherwise have no second recovery
path. The `platform_admin` role remains immutable through the API.

*Confirmed by Plan 2b (Tasks 7 and 16), not amended.* The premise is real:
`bootstrapPlatformAdmin` takes `pg_advisory_xact_lock` and refuses when a
`platform.admin_created` row already exists, in one transaction, and the CLI does
nothing else. So the exception above stands as written and Plan 2c inherits it. This
is worth a line because an earlier draft of Plan 2b shipped a `created === null`
guard instead — current-state rather than monotonic — which would have made the CLI
runnable again after deleting the admin row and quietly removed the only stated
justification for the one peer-creating route in the system.

**`GET /health` touches no database**, so a database blip cannot mark the
container unhealthy mid-incident; it is what the Docker healthcheck calls.
`GET /health/ready` runs `SELECT 1` with a 2-second statement timeout and
compares `schema_migrations` against the on-disk file list; it is what the
deploy gate calls. `/health/ready` returns 404 through Nginx — readiness detail
is never exposed publicly. `/health` is proxied but restricted to loopback, so
the deploy's `--resolve` probe reaches it and the public internet gets 403.

### 6.3 Error model

#### 6.3.1 Body shape

```json
{ "error": { "code": "validation_failed",
             "message": "The request could not be processed.",
             "requestId": "k3f9x2ab",
             "errors": [ { "field": "timeZone", "code": "invalid_time_zone" },
                         { "field": "shopIds[1]", "code": "not_found" } ] } }
```

`errors` appears only for `validation_failed`. `requestId` is an 8-character random id also written to the request log line — it is the mechanism that makes "no internals ever reach the client" survivable in practice.

This is a **departure** from the house `{"error":"Unauthorized"}` (`apps/customer-order/server.js:262,289`; `apps/epaper-hub/server.js:94`). Justified because the Phase-2 admin UI must branch between five distinct `403`s (`origin_not_allowed`, `password_change_required`, `current_password_invalid`, `self_modification_forbidden`, plain `forbidden`), because `core-api` is a new service with no existing clients, and because it is not a repo-wide migration — `customer-order` and `epaper-hub` keep their shape.

#### 6.3.2 Code vocabulary (stable; a code is never reused for a different meaning)

| Status | Codes |
| --- | --- |
| 400 | `invalid_json`, `invalid_request` (body parsed but is not an object) |
| 401 | `unauthenticated`, `invalid_credentials` (login only), `pairing_failed` (pair only) |
| 403 | `forbidden`, `origin_not_allowed`, `password_change_required`, `self_modification_forbidden`, `current_password_invalid` |
| 404 | `not_found` — **one code, one message, for unknown route, unknown resource, and resource outside scope** |
| 405 | `method_not_allowed` (+`Allow`) |
| 409 | `company_name_taken`, `shop_name_taken`, `table_label_taken`, `terminal_name_taken`, `email_unavailable`, `last_platform_admin`, `last_company_admin`, `role_not_shop_assignable`, `terminal_suspended`, `company_suspended`, `scope_required`, `scope_selected`, `acting_company_suspended` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `validation_failed` — the only 422 code; detail lives in `errors[]` |
| 429 | `rate_limited` |
| 500 | `internal_error` |
| 503 | `service_unavailable` (+`Retry-After: 5`) |

Field codes inside `errors[]`: `required`, `type`, `too_short`, `too_long`, `pattern`, `not_in_enum`, `out_of_range`, `invalid_uuid`, `invalid_time_zone`, `ambiguous_business_day`, `unknown_field`, `not_found`, `duplicate`, `immutable`.

**Field codes never appear as the top-level `error.code`.** `ApiError`'s constructor rejects them in that position, so `{"code":"invalid_time_zone"}` is impossible: the body is always `{"code":"validation_failed", "errors":[{"field":"timeZone","code":"invalid_time_zone"}]}`. The route table in §6.2 writes them as `422 validation_failed [field: X, code: Y]` to keep the two layers visibly distinct.

**The single `not_found` code is load-bearing.** Splitting it into `shop_not_found` / `terminal_not_found` re-opens exactly the leak that choosing 404 over 403 was meant to close: a typed code confirms the route matched a real resource type at a real id. A structural test asserts the out-of-scope body is byte-identical to the unknown-path body.

**403 role denials use the generic `forbidden`.** Specific 403 codes exist only where the client must take a *different UI action*.

**409, not 403, for scope-state mismatch.** `scope_required` (unscoped platform_admin on a tenant route), `scope_selected` (scoped platform_admin on a platform route), `acting_company_suspended` (the selected company was suspended underneath them). The remedy is a state change via `POST /api/admin/scope`, not a permission change — and none of the three may be allowed to reach `dangerouslyQueryAcrossTenants` and surface as a 500.

#### 6.3.3 Baseline error sets (apply everywhere; not repeated per route row)

| Applies to | Always possible |
| --- | --- |
| Every route | 404 `not_found` (unknown path), 405 `method_not_allowed`, 429, 500, 503 |
| Every `auth:'user'` route | + 401 `unauthenticated`, 403 `password_change_required` |
| Every non-GET `auth:'user'` route, and login | + 403 `origin_not_allowed`, 415, 400 `invalid_json`, 400 `invalid_request`, 413 |
| Every `auth:'terminal'` route | + 401 `unauthenticated` |
| Every route with a path id | + 404 `not_found` (malformed id, unknown id, or id outside scope — one indistinguishable outcome) |
| Every route with `body`/`query` | + 422 `validation_failed` |
| Every tenant route, platform_admin caller | + 409 `scope_required`, 409 `acting_company_suspended` |
| Every `/api/platform/*` route | + 409 `scope_selected` |

#### 6.3.4 Condition → status, exhaustively

| Condition | Status / code |
| --- | --- |
| Unparseable JSON body | 400 `invalid_json` |
| Body parses but is not an object | 400 `invalid_request` |
| Body exceeds 64 KiB | 413 `payload_too_large` |
| Missing/wrong `Content-Type` on a cookie-auth non-GET, or on login | 415 |
| Missing/mismatched `Origin` on a cookie-auth non-GET, or on login | 403 `origin_not_allowed` |
| Path matches no registered pattern | 404 `not_found` |
| Path matches, method not registered | 405 + `Allow` |
| No session cookie, unresolvable, or **more than one** `__Host-core_session` | 401 `unauthenticated` (+ clearing `Set-Cookie` only when one was presented) |
| Session cookie offered in `Authorization`; terminal token offered in a cookie or query string | credential treated as absent → 401 |
| Terminal token invalid/revoked/expired, or terminal, shop or company not active | 401 (uniform) |
| Login: unknown email, wrong password, locked, suspended user, suspended company | 401 `invalid_credentials` (uniform, fixed budget, no `Retry-After`) |
| Pair: any semantic failure, including a malformed `code` | 401 `pairing_failed` (uniform) |
| `must_change_password` true on a non-exempt route | 403 `password_change_required` |
| Caller's role not in the route's `roles`, or rank not strictly below target before **and** after | 403 `forbidden` |
| Self-targeting `role`/`status`/`shopIds` | 403 `self_modification_forbidden` |
| Path resource malformed, nonexistent, or outside scope | 404 `not_found` |
| Observable unique-index collision | 409 `<thing>_taken` / `email_unavailable` |
| Invariant refusal (last admin, immutable kind, non-assignable role, suspended terminal) | 409 per §6.3.2 |
| Field-level shape or semantic failure | 422 `validation_failed` |
| Bucket exhausted | 429 (+`Retry-After` except on login and pair) |
| Anything uncaught | 500 `internal_error` |
| Readiness failing, pool timeout, SQLSTATE 53300, SIGTERM drain | 503 (+`Retry-After: 5`) |

#### 6.3.5 Validation ordering — the ordering IS the security property

```
1.  requestId, security headers, Cache-Control: no-store
2.  route lookup                → 404 (unknown path) / 405 (+Allow)      [credential-independent]
3.  declared auth-mode lookup                                            [boot-validated; never a runtime 500]
4a. CREDENTIAL-INDEPENDENT rate buckets → 429                            [before any scrypt is queued]
5.  credential resolution + channel binding, READ-ONLY → 401
5b. PRINCIPAL-KEYED rate buckets (users.id / terminal id) → 429
6.  must_change_password gate   → 403
7.  Origin + Content-Type gates → 403 / 415         [cookie-auth non-GET, and login]
8.  body read (413) + JSON parse (400)
9.  path-parameter syntax       → 404 (NEVER 422)
10. AUTHORIZATION: route roles → 403; then each path resource resolved in path order
    (shop → terminal | table) via tenantQuery → 404 on zero rows
11. body/query validation       → 422, all errors reported at once
12. cross-field/referential validation (each shopIds[i] is an active shop in scope)
    inside the mutation transaction → 422 with field code not_found
13. mutation + audit row, one transaction, inside withTenantScope
14. session sliding renewal (at most once/60s) — ONLY here
15. response
```

*Amended by Plan 2b: step 10 is two halves and they land in different plans.* The
**static route-roles** half is shipped and runs at **step 7.5**, reading
`lib/authorization.js` — declared aliases against the caller's materialised scope,
403 on refusal. The **per-resource** half (each path resource resolved in path order
via `tenantQuery` → 404) waits for the routes that have path resources, which is Plan
2c. Plan 2b registers none, so there is nothing for it to resolve. A gap follows from
that split and is recorded in identity-slice §11.11 rather than here: §6.3.3's **409
`scope_required`** has no producer anywhere in the service, and Plan 2c's roughly
twenty tenant routes at `anyUser` are its first consumers.

**Steps 9 and 10 must precede step 11.** If body validation ran first, `POST /api/admin/shops/<another tenant's shop>/tables` with a bad `label` returns 422 while the same request with a good `label` returns 404 — the attacker controls the body, so the validator becomes a free existence oracle for every shop id on the platform. The 404 is produced by the *absence of a row from a scoped query* (`tenantQuery` binds `company_id = $1` and, when `shopScoped`, `shop_id = ANY($2)` itself), so "exists but not yours" and "does not exist" are literally the same zero-row result at the driver level and cannot regress by someone forgetting a comparison.

**Path-parameter syntax failures return 404, not 422.** A segment that cannot be a uuid cannot name a resource. One crisp testable line: **422 never describes a path segment.**

**Step 4a is split from 5b, and the split is not cosmetic.** Five of the seven limiters in the §5.7 table (`create-user`, `password-reset`, `pairing-code-mint`, `password-change-abuse`, `token-rotate`) are keyed on a principal that does not exist until step 5. Writing them at step 4 forces the implementer to key on the raw presented credential string — attacker-controlled — so every probe lands in a fresh empty bucket and the limit never fires, while the unbounded set of one-hit buckets becomes an unauthenticated memory-growth vector. Boot assertion: a route declaring `limit.key ∈ {user, terminal}` must declare `auth !== 'public'`. Stated invariant: **no bucket may ever be keyed on an unresolved credential value, and no bucket may ever be keyed on a server-side fact about another principal** (which is what keeps `Retry-After` free of disclosure).

**Principal buckets are keyed on `users.id`, not on the session.** A session-keyed bucket resets on demand — the caller holds valid credentials, `POST /api/admin/auth/login` is `public` so a presented cookie is ignored, and there is no cap on concurrent sessions per user, so the stated "20 probes per 10 minutes" ceiling is off by whatever the login rate allows (~9,000 per 15 minutes). Keyed on `users.id` the number is real within a process lifetime.

**Step 14 is after everything.** Resolution at step 5 is read-only; the `UPDATE user_sessions SET expires_at = LEAST(now() + <idle>, absolute_expires_at), last_seen_at = now(), last_seen_ip = <derived ip>` runs only on a request that reached step 13/14. A successful bearer resolution writes the terminal side of the same thing at the same point — `terminal_tokens.last_seen_at`/`last_seen_ip` and `terminals.last_seen_at` — under the same once-per-60-seconds throttle. Successful pairing sets `terminals.paired_at` alongside `status='active'` (§5.5 step 3). Those five columns have no other writer. Invariant: **a rejected request never extends a session.** Without this, a script on a same-site sibling (`order.yeyintlwin.com`, which already needed XSS hardening — commit da5ed83) can `fetch(..., {credentials:'include'})` every five minutes, collect `403 origin_not_allowed` each time, and hold an unattended till session alive to the 7-day absolute cap instead of letting it die at the 8-hour idle horizon.

#### 6.3.6 Leak prevention — four mechanisms, not a promise

1. **Handlers never build an error response from a caught exception.** They `throw new ApiError(status, code, errors?)`, whose constructor accepts only values from the fixed vocabulary. Anything else reaching the top-level handler becomes 500 `internal_error`.
2. **`sendError()` serialises only `{code, message, requestId, errors?}`, and `message` is looked up from a static table keyed by `code`.** Never derived from `Error.message`, never interpolated with user input or driver output. There is no code path that copies a string from `pg` into a response.
3. **`pg` errors are mapped by SQLSTATE, with constraint names used only as an internal lookup key.** `57014`/`53300` → 503; `23505`/`23503`/`23514` → the code the call site declared (`tenantQuery(scope, { sql, shopScoped, conflicts: { shops_company_name_active_key: 'shop_name_taken' } }, params)`). Unmapped constraint → 500. `err.constraint` is read to pick a code and is **never serialised**, keeping `_key`/`_fkey`/`_check` strings out of every response and decoupling the API vocabulary from DDL.
4. **Two tests.** (a) Every error body produced anywhere in the suite is scanned against `/(SELECT|INSERT|UPDATE|DELETE|FROM |WHERE |pg_|_key\b|_fkey\b|_check\b|at Object\.|node:internal|\/app\/|scrypt\$|unreachable|checksum_mismatch)/i` and any hit fails. (b) A unit test asserts `sendError` drops every property outside the four-key allowlist, so a future `ApiError` carrying a `cause` cannot leak it.

**`GET /health/ready` is inside the leak rule, not outside it.** Its public 503 body is the ordinary opaque envelope. The closed-vocabulary `checks` (`ready|unreachable|timeout`, `current|pending|checksum_mismatch`) go to the request log against the same `requestId`. That vocabulary is a precise "the database is down and a migration is mid-flight" signal, and it would otherwise be protected only by one line in an Nginx file that startup validation cannot see and no test can observe.

**Logging.** One structured line per request: method, **route pattern** (never the raw path, never the query string), status, duration, `requestId`, actor kind and id. Never a body, never headers, never `Set-Cookie`. This is an explicit rejection of `morgan("combined")` at `apps/epaper-hub/server.js:32`, which writes the full URL — including the `?api_key=` that `:89` accepts — into the access log. Correspondingly, `log_statement` must stay off on `core-db`.

#### 6.3.7 Two deliberate corrections to settled text, stated so nobody re-derives them

**(a) `POST /api/admin/auth/password` must not write `users.failed_login_count` or `users.locked_until`.** Those columns belong to the unauthenticated login credential. Throttling the authenticated route on them lets a stolen session drive the legitimate owner's *login* lockout — three 403s, then `locked_until` climbing to the 15-minute cap, one request every 14 minutes holds it forever, and the victim reads their own uniform `401 invalid_credentials` as a typo while the attacker's session slides its idle window on every request. Instead: an own per-`users.id` bucket, and on the Nth consecutive `current_password_invalid` **delete the presenting session** and write `user.password_change_abuse` — punishing the credential actually being abused and converting a permanent DoS into a self-limiting one. `403 current_password_invalid` (not 401) stands: the session credential *is* valid, and a client's global "401 → drop session and redirect" handler would otherwise let a stolen session grief the real user out of theirs.

**(b) Create-user returns `409 email_unavailable`, not the settled "identical response whether or not the email collides."** The uniform response is unimplementable: the caller issues `GET /api/admin/users?email=…` immediately afterwards and sees whether the row exists, so a fabricated 201 closes the oracle for exactly zero requests while handing an administrator credentials that will never work. The gap is closed with mechanism instead: a non-confirming message ("That email address is not available."), a per-`users.id` bucket of 20 create/reset calls per 10 minutes, and an audit row with `outcome='failure'` carrying the probed address (permitted — `audit_events_detail_no_credentials` forbids credential-named keys, not email addresses). The residual is recorded in §11.2. For `POST /api/platform/admins` the 409 is not an oracle at all: platform admins have global visibility by construction.

### 6.4 Validation ordering

The ordering *is* the security property. See the numbered pipeline in §6.3.
The two clauses most easily lost:

- **Path resolution precedes body validation.** If body validation ran first,
  `POST /api/admin/shops/<another tenant's shop>/tables` with a bad `label`
  would return 422 while the same request with a good `label` returns 404 — and
  since the attacker controls the body, the validator becomes a free existence
  oracle for every shop id on the platform.
- **Credential-independent rate buckets precede credential resolution;
  principal-keyed buckets follow it.** Five of the seven limiters in §5.7 are keyed on a
  principal that does not exist until resolution. Placing them earlier forces
  keying on the raw presented credential — attacker-controlled — so every probe
  lands in a fresh empty bucket, the limit never fires, and the unbounded set of
  one-hit buckets becomes an unauthenticated memory-growth vector.

### 6.5 CORS for terminal subdomains

Decision 12 puts the kitchen-display and cashier-counter apps on their own
subdomains in Phases 4–5. That makes `http/terminal-cors.js` load-bearing
rather than dead code, and it introduces the one rule that must never be
relaxed:

- The responder applies to **`/api/terminal/*` only**. Never to
  `/api/admin/*`, never to `/api/platform/*`.
- Origins come from `TERMINAL_ALLOWED_ORIGINS`, an exact-origin allowlist. No
  wildcards, no suffix matching.
- **It never emits `Access-Control-Allow-Credentials`.** Cookie-authenticated
  routes therefore stay uncallable cross-origin regardless of what the
  allowlist contains. Terminal routes authenticate by bearer token, which the
  browser attaches explicitly, so they do not need it.

In Phase 1 `TERMINAL_ALLOWED_ORIGINS` is empty, which means no CORS headers are
emitted at all — the responder is shipped and inert. Phase 4 populates it and
adds the `kitchen.` server block; Phase 5 adds `counter.`. Writing the decision
down now matters because the alternative failure is silent: a Phase-4 developer
who cannot make the admin UI work cross-origin reaches for
`Access-Control-Allow-Credentials`, and every staff session enters the blast
radius of a subdomain that renders admin-authored content.

## 7. File layout

```
apps/core-api/
  package.json                  scripts start/test/pretest/migrate/db:reset; single dependency "pg"; engines node>=20
  package-lock.json             committed, like both existing apps
  Dockerfile                    node:20-alpine, built from the REPO ROOT, ENV PORT=3200, CMD node apps/core-api/server.js
  README.md                     local Postgres setup, env contract, bootstrap CLI, test commands
  .env.example                  every required variable; no default value for any credential
  server.js                     process entry: loadDotEnv, config, migrate, DB retry, listen; exports { createApp, start }
  config.js                     PURE. Parses+validates an env object into a frozen config; throws named errors

  db/
    pool.js                     the ONLY file that requires "pg"; builds runtime + migration pools; never exports a Pool
    index.js                    the choke point: withTenantScope, tenantQuery, withUnscopedConnection
    scope.js                    PURE. createScope, assertTenantScope, module-private Symbol, Object.freeze
    migrate.js                  ordered runner; takes the migrations DIRECTORY as a parameter (so tests never mutate ./migrations)
    health.js                   SELECT 1 readiness probe + the bounded 10x1s startup retry
    errors.js                   PURE. ApiError + the fixed code vocabulary + pgErrorToHttp(sqlstate)

  migrations/
    0001_init.sql               the settled Phase-1 DDL, verbatim

  lib/                          ALL PURE: no database, no filesystem, no network, injected clock
    password.js                 scrypt hash/verify, PHC encode/parse, maxmem 64MB, timingSafeEqual, policy
    tokens.js                   randomBytes(16) -> 22 Base64URL; sha256 -> Buffer(32)
    pairing-code.js             Crockford base32 mint, fold(), XXXXX-XXXXX grouping, sha256
    time.js                     session TTL clamping (LEAST), 60s renewal throttle, IANA zone + 400-day rollover proof
    client-ip.js                X-Forwarded-For parsed from the RIGHT by TRUSTED_PROXY_HOPS; normalises ::ffff: and ports
    rate-limit.js               credential-independent buckets + principal-keyed buckets; injected clock
    semaphore.js                the 2-slot scrypt concurrency gate
    authorization.js            role lattice, shop containment, self-mutation refusal, last-admin refusal
    audit.js                    builds the audit_events row: flattens detail, drops credential-named keys, caps lengths
    validate.js                 ~80-line validate(input, spec); uuid/email/label-fold/enum/array-of-uuid; reject, never coerce

  http/
    router.js                   the ONLY file that requires express; route(m,p,{auth,roles,params,query,body,audit,limit},h);
                                listRoutes(); boot-time table validation; JSON 404/405/error tail
    respond.js                  PURE. sendJson/sendError; Cache-Control: no-store and the security headers on EVERY response
    authenticate.js             resolves cookie OR bearer into a scope, READ-ONLY; strict channel binding
    cookies.js                  PURE. collect ALL values for a name (reject duplicates); build the __Host- Set-Cookie
    csrf.js                     PURE. Origin + Content-Type rule, applied only to cookie-auth routes and login
    terminal-cors.js            PURE. narrow OPTIONS responder for /api/terminal/* only, exact-origin allowlist from
                                TERMINAL_ALLOWED_ORIGINS (default empty = no CORS headers at all); never emits
                                Access-Control-Allow-Credentials, so cookie routes stay uncallable cross-origin
    routes/
      health.js                 GET /health, GET /health/ready
      auth.js                   login, logout, logout-all, me, password, POST /api/admin/scope
      platform-companies.js     /api/platform/companies*
      platform-admins.js        /api/platform/admins*
      shops.js                  /api/admin/shops, /api/admin/shops/:shopId
      shop-tables.js            /api/admin/shops/:shopId/tables*
      users.js                  /api/admin/users*
      terminals.js              /api/admin/shops/:shopId/terminals*  (nested, incl. pairing-codes and revoke)
      terminal-self.js          POST /api/terminal/pair, /api/terminal/token/rotate, GET /api/terminal/me

  repositories/
    auth/                       PRE-TENANT: reached before a scope exists; every export declares PRE_TENANT_REASON
      users.js                  login lookup + the atomic failed_login_count bump as the transaction's first statement
      sessions.js               create / resolve (read-only) / renew (clamped) / delete
      terminal-tokens.js        resolve a bearer joined terminal -> shop -> company, all three status='active'
      pairing.js                the single-use redemption UPDATE
      audit.js                  PRE-TENANT audit writer for failures that occur before a scope exists
                                (failed login, failed pairing): actor_kind IN ('anonymous','system'),
                                company_id/shop_id may be NULL, writes through withUnscopedConnection,
                                declares PRE_TENANT_REASON like its siblings. Takes NO scope, so Mode 6
                                does not apply to it
      scope-materialize.js      shopIds via COALESCE(array_agg(...), '{}') JOIN shops WHERE status='active';
                                administeredShopIds (status-independent) for companyAdmin only
    shops.js                    tenant-scoped shop repository (exports ARGUMENT_ROLES)
    shop-tables.js              tenant-scoped dining-table repository
    terminals.js                tenant-scoped terminal repository
    users.js                    tenant-scoped user repository (containment is an EXISTS semi-join)
    audit.js                    TENANT-scoped append-only writer only; fully swept by the isolation suite
    platform/
      query.js                  dangerouslyQueryAcrossTenants(scope, sql, params); asserts stamped scope, kind==='platform'
      companies.js              listCompanies, getCompany, createCompany, updateCompany
      admins.js                 listPlatformAdmins, getPlatformAdmin, createPlatformAdmin
                                (last-active-admin refusal), updatePlatformAdmin,
                                resetPlatformAdminPassword
      audit.js                  the PLATFORM audit writer, split out of repositories/audit.js so the tenant writer can
                                satisfy Mode 6 (must throw on a platform scope) and Mode 2 (company_id must equal A)

  scripts/
    create-platform-admin.js    SHIPPED, Plan 2b. CLI bootstrap: stdin echo-off, refuses without a TTY,
                                advisory lock, monotonic audit guard
    unlock-account.js           PLAN 2d. clears locked_until / failed_login_count, writes an audit row
    set-password.js             PLAN 2d. operator password reset; bumps sessions_valid_from
    sweep-expired.js            PLAN 2d. deletes expired sessions and UNCONSUMED dead codes (consumed_at IS NULL AND
                                (expires_at < now() OR revoked_at IS NOT NULL)); a CONSUMED code is retained for the
                                life of the token that references it — terminal_tokens.pairing_code_id is ON DELETE
                                RESTRICT, so deleting it would raise 23503; trims audit_events beyond AUDIT_RETENTION_DAYS
    setup-template-db.js        npm `pretest`: builds core_api_test_template; NO-OP + exit 0 when the URL is unset
    reset-database.js           npm `db:reset`; three independent guards; the sanctioned answer to a local checksum surprise

  testing/                      NOT under test/ -- node --test would spawn every .js here as its own test process
    database.js                 cloneTemplate(__filename) / createEmptyDatabase / unscoped / resetFixtures
    http.js                     app.listen(0) + fetch driver + EXPLICIT cookie jar + Headers.getSetCookie()
    fixtures/two-tenant.js      the A / A1 / A2 / A3-suspended / B / B1 / C-suspended seed, deterministic UUIDs

  test/                         contains ONLY *.test.js (asserted by source-structure.test.js)
    schema-invariants.test.js   S1-S7
    source-structure.test.js    C1-C13
    route-auth.test.js          the declared-auth contract (no database)
    tenant-isolation.test.js    the eight-mode two-tenant sweep + the route-level probe
    migrate.test.js             runner behaviour, all scenarios built in os.tmpdir()
    auth-login.test.js          fixed time budget, atomic backoff, byte-identical 401, no Retry-After
    auth-session.test.js        __Host- cookie shape, duplicate-cookie 401, clamped renewal, renewal-after-gates
    auth-password.test.js       403 current_password_invalid; N failures leave locked_until NULL; session deleted on abuse
    terminal-pairing.test.js    mint revokes live token+code, concurrent double-redeem, rotate overlap, opaque failures
    authorization.test.js       pure: role lattice, shop containment, self-mutation, last-admin
    password.test.js            pure: scrypt maxmem trap, PHC round-trip, param upgrade + rehash,
                                policy bounds (11 / 12 / 256 / 257 chars), NFKC normalisation
    tokens.test.js              pure: 22-char Base64URL, sha256 is a 32-byte Buffer (NOT hex)
    client-ip.test.js           pure: forged leftmost XFF creates no new bucket
    rate-limit.test.js          pure: principal keys; re-login does not reset the create-user bucket;
                                every limiter named in §5.7 exists and no others
    semaphore.test.js           in-process: SCRYPT_SLOTS honoured, queue depth sheds 503, release on throw
    cookies.test.js             pure: all-values collection, duplicate rejection, __Host- attribute string
    time.test.js                pure: LEAST clamping, DST spring-forward / fall-back resolution
    scope.test.js               pure: empty shopIds is [], frozen, Symbol-stamped, unstamped rejected
    audit-redaction.test.js     pure + one DB case proving the flat-object + credential-key CHECKs bite
    config.test.js              pure: startup validation refuses to listen on each bad input
    bootstrap-cli.test.js       double-run inserts once; guard survives deleting the platform_admin row
    scripts.test.js             unlock-account clears locked_until + failed_login_count and audits; set-password
                                writes a valid PHC hash, bumps sessions_valid_from and kills live sessions;
                                reset-database refuses on each of its three guards independently; sweep-expired
                                deletes only dead rows and leaves a consumed code alone
    db-index.test.js            tenantQuery descriptor assertions: throws when company_id appears in an INSERT
                                column list or an UPDATE SET list; throws when the SQL omits the predicate the
                                descriptor declares
    deploy-config.test.js       compose at root, core-net, nginx install+rollback, concurrency, pg_dump -T
    ci-contract.test.js         workflow declares the postgres service and never sets the skip flag
```

Repo-level files this phase touches: `docker-compose.yml` (moved to the root), `.github/workflows/deploy.yml`, `apps/epaper-hub/test/deploy-config.test.js` (lines 18, 32, 204), `apps/epaper-hub/docker-compose.yml` `build: .` → explicit context/dockerfile, root `package.json` `scripts.test`, new `/.gitattributes`, new `/.dockerignore` line `apps/*/.env`, new `infra/nginx/api.conf` + `infra/nginx/core-api-proxy.conf` + `infra/backup-core-db.sh`.

## 8. Test strategy

### 8.1 Database strategy — one database per test FILE, cloned from a template

`node --test` runs files in **separate child processes, concurrently**, and tests within a file serially. Per-file is therefore the exact granularity that matches the runner: a private database per process makes advisory locks, `FOR UPDATE` row locks, identity counters and fixed fixture UUIDs non-colliding.

- Name: `core_api_t_<first 12 hex of sha256(path relative to apps/core-api)>` — 23 chars, deterministic, so a failure names a database you can `psql` into and a re-run reclaims rather than accumulates.
- `cloneTemplate(__filename)` takes a session advisory lock on the maintenance DB across **check + rebuild + clone** (not just the rebuild), because `CREATE DATABASE … TEMPLATE t` fails with *"source database is being accessed by other users"* if any backend is connected to `t`. ~150 ms × 8 DB files ≈ 1.2 s total. Deterministic beats fast.
- Staleness check compares the template's `schema_migrations` against the SHA-256 of every file in `migrations/` and rebuilds if they differ. `pretest` is an **optimization**; the self-healing check is the correctness guarantee, because `apps/customer-order/package.json` trains developers to type `node --test` directly, and Node 20 (the CI pin and the base image) has no `--test-global-setup`.
- **The template is built by invoking the production runner `db/migrate.js`**, never `psql -f` and never a `schema.sql` dump. `0001_init.sql` contains a dollar-quoted `CREATE FUNCTION` and a dollar-quoted `DO` block, and its header states the runner must never split on semicolons — a shortcut in the test path means the one rule most likely to be violated is the one rule never exercised. Every `npm test` is therefore also a migration-runner test.

**Rejected:** transaction-per-test — `withTenantScope()` *itself* does `BEGIN`/`SET LOCAL`/`COMMIT`, so wrapping it forces production code to emit `SAVEPOINT` under a test flag, dissolving the single-seam property; and one transaction cannot test two racing transactions, which is what the double-redemption guard, the pairing-mint `FOR UPDATE` and the bootstrap `pg_advisory_xact_lock` are *about*. **Rejected:** schema-per-file — `0001` hardcodes `GRANT … IN SCHEMA public` and declares `set_updated_at()` unqualified, so a non-`public` `search_path` grants against the wrong schema; and advisory locks are database-wide, so the migrate and bootstrap suites would block each other invisibly.

**Helpers live in `apps/core-api/testing/`, not `test/`.** `node --test`'s default pattern is `**/{test,test/**/*,test-*,*[._-]test}.{js,…}` — every `.js` under a directory named `test` is spawned as its own test process. A `test/helpers/setup-template-db.js` would run concurrently with the real suites and DROP the template out from under a sibling's `CREATE DATABASE … TEMPLATE`. `source-structure.test.js` asserts `fs.readdirSync('test')` contains only `*.test.js`, so this cannot regress.

**Skipping is possible locally and structurally impossible in CI.** `cloneTemplate()` **throws** (never skips) when `CORE_API_TEST_DATABASE_URL` is unset, with the variable name, an example value and the Windows/CI setup lines in the message. One deliberate hatch, `CORE_API_SKIP_DB_TESTS=1`, produces *visible* TAP skips — and makes `pretest` a no-op exit 0, so the ~12 database-free suites still run. `ci-contract.test.js` (no database) asserts against `.github/workflows/deploy.yml` text that it declares a `postgres:16-alpine` service, sets `CORE_API_TEST_DATABASE_URL`, runs `npm --prefix apps/core-api test`, and **never** sets the skip flag. Same technique as `apps/epaper-hub/test/deploy-config.test.js:181-216`.

**Within a file**, mutating tests re-seed via one statement naming all ten non-infrastructure tables with **no `CASCADE`**:
`TRUNCATE audit_events, terminal_tokens, terminal_pairing_codes, terminals, user_sessions, user_shops, shop_tables, shops, users, companies RESTART IDENTITY`.
Omitting `CASCADE` is the point: when Phase 2 adds `menu_items`, this fails loudly instead of leaving a table silently un-reset.

**Driving HTTP:** the real Express app on `app.listen(0)` driven by global `fetch`, **a departure from `server.inject()` at `apps/customer-order/server.js:350`**. That helper exists because customer-order is raw `node:http`; its fake `res` (`:364-379`) stores headers in a plain object, so **two `Set-Cookie` values of the same name cannot even be represented** — and the settled cookie rule is that the parser collects *all* values and returns 401 on more than one. A transport that cannot express the bug cannot test the fix. `Headers.getSetCookie()` is available in Node 20. No automatic cookie jar: half these tests send duplicated or malformed cookies on purpose. `__Host-` semantics are browser-enforced, so the tests assert the emitted header *string*, the same technique as `apps/customer-order/test/server.test.js:72`.

### 8.2 Fixtures — `testing/fixtures/two-tenant.js`

Hardcoded mnemonic UUIDs, never random, so a failure prints `expected aaaa…-0002, got bbbb…-0001`.

| Entity | Notes |
| --- | --- |
| Company A / Company B | both `active` |
| **Company C** | **`suspended`**, with an active `company_admin`, a live session row and a live terminal token |
| Shop A1, A2 | `active`; A2 also holds a `cashier_counter` terminal (the cross-shop escalation target) |
| **Shop A3** | **`suspended`**, with a `user_shops` row for A-manager, a live terminal and a live token |
| Shop B1 | `active` |
| P-admin | `platform_admin`, `company_id NULL`; **two session rows** — one with `acting_company_id NULL`, one with `acting_company_id = A` |
| A-admin | `company_admin` |
| A-manager | `shop_manager`, assigned **A1 and A3 only** |
| A-staff | `staff`, assigned A1 **and A2** (so the duplicate-row semi-join case is covered) |
| **A-unassigned** | `staff`, **zero `user_shops` rows** |
| B-admin | `company_admin` |
| Tables | one per shop, all labelled `'1'`, proving `shop_tables_shop_label_active_key` is per-shop |
| Terminals | `kitchen_display` in A1/A2/B1 + `cashier_counter` in A2 + **one `suspended` terminal in A1 holding a live token** |
| Tokens | one live token per terminal + **one `revoked` token** (`revoked_reason='admin_revoke'`) on A1's kitchen terminal |
| Pairing code | one live code on A2's cashier terminal |

The suspended rows are not decoration. The settled design names *"suspension revokes nothing"* as the most-repeated defect across all drafts. Without a suspended shop, a `scope-materialize.js` written without `JOIN shops … AND s.status='active'` passes Modes 1, 3 and 4 and ships — and in production A2's manager keeps minting pairing codes against A2's cashier terminal while the operator believes containment worked. Without a suspended terminal/shop/company, a bearer resolver written as a bare `token_hash` probe passes everything.

Seeding order is forced by the FK cycle: companies with `created_by_user_id` NULL → P-admin (`company_id` NULL) → tenant users with `created_by_user_id = P-admin` → `UPDATE companies SET created_by_user_id`. `terminals.created_by_user_id` and `terminal_pairing_codes.created_by_user_id` are `NOT NULL`, so the fixture must supply them. Password hashes are computed **once** at module load (scrypt at N=32768 is ~100 ms; seven users × per-test re-seed would dominate). The fixture writes via `db.unscoped(...)`, deliberately bypassing repositories, because no legitimate scope can create rows in two tenants — which is why `testing/**` sits outside the `withUnscopedConnection` allowlist walker.

### 8.3 Suite 1 — `test/schema-invariants.test.js`

**S1 — tenant column.** Every base table not in the exception list has `company_id uuid NOT NULL`. The exception list is **five** entries, not the two the settled text names (that list is unachievable as written), and **each carries its own positive assertion** so it is a stated shape rather than a hole:

| Table | Positive assertion instead |
| --- | --- |
| `schema_migrations` | has no `company_id` column at all |
| `companies` | `id` is `uuid` and the PK |
| `users` | `company_id` is `uuid` and **nullable**, AND `users_platform_admin_has_no_company` exists in `pg_constraint` |
| `user_sessions` | `acting_company_id` is `uuid` and nullable |
| `audit_events` | `company_id` is `uuid` and nullable, AND `audit_events_shop_implies_company` exists |

A Phase-2 table omitting `company_id` fails unless a developer consciously edits this list.

**S2 — composite ownership FKs.** One `pg_constraint` query returns every FK with ordered child/parent column arrays and `confdeltype`. Rule: if the child column list contains any containment column (`shop_id`, `terminal_id`, `shop_table_id`, `user_id`, `pairing_code_id`), it must also contain `company_id`. Named exceptions, each with a reason string in the test source: the ten attribution FKs (`created_by_user_id` ×7, `revoked_by_user_id`, `actor_user_id`, `actor_terminal_id` — the last references a tenant table single-column and needs saying out loud); `user_sessions.user_id` and `user_sessions.acting_company_id` (pre-tenant: read to *discover* the tenant); `terminal_tokens.pairing_code_id` (the row is already anchored by its own composite FK; making it composite would need a 4-column UNIQUE `0001` does not create).

**S2b — delete actions.** `confdeltype` is never `'n'` (SET NULL) or `'d'`. `'c'` (CASCADE) only for exactly three: `user_shops.(user_id, company_id)`, `user_sessions.user_id`, `user_sessions.acting_company_id`. Everything else `'r'`.

**S3 — the anchors by name**, with exact column lists: `users_id_company_key(id, company_id)`, `shops_id_company_key(id, company_id)`, `shop_tables_id_shop_company_key(id, shop_id, company_id)`, `terminals_id_shop_company_key(id, shop_id, company_id)`. Postgres already refuses a composite FK without a matching UNIQUE, so the assertion with teeth is the reverse one: a later migration dropping an anchor once its last composite FK is gone leaves the next table quietly unable to declare one.

**S4 — credential digests.** Every `%_hash` column **except `users.password_hash`** is `bytea` with a CHECK whose `pg_get_constraintdef()` contains `octet_length(<col>) = 32`. The one exception carries its own positive assertion, in the same style as S1: `users.password_hash` is `text` and a CHECK on it contains `LIKE 'scrypt$%'` — it stores a PHC-style string by design (§5.1), not a digest. The exception list is a one-entry literal, so a Phase-2 `%_hash` column added as text fails unless a developer consciously edits it.

**S5 — `updated_at` triggers.** Every table with an `updated_at` column has a non-internal `BEFORE UPDATE … EXECUTE FUNCTION set_updated_at()`. Conditional on the column, so it self-maintains.

**S6 — ledger agreement.** `schema_migrations` equals, as a set, `{filename, sha256(normalised bytes)}` for every file on disk.

**S7 — no plaintext-shaped credential columns** named exactly `password`, `token`, `code`, `secret`, `session_id`.

**Deliberately not asserted:** the `core_api_owner`/`core_api_app` grants. The `DO $$` block in `0001` is guarded on `pg_roles` precisely so a single-role local database applies the file unchanged; asserting grants would fail on every dev machine or assert nothing.

### 8.4 Suite 2 — `test/source-structure.test.js`

Pure `fs` + regex, no parser, no dependency — the shape `apps/epaper-hub/test/monorepo-structure.test.js` already hand-rolls.

**Two correctness requirements that silently void this suite if missed.** (1) The walker normalises `path.sep` to `/` before matching any allowlist path — on Windows `startsWith("repositories/")` matches nothing, every rule passes vacuously, and the suite is green and worthless. (2) The suite asserts it scanned a plausible count (`files.length >= 25`) and that a known sentinel (`db/index.js`) is in the scanned set.

**Comments are stripped before matching** (`--` to EOL for `.sql`; `//` and `/* */` for `.js`), with a per-rule self-test: one fixture string that must match, one comment-only string that must not. Without this, documenting a rule violates it — a header comment in `http/authenticate.js` explaining *why* `req.query.api_key` is rejected would turn C7 red, and both available repairs (delete the documentation, or weaken the regex) lose. The house style is to write the rejected pattern down next to the code; `0001_init.sql` is roughly 40% comment.

- **C1** — files matching `require("pg")` is **exactly** `["db/pool.js"]` (`deepEqual` on a sorted array, not a subset).
- **C2** — no `\b(?:pool|client)\.query\s*\(` outside `db/`.
- **C3** — files matching `require("express")` is exactly `["http/router.js"]`; no `app.(get|post|put|patch|delete|use)(` or `express.Router` elsewhere. One way to register a route means one place auth can be forgotten — the static half of the fix for the `app.use('/api/terminal', mw)` boundary-matching hole.
- **C4** — the `withUnscopedConnection(` caller set equals a hardcoded 9-entry list under `db/` and `repositories/auth/` (the ninth is `repositories/auth/audit.js`, the pre-tenant audit writer).
- **C5** — `dangerouslyQueryAcrossTenants` appears only under `repositories/platform/`. The needle is built by concatenation so the scanner cannot match itself and report a false pass.
- **C6 — exempt-zone budgets.** `repositories/platform/` exports exactly **10** tenant-crossing functions in Phase 1, asserted by `deepEqual` on the sorted name list (`appendPlatformAuditEvent`, `createCompany`, `createPlatformAdmin`, `getCompany`, `getPlatformAdmin`, `listCompanies`, `listPlatformAdmins`, `resetPlatformAdminPassword`, `updateCompany`, `updatePlatformAdmin`) — one per `/api/platform/*` route in §6.2, plus the audit writer; `repositories/auth/` exports exactly N (fixed when the module list is written) and **every export declares a non-empty `PRE_TENANT_REASON`**. Adding an eleventh platform function requires editing a name list in a test — a diff a reviewer cannot miss. This is the only mechanism that stops an exempt zone expanding silently.
- **C7** — no `require("morgan")`, no `x-api-key`, no `req.query.api_key`, no `req.query` access whose key matches `/token|key|code|secret|password|session/i`.
- **C8** — no `process.env.[A-Z_]*(KEY|SECRET|PASSWORD|TOKEN|URL)[A-Z_]*\s*(\|\||\?\?)\s*["'\`]` (string-literal fallback). `options.x ?? process.env.X` is fine.
- **C9** — nothing under `lib/` requires `node:fs`, `node:http(s)`, `node:net`, `pg`, or `../db`.
- **C10** — migration filenames match `^\d{4}_[a-z0-9_]+\.sql$`, numbers contiguous from `0001`, no duplicates, no `DROP TABLE`/`DROP COLUMN`/`SET NOT NULL` without a `DEFAULT`, no `-- migrate: no-transaction`.
- **C11** — root `package.json` `scripts.test` contains `apps/core-api`.
- **C12** — `/.gitattributes` exists and contains `*.sql text eol=lf`; `.dockerignore` contains `apps/*/.env`.
- **C13** — `fs.readdirSync('test')` contains only `*.test.js`; no test file writes into `migrations/`.

### 8.5 Suite 3 — `test/route-auth.test.js` (no database)

`http/router.js` exports `listRoutes()`. `route()` **throws at registration time** if `options.auth` is absent or not one of the three. There is no default anywhere — that is what "deny by default and declared" means mechanically.

1. Every entry's `auth` is one of `user|terminal|public`.
2. `new Set(publicEntries)` **deep-equals** the public set of §6.1 as it stands in the current plan — `{"GET /health","GET /health/ready","POST /api/admin/auth/login"}` after Plan 2b, eight after Plan 2d, nine once the terminal plan registers `POST /api/terminal/pair`. Equality, not containment: adding an entry fails, and so does removing one, and the literal is widened in the same commit as the route. *Amended by Plan 2b (Task 14): this rule previously named a fixed four including `POST /api/terminal/pair`, which no plan has yet registered.*
3. The must-change-password exempt set deep-equals `{"POST /api/admin/auth/password","POST /api/admin/auth/logout"}`.
4. No duplicate `${method} ${path}`; every `:param` has a `params` entry; every non-GET declares `body` (possibly `null`) and `audit`; every GET collection declares `query`. **Every declared `audit` value is a member of the §5.9 table**, and every route declaring a `limit` names a limiter present in the §5.7 table.
5. Every `auth:'terminal'` path starts `/api/terminal/`; every `auth:'user'` route declares a non-empty `roles` drawn from the four aliases enumerated in §5.4.
6. Every terminal-administration path matches `^/api/admin/shops/:shopId/terminals(?:/|$)` — the nesting is asserted, not merely intended.
7. Every route emitting a `Location` has a registered `GET` for that pattern.
8. Any route declaring `limit.key ∈ {user, terminal}` declares `auth !== 'public'`.
9. `HEAD` resolves through the same table (`HEAD /health` → 200); `OPTIONS` on a non-`/api/terminal/` path → 405 + `Allow`. For the CORS clause only, the suite builds a second app instance with `TERMINAL_ALLOWED_ORIGINS='https://kitchen.example.test'` — Phase 1 ships the allowlist empty, so against the default instance the assertion would be vacuous. Three outcomes: allowlisted origin on `/api/terminal/*` → 204 with `Access-Control-Allow-Origin`/`-Methods`/`-Headers` and **never** `-Credentials`; non-allowlisted origin on `/api/terminal/*` → 204 with no CORS headers at all; any other path → 405 + `Allow`.
10. Every entry declares a `sample` (params + minimal body); a route with no `sample` **fails the suite**.

The `HEAD` case is load-bearing, not pedantry: `apps/epaper-hub/docker-compose.yml:16` health-checks with `wget --spider`, which issues `HEAD`, and core-api's compose service is copied from it. If the auth middleware does not key on `req.method === 'HEAD' ? 'GET' : req.method`, the container is permanently unhealthy, `depends_on: condition: service_healthy` never releases, and the failure presents as a database problem.

### 8.6 Suite 4 — `test/tenant-isolation.test.js`, eight modes plus a route probe

The argument-role map lives **inside each repository module** as a named `ARGUMENT_ROLES` export, not in a side file — a separate registry drifts from the signature it describes on the first refactor. Preamble per module under `repositories/` excluding `auth/` and `platform/`:

```js
assert.deepEqual(Object.keys(mod).filter(k => typeof mod[k] === "function").sort(),
                 Object.keys(mod.ARGUMENT_ROLES).sort());
```

`deepEqual`, not a subset check, so both a new undeclared function and a stale declaration for a deleted one fail. Closed role vocabulary — an unrecognised role fails the suite: `shopId | shopTableId | terminalId | userId | pairingCodeId | terminalTokenId | literal | options`. There is **no `companyId` role** (Rule Zero) and no `actorUserId` role (the actor comes from `scope.userId`). Entries carry `table`, `writes` and `sample` so the driver can re-read row provenance and count writes without forcing `companyId` into any DTO.

| Mode | What it does | The bug only it catches |
| --- | --- | --- |
| **1 — cross-tenant substitution, both directions** | Scope A-admin with every id filled from B, then the mirror | A hardcoded `company_id = 'aaaa…'` typo passes one direction and fails the other |
| **2 — legal-call row provenance** | Scope A-admin, A's legal ids. Collections must be **non-empty** AND every returned id re-read via `db.unscoped()` against `table` must carry `company_id = A` | A bare "returns zero rows" assertion is meaningless for a list, and is exactly what let `SELECT … FROM terminals WHERE shop_id = $1` pass a substring scanner while carrying no tenant predicate |
| **3 — shop containment** | Scope A-manager (A1/A3), arguments = **A2's** ids — same company, different shop | A company-only predicate passes Mode 1 and fails only here: the shop-1 manager minting a pairing code against shop 2's cashier terminal |
| **4 — empty assignment set, fail-closed** | Scope A-unassigned, A's legal ids; plus `createScope(A-unassigned).shopIds` is `[]` and `Array.isArray` — not `undefined`, not `null` | `array_agg` over zero rows returns NULL, so without `COALESCE(…, '{}')` a just-revoked staff user gets a `company_admin`-shaped scope: **revocation escalates privilege** |
| **5 — write-side column injection** | Every `writes` function called under A's scope with `sample` plus injected `companyId: B` and `company_id: B`; created row must be A. Paired with a `test/db-index.test.js` case asserting `tenantQuery` **throws** when the SQL names `company_id` in an INSERT column list or an UPDATE SET list | The INSERT-side gap: a `company_admin` who learned another company's uuid creating a `role='company_admin'` row inside it, with every read-side fixture still green |
| **6 — scope-kind refusal** | Every tenant function with `{kind:'platform'}` must throw; every `repositories/platform/*` with a tenant scope must throw. **Does not apply to `repositories/auth/audit.js`**, which takes no scope at all — its behaviour is covered by named per-behaviour cases in `auth-login.test.js` and `terminal-pairing.test.js` | A "platform skips the filter" branch |
| **7 — scope-shape refusal** | A structurally identical plain object lacking the private Symbol, and a stamped scope with `shopIds` deleted — both throw from `assertTenantScope` | `?? null` papering over a gap |
| **8 — fail-closed on suspension** *(new)* | `createScope(A-manager).shopIds` excludes A3; the suspended-terminal token, the A3 token, the revoked token and C-admin's session each yield 401 on their own kind of route; P-admin's `acting_company_id NULL` session reaches no tenant route while the `= A` session reaches A's rows and none of B's | The single most-repeated defect: a `scope-materialize` without `JOIN shops … status='active'`, or a bearer resolver without `tm/s/c.status='active'` |

**Route-level probe**, driven off `listRoutes()` + each route's `sample`, in the same file:
- Re-seed immediately before the probe and **mint the probe's credentials fresh**. Modes 2 and 5 both call `issuePairingCode`, which by settled semantics revokes the terminal's live token and sets `status='unpaired'` — so reusing the fixture bearer means every "401" is 401 because the token is dead, not because channel binding worked, and regressing channel binding leaves the probe green.
- **Positive controls first**, failing the suite with an explicit message if either does not hold: the terminal bearer returns non-401 on `GET /api/terminal/me`; the session cookie returns non-401 on one `auth:'user'` route.
- Then: every non-public route with no credential → 401; every `auth:'user'` route presented a valid **terminal bearer** → 401; every `auth:'terminal'` route presented a valid **session cookie** → 401; both credentials at once → no wider access than either alone; every non-GET cookie-auth route (plus login) with a wrong `Origin` → 403 and with a non-JSON `Content-Type` → 415, and as the negative control every GET cookie-auth route with a wrong `Origin` → **not** 403; `POST /api/terminal/pair` with **no `Origin` at all** → **not** 403.
- **Connection-leak guard:** after the sweep, `idleCount === totalCount` and `waitingCount === 0`. A repository that throws without releasing a client is a slow production death no functional assertion notices.

### 8.7 Suite 5 — `test/migrate.test.js`

**`db/migrate.js` takes the migrations directory as a parameter, and every scenario is built in a fresh `os.tmpdir()` directory removed in `after()`.** Per-file cloning isolates the database; it does not isolate the filesystem, and every other test file runs concurrently against `apps/core-api/migrations/` — the eight `cloneTemplate()` suites read it to decide whether the template is stale, and `source-structure.test.js` scans it for C10. Writing a deliberately-broken `0002` there turns S6 red, turns C10 red, and — worst — makes every sibling's `cloneTemplate()` decide the template is stale and rebuild it by running the broken file, so the whole run fails for reasons unrelated to what each suite tests. The fastest repair under pressure is `--test-concurrency=1`, which discards the entire parallel-per-file design.

Scenarios, each on a fresh empty database: fresh apply; re-run is a no-op with `applied_at` unchanged; **checksum mismatch → fatal**; row with no file on disk → **WARNING, exit 0** (making it fatal deletes image rollback, the only recovery lever on a push-to-main pipeline with no staging tier); pending file at startup → server refuses to listen; failing file → transaction rolls back with no ledger row and no partial tables (which also proves `SET LOCAL lock_timeout` at `0001:24` is genuinely inside a transaction and not a silently-ignored no-op); advisory-lock contention → second runner exits non-zero with `another instance is migrating` inside the bound rather than hanging; **semicolon-splitting regression** → `set_updated_at` exists as a `pg_proc` row AND an `UPDATE companies SET name=…` actually moves `updated_at` (a split runner passes a naive "did it apply" check and fails this one).

### 8.8 Purity tiers

**Tier 1 (referentially transparent, no DB/FS/network/ambient clock):** `config.js`, `db/scope.js`, `db/errors.js`, `http/respond.js`, `http/cookies.js`, `http/csrf.js`, `http/terminal-cors.js`, all of `lib/`. `tokens.js`/`pairing-code.js`/`password.js` call `node:crypto` — CPU and the OS RNG, not I/O. `time.js` and `client-ip.js` take the clock and the hop count as arguments and never read `Date.now()` or `process.env`, which is what keeps DST tests deterministic. `password.test.js` uses reduced scrypt parameters for round-trips and the real ones for exactly one case: the **maxmem trap** (`128 × 32768 × 8 = 33,554,432` against Node's 32 MB default, which throws unless `maxmem: 64*1024*1024` is passed).

**Tier 2 (in-process mutable state, injected clock, no DB):** `lib/rate-limit.js`, `lib/semaphore.js`, `http/router.js`. `semaphore.test.js` drives slot exhaustion with a fake clock and asserts a slot is released when the guarded function throws — a leaked slot degrades to a permanent 503 on the login route.

**Tier 3 (real database):** `db/pool.js`, `db/index.js`, `db/migrate.js`, `db/health.js`, all of `repositories/`, all of `http/routes/`, all of `scripts/`, `server.js`.

Rule C9 is what stops Tier 1 quietly decaying into Tier 3. It is a require-graph check, not a behaviour check — a `lib/` module reading `process.env` or calling `Date.now()` passes C9 and is still non-deterministic; that discipline rests on review.

### 8.9 CI

Postgres runs as a **job-level service container** in the existing `deploy` job (GitHub-hosted runners run these natively; no `docker compose`, no compose file). Adding it to the existing job rather than a separate `test.yml` matters: `deploy.yml` is currently both the test gate and the deployer, and splitting them means a push can deploy without tests unless a `needs:` edge is wired.

```yaml
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_PASSWORD: postgres }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres -h 127.0.0.1"
          --health-interval 5s --health-timeout 5s --health-retries 10
```

`-h 127.0.0.1` for the same reason as production: during initdb the entrypoint runs a temporary server on the unix socket only, so a socket `pg_isready` reports healthy while TCP is still refused. `postgres:16-alpine` matches the production compose tag and a `deploy-config` assertion pins the two to the same literal string. Steps `npm --prefix apps/core-api ci` / `npm --prefix apps/core-api test` go **after** the existing customer-order steps and **before** `Build images`.

## 9. Deployment and operations

### 9.0 The compose move is a FIVE-file atomic change

The settled text names two files. There are five, and the *test* is what breaks first:

| File | Change |
| --- | --- |
| `apps/epaper-hub/docker-compose.yml` | `git mv` to `docker-compose.yml` at the repo root |
| `apps/epaper-hub/docker-compose.yml:4` | `build: .` → `build: { context: apps/epaper-hub }` — a relative build context resolves against the compose file's directory, so moving the file silently repoints `.` from `apps/epaper-hub` to the repo root. Production is unaffected (`--no-build`), but `docker compose build` locally then fails, and `docker compose config` **still prints ok**, so the obvious verification does not see it. **The context must stay `apps/epaper-hub`, not become the repo root**: `apps/epaper-hub/Dockerfile` is written for that context (`COPY package*.json ./` at line 5, `COPY server.js ./server.js` at line 8), and it is what CI already builds with (`docker build -t epaper-hub:$SHA apps/epaper-hub`, `deploy.yml:32`). Rooting the context instead would copy the workspace `package.json` and then fail on `COPY server.js`. `apps/customer-order` and `apps/core-api` are the opposite case — both are built from the repo root with an explicit `-f`, because customer-order copies `packages/epaper-hub-sdk` |
| `.github/workflows/deploy.yml:49` | `scp … apps/epaper-hub/docker-compose.yml` → `scp … docker-compose.yml` |
| `apps/epaper-hub/README.md:26` | `docker compose -f apps/epaper-hub/docker-compose.yml up -d --build` → `docker compose up -d --build`, run from the repo root. No test covers this line, which is why it is listed here |
| `apps/epaper-hub/test/deploy-config.test.js:18,32,204` | `path.join(appRoot, …)` → `path.join(repoRoot, …)`; `/apps\/epaper-hub\/docker-compose\.yml/` → `/scp -i [^\n]*docker-compose\.yml/` |

Two negative assertions at `deploy-config.test.js:214-215` constrain everything below — `:214` is `assert.doesNotMatch(workflow, /docker build -t epaper-hub:\$\{\{ github\.sha \}\} \./)`, which already pins the epaper-hub image build away from a repo-root context, and `:215` is `assert.doesNotMatch(workflow, /app\.tgz|tar -xzf|APP_API_KEY|cat > \.env|self-hosted/)` — so no tarball of config files, no `cat > .env` heredoc, no self-hosted runner. (`/tmp/core-api-image-<sha>.tgz` does not match `app\.tgz`.)

### 9.1 `docker-compose.yml` (repo root)

```yaml
networks:
  core-net:

services:
  core-db:
    image: postgres:16-alpine        # pinned to a MAJOR; an unpinned tag eventually pulls 17,
    container_name: core-db          # refuses to start against a PGDATA written by 16, and
    restart: unless-stopped          # presents as a total outage at 22:00
    networks: [core-net]             # NOT on the default network -- see 9.2
    # NO `ports:` KEY AT ALL.
    env_file:
      - ${CORE_ENV_FILE:-.env}
    environment:
      POSTGRES_USER: core_api_owner
      POSTGRES_DB: core
      POSTGRES_INITDB_ARGS: "--data-checksums --encoding=UTF8"
      PGDATA: /var/lib/postgresql/data/pgdata
      TZ: UTC
    command:
      - postgres
      - -c
      - max_connections=40
      - -c
      - shared_buffers=128MB
      - -c
      - effective_cache_size=384MB
      - -c
      - work_mem=4MB
      - -c
      - maintenance_work_mem=64MB
      - -c
      - max_parallel_workers_per_gather=0   # Phase 1's largest table holds a few dozen rows;
      - -c                                   # each worker is a memory spike where the OOM killer
      - timezone=UTC                         # is the named top risk
      # ADVISORY-LOCK ORPHAN FIX: default keepalive idle is 2 hours, so a SIGKILLed
      # core-api holding the migration lock blocks every deploy for that long.
      # 20 + 5*3 = ~35 s, comfortably inside the runner's 60 s bounded retry.
      - -c
      - tcp_keepalives_idle=20
      - -c
      - tcp_keepalives_interval=5
      - -c
      - tcp_keepalives_count=3
    volumes:
      - core-db-data:/var/lib/postgresql/data
    healthcheck:
      # -h 127.0.0.1 IS LOAD-BEARING: during initdb the entrypoint runs a temporary
      # server on the unix socket only, so a socket pg_isready reports healthy while
      # TCP is still refused and compose starts core-api against nothing.
      test: ["CMD-SHELL", "pg_isready -U core_api_owner -d core -h 127.0.0.1 || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s
    stop_grace_period: 60s     # let Postgres checkpoint instead of being SIGKILLed after 10 s
    shm_size: 128mb
    oom_score_adj: -500        # bias the kernel AWAY from the process holding the data

  core-api:
    image: ${CORE_API_IMAGE:-core-api}
    container_name: core-api
    restart: unless-stopped
    networks: [core-net, default]
    ports:
      - "127.0.0.1:3200:3200"
    env_file:
      - ${CORE_ENV_FILE:-.env}
    environment:
      PORT: 3200
      HOST: 0.0.0.0
      TZ: UTC
      API_PUBLIC_ORIGIN: https://api.yeyintlwin.com
      TERMINAL_ALLOWED_ORIGINS: ""       # empty = no CORS headers at all (Phase-1 default)
      TRUSTED_PROXY_HOPS: 1
      SESSION_IDLE_SECONDS: 28800
      SESSION_ABSOLUTE_SECONDS: 604800
      PAIRING_CODE_TTL_SECONDS: 900
      TERMINAL_TOKEN_TTL_SECONDS: 7776000
      LOGIN_RATE_PER_MINUTE: 30
      LOGIN_TIME_BUDGET_MS: 400
      SCRYPT_SLOTS: 2
      PAIR_RATE_PER_MINUTE: 20
      ADMIN_MINT_RATE_PER_10MIN: 20
      PAIRING_MINT_RATE_PER_10MIN: 30
      PASSWORD_ABUSE_THRESHOLD: 5
      ROTATE_RATE_PER_HOUR: 5
      AUDIT_RETENTION_DAYS: 365
      DB_POOL_MAX: 8
    depends_on:
      core-db:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3200/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 60s
    mem_limit: 512m
    oom_score_adj: 500

  epaper-hub:      # unchanged except: build: {context: apps/epaper-hub}
                   # (see 9.0 — the context must NOT become the repo root)
                   # and oom_score_adj: 500.  env_file stays ${EPAPER_ENV_FILE:-.env}
  customer-order:  # unchanged except oom_score_adj: 500

volumes:
  epaper-data:
  core-db-data:
```

**The container healthcheck calls `/health`, not `/health/ready`.** Nothing depends on core-api, so an unhealthy mark would restart nothing; a transient DB blip should not produce a misleading status. The *deploy gate* calls `/health/ready`.

### 9.2 Two secrets files and a separate network — not deferrable

The existing shape gives every service the same `env_file` (`apps/epaper-hub/docker-compose.yml:9-10, 27-28`). After Phase 1 that file holds a Postgres **superuser** DSN, and `epaper-hub` is internet-facing with the `req.query.api_key` (`server.js:89`) + `morgan("combined")` (`:32`) pattern. Any code-execution or SSRF bug there would read `DATABASE_MIGRATION_URL` and reach `core-db:5432` on the shared default network — as `core_api_owner` that is `COPY … TO PROGRAM`, i.e. a shell in the database container, plus every tenant's rows and every scrypt hash. Before Phase 1 the worst outcome of an epaper-hub compromise was twelve e-paper screens. The proposed structural test ("no `environment:` block names `POSTGRES_PASSWORD`") cannot see this, because the leak is via `env_file:`.

Therefore: `core-net` is a separate network that only `core-db` and `core-api` join, and core's secrets live in a second mode-600 file `~/core-api.env` referenced as `${CORE_ENV_FILE:-.env}`. Per-service env files for the *other* three services remain deferred. A structural test asserts no service other than `core-db`/`core-api` lists `CORE_ENV_FILE`.

**`core-db` publishes no host port at all.** Not `127.0.0.1:5432:5432` — that differs from `5432:5432` by one deletion, and Docker's published ports install DNAT rules that **bypass ufw** on Ubuntu — a fact `infra/README.md` does not currently record and this phase must add to it. Nothing needs it: `core-api` uses the compose network, `psql`/`pg_dump` go through `docker compose exec`. It is also load-bearing for the settled bootstrap decision, which rejects `BOOTSTRAP_ADMIN_PASSWORD` specifically because `DATABASE_URL` is exploitable only from inside the host. A key that should not exist cannot be mistyped; a structural test asserts the compose text contains no `5432` mapping.

### 9.3 `apps/core-api/Dockerfile`

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY apps/core-api ./apps/core-api
RUN npm --prefix apps/core-api ci --omit=dev --workspaces=false
ENV NODE_ENV=production PORT=3200 HOST=0.0.0.0 TZ=UTC
EXPOSE 3200
CMD ["node", "apps/core-api/server.js"]
```

Built from the repo root: `docker build -f apps/core-api/Dockerfile -t core-api:$SHA .` — same base image, same `--prefix … --workspaces=false` idiom, same `ENV`/`EXPOSE`/array-`CMD` as `apps/customer-order/Dockerfile`.

- **DEPARTURE: `npm ci` rather than `install`.** customer-order uses `install` (`Dockerfile:8-9`) despite having a lockfile; core-api is the first app with a real dependency tree, so `ci` failing loudly on a stale lockfile is the behaviour you want. If `ci` misbehaves under `--prefix` on the first build, fall back to `install --omit=dev --workspaces=false` and note it.
- `scripts/` in the image is **required** — `create-platform-admin.js` (shipped in Plan 2b), `unlock-account.js` and `set-password.js` (both Plan 2d) run via `docker compose exec`.
- **`.dockerignore` needs `apps/*/.env` added.** The root file excludes only top-level `.env`, so a developer's `apps/core-api/.env` — now containing `DATABASE_URL` — would be baked into the production image. `.gitignore:2` already uses exactly this pattern. This is a latent bug in the customer-order build that Phase 1 makes dangerous.
- **New runtime dependency: `pg`**, in a repo where `apps/customer-order/package.json` declares only a `file:` link. Hand-rolling the wire protocol is not YAGNI. It pulls ~10 small transitive packages; `pg-native` must not be installed (needs libpq + a C toolchain, instant failure on the Windows dev machine).

### 9.4 Migration runner contract

`apps/core-api/db/migrate.js`, invoked from `start()` before `listen()` — the same order as `apps/customer-order/server.js:455-474`.

| # | Step | Fatal? |
| --- | --- | --- |
| 1 | `startupConfiguration()` — pure env validation, no network | **Fatal**, exit 1 |
| 2 | Connect migration pool (`max: 1`, `application_name=core-api-migrate`) | see below |
| 3 | `SHOW server_version_num` ≥ `140000` | **Fatal** |
| 4 | Ensure the `core_api_app` role and grants | **Fatal** |
| 5 | `CREATE TABLE IF NOT EXISTS schema_migrations` (DDL identical to `0001:34-39`) | **Fatal** |
| 6 | `pg_try_advisory_lock(4264071001)`, session-level, bounded 60 s retry | **Fatal**, `another instance is migrating` |
| 7 | Enumerate + validate filenames | **Fatal before anything is applied** |
| 8 | Per file: compare checksum, or apply in one transaction | **Fatal** |
| 9 | Post-loop reconciliation | mixed |
| 10 | Release lock, `pool.end()` the migration pool | — |
| 11 | Open the runtime pool (`DATABASE_URL`), one `SELECT 1` | **Fatal** |
| 12 | `listen()` | — |

**Connection retry — retry the transient, fail fast on the deterministic.** Retry 10×1 s on `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, SQLSTATE `57P03`. **Fatal immediately** on `28P01`/`28000` and `3D000` — retrying a wrong password for ten seconds buries a deterministic failure behind a timeout. The `28P01` message reads verbatim: *"DATABASE_MIGRATION_URL was rejected by the server (28P01). If you rotated POSTGRES_PASSWORD, the running cluster still holds the old value — see infra/README.md 'Rotating database passwords'."*

**Role bootstrap must not hardcode the database name.** `0001:508-517` is guarded on `pg_roles`, so the role is created outside the migration — but the same runner also builds `core_api_test_template` and per-file clones on a CI server that has no database named `core`, and a hardcoded `REVOKE ALL ON DATABASE core` fails with `3D000` on the very first CI run. The 30-second repair under pressure is `try{}catch{}` or `if (production)`, after which the REVOKE is exercised nowhere and `PUBLIC` still holds `CONNECT` on `core` in production with a green build history behind it. Derive it in SQL:

```sql
DO $$ BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO core_api_app', current_database());
END $$;
```

and `ALTER ROLE core_api_app LOGIN PASSWORD <quote_literal($1)>` on **every** boot, so changing `DATABASE_URL` and redeploying genuinely rotates the app password. (`quote_literal` keeps escaping in Postgres's hands. **Do not set `log_statement=all` on this cluster** — that bind parameter would land in the log.) Correspondingly, the *"username must be `core_api_owner`"* startup assertion applies only when `NODE_ENV=production`, with a unit test feeding the production branch a non-owner DSN and asserting it throws — so the check that protects production stays exercised while CI can run at all.

**Applying a file:** the whole file goes to `client.query()` as **one string with no parameters**. node-postgres uses the simple query protocol (which permits multiple statements) only when no values are bound; pass even one and it raises *"cannot insert multiple commands into a prepared statement."* Sequence: `BEGIN` → file text → `INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1,$2,$3)` → `COMMIT`. The explicit `BEGIN` is what makes `SET LOCAL lock_timeout`/`statement_timeout` at `0001:24-25` meaningful — `SET LOCAL` outside a transaction block is silently ignored.

**Checksums — and a live cross-platform trap.** Checksum = SHA-256 of the file, stored as `bytea(32)`. **Normalise line endings before hashing:**

```js
const raw = fs.readFileSync(file);
const normalised = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const checksum = crypto.createHash('sha256').update(normalised).digest();
```

This repo has **no `.gitattributes`** (verified against `git ls-files`), the developer is on `win32`, and images build on `ubuntu-latest`. `autocrlf=true` is the Git-for-Windows installer default, so the *same* file yields two digests and the runner declares a fatal mismatch — the one error with no escape hatch — on a file nobody edited. Also add `/.gitattributes` with `*.sql text eol=lf` as the belt to that braces.

Verdicts: equal → skip; differ → **FATAL** (history was edited); no row → apply; filename failing `^[0-9]{4}_[a-z0-9_]+\.sql$` or a duplicate prefix → **FATAL before anything is applied** (same regex as the table's own CHECK, so a bad name would otherwise fail the `INSERT` *after* the DDL ran); on disk but no row after the loop → **FATAL** (pending); row but no file → **WARNING only**, because making it fatal deletes image rollback, which on a push-to-main pipeline with no staging tier is the only recovery lever there is. **There is no `--force` and no skip variable.** The mismatch message prints both digests and the two remedies: never edit an applied migration — add `000N_fix_x.sql`; locally, `npm run db:reset`. A `--check` mode (exit 1 on pending or mismatch, apply nothing) runs in CI.

**Fatal-error exit — DEPARTURE.** `apps/customer-order/server.js:501-504` uses `process.exitCode = 1` and lets the loop drain. core-api cannot: by the time some checks fail a `pg.Pool` is open and keeps the loop alive forever, so the container would neither listen nor exit, `restart: unless-stopped` would never fire, and the failure would present as an indefinite hang with one log line. Required shape:

```js
start().catch(async (error) => {
  console.error(error.message);
  try { await closeAllPools(); } catch {}
  process.exit(1);
});
```

### 9.5 `.github/workflows/deploy.yml`

**Add at workflow level — this is a blocker, not hardening:**

```yaml
concurrency:
  group: deploy-production
  cancel-in-progress: false
```

The file today has no `concurrency` key, so two pushes run two jobs against one host, one project directory, one set of fixed `/tmp/*.tgz` paths and one set of fixed `container_name:` values. Push B's scp overwrites the image A has not loaded; A's `find … -exec rm -rf {} +` (`:84`) runs while B is still scp-ing config files; both run `docker compose up -d` with different `CORE_API_IMAGE` values; whichever core-api wins the advisory lock migrates and the other exits 1 and is restarted into an already-migrated database. If the surviving container is A, the runner's reconciliation finds a row with no file, logs a WARNING and starts — **production silently runs sha A's code against sha B's schema, both builds green, `/health/ready` 200**. `cancel-in-progress: false` specifically: cancelling mid-`ssh` heredoc kills the SSH client without stopping the remote shell, which is precisely how you orphan the migration lock. Also make the tarball path `/tmp/core-api-image-${{ github.sha }}.tgz`.

Job-level Postgres service and the two core-api npm steps: see §8.9. Build/upload:

```yaml
      docker build -f apps/core-api/Dockerfile -t core-api:${{ github.sha }} .
      docker save core-api:${{ github.sha }} | gzip > /tmp/core-api-image-${{ github.sha }}.tgz

      ssh … 'mkdir -p ~/restaurant-order-system/config ~/backups && chmod 700 ~/backups'
      scp -i ~/.ssh/lightsail.pem docker-compose.yml              …:~/restaurant-order-system/docker-compose.yml
      scp -i ~/.ssh/lightsail.pem infra/nginx/api.conf            …:/tmp/api.conf
      scp -i ~/.ssh/lightsail.pem infra/nginx/core-api-proxy.conf …:/tmp/core-api-proxy.conf
      scp -i ~/.ssh/lightsail.pem infra/backup-core-db.sh         …:~/restaurant-order-system/config/backup-core-db.sh
      scp -i ~/.ssh/lightsail.pem /tmp/core-api-image-${{ github.sha }}.tgz …:/tmp/
```

Nginx files go to `/tmp`, **not** to `~/restaurant-order-system/`, because `deploy.yml:84`'s `find … ! -name docker-compose.yml ! -name config -exec rm -rf {} +` deletes anything else there — a file scp'd "alongside the compose file" is erased before `docker compose up -d`, the workflow-text assertion stays green, and the network half of the rate limiting silently never ships. `backup-core-db.sh` goes under `config/`, which the find preserves.

**The deploy heredoc, in order** (`set -euo pipefail` is already in force at `:57`):

```sh
docker load -i /tmp/core-api-image-${{ github.sha }}.tgz
docker volume create restaurant-order-system_core-db-data
# … existing epaper-emulator migration block, unchanged …
find ~/restaurant-order-system -mindepth 1 -maxdepth 1 ! -name docker-compose.yml ! -name config -exec rm -rf {} +
cd ~/restaurant-order-system
export EPAPER_ENV_FILE=../restaurant-order-system.env
export CORE_ENV_FILE=../core-api.env
export EPAPER_IMAGE=epaper-hub:${{ github.sha }}
export CUSTOMER_ORDER_IMAGE=customer-order:${{ github.sha }}
export CORE_API_IMAGE=core-api:${{ github.sha }}

# ---- 1. PRE-DEPLOY DUMP. Gated on the VOLUME, not on a running container. ----
# `docker compose ps --quiet core-db` is true only when core-db is RUNNING, so it
# cannot distinguish "does not exist yet" (legitimate skip) from "exists and is down"
# (backup mandatory) -- and the deploy most likely to need the dump is the one that
# silently skips it, while `ln -sf` leaves a STALE latest-pre-deploy.dump to be
# uploaded under this commit's artifact name.
if docker volume inspect restaurant-order-system_core-db-data >/dev/null 2>&1; then
  docker compose up -d core-db
  for i in $(seq 1 30); do docker compose exec -T core-db pg_isready -U core_api_owner -d core -h 127.0.0.1 && break; sleep 2; done
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  # `exec -T` IS LOAD-BEARING: without it docker allocates a TTY and CRLF translation
  # silently corrupts the binary custom-format dump.
  docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d core -Fc' \
    > ~/backups/pre-deploy-"$ts".dump
  test -s ~/backups/pre-deploy-"$ts".dump
  docker compose exec -T core-db pg_restore --list < ~/backups/pre-deploy-"$ts".dump > /dev/null
  chmod 600 ~/backups/pre-deploy-"$ts".dump
  printf '%s %s\n' "${{ github.sha }}" "pre-deploy-$ts.dump" > ~/backups/LAST_PRE_DEPLOY
  ln -sfn ~/backups/pre-deploy-"$ts".dump ~/backups/latest-pre-deploy.dump
fi

# ---- 2. NGINX: snapshot, install, validate, ROLL BACK on failure, then reload ----
# Installing first and validating second leaves a broken file latent on disk when
# nginx -t fails: the running nginx keeps its in-memory config so nothing looks wrong,
# and the box goes down the next time certbot's renew hook or a reboot reloads it --
# taking order.yeyintlwin.com and epaper-hub.yeyintlwin.com with it, days later.
sudo cp -a /etc/nginx/conf.d/api.yeyintlwin.com.conf /tmp/api.conf.bak 2>/dev/null || :
sudo install -m0644 /tmp/api.conf            /etc/nginx/conf.d/api.yeyintlwin.com.conf
sudo install -m0644 -D /tmp/core-api-proxy.conf /etc/nginx/snippets/core-api-proxy.conf
if ! sudo nginx -t; then
  if [ -f /tmp/api.conf.bak ]; then sudo cp -a /tmp/api.conf.bak /etc/nginx/conf.d/api.yeyintlwin.com.conf
  else sudo rm -f /etc/nginx/conf.d/api.yeyintlwin.com.conf; fi
  sudo nginx -t          # prove the box is left loadable
  exit 1
fi
sudo systemctl reload nginx
sudo nginx -T | grep -q 'limit_req_zone .*zone=core_login'
sudo nginx -T | grep -q 'proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for'

docker compose up -d --no-build

# ---- 3. HEALTH GATE, 90 s, THROUGH THE REAL CHAIN ----
ok=0; i=0
while [ "$i" -lt 45 ]; do
  if curl -fsS -m 3 http://127.0.0.1:3200/health/ready >/dev/null 2>&1; then ok=1; break; fi
  i=$((i+1)); sleep 2
done
[ "$ok" -eq 1 ] || { docker compose logs --tail 200 core-api || true; docker compose logs --tail 50 core-db || true; exit 1; }

# nginx -T proves the DIRECTIVES are loaded. It does not prove a server block matches
# api.yeyintlwin.com, that the certificate serves, or that limit_req fires.
curl -fsS -m 5 --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health >/dev/null

# ---- 4. TRUSTED_PROXY_HOPS PROBE. A wrong value fails SILENTLY in both directions.
# THIS MUST RUN BEFORE THE limit_req BURST BELOW. Run after it, the burst has already
# exhausted the core_login bucket for this source address, so nginx sheds the probe,
# it never reaches core-api, no audit row is written, and the SELECT reads a row left
# by the burst (source_ip 127.0.0.1) -- which is neither 203.0.113.99 nor null, so both
# assertions pass vacuously whatever TRUSTED_PROXY_HOPS is set to.
# CORRECTED BY PLAN 2b (Task 12) -- this appendix was wrong twice and the shipped
# heredoc is the authority. It read `curl -fsS ... || true`, which deploy-config.test.js
# bans: -f makes curl exit non-zero on the 401 this probe EXPECTS, and `|| true` then
# swallows a probe that never reached core-api at all. Capture the status instead and
# assert it. The psql quoting was '"'"'-style; the shipped form escapes inside a
# double-quoted sh -c, and </dev/null is on both `docker compose exec` calls so neither
# eats the heredoc.
probe_status=$(curl -s -o /tmp/xff-probe.body -w '%{http_code}' -m 5 \
  --resolve api.yeyintlwin.com:443:127.0.0.1 \
  -X POST https://api.yeyintlwin.com/api/admin/auth/login \
  -H 'Origin: https://api.yeyintlwin.com' -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 203.0.113.99' \
  --data-binary '{"email":"xff-probe@invalid.test","password":"x"}' </dev/null)
test "$probe_status" = "401" || { echo "login probe: expected 401 from core-api, got $probe_status"; cat /tmp/xff-probe.body; exit 1; }
grep -q '"code":"invalid_credentials"' /tmp/xff-probe.body || { echo 'login probe: that 401 did not come from core-api'; cat /tmp/xff-probe.body; exit 1; }
rm -f /tmp/xff-probe.body
# Read TRUSTED_PROXY_HOPS out of the RUNNING PROCESS, not the project files.
hops=$(docker compose exec -T core-api sh -c 'tr "\0" "\n" < /proc/1/environ' </dev/null | sed -n 's/^TRUSTED_PROXY_HOPS=//p' | tr -d '\r')
test "$hops" = "1" || { echo "core-api PID 1 has TRUSTED_PROXY_HOPS='$hops', expected 1"; exit 1; }
# Select THIS probe's row by its address, not "the most recent row".
probe=$(docker compose exec -T core-db sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -tAq -U core_api_owner -d core -c \"SELECT coalesce(host(source_ip), 'null') FROM audit_events WHERE detail->>'email' = 'xff-probe@invalid.test' ORDER BY id DESC LIMIT 1\"" </dev/null)
test -n "$probe"                || { echo 'XFF probe wrote no audit row - it never reached core-api'; exit 1; }
test "$probe" != "203.0.113.99" || { echo 'FORGEABLE X-Forwarded-For: TRUSTED_PROXY_HOPS is wrong'; exit 1; }
test "$probe" != "null"         || { echo 'client IP derivation collapsed; check TRUSTED_PROXY_HOPS'; exit 1; }

# ---- 5. limit_req PROBE. Deliberately exhausts the core_login bucket, so nothing
# that depends on reaching core-api from this address may run after it.
codes=$(for n in $(seq 1 20); do curl -s -o /dev/null -w '%{http_code} ' -m 3 \
  --resolve api.yeyintlwin.com:443:127.0.0.1 -X POST https://api.yeyintlwin.com/api/admin/auth/login \
  -H 'Origin: https://api.yeyintlwin.com' -H 'Content-Type: application/json' \
  --data-binary '{"email":"deploy-probe@invalid.test","password":"x"}'; done)
echo "$codes" | grep -q 429 || { echo 'nginx limit_req is not firing on the login route'; exit 1; }

# ---- 6. BACKUP HEALTH: make silence a red build ----
rm -f "$HOME"/backups/*.part
if docker volume inspect restaurant-order-system_core-db-data >/dev/null 2>&1 && [ -f "$HOME/backups/LAST_OK" ]; then
  find "$HOME/backups/LAST_OK" -mtime -2 | grep -q . || { echo 'no successful core-db nightly in 48h'; exit 1; }
fi
df -P "$HOME" | awk 'NR==2 && $5+0 > 85 { print "disk " $5 " full"; exit 1 }'

# ---- 7. CRON, LAST, AND FAILURE-PROOF ----
# `crontab -l | grep -Fv … | crontab -` exits 1 under set -e on a box with NO crontab
# (crontab -l exits 1, grep on empty input exits 1, pipefail propagates), aborting the
# deploy with an EMPTY error message BEFORE the service ever starts -- and on Vixie
# cron the empty stdin also wipes any crontab that did exist.
{ crontab -l 2>/dev/null || true; } | { grep -Fv -e 'backup-core-db.sh' -e 'sweep-expired.js' || true; } > /tmp/ct.$$
printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n17 3 * * * %s/restaurant-order-system/config/backup-core-db.sh >> %s/backups/backup.log 2>&1\n43 3 * * * cd %s/restaurant-order-system && CORE_ENV_FILE=../core-api.env docker compose exec -T core-api node apps/core-api/scripts/sweep-expired.js >> %s/backups/sweep.log 2>&1\n' "$HOME" "$HOME" "$HOME" "$HOME" >> /tmp/ct.$$
crontab /tmp/ct.$$ && rm -f /tmp/ct.$$
crontab -l | grep -q backup-core-db.sh
# AUDIT_RETENTION_DAYS configures nothing unless the sweep is actually installed.
crontab -l | grep -q sweep-expired.js

docker image prune -f
rm -f /tmp/*-image*.tgz /tmp/api.conf /tmp/core-api-proxy.conf
```

A final workflow step (`if: always()`) reads `~/backups/LAST_PRE_DEPLOY`, **fails if the recorded sha is not this commit's**, scp's that exact file, and uploads it via `actions/upload-artifact@v4` with `retention-days: 14`. **Say the exposure out loud:** that artifact contains email addresses, IP addresses and scrypt hashes, readable by anyone with repo access. For a private personal repo that is an acceptable trade against having no off-box copy at all; the upgrade path is a write-only bucket, on the trigger decision 14 names.

**The gate does not auto-rollback.** By the time it runs the migration has applied; rolling the image back leaves the schema *ahead* of the image, which the runner treats as a warning — so the old image starts and looks healthy while running against a schema it does not know. That is a real recovery path, but a human decision. Runbook line: `CORE_API_IMAGE=core-api:<previous-sha> docker compose up -d core-api`.

**Every push already recreates `epaper-hub` and `customer-order`** (a fresh `${{ github.sha }}` tag on every run), resetting all 12 table displays to `Welcome` and dropping every in-memory order session. Phase 1 does not introduce that but **lengthens the window** by putting a migration in front of it. Deploy outside service hours, and put that sentence in `infra/README.md`.

### 9.6 `infra/nginx/`

**`core-api-proxy.conf`:**

```nginx
proxy_http_version 1.1;
proxy_set_header Connection        "";
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;   # THE line hops=1 depends on
proxy_connect_timeout 2s;
proxy_read_timeout   30s;
proxy_send_timeout   30s;
proxy_pass http://core_api;
```

**`api.conf`:**

```nginx
# limit_req_zone must be at http{} scope. Ubuntu's stock nginx.conf includes
# conf.d/*.conf inside http{}, which is why this installs to conf.d: zero edits to nginx.conf.
limit_req_zone $binary_remote_addr zone=core_login:1m rate=10r/m;
limit_req_zone $binary_remote_addr zone=core_pair:1m  rate=20r/m;
limit_req_zone $binary_remote_addr zone=core_api:5m   rate=20r/s;

upstream core_api {
    # max_fails=0 on purpose. With one server in the group, proxy_next_upstream can
    # never retry (there is no next server), while max_fails=3 makes nginx STOP
    # attempting connections for fail_timeout after a recreate -- returning 502 for
    # seconds AFTER core-api is listening and healthy.
    server 127.0.0.1:3200 max_fails=0;
    keepalive 16;
}

server {
    listen 80; listen [::]:80;
    server_name api.yeyintlwin.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    # Old-style `ssl http2` on purpose: `http2 on;` needs nginx >= 1.25.1 and would
    # fail nginx -t on Ubuntu 22.04 (1.18) / 24.04 (1.24). The old form only warns.
    listen 443 ssl http2; listen [::]:443 ssl http2;
    server_name api.yeyintlwin.com;
    ssl_certificate     /etc/letsencrypt/live/api.yeyintlwin.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yeyintlwin.com/privkey.pem;

    client_max_body_size  64k;      # no Phase-1 body is legitimately large, and a 5 MB
    client_body_timeout   10s;      # body is a free way to occupy a scrypt slot
    client_header_timeout 10s;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # /health is PROXIED but loopback-only: the deploy gate curls it through the
    # real TLS chain with --resolve, so a hard 404 here would abort every deploy
    # at `curl -fsS` (exit 22) after the migration has already applied.
    location = /health       { allow 127.0.0.1; allow ::1; deny all;
                               include /etc/nginx/snippets/core-api-proxy.conf; }
    location = /health/ready { return 404; }   # never expose readiness publicly

    location = /api/admin/auth/login { limit_req zone=core_login burst=5 nodelay; limit_req_status 429;
                                       include /etc/nginx/snippets/core-api-proxy.conf; }
    location = /api/terminal/pair    { limit_req zone=core_pair  burst=5 nodelay; limit_req_status 429;
                                       include /etc/nginx/snippets/core-api-proxy.conf; }
    location / { limit_req zone=core_api burst=40 nodelay;
                 include /etc/nginx/snippets/core-api-proxy.conf; }
}
```

**Why `TRUSTED_PROXY_HOPS=1` is correct.** `$proxy_add_x_forwarded_for` is the client's incoming XFF with `$remote_addr` appended **on the right**, so counting one from the right yields the address Nginx actually saw. A client sending `X-Forwarded-For: 1.2.3.4` produces `1.2.3.4, <real ip>` and the real IP still wins. Four silent breakers, all for `infra/README.md`: (1) `real_ip_header`/`set_real_ip_from` in this block rewrites `$remote_addr` *before* the variable is evaluated — total bypass, so a structural test asserts **neither directive appears**; (2) a `location` that `proxy_pass`es without the snippet — a test asserts `count(proxy_pass) === count(include …core-api-proxy.conf)`; (3) adding a proxy in front without changing the number — every entry shifts and one attacker locks out every account on the platform; (4) `proxy_set_header X-Forwarded-For $remote_addr`, which works at hops=1 but discards the chain.

**Code-side:** if XFF is absent, has fewer than `TRUSTED_PROXY_HOPS` entries, or the selected entry fails `net.isIP()`, the derivation is *untrusted* — the bucket key becomes a single shared `"unknown"` (strictest, fail-closed), `source_ip` is written NULL (fail-soft), and **it logs at error level on every occurrence**. Writing the raw comma-separated header into an `inet` column raises *"invalid input syntax for type inet"* inside the login transaction, failing login outright for anyone behind two proxies. Strip ports and IPv6 brackets; normalise `::ffff:a.b.c.d` to v4 so buckets and `inet` values agree.

Two notes for later: do **not** add `proxy_buffering off` now; do add it for the Phase-4 SSE route. The certificate must exist before `nginx -t` passes — one-time prerequisite ordering is DNS A record → `certbot certonly --nginx -d api.yeyintlwin.com` → then let the deploy install the file.

### 9.7 Backup

**`infra/backup-core-db.sh`** (installed to `config/`, which the `find` preserves):

```sh
#!/bin/sh
set -eu
cd "$HOME/restaurant-order-system"
export CORE_ENV_FILE=../core-api.env
mkdir -p "$HOME/backups"; chmod 700 "$HOME/backups"
ts="$(date -u +%Y%m%dT%H%M%SZ)"; out="$HOME/backups/nightly-$ts.dump"
docker compose exec -T core-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d core -Fc' > "$out.part"
test -s "$out.part"
# Structural verification: an OOM kill or a full disk mid-dump produces a truncated
# file that pg_dump exits 0 on often enough to matter.
docker compose exec -T core-db pg_restore --list < "$out.part" > /dev/null
mv "$out.part" "$out"; chmod 600 "$out"
ls -1t "$HOME"/backups/nightly-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
touch "$HOME/backups/LAST_OK"     # means "a dump completed AND passed pg_restore --list"
```

The `.part` discipline means a truncated dump never replaces a good one and never counts toward retention. `LAST_OK` is what the deploy checks (§9.5, step 6 of the heredoc) — without it the nightly has **no failure signal at all**: `set -eu` exits early, output goes to a log nobody reads, and cron's MAILTO goes to a local mailbox on a box with no MTA.

**What is and is not protected:** bad migration / bad DELETE / logical corruption → yes (pre-deploy dump + up to 14 nightlies). Volume deleted / filesystem corruption → yes, back to the last nightly. **Instance lost → only back to the last deploy** (the nightlies live on the instance they protect). PITR → no, deferred to Phase 3 by decision. Cheapest complement, a checkbox not code: enable Lightsail automatic instance snapshots, understanding that a snapshot is crash-consistent, not logical, and that `--data-checksums` is what makes a corrupt restored page loud.

**`scripts/restore-drill.sh`** restores the newest nightly into `core_restore_check`, asserts `schema_migrations` matches the image, runs the schema-invariants assertions against it, prints row counts, drops it. **Run it once by hand before Phase 1 ships**, then monthly. A backup nobody has restored is not a recovery plan.

### 9.8 RESTORE — the runbook, literal and paste-safe

Every quote below is a real `'`. **Scenario A — roll back a bad migration:**

```sh
cd ~/restaurant-order-system
export CORE_ENV_FILE=../core-api.env

# 0. STOP THE WRITER FIRST, or you get a database half old and half new.
docker compose stop core-api

# 1. Prove the dump is READABLE before destroying anything.
ls -la ~/backups
docker compose exec -T core-db pg_restore --list < ~/backups/pre-deploy-<ts>.dump | head -30

# 2. Dump the CURRENT (broken) state anyway. Step 3 is irreversible.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d core -Fc' \
  > ~/backups/before-restore-$(date -u +%Y%m%dT%H%M%SZ).dump

# 3. Terminate, LOCK OUT reconnects, then drop. Three separate -c invocations:
#    chaining a terminate ahead of a DROP in one psql call means ON_ERROR_STOP aborts
#    halfway, leaving the app stopped and the restore not started.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "ALTER DATABASE core WITH ALLOW_CONNECTIONS false;"'
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '"'"'core'"'"' AND pid <> pg_backend_pid();"'
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS core;" -c "CREATE DATABASE core OWNER core_api_owner;"'

# 4. Restore, all-or-nothing. Do NOT pass --no-owner: the owner/app split is the point
#    of this schema and --no-owner collapses it.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U core_api_owner -d core \
  --exit-on-error --single-transaction' < ~/backups/pre-deploy-<ts>.dump

# 5. VERIFY BEFORE STARTING THE APP.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d core \
  -c "SELECT filename, applied_at FROM schema_migrations ORDER BY filename;" \
  -c "SELECT role, status, count(*) FROM users GROUP BY 1,2 ORDER BY 1,2;"'
```

**Step 6 is the one everybody gets wrong.** Read that ledger against the migrations in the running image. Dump **older** than the image (file on disk, no row): the runner will **re-apply** it on next start — if that migration is what broke you, you have restored nothing, so roll the image back in the same operation. Dump **newer** than the image (row, no file): the runner logs a WARNING and starts — deliberate, and this is the moment that decision earns its keep. Then `docker compose logs -f --tail 100 core-api` and `curl -fsS http://127.0.0.1:3200/health/ready`.

**Scenario B — fresh instance.** The dump contains grants referencing `core_api_app` but not the role itself. Before `pg_restore`: `docker compose up -d core-db` (initdb creates `core_api_owner`), then `CREATE ROLE core_api_app LOGIN NOINHERIT PASSWORD '<value from DATABASE_URL>';`. Skipping this yields a wall of *"role core_api_app does not exist"* and, with `--single-transaction`, a full rollback — loud, which is correct.

**Rotating database passwords — the order is not negotiable.** `POSTGRES_PASSWORD` is read by the image **only when it creates the data directory**; editing it afterwards changes nothing. (1) `ALTER ROLE core_api_owner PASSWORD '<new>';` in the database. (2) Then edit `~/core-api.env` in **both** places — `POSTGRES_PASSWORD` and the password inside `DATABASE_MIGRATION_URL`; core-api refuses to listen if they differ. (3) `docker compose up -d`. The **app** password needs none of this: edit `DATABASE_URL` and redeploy, since the runner issues `ALTER ROLE core_api_app … PASSWORD` on every boot.

### 9.9 Local development

```sh
docker run -d --name core-db-dev -e POSTGRES_USER=core_api_owner -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=core -p 127.0.0.1:5433:5432 postgres:16-alpine
```

Port **5433** so a locally installed Postgres on 5432 does not shadow it. `apps/core-api/.env` (gitignored by the existing `apps/*/.env` rule):

```dotenv
NODE_ENV=development
PORT=3200
HOST=127.0.0.1
API_PUBLIC_ORIGIN=http://localhost:3200
TRUSTED_PROXY_HOPS=0
POSTGRES_PASSWORD=devpassword
DATABASE_MIGRATION_URL=postgres://core_api_owner:devpassword@127.0.0.1:5433/core
DATABASE_URL=postgres://core_api_app:devpassword@127.0.0.1:5433/core
CORE_API_TEST_DATABASE_URL=postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres
```

Loaded by a copy of `loadDotEnv()` from `apps/customer-order/server.js:28-35` — eight lines, no `dotenv` dependency, and it already refuses to override an existing `process.env` value. **Small DEPARTURE: duplicated rather than shared**, because `packages/shared` is not in the root `workspaces` array and consuming it would mean changing the workspace layout for eight lines. Two controlled relaxations, both gated on `NODE_ENV !== 'production'` with the production branch byte-identical to the deployed rule: `API_PUBLIC_ORIGIN` may be `http://localhost:<port>`; `TRUSTED_PROXY_HOPS=0` is permitted and means "use the socket address".

`npm run db:reset` is the only script in the repo that destroys data, so it carries **three independent guards**: refuse if `NODE_ENV === 'production'`; refuse if the `DATABASE_MIGRATION_URL` host is not `localhost`/`127.0.0.1`/`::1`; require `--yes` on argv after printing host, port and database. It is also the sanctioned answer to the checksum surprise — against a database with real rows there is no such escape, and there should not be.

### 9.10 Bootstrap CLI

```sh
cd ~/restaurant-order-system
CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec core-api \
  node apps/core-api/scripts/create-platform-admin.js you@example.com
```

*Corrected by Plan 2b:* this recipe carried `CORE_ENV_FILE` alone. Compose validates
**every** service's `env_file` on every subcommand, so the one-variable form dies at
project load complaining about the *other* file — on a fresh instance, in the runbook
whose whole purpose is that there is nothing else to fall back on.

`docker compose exec`, **never `exec -T`** — the script reads the password from stdin with echo disabled and must **refuse and exit non-zero when `process.stdin.isTTY` is false**, otherwise `echo 'pw' | docker compose exec -T …` works and the password lands in shell history, which is exactly what "never from argv" exists to prevent. The path inside the container is `apps/core-api/scripts/…` because `WORKDIR /app` and the Dockerfile copies into `./apps/core-api`. The script connects with **`DATABASE_URL` (`core_api_app`)**, not the owner: it performs pure DML and `pg_advisory_xact_lock` is available to any role, so the superuser credential stays unused. The container must be running — which is exactly why an empty `platform_admin` set logs a warning and does **not** refuse to listen; that is the one deliberate exception to the repo's refuse-to-start convention, forced by the mechanism. Zero rows inserted exits non-zero. There is no `--force`. Neighbouring levers in the same runbook section: `unlock-account.js`, `set-password.js` — **neither exists**; both belong to **Plan 2d**, and identity-slice §11.1 records what that costs an operator today.

*Confirmed by Plan 2b (Tasks 7 and 16).* Every mechanism this section describes is implemented, so the next reader does not re-litigate it. `bootstrapPlatformAdmin` in `apps/core-api/repositories/auth/users.js` takes `pg_advisory_xact_lock`, refuses when a `platform.admin_created` audit row already exists, and writes its own audit row **inside** the same transaction — held by *"the bootstrap is MONOTONIC: the guard is an audit row, not the current state"* and *"a repeated address inside the same bootstrap is email_taken, not already_bootstrapped"* in `apps/core-api/test/auth-users.test.js`. The CLI half is held by four tests in `apps/core-api/test/scripts.test.js`, including *"the bootstrap CLI refuses a piped password and exits non-zero"* and *"…has no force flag and never reads a password from argv"*. The empty-`platform_admin` warning is in `server.js`, after `waitForDb` and before `createApp`: it warns and continues to listen, and a failure to count is caught and logged rather than rethrown.

### 9.11 Cutover order

1. DNS `A` record `api.yeyintlwin.com` → the Lightsail instance.
2. `sudo certbot certonly --nginx -d api.yeyintlwin.com` (the deploy's `nginx -t` fails without it).
3. Host prerequisites: 2 GB swap + `vm.swappiness=10`; record `free -m` and `docker stats` in `infra/README.md`; confirm the deploy user has `sudo` for `install`, `nginx -t`, `systemctl reload nginx`.
4. Create `~/core-api.env` mode 600 with the three secrets; confirm `~/restaurant-order-system.env` is untouched.
5. The atomic commit (§9.0), **outside service hours**.
6. Push. Watch the gate; on failure read `docker compose logs core-api` — the runner prints file, digest and verdict.
7. Bootstrap, then verify login.
8. Confirm the XFF probe passed in the deploy log and record the topology in `infra/README.md`.
9. Run the restore drill against the first pre-deploy dump. Do not skip it because it is the day everything worked — that is exactly when it is cheap.

### 9.12 Environment variables

**Required versus defaulted.** The three secrets (`POSTGRES_PASSWORD`,
`DATABASE_MIGRATION_URL`, `DATABASE_URL`) and `API_PUBLIC_ORIGIN` have **no code
default**: absent, the server refuses to listen. `TRUSTED_PROXY_HOPS` is required
when `NODE_ENV=production` and otherwise defaults to `0`. Everything else —
`PORT`, `HOST`, `TERMINAL_ALLOWED_ORIGINS` and the tunables — is **defaulted in
`config.js` to the same value the Compose file sets**, so the Compose entries are
documentation rather than load-bearing, and a developer running `node server.js`
with only a `.env` file gets production-identical behaviour. `config.test.js`
asserts the two sets agree, which is what stops the Compose file and `config.js`
drifting into two different defaults for the same knob.

**`POSTGRES_PASSWORD`** — *secret env file (~/core-api.env, mode 600, outside the deploy folder)*

- Purpose: Owner-role password at initdb; also used by in-container pg_dump/psql in the runbook.
- Validation: Non-empty, no default. The >= 24 character minimum applies **only when `NODE_ENV=production`** — the same treatment as the `DATABASE_MIGRATION_URL` username rule, so the local recipe in §9.9 stays valid. The equality check against the password component of `DATABASE_MIGRATION_URL` is **unconditional**; it is the detector for 'the operator edited one of the two files', and the server refuses to listen if they differ.

**`DATABASE_MIGRATION_URL`** — *secret env file*

- Purpose: The migration runner's dedicated max:1 pool, end()ed before listen. Keeping an idle superuser connection alive for the process lifetime would be a standing capability with no user.
- Validation: Parses as postgres:/postgresql:; has username AND password; non-empty database name; sslmode=require unless the host is core-db/localhost/127.0.0.1/::1. Username must be exactly core_api_owner ONLY when NODE_ENV=production (CI runs as postgres). Refuses to listen otherwise. Auth failure (28P01) is fatal with no retry and names the rotation runbook.

**`DATABASE_URL`** — *secret env file*

- Purpose: The runtime pool, and the credential the bootstrap CLI uses. Rotated automatically: the runner issues ALTER ROLE core_api_app … PASSWORD on every boot.
- Validation: Same parse rules; the username must be exactly core_api_app — which subsumes 'must not be core_api_owner' (pasting the migration URL here silently hands the app DDL rights and deletes the two-role design 0001_init.sql:498-517 exists to create) and keeps the DSN in agreement with the two places that hardcode the role name (§9.4's ALTER ROLE on every boot, and the 0001 DO block); must differ from DATABASE_MIGRATION_URL.

**`CORE_ENV_FILE`** — *compose interpolation (exported in the deploy heredoc as ../core-api.env)*

- Purpose: Points core-db and core-api at a SECOND secrets file, so epaper-hub and customer-order never receive the Postgres superuser DSN.
- Validation: Not read by the app. Compose fails to resolve env_file if unset in a folder with no .env — the deploy exports it once so every later `docker compose exec` agrees.

**`PORT`** — *compose default (3200)*

- Purpose: Listen port.
- Validation: Integer 1-65535.

**`HOST`** — *compose default (0.0.0.0) / image ENV*

- Purpose: Bind address. The 'not exposed past Nginx' property is delivered by the compose mapping 127.0.0.1:3200:3200 plus a structural test — the layer that can actually see the thing being guarded, exactly as infra/README.md:14 already describes for 3000 and 3100.
- Validation: Must be exactly 127.0.0.1, ::1 or 0.0.0.0 — anything else (a public IP typo) is fatal. This is an explicit CORRECTION to the settled 'HOST=127.0.0.1 whenever NODE_ENV=production' rule: a process bound to 127.0.0.1 INSIDE a container is unreachable from docker-proxy and the compose network, so that rule implemented literally yields a service that answers nothing.

**`NODE_ENV`** — *image ENV (production)*

- Purpose: Selects the production branch of the origin, proxy-hop and DSN-username checks.
- Validation: Not itself validated; it is the trigger for several other rules.

**`TZ`** — *compose default (UTC) on BOTH containers*

- Purpose: Makes container log timestamps, now() and psql output in every runbook command agree; a host-timezone change cannot shift anything.
- Validation: Not validated.

**`API_PUBLIC_ORIGIN`** — *compose default (https://api.yeyintlwin.com)*

- Purpose: The single allowed Origin for every cookie-authenticated non-GET and for login.
- Validation: Parses as a URL; no username, password, query or fragment; pathname === '/'; protocol https: when NODE_ENV=production, http: additionally allowed for localhost/127.0.0.1 otherwise. Same validation shape as normalizeBaseUrl (packages/epaper-hub-sdk/index.js:3-15).

**`TERMINAL_ALLOWED_ORIGINS`** — *compose default (empty string)*

- Purpose: Exact-origin allowlist for the narrow OPTIONS responder scoped to /api/terminal/* ONLY. Needed because kitchen_display and cashier_counter are browser apps: a cross-origin fetch carrying Authorization or application/json preflights, and a 405 to the preflight makes pairing fail as an opaque TypeError. Deliberately never emits Access-Control-Allow-Credentials, so cookie-authenticated routes stay uncallable cross-origin. Empty in Phase 1 — the responder ships inert. Phase 4 sets `https://kitchen.<domain>` and Phase 5 adds `https://counter.<domain>`, per decision 12 and §6.5.
- Validation: Comma-separated absolute https origins, each parsed with the same rules as API_PUBLIC_ORIGIN; duplicates and trailing paths are fatal. Empty is valid and means NO CORS headers are ever emitted.

**`TRUSTED_PROXY_HOPS`** — *compose default (1)*

- Purpose: Count from the RIGHT of X-Forwarded-For to derive the client IP for rate-limit buckets and audit_events.source_ip. A wrong value fails silently in both directions, so the deploy runs a forged-XFF probe as a gate.
- Validation: Integer >= 0. REQUIRED whenever NODE_ENV=production — retargeted from the settled 'HOST=127.0.0.1' trigger, which is unobservable inside a container; in production behind compose and Nginx a proxy is always present, so NODE_ENV is the containerization-proof trigger with the same fail-closed property.

**`SESSION_IDLE_SECONDS`** — *compose default (28800)*

- Purpose: Sliding idle window (one shift). Renewal is LEAST(now()+idle, absolute_expires_at) and runs at most once per 60 s per session, only after a request has passed every gate.
- Validation: Integer > 0.

**`SESSION_ABSOLUTE_SECONDS`** — *compose default (604800)*

- Purpose: Absolute session cap (7 days).
- Validation: Integer > 0 AND strictly greater than idle — otherwise every session violates user_sessions_idle_within_absolute (0001_init.sql:270) on its first renewal.

**`PAIRING_CODE_TTL_SECONDS`** — *compose default (900)*

- Purpose: Pairing-code lifetime; part of the stated 50-bit brute-force bound.
- Validation: Integer > 0.

**`TERMINAL_TOKEN_TTL_SECONDS`** — *compose default (7776000)*

- Purpose: Terminal bearer token lifetime (90 days). Terminals rotate when fewer than 14 days remain.
- Validation: Integer > 0.

**`LOGIN_RATE_PER_MINUTE`** — *compose default (30)*

- Purpose: The credential-independent global login bucket, sized to real staff volume, shedding with 429 BEFORE any scrypt work is queued. *Amended by Plan 2b:* it is **one of two** controls on semaphore occupancy, not "the" control — `login-global` sheds in process and nginx's `core_login` zone sheds at the edge, and neither substitutes for the other, since nginx cannot see `users.id` and the process cannot see a request nginx already dropped. Identity-slice §7.3 names the four that will bound occupancy once Plan 2d adds a second unauthenticated scrypt path.
- Validation: Integer > 0.

**`LOGIN_TIME_BUDGET_MS`** — *compose default (400)*

- Purpose: The fixed login time budget that makes every failure cause indistinguishable.
- Validation: Integer >= 250. Must exceed worst-case scrypt (~100 ms) with margin, or the 'byte-identical outcome after the same wall-clock budget' invariant leaks through overrun. Measured from slot acquisition, not request arrival (§5.1).

**`SCRYPT_SLOTS`** — *compose default (2)*

- Purpose: Concurrent scrypt hashes permitted; the queue depth is `4 ×` this value, and anything beyond is shed with 503 + `Retry-After: 5`.
- Validation: Integer 1–8. Above 8 on a 512 MB container the memory-hard parameters put the process inside OOM-killer range while Postgres shares the box.

**`PAIR_RATE_PER_MINUTE`** — *compose default (20)*

- Purpose: Credential-independent ceiling on `POST /api/terminal/pair` per client IP; the network half of the 50-bit pairing-code bound.
- Validation: Integer > 0.

**`ADMIN_MINT_RATE_PER_10MIN`** — *compose default (20)*

- Purpose: Shared ceiling on create-user and password-reset per calling `users.id`; the bound on the email-existence oracle (§5.8(b)).
- Validation: Integer > 0.

**`PAIRING_MINT_RATE_PER_10MIN`** — *compose default (30)*

- Purpose: Ceiling on pairing-code issuance per calling `users.id`.
- Validation: Integer > 0.

**`PASSWORD_ABUSE_THRESHOLD`** — *compose default (5)*

- Purpose: Consecutive `current_password_invalid` responses before the presenting session is deleted (§5.8(a)).
- Validation: Integer > 0.

**`ROTATE_RATE_PER_HOUR`** — *compose default (5)*

- Purpose: Ceiling on `POST /api/terminal/token/rotate` per `terminals.id`.
- Validation: Integer > 0.

**`AUDIT_RETENTION_DAYS`** — *compose default (365)*

- Purpose: Sweep horizon for audit_events (scripts/sweep-expired.js).
- Validation: Integer > 0.

**`DB_POOL_MAX`** — *compose default (8)*

- Purpose: Runtime pool size.
- Validation: Integer 1-20. Sized against max_connections=40, leaving room for psql, pg_dump and the migration connection.

**`CORE_API_TEST_DATABASE_URL`** — *CI job env and the developer's apps/core-api/.env — never in production compose*

- Purpose: Maintenance-database connection the test harness uses to create the template and the per-file clones. Its absence must never silently disable the tenant-isolation suite.
- Validation: Not validated at server startup. cloneTemplate() THROWS (never skips) when unset, printing the variable name, an example value and the setup lines. ci-contract.test.js asserts deploy.yml sets it and declares a postgres:16-alpine service.

**`CORE_API_SKIP_DB_TESTS`** — *developer shell only*

- Purpose: The single deliberate escape hatch for a laptop with no Postgres.
- Validation: When set to 1, DB suites report VISIBLE TAP skips and `pretest` becomes a no-op exit 0 so the ~12 database-free suites still run. ci-contract.test.js asserts the workflow NEVER sets it.


## 10. Deferred to later phases

Each entry carries the phase it belongs to. Three are cut permanently.

- shops.currency_code, currency_minor_unit and the seeded currencies reference table -- Phase 2, alongside the first price column. Nothing in Phase 1 prices anything. Cutting also deletes two live bugs the reviewers found: currency and minor_unit are two columns describing one fact with no constraint tying them (a Phase-2 settings form exposes currency and not the exponent, so JPY->USD stores $12.50 as either 13 or 1250 with the database accepting both), and currency_code is the sole determinant of how every historical integer amount is read, so one UPDATE silently restates months of revenue by 100x.
- shops.service_fee_bp and tax_bp -- Phase 2. Basis points are the right representation when they arrive, but Phase 1 computes no totals, and a shop created through a Phase-2 form that defers 'advanced settings' would silently apply the 10% + 10% inherited from order-store.js to real customers, with Math.round already applied so the error is unrecoverable from the stored total.
- shops.order_origin and its 59-character QR budget -- Phase 3, with the code that renders a QR. The budget is correctly derived (table-template.js:85 throws when modules+8 > 96, drawQr's scale is floor(96/(modules+8)), so a scannable panel needs scale >= 2 -> version <= 5 -> <= 84 bytes, minus '/t/' plus 22 characters = 59), but it is pinned to a template Phase 3 may redesign. Cutting it also removes an unverified per-shop domain claim that any company_admin could point at a competitor's branded ordering host.
- companies.slug and shops.slug -- Phase 2, if and only if admin routing commits to them. Neither is read in Phase 1; decision 7 guarantees no persistent data, so backfilling a NOT NULL UNIQUE slug across single-digit rows later is a five-minute job, not the 'manual data exercise' one draft feared.
- shop_tables.sort_order -- Phase 2, with the first screen that lists tables. The problem is real (label ordering puts '10' before '2') but Phase 1 ships no UI, and ADD COLUMN ... NOT NULL DEFAULT 0 does not rewrite the table in PG 11+.
- shop_tables.epaper_screen_key -- Phase 3. It was meant to break the epaperId === tableNumber coupling in epaper-client.js, but it does not: the coupling lives in packages/epaper-hub-sdk/index.js:24, which hard-rejects any epaperId outside 1..12, as does table-template.js validateInput. The mapping belongs in the same change that widens the SDK contract and decides whether it is scoped to a shop or to a specific epaper_hub terminal.
- shop_tables.seat_count -- Phase 3. Covers belong on the visit row, not the table.
- terminal_tokens.superseded_at, replaced_by_token_id, the self-referential composite FK, its partial unique index, and the entire reuse-detection state machine -- the phase that first has real hardware to rotate. It is the most intricate machinery in any of the three drafts and no client can exercise it for at least 76 days after the first real device exists. Worse, reviewers showed the crash-retry branch is attacker-steerable and the successor-was-used branch is a documented false positive that costs a shop its evening. Phase 1 keeps pairing, expiry, revocation with a reason, and a simple overlapping rotate endpoint -- a complete and testable story.
- terminal_pairing_codes.attempt_count -- cut permanently, not deferred. A wrong guess matches no row, so it can never be incremented by an attacker; it caps only resubmission of a code the submitter already holds.
- users.session_epoch and terminals.token_epoch -- cut permanently. Epochs earn their keep only when a credential caches authorization state. Here role, company and shopIds are re-read on every request, so the only remaining need is credential change, covered by the single users.sessions_valid_from column.
- users.password_expires_at and a single-use invite-token table -- Phase 2, with the staff-management screens. Phase 1 creates users through the API with must_change_password enforced in the resolver; a dormant-invite expiry matters when there are invites to be dormant.
- Password reset / forgot-password -- Phase 2; identity-slice §1 brings the self-service half forward into Plan 2d. Phase 1 recovery is scripts/unlock-account.js and scripts/set-password.js over docker compose exec, which is honest for a platform with one operator. *Amended by Plan 2b:* neither script exists yet — both are **Plan 2d**, and until 2d lands there is no recovery lever at all beyond POST /api/platform/admins from a second admin session. Identity-slice §11.1 states the consequence for a mistyped address.
- user_sessions.user_agent -- cut permanently. Personal data with no named requirement in Phases 2-8; last_seen_ip is retained because it is the only leak signal available.
- The migration runner's '-- migrate: no-transaction' escape hatch for CREATE INDEX CONCURRENTLY -- the phase that first needs a concurrent index build. SET LOCAL is silently ignored outside a transaction block, so the hatch would strip lock_timeout from exactly the migrations that run long and take heavy locks. Phase 1's largest table holds a few dozen rows; no index build can block anything.
- Pairing confirmation handshake (device shows a 4-digit number the issuer must confirm) -- Phase 2, with the admin UI that could display it. consumed_at is already recorded, so the issuer-visible 'paired at 19:04' view is available the moment there is a screen to show it on.
- Postgres RLS itself -- deferred by decision 3. What Phase 1 buys is the ability to add it as a pure migration for the six RLS-ready tables (see 3.3): company_id NOT NULL everywhere, composite FKs keeping it consistent, and withTenantScope() already holding a transaction boundary where SET LOCAL app.company_id will go.
- Zero-downtime deploys -- Phase 4, when the kitchen display holds long-lived realtime connections. docker compose up -d recreates a single replica and costs 2-5 seconds of connection refusal; Nginx should be configured to retry the upstream so that surfaces as a retry rather than a bare 502.
- Continuous archiving / PITR -- Phase 3, when orders and money enter the database. Phase 1 ships nightly pg_dump -Fc plus one unconditional pre-deploy dump copied off the box, which is the only rollback for a destructive migration on a push-to-main pipeline.

## 11. Accepted risks

These are not open questions. Each was raised during review, considered, and
accepted for Phase 1 with the reasoning recorded.

Where the same risk appears in both subsections, §11.2 carries the current
numbers — it was written later and against the finished surface.

### 11.1 Schema, isolation and credentials

- Tenant isolation is repository discipline plus tests, not a database guarantee. withTenantScope(), the tenantQuery descriptor, the composite-FK web and the three enforcement suites shrink the hole substantially, but one SELECT that reaches the pool another way still leaks. This is the direct, accepted cost of deferring RLS, and it should be revisited BEFORE the second real tenant onboards, not after.
- RLS is a pure migration for the six RLS-ready tables ONLY (see 3.3). users, user_sessions, terminal_tokens and terminal_pairing_codes are read to DISCOVER the tenant, before any app.company_id could be set, so a uniform equality policy on them makes every login and every authenticated request return zero rows. They are named as an explicit pre-tenant allowlist reached only through repositories/auth/, destined for a BYPASSRLS role or SECURITY DEFINER functions. That decision is written down now so it is not discovered mid-migration, but it is not implemented, and no draft's claim that RLS is unconditionally 'a pure migration' survives contact with the login path.
- The composite-FK web is the strongest control in the schema and it is only as durable as one pg_constraint test. A later migration adding a plain single-column FK silently drops the guarantee for that relationship. That test must be treated as load-bearing -- never skipped, never made advisory.
- shops.time_zone and business_day_rollover_hour are mutable with no history and no effective dating, while business_date will be the primary bucketing key for every Phase-3 order and every Phase-6 report. The forward-only policy (business_date computed and STORED at write time, never recomputed) is deliberate and correct for accounting, but it means an owner who corrects a timezone sees yesterday's report unchanged and reads it as a bug. It needs documenting where operators can see it, and Phase 1 MUST log a `shop.updated` audit event (§5.9) so the change is at least attributable.
- The DST resolution rule is specified but untested against real data. Nonexistent local times (spring forward) resolve to the first instant after the gap; ambiguous local times (fall back) resolve to the earlier occurrence; the next boundary is always recomputed from the zone and must be strictly greater than now. The existing carry-forward at apps/customer-order/server.js:66 ('if (rollover <= instant) rollover += DAY_MS') is FORBIDDEN going forward -- with a skipped hour it silently jumps a whole day, doubling every visit's life and breaking the README's guarantee that a photographed QR stops working at rollover. Getting this wrong looks like sporadic off-by-one-day report bugs, and it is simultaneously a credential expiry.
- Terminal tokens are bearer credentials on tablets sitting in a restaurant, and both kitchen_display and cashier_counter are browser apps in this repo -- so the credential must live in JS-reachable storage, strictly less protected than the HttpOnly staff cookie. Binding is to a shop and a terminal kind, not to a device identity; there is no attestation. Rotation, per-token revocation, terminal suspension and last_seen_ip are compensating controls, not prevention. Delivering the terminal credential as a __Host- cookie with SameSite=Strict is worth evaluating in the phase that builds those apps.
- A pairing code is returned in one HTTP response body, a narrow and deliberate exception to the repo's 'raw credentials never appear in a response body' rule (there is no out-of-band channel to a kitchen tablet). It carries 50 bits rather than 128, and it can land in a browser network log or admin client state. Whoever redeems it first silently wins: Phase 1 records consumed_at but ships no screen showing the issuer that it was consumed, so a code read aloud or left on screen can be taken by someone else and the manager sees only a generic failure and reissues.
- Per-account backoff is still a nuisance denial-of-service against a known address. Exponential-and-bounded with reset-on-success is chosen specifically so a correct password always eventually works, but a determined attacker can hold one operator in a repeating 15-minute penalty. The CLI unlock script is the answer and it requires shell access on the box.
- In-process rate limiters do not survive a restart and are not shared across containers. They are a burst control; the durable half is the per-account backoff in Postgres, and the network half is an Nginx file that must actually be deployed. If infra/nginx/api.conf is not shipped by deploy.yml, the loss is invisible -- CI stays green and startup validation cannot see it.
- Postgres joins docker-compose on the same small Lightsail box as several unrelated containers, and this is the release where persistent business data starts to exist. Memory pressure invoking the OOM killer during a write is the most likely cause of real loss. Mitigations that MUST land with this phase: pin postgres:16-alpine (an unpinned tag eventually pulls a new major, refuses to start against the existing PGDATA, and presents as a total outage), publish no host port at all, use a named volume, set a modest max_connections and shared_buffers, add host swap, and take an unconditional pg_dump -Fc immediately before the migration step of every deploy with the dump copied OFF the box. A dump that lives only on the instance it protects is not a backup, and a backup nobody has restored is not a recovery plan.
- Changing POSTGRES_PASSWORD in ~/core-api.env after the volume is initialised has no effect -- Postgres reads it only when creating the data directory. An operator rotating it will believe it changed, the app will keep working with the old value, and the discrepancy surfaces months later during an incident. Rotation is ALTER ROLE first, env file second, and this needs writing into infra/README.md.
- The migration runner holds a pg advisory lock for the whole run. A container killed while holding it blocks every subsequent deploy until Postgres reaps the connection -- a confusing failure at the worst moment. The bounded pg_try_advisory_lock retry (60 s, then exit non-zero with 'another instance is migrating') makes it diagnosable rather than an indefinite hang. The runner must also send each file as one query string rather than splitting on semicolons, or the dollar-quoted trigger function and DO block in 0001 are cut in half.
- Checksum enforcement blocks editing an already-applied migration. Intentional, and it will surprise the first person who fixes a typo in 0003 locally and then cannot start against an existing database.
- last_seen_ip is retained on sessions, tokens, pairing codes and audit rows with no retention policy beyond the audit sweep. Personal data accumulating by default.
- Nothing in Phase 1 reads shops.time_zone or business_day_rollover_hour. Removing their DEFAULTs forces an explicit decision at creation, which is the main mitigation, but a mistyped IANA name still passes the database (zone validation is STABLE, so it cannot be a CHECK) and would first surface as an exception inside a Phase-3 scheduled job, breaking one shop's business day with no obvious cause. The repository's Intl validation is the only guard and a psql insert bypasses it.

### 11.2 Surface and operations

- The email-existence oracle is reduced, not eliminated, and this is a knowing departure from the settled 'identical response whether or not the email collides' rule — that rule is unimplementable, because the caller can list the collection immediately afterwards, so a fabricated 201 closes the oracle for zero requests while handing an administrator credentials that never work. With a global users_email_key, any authenticated admin can learn whether an address is registered anywhere on the platform: 20 probes per 10 minutes per user id, every probe audited. The bucket is in-process, so it also resets on every `docker compose up -d`, which the pipeline does on every push to main. Revisit before the second real tenant onboards — the same trigger §11.1 names, and the fix afterwards is a unique-key change plus a login-flow rewrite against live sessions.
- Principal-keyed rate limiters (create-user, password-reset, pairing-code mint, password-change abuse, rotate) are in-process only. The settled schema has no rate-limit table and this design does not add one, so the durable half remains the per-account login backoff in Postgres and the network half remains infra/nginx/api.conf. Consequence: a redeploy resets every principal bucket, and a second core-api container would double every limit. Both are acceptable for a single-replica personal deployment and neither is detectable from inside the process; the deploy-time limit_req probe is the only evidence that the network layer exists at all.
- Rotation always mints a successor and never refuses on supersession grounds — a knowing departure from the settled 'an already-superseded token may not rotate: 401', which cannot be implemented because superseded_at and replaced_by_token_id were cut from the schema and the only available approximation (testing whether expires_at was already shortened) bricks the exact device the 10-minute overlap exists to save. The residual is orphaned successor tokens: a device that retries N times leaves N-1 unused 90-day tokens, so terminal.activeTokenCount will occasionally read 2 or 3 for a healthy terminal, and an operator who reads that as compromise will revoke and dark the display. Bounded by 5 rotations/hour/terminal plus an audit row per rotation; the admin UI must explain it, or Phase 4 should sweep never-seen successors older than 24 hours.
- 403 current_password_invalid remains an online password-verification oracle for anyone holding a stolen session. Moving its throttle off users.locked_until removes the lockout-DoS-against-the-victim primitive (that was the fix), but the oracle itself stays: the attacker learns the plaintext, which is worth something for credential stuffing elsewhere even though it yields nothing new inside this platform. The per-user bucket and the session-deletion-on-abuse response are the only controls; there is no second factor in Phase 1.
- Two narrow, deliberate exceptions to 'raw credentials never appear in a response body' ship in Phase 1: the pairing code and the create-user/password-reset one-time password. Both are forced by the absence of any out-of-band channel — invites and email delivery were cut to Phase 2 — and both can land in a browser network log or in admin client state. Phase 1 records consumed_at but ships no screen showing the issuer that a code was consumed, so a code read aloud can be taken by someone else and the manager sees only a generic failure and reissues.
- The single not_found code makes the API materially harder to debug: a typo'd path, a resource in another tenant and a genuine permission gap are indistinguishable to a client AND to the developer building the Phase-2 UI. requestId plus the server log is the only way to tell them apart, which makes the log line and its retention load-bearing for developer productivity, not just for incidents.
- Tenant isolation is repository discipline plus tests, not a database guarantee — the direct, accepted cost of deferring RLS. One SELECT that reaches the pool another way still leaks. Rules C1/C2/C5 and the eight-mode sweep shrink the hole substantially, and the C6 export-count budgets stop the exempt zones expanding silently, but repositories/auth/ is exempt from the mechanical sweep BY CONSTRUCTION (it is the code read to discover the tenant), so the five most security-critical modules in the service get named per-behaviour tests instead. RLS remains a pure migration for the six RLS-ready tables only (see 3.3); users, user_sessions, terminal_tokens and terminal_pairing_codes need a BYPASSRLS role or SECURITY DEFINER functions, and no draft's claim that RLS is unconditionally 'a pure migration' survives contact with the login path.
- The composite-FK web is the strongest control in the schema and is only as durable as one pg_constraint test. Its exception lists — five tables in S1, thirteen named FKs in S2, three CASCADE entries in S2b — are the pressure point: the natural repair when a Phase-2 table trips the rule is to append a name, not to fix the table. Every exception carries a positive assertion and a reason string specifically to make that append visible in review, but the mechanism is a code-review norm, not a control.
- Nothing in Phase 1 exposes the audit trail over HTTP (GET /api/admin/audit-events is cut), so the only accountability mechanism in the system is readable only by someone with psql on the box — the same person who deploys the code and holds platform_admin. Separation of duties is zero in Phase 1 and that is a property of the deployment, not of this API surface.
- I cannot see the Lightsail instance size, current free memory, installed nginx version, or whether the deploy user has passwordless sudo. Every tuning number in the compose file (shared_buffers=128MB, max_connections=40, mem_limit 512m) assumes at least 2 GB RAM plus 2 GB swap and is wrong on a 512 MB instance. api.conf uses the old `listen 443 ssl http2` form precisely because nginx >= 1.25.1 cannot be confirmed. The sudo-dependent steps fail the deploy if sudo is unavailable — correct behaviour, but it surfaces as a red build on the first Phase-1 push rather than as a prerequisite check.
- Splitting core's secrets into ~/core-api.env and putting core-db on its own network closes the acute exposure (a superuser DSN in the environment of an internet-facing container that logs full URLs), but epaper-hub and customer-order still share ~/restaurant-order-system.env with each other, and core-api still joins the default network so Nginx can reach it. A compromise of core-api itself therefore still reaches the other services' network namespace. Per-service env files for the remaining three are deferred, not solved.
- Retention of consumed pairing codes and revoked terminal tokens is unspecified in the settled schema, so their consumed_from_ip and last_seen_ip persist indefinitely; AUDIT_RETENTION_DAYS covers only audit_events, and session/pairing rows age out with their own expiry sweep. A CREDENTIAL_HISTORY_RETENTION_DAYS knob is the obvious answer but the sweep semantics are a schema decision outside this design. Personal data accumulates by default.
- A mistyped IANA time zone inserted directly with psql bypasses the repository's Intl validation entirely, and no deployment control can prevent it. 'Never create shops with psql' is a rule, not a control, and it will first surface as an exception inside a Phase-3 scheduled job affecting one shop's business day. Related: shops.time_zone and business_day_rollover_hour are mutable with no history and no effective dating while business_date is forward-only, so an owner who corrects a timezone sees yesterday's report unchanged and reads it as a bug — hence the mandatory shop.updated audit row and the infra/README.md sentence.
- The DST resolution rule (nonexistent local times resolve to the first instant after the gap; ambiguous ones to the earlier occurrence; the next boundary always strictly greater than now) is specified and unit-tested but has never run against real data, and the existing carry-forward at apps/customer-order/server.js:66 is FORBIDDEN going forward because a skipped hour makes it jump a whole day. Getting this wrong looks like sporadic off-by-one-day report bugs and is simultaneously a credential expiry.
- Terminal tokens are bearer credentials on tablets in a restaurant, and both kitchen_display and cashier_counter are browser apps, so the credential must live in JS-reachable storage — strictly less protected than the HttpOnly staff cookie. Binding is to a shop and a terminal kind, not to a device identity; there is no attestation. Rotation, per-token revocation, terminal suspension and last_seen_ip are compensating controls, not prevention. Delivering the terminal credential as a __Host- cookie with SameSite=Strict is worth evaluating in the phase that builds those apps.
- Platform scope has no database-level restraint: any bug in repositories/platform/ reads every tenant. The scope-selection model plus the C6 budget hold it at ten functions today, but it grows with every later phase that adds cross-tenant reporting, and the role is held by the same person who deploys the code.
- The concurrency key, the nginx rollback branch, the volume-gated pre-deploy dump and the crontab fix each close a specific way the FIRST Phase-1 deploy fails silently or half-succeeds. None of them has been exercised against the real box, and three of the four (concurrency, nginx rollback, crontab-on-a-bare-box) are only observable under conditions a normal deploy does not reproduce — so the doneChecklist items that require deliberately creating those conditions are the only evidence they work.

## 12. Definition of done

Each item is verifiable by running a command.

- [ ] node -v prints v20 or later, and `node -e "const{Client}=require('pg');const c=new Client(process.env.CORE_API_TEST_DATABASE_URL);c.connect().then(()=>c.query('show server_version_num')).then(r=>{console.log(r.rows[0]);return c.end()})"` prints server_version_num >= 140000
- [ ] npm --prefix apps/core-api ci && npm --prefix apps/core-api test  →  '# fail 0' AND '# skip 0'. The skip count is part of the pass condition.
- [ ] CORE_API_SKIP_DB_TESTS=1 npm --prefix apps/core-api test  →  '# fail 0' with a NONZERO skip count, and every pure suite (password, tokens, cookies, scope, authorization, route-auth, source-structure, ci-contract) still reported as run — proving pretest no-ops instead of aborting the whole test phase
- [ ] npm test at the repo root is green and its output includes apps/core-api
- [ ] npm --prefix apps/epaper-hub test is green — this is what proves the four-file compose move landed completely (deploy-config.test.js lines 18, 32 and 204 were repointed, not relaxed)
- [ ] `docker compose -f docker-compose.yml build epaper-hub` succeeds — a REAL build, not `config` (which normalises a broken build context and still prints ok) and not `build --dry-run` (which never executes a COPY layer, so a root context would fail only at run time)
- [ ] test "$(grep -c limit_req infra/nginx/api.conf)" -ge 2  →  exit 0
- [ ] BREAK 1 — append `CREATE TABLE leaky (id uuid PRIMARY KEY, shop_id uuid NOT NULL);` to migrations/0001_init.sql; the run fails and ONLY test/schema-invariants.test.js reports 'not ok'; git checkout restores green
- [ ] BREAK 2 — add `const { Pool } = require("pg");` to repositories/shops.js; ONLY test/source-structure.test.js reports 'not ok'
- [ ] BREAK 3 — change any one route's auth to 'public'; ONLY test/route-auth.test.js reports 'not ok'
- [ ] BREAK 4 — in repositories/terminals.js flip the descriptor to `shopScoped: false` AND add `shop_id = $2` bound from the caller's argument; the descriptor assertion is satisfied, Mode 1 PASSES in both directions, and ONLY Mode 3 (shop containment) reports 'not ok'. (Deleting `company_id = $1`, or dropping `shop_id = ANY($2)` while leaving the descriptor untouched, is NOT a valid probe — tenantQuery's own descriptor assertion absorbs both before any mode runs.)
- [ ] BREAK 5 — leave the scoped query intact but return its rows from a second, unscoped `withUnscopedConnection` read of the same table; ONLY Mode 2 (row provenance) reports 'not ok'
- [ ] BREAK 6 — in repositories/auth/scope-materialize.js drop `JOIN shops s ON s.id = us.shop_id AND s.status = 'active'`; ONLY Mode 8 (fail-closed on suspension) reports 'not ok'
- [ ] BREAK 7 — delete the `services: postgres:` block from .github/workflows/deploy.yml; ONLY test/ci-contract.test.js reports 'not ok'
- [ ] git grep -n "dangerouslyQueryAcrossTenants" -- apps/core-api | grep -v "apps/core-api/repositories/platform/" | grep -v "apps/core-api/test"  →  no output
- [ ] git grep -l 'require("pg")' -- apps/core-api  →  only apps/core-api/db/pool.js;  git grep -l 'require("express")' -- apps/core-api  →  only apps/core-api/http/router.js
- [ ] git grep -nE 'process\.env\.[A-Z_]*(KEY|SECRET|PASSWORD|TOKEN)[A-Z_]*\s*(\|\||\?\?)\s*["'"'"'`]' -- apps/core-api  →  no output
- [ ] git grep -n "BOOTSTRAP_ADMIN" -- .github apps/core-api docker-compose.yml  →  no output
- [ ] git check-attr text eol -- apps/core-api/migrations/0001_init.sql  →  'text: set' and 'eol: lf';  grep -q 'apps/\*/\.env' .dockerignore  →  exit 0
- [ ] ls apps/core-api/test | grep -v '\.test\.js$'  →  no output (helpers live in testing/, the template builder in scripts/)
- [x] docker compose exec core-api node apps/core-api/scripts/create-platform-admin.js first@example.test exits 0 and prints 'created'; a second run with a different address exits NON-ZERO; DELETE the platform_admin row and re-run — still non-zero (the audit_events guard is monotonic, not current-state) — *Run on production 2026-08-05. Clauses 1 and 2 were exercised against the live box: `yeyintlwin.dev@gmail.com` was created and printed `created platform administrator … (80788b01-…)`, and a second run at `second@example.test` was refused with "this platform has already been bootstrapped, and that is permanent by design". **Clause 3 was NOT run in production and must not be** — it deletes the only administrator on an internet-facing service to prove a point already proved elsewhere. It is covered by `auth-users.test.js`'s "the bootstrap is MONOTONIC" against a cloned test database, which deletes the row and asserts the third attempt still returns `already_bootstrapped`.*
- [x] echo 'pw' | docker compose exec -T core-api node apps/core-api/scripts/create-platform-admin.js x@example.test exits NON-ZERO refusing to read a password from a pipe and telling the operator to use an interactive terminal (no password may reach shell history). *Amended by Plan 2b: this line quoted a 'requires a TTY' message; the shipped wording is different and the message is pinned by `scripts.test.js`, so the checkbox moved rather than the message. Confirmed on production 2026-08-05 — `exec -T` printed the usage block and exited non-zero rather than prompting.*
- [ ] *Both boxes above are MANUAL, on the box. The mechanisms behind them are implemented and covered in-suite as of Plan 2b — see §9.10's confirmation note for the six tests — so a failure here is a deployment fact, not an unwritten feature.*
- [ ] On the box: `curl -fsS -m 5 --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health` returns 200, and 20 rapid POSTs to /api/admin/auth/login through that same --resolve chain produce at least one 429 — proving nginx limit_req is live in production, not merely present in a file
- [ ] On the box, BEFORE any limit_req burst from the same address: a login POST for `xff-probe@invalid.test` carrying `X-Forwarded-For: 203.0.113.99` produces an audit_events row selected by `detail->>'email'` (never "the most recent row") whose source_ip is NEITHER 203.0.113.99 (forgeable) NOR NULL (derivation collapsed to the shared bucket) — and the row must exist at all, since a shed request writes nothing and would otherwise pass vacuously
- [ ] On the box: `sudo nginx -T | grep -c 'set_real_ip_from\|real_ip_header'` → 0, and count(proxy_pass) equals count(include .*core-api-proxy.conf) in api.yeyintlwin.com.conf
- [ ] Kill the deploy mid-migration (docker kill core-api while it holds the advisory lock), then re-run the deploy: it succeeds within the 60 s bounded retry with no manual pg_terminate_backend — proving tcp_keepalives_idle=20 reaps the orphaned backend
- [ ] scripts/restore-drill.sh run once by hand against the first pre-deploy dump: it restores, asserts schema_migrations matches the image, passes the schema-invariants assertions, prints row counts and drops the scratch database
- [ ] Scenario A of the §9.8 runbook rehearsed once against a THROWAWAY database name (substitute `core_scenario_a` for `core` in steps 3–5) before the first production deploy, with a dated receipt at `~/backups/SCENARIO_A_REHEARSED`. **Never rehearse Scenario A verbatim on the box — step 3 drops the production database.**
- [ ] **PLAN 2d.** `scripts/unlock-account.js` against a fixture user whose locked_until is in the future clears locked_until and failed_login_count and writes an audit row; `scripts/set-password.js` writes a valid PHC hash, bumps sessions_valid_from, and a session minted before the change returns 401 afterwards. *Neither script exists; this box cannot be ticked before Plan 2d and is marked so it is not read as a regression.*
- [ ] On a box with NO existing user crontab, `crontab -l | grep -q sweep-expired.js` exits 0 after a full deploy, and running the sweep by hand deletes an expired session while leaving a CONSUMED pairing code in place
- [ ] On a box with NO existing user crontab, a full deploy succeeds end to end and `crontab -l | grep -q backup-core-db.sh` exits 0
- [ ] grep -q TRUSTED_PROXY_HOPS infra/README.md && grep -q 'ALTER ROLE' infra/README.md && grep -q business_date infra/README.md && grep -q 'outside service hours' infra/README.md && grep -q create-platform-admin apps/core-api/README.md && grep -q CORE_API_TEST_DATABASE_URL apps/core-api/README.md

## Appendix A — `migrations/0001_init.sql`

```sql
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
```
