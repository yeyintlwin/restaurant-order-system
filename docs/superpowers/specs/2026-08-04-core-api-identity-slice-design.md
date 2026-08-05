# Core API — Identity Slice Design (Phase 1, Plan 2)

Authentication, tenant and user administration, and the two credential-recovery
flows: forgot-password and email verification.

**Parent spec:** [2026-07-29-core-api-phase1-design.md](2026-07-29-core-api-phase1-design.md).
Section references written bare (§5.4, §8.5) point at that document. This one
records only what is **new or amended**; everything it does not mention stands as
written there.

---

## 1. Why this exists

Plan 1 shipped `apps/core-api` as a service that boots, validates its
configuration, migrates before it listens, answers `/health` and `/health/ready`,
and carries the tenant choke point with the enforcement suites that keep it
honest. It ships **no authentication of any kind**: no `lib/password.js`, no
`lib/tokens.js`, no `http/authenticate.js`, no `repositories/auth/*`, and exactly
one route file. The only account that can exist is none, because
`scripts/create-platform-admin.js` was deferred.

This slice makes the platform usable by humans. At the end of it, a platform
administrator exists, can create companies and their owners, those owners can
create shops and staff, everybody can sign in, and anybody who loses their
password can recover it without a database console.

### 1.1 In scope

- Password hashing, sessions, login, logout, logout-all, `me`, password change.
- `POST /api/admin/scope` — a platform admin selecting the company they act inside.
- `/api/platform/companies` (4 routes) and `/api/platform/admins` (5 routes).
- `/api/admin/users` (6 routes) and `/api/admin/shops` (4 routes).
- **New:** forgot-password, reset-password, email verification (4 routes).
- **New:** two server-rendered landing pages under `/admin`.
- `lib/client-ip.js`, the audit writer, the §5.7 limiter roster and its boot check.
- `scripts/create-platform-admin.js` and `scripts/sweep-expired.js`.
- The behavioural forged-XFF probe in the deploy pipeline.

### 1.2 Out of scope

`shop_tables` and its 4 routes; `terminals` and its 6 routes;
`/api/terminal/pair` and `/api/terminal/token/rotate`. They are the next plan.
Nothing about menus, orders, e-paper or the admin SPA.

The consequence worth stating: **`POST /api/terminal/pair` does not join the
public route set in this slice.** The set is eight here and becomes nine when the
terminal plan lands.

---

## 2. Settled decisions

Each was an explicit fork. Recorded so nobody re-derives them.

| # | Decision | Rejected alternative |
| --- | --- | --- |
| 1 | **Roles are unchanged** — `platform_admin`, `company_admin`, `shop_manager`, `staff`. The Burmese-language role names map onto these four exactly: admin, ဆိုင်ပိုင်ရှင်, ဆိုင်မန်နေဂျာ, ဆိုင်ဝန်ထမ်း. | Collapsing to three by dropping `shop_manager`, which would require a `0002_` rewrite of the `users.role` CHECK. |
| 2 | **Account creation is unchanged**: an administrator creates the user and the API returns a server-minted `initialPassword` once, with `must_change_password = true`. The password reaches the person by whatever channel the administrator already uses. | Invite links, which §10 anticipated ("a single-use invite-token table — Phase 2") but which would put email on the critical path of onboarding a restaurant that may not have staff email addresses at all. |
| 3 | **Email verification gates forgot-password and nothing else.** An unverified user is otherwise completely normal. | A blocking gate in the resolver like `must_change_password`, which would lock out every staff member without an email address. |
| 4 | **Email is delivered over SMTP via `nodemailer`.** | Resend or Amazon SES over plain HTTPS with no new dependency. |
| 5 | **A delivery retry revokes the token row and mints a successor**, carrying `delivery_attempts + 1`. | An outbox holding the rendered message, which would store live reset tokens in plaintext — and therefore in the pre-deploy dump that parent decision 14 uploads as a 14-day GitHub artifact. |
| 6 | **The link carries the token in the URL fragment.** | A query string, which nginx and any access log would capture — the exact pattern §5.3 condemns at `apps/epaper-hub/server.js:89`. C7's `CREDENTIAL_QUERY` rule blocks `req.query.<anything>` repo-wide anyway. |
| 7 | **The landing pages are served by core-api under `/admin`, with a second frozen header table and a hash-based CSP.** | A nonce (impossible: `respond.js` is Tier-1 pure and has no RNG); loosening the existing table (forbidden by `respond.test.js:49-52`); or pointing the link at a UI that does not exist yet. |
| 8 | **Email bodies are English only.** No `users.locale` column. | A bilingual body, or a locale column whose write path this slice would then have to design. |
| 9 | **`users.email` is not patchable and no email-change route is added.** | A `PATCH` accepting `email`. See §11.1 for the accepted residual. |
| 10 | **The behavioural forged-XFF probe lands in `deploy.yml` in this slice.** | Deferring it again, which would leave `deploy-config.test.js:731-741`'s instruction answered by deletion rather than by the assertion it demands. |
| 11 | **Parent §10's "Password reset / forgot-password — Phase 2" is amended, not honoured.** | Re-cutting the slice to exclude recovery, which was the explicit request. |

---

## 3. Schema — the `0002_` migration

Three changes. `0001_init.sql` is **not touched**: it is applied in production with
its checksum recorded, so editing it yields `checksum_mismatch` and a 503 readiness.

### 3.1 `users.email_verified_at`

```sql
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
```

Nullable; `NULL` means unverified. No backfill: production holds zero user rows
today, because `create-platform-admin.js` ships in this very slice. `ADD COLUMN`
with no default does not rewrite the table in PG 11+, so the additive-only
discipline holds.

### 3.2 `user_email_tokens`

```sql
CREATE TABLE user_email_tokens (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose             text NOT NULL
                        CHECK (purpose IN ('password_reset', 'email_verify')),
  token_hash          bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  -- The address this token was actually sent to, snapshotted. Consumption
  -- requires it still equal users.email, so the bound mirrors users.email's:
  -- an over-long value is not an error, it is a silently unredeemable row.
  sent_to_email       text NOT NULL
                        CHECK (length(sent_to_email) BETWEEN 3 AND 254),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  consumed_from_ip    inet,
  revoked_at          timestamptz,
  revoked_reason      text CHECK (revoked_reason IS NULL
                                  OR revoked_reason IN ('superseded', 'delivery_retry',
                                                        'delivery_exhausted', 'password_changed',
                                                        'user_suspended', 'swept')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_from_ip     inet,
  -- Delivery state. The raw token is NEVER stored, so a retry revokes this row
  -- and mints a successor rather than re-sending this one (decision 5).
  delivery_attempts   integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivery_next_at    timestamptz,
  delivery_sent_at    timestamptz,
  delivery_last_error text CHECK (delivery_last_error IS NULL
                                  OR length(delivery_last_error) <= 500),
  CONSTRAINT user_email_tokens_expires_after_creation CHECK (expires_at > created_at),
  -- The two end-state invariants 0001 enforces on both of its sibling
  -- credential tables. Postgres, not discipline.
  CONSTRAINT user_email_tokens_single_end_state
    CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT user_email_tokens_revocation_is_explained
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE UNIQUE INDEX user_email_tokens_hash_key
  ON user_email_tokens (token_hash);

CREATE UNIQUE INDEX user_email_tokens_live_key
  ON user_email_tokens (user_id, purpose)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX user_email_tokens_delivery_due_idx
  ON user_email_tokens (delivery_next_at)
  WHERE delivery_sent_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX user_email_tokens_sweep_idx
  ON user_email_tokens (expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
```

**`revocation_is_explained` is the one doing real work.** Without it,
`revoked_reason = 'superseded'` with `revoked_at` still `NULL` is a row that
claims to be dead while it goes on occupying the `live_key` slot — precisely the
brick this table is shaped to avoid.

**The migration must repeat `SET LOCAL lock_timeout` and `statement_timeout`.**
`SET LOCAL` is transaction-scoped and the runner opens a fresh `BEGIN` for every
file, so `0001`'s settings are not inherited. They bind harder here than they did
there: `ALTER TABLE users` takes `ACCESS EXCLUSIVE` on a table that already
exists, so with no bound it queues behind any open transaction touching `users`,
and every later reader of `users` then queues behind it. `0001` only ever created
new tables, could block on nothing pre-existing, and set them anyway.

**The partial unique index carries the pairing-code trap verbatim.** `now()`
cannot appear in an index predicate, so an expired-but-unconsumed token still
occupies the live slot and would permanently brick that user's recovery. Every
mint site therefore runs `SELECT … FROM users WHERE id = $1 FOR UPDATE` → revoke
any live row → insert, inside one transaction.

**The lock goes on the `users` row, not on the token rows.** Locking
`user_email_tokens` finds *nothing to lock* in the common case where no live
token exists, so two concurrent mints both sail through and one takes a `23505`
on `user_email_tokens_live_key` — on the one screen whose entire purpose is
issuing a credential. This is the same remedy the parent spec prescribes for
`terminal_pairing_codes`, where `0001_init.sql:355-359` likewise names the parent
table rather than the child. It serialises both purposes for one user, which is
acceptable at this volume.

**No `company_id`.** The token is presented by an unauthenticated caller, so the
user — and therefore the tenant — is discovered *by* the lookup. It is in the same
pre-tenant class as `user_sessions`.

### 3.3 Revoke DML on the migration ledger

```sql
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM core_api_app;
```

`0001_init.sql:512` grants DML on all tables in `public`, so the application role
can today forge or delete a ledger row and make the next deploy skip or re-apply a
migration. Plan 5 recorded this as **"FINDING for Plan 2, deliberately NOT fixed
here"** and named a `0002_` migration as the remedy. This is it.

The migration runner applies each file as one string in one transaction, and
`GRANT`/`REVOKE` are transactional in PostgreSQL, so this is legal in-file.

### 3.4 Invariant lists that must be edited by hand

`schema-invariants.test.js` is written to reject a new table unless a developer
consciously widens a list. That is the mechanism working, not a defect.

| List | Add | Stated reason |
| --- | --- | --- |
| `TENANT_COLUMN_EXCEPTIONS` (5 → 6) | `user_email_tokens` | pre-tenant: read in order to DISCOVER the tenant |
| `COMPOSITE_FK_EXCEPTIONS` | `user_email_tokens.user_id` | pre-tenant: read in order to DISCOVER the tenant |
| `CASCADE_FKS` (3 → 4) | `user_email_tokens.user_id` | ephemeral credential, not history — the same class as `user_sessions.user_id` |

S1 additionally requires that **each exception carries its own positive
assertion** in its own test. A new entry without one fails the anti-rot check, so
the slice must add that test, asserting `user_email_tokens` carries `user_id`
`NOT NULL` and reaches its company only through `users`.

S7's `PLAINTEXT_COLUMN_NAMES` is `["password", "token", "code", "secret",
"session_id"]` — exact names only. `token_hash`, `revoked_reason` and
`delivery_last_error` are not members, so nothing there needs widening.

### 3.5 `migrate.test.js` pins the migration set to exactly one file

Five assertions encode "there is exactly one migration" and every one of them
fails on the mere existence of `0002_*.sql`, before any column is inspected:

| Line | Assertion |
| --- | --- |
| `104` | `assert.deepEqual(fs.readdirSync(MIGRATIONS_DIR).sort(), ["0001_init.sql"])` |
| `295` | `assert.deepEqual(first.applied, ["0001_init.sql"])` |
| `302` | `assert.equal(ledger.rows[0].filename, "0001_init.sql")` |
| `309` | `assert.deepEqual(second.skipped, ["0001_init.sql"])` |
| `536` | `assert.deepEqual(ledger.rows.map((row) => row.filename), ["0001_init.sql"])` |

All five widen in the same commit as the migration file.

---

## 4. Credential recovery

### 4.1 Token format and lifetime

`crypto.randomBytes(16).toString('base64url')` → 22 Base64URL characters, SHA-256
stored, raw value appearing only in one outbound email body. This is the house
convention used by `user_sessions` and `terminal_tokens`.

It is deliberately **not** the 10-character Crockford base32 of pairing codes.
That departure exists for one reason the parent spec states plainly — the person
is typing on a kitchen tablet's on-screen keyboard. Here the person clicks a link
and types nothing, so the entropy reduction buys nothing and the credential grants
full account takeover.

| Purpose | TTL | Config |
| --- | --- | --- |
| `password_reset` | 30 minutes | `PASSWORD_RESET_TTL_MINUTES` |
| `email_verify` | 24 hours | `EMAIL_VERIFY_TTL_HOURS` |

The asymmetry is the blast radius: a reset token *is* the account; a verify token
grants only the right to set one timestamp.

### 4.2 Forgot-password, and the four enumeration channels

`POST /api/admin/auth/forgot-password` is public and **always answers `202`** —
for an unknown address, a suspended user, a suspended company, and an unverified
address alike.

§5.8(b) established that a uniform response is worthless if another channel
reveals the truth. Four channels exist here and each is closed by its own
mechanism:

**(a) The response body and status.** Constant, as above.

**(b) Timing.** The handler writes `202` **before doing any work at all** and
performs the lookup, mint and send from `setImmediate`. Response latency therefore
cannot depend on whether the address exists, because at the moment of the response
nothing has been looked up. This is strictly stronger than login's
`LOGIN_TIME_BUDGET_MS` approach, which is forced to measure a budget only because
login must decide its status code before answering.

The work function is exported so it can be tested without the timer.

**(c) The rate limiter.** Keyed on **client IP only**, never on `users.id`. A
principal-keyed bucket would answer "does this address exist" after N probes, and
`validateRouteTable` at `router.js:129-133` makes that combination fatal at boot
anyway. No `Retry-After` header — §5.7 already records for `login-global` and
`pair-global` that the header would confirm the bucket.

**(d) The audit trail.** Every request writes `auth.password_reset_requested`
with `actor_kind = 'anonymous'`, `detail.email` carrying the probed address, and
the derived `source_ip`. Same shape as `auth.login_failed`.

### 4.3 Consuming a reset token

`POST /api/admin/auth/reset-password` is public, takes `{ token, newPassword }`,
and **acquires the `lib/semaphore.js` scrypt slot**, releasing it in a `finally`.
This is not optional: it is the second unauthenticated CPU-bound path in the
service, and without the slot an attacker exhausts the same two slots login is
throttled to protect.

The transaction's **first statement** is the single-use guard:

```sql
UPDATE user_email_tokens
   SET consumed_at = now(), consumed_from_ip = $2
 WHERE token_hash = $1
   AND purpose = 'password_reset'
   AND consumed_at IS NULL
   AND revoked_at IS NULL
   AND expires_at > now()
RETURNING user_id, sent_to_email
```

Zero rows aborts the transaction. That is what makes concurrent double redemption
impossible rather than merely unlikely — the same construction as
`/api/terminal/pair`.

Still inside the transaction, on success:

1. `sent_to_email` must still equal `users.email`.
2. The user and their company must both be `active`.
3. Write the new `password_hash`.
4. Bump `users.sessions_valid_from` — every existing session dies.
5. Clear `failed_login_count` and `locked_until`. A reset that leaves the account
   locked helps nobody; this is the remedy for a locked-out cashier.
6. Set `must_change_password = false`. They just chose it themselves.
7. Set `email_verified_at = now()` if it is `NULL` — they demonstrably read that
   inbox.
8. Revoke every other live token for this user, `revoked_reason = 'password_changed'`.
9. Write `auth.password_reset_completed`.

**No auto-login.** The response is `200` and the page asks them to sign in. A
public route that mints a session cookie is one more thing to get wrong for a
convenience the user pays once.

Every failure mode — unknown, expired, consumed, revoked, address changed, user or
company suspended — returns one identical `401 reset_link_invalid` and writes an
audit row.

### 4.4 Email verification

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /api/admin/auth/verify-email/request` | user, `anyUser` | Mints and sends to `users.email`. Limited per `users.id`. |
| `POST /api/admin/auth/verify-email` | public | Consumes. Sets `email_verified_at`. |

The request route is authenticated because the caller already holds their
password — there is no address to enumerate and no reason to spend a public route
on it. The consume route is public because the link may be opened on a device
where nobody is signed in.

**The request route is NOT exempt from the `must_change_password` gate.** A
freshly created user changes their password first and verifies second. That
ordering is correct, and it keeps `SETTLED_EXEMPT` at exactly the two entries
§8.5 rule 3 names, so neither the spec nor `route-auth.test.js:46` moves.

Failure returns `401 verify_link_invalid`. Verifying an already-verified address
is idempotent and returns `200`.

---

## 5. Email delivery

### 5.1 Placement — not in `lib/`

§3.2 rule 3 requires everything under `lib/` to be pure: no database, no
filesystem, no network. SMTP is network I/O. A new area:

```text
apps/core-api/mail/
  transport.js    the ONLY file permitted to require("nodemailer")
  templates.js    pure: variables in, { subject, text, html } out
  sweeper.js      the retry loop
```

The `transport.js` rule is the third instance of a pattern the service already
enforces twice — `db/pool.js` is the only file that may require `pg`,
`http/router.js` the only one that may require `express`. `source-structure.test.js`
names those by literal, so it needs a third literal; without it, `templates.js`
could require `nodemailer` and every test stays green.

`walk()` is a deny-list descent, so `mail/` is scanned automatically and the
`>= 15` file floor absorbs it. Nothing rejects the directory itself.

### 5.2 Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `SMTP_HOST` | — | required when `EMAIL_ENABLED` |
| `SMTP_PORT` | `587` | 465 requires `SMTP_SECURE=true` |
| `SMTP_SECURE` | `false` | STARTTLS on 587 |
| `SMTP_USER` | — | required when `EMAIL_ENABLED` |
| `SMTP_PASSWORD` | — | secret; never logged, never in `deploy.yml` |
| `EMAIL_FROM` | — | required when `EMAIL_ENABLED` |
| `EMAIL_ENABLED` | `true` | `false` is the explicit, logged escape hatch |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | |
| `EMAIL_VERIFY_TTL_HOURS` | `24` | |
| `EMAIL_RETRY_MAX` | `5` | |
| `EMAIL_SWEEP_INTERVAL_SECONDS` | `20` | |

Link origin reuses `API_PUBLIC_ORIGIN`; no new variable. Parent decision 11
already places the admin UI same-origin at `/admin`.

`SMTP_PASSWORD` lives in `~/core-api.env` beside `POSTGRES_PASSWORD` and is set by
hand on the box. `deploy-config.test.js` bans any redirection into that file, so
the pipeline cannot write it.

**Two frozen fixtures block this.** `config.test.js:10` and `:20` define `DEV_ENV`
and `PRODUCTION_ENV` as `Object.freeze`d objects carrying five and six keys
respectively, none of them SMTP. A `required()` SMTP credential with
`EMAIL_ENABLED` defaulting to `true` therefore detonates the entire config suite,
not one test. Both fixtures widen in the same commit.

**Deploy ordering is load-bearing.** With `EMAIL_ENABLED=true` and no SMTP
secrets on the box, the server refuses to listen and the deploy gate fails —
*after* the migration has applied. The secret goes on the box **before** the merge.
This belongs in the cutover checklist as a numbered step, not as prose.

### 5.3 The send path

1. Mint the token inside a transaction; `delivery_next_at = now()`; commit.
2. `setImmediate` → attempt one send.
3. Success → `delivery_sent_at = now()`.
4. Failure → `delivery_attempts + 1`, `delivery_last_error` truncated to 500
   characters, `delivery_next_at = now() + min(2^n minutes, 30 minutes)`.
5. The sweeper wakes every `EMAIL_SWEEP_INTERVAL_SECONDS`, selects due rows with
   `FOR UPDATE SKIP LOCKED`, and for each **revokes the row
   (`revoked_reason = 'delivery_retry'`) and mints a successor** carrying
   `delivery_attempts + 1`. Without carrying the count forward the chain retries
   forever.
6. At `EMAIL_RETRY_MAX` the token is revoked `'delivery_exhausted'` and
   `auth.email_send_failed` is written with `purpose` and `attempts`.

`SKIP LOCKED` is not needed by a single replica and is cheap insurance for the
zero-downtime deploys parent §10 assigns to Phase 4.

The loop must not run under test. `EMAIL_ENABLED=false` in the test environment
gates the timer, and the loop body is exported as `runEmailSweep(deps)` taking the
clock as an argument — never an ambient read.

### 5.4 A residual this design accepts

If a send succeeds but the process dies before `delivery_sent_at` is written, the
sweeper mints a successor and sends a second email. The first link is then dead by
the live-token index, so a user who clicks the older message sees "link invalid"
while a valid newer message sits above it in the same inbox. The window is the
milliseconds between the SMTP response and one `UPDATE`. Closing it properly needs
two-phase commit against an SMTP server, which is not a thing.

---

## 6. HTTP surface

### 6.1 New routes

| Method | Path | Auth | Roles | Notes |
| --- | --- | --- | --- | --- |
| `POST` | `/api/admin/auth/forgot-password` | public | — | Always 202. Responds before working. |
| `POST` | `/api/admin/auth/reset-password` | public | — | Acquires the scrypt semaphore. |
| `POST` | `/api/admin/auth/verify-email/request` | user | `anyUser` | Not exempt from the password-change gate. |
| `POST` | `/api/admin/auth/verify-email` | public | — | Consume. |
| `GET` | `/admin/reset-password` | public | — | Landing page. |
| `GET` | `/admin/verify-email` | public | — | Landing page. |

`pathToRegExp` anchors `^…/?$`, so `/api/admin/auth/verify-email` does not swallow
`/api/admin/auth/verify-email/request`.

Every route in this slice — the 25 already specified by the parent as well as the
6 new ones — must declare `sample`, which `route-auth.test.js:90-97` requires of
every entry. `route()` never mentions `sample`, so omitting it boots clean and
only that test complains.

### 6.2 The public set is eight

```text
GET  /health
GET  /health/ready
POST /api/admin/auth/login
POST /api/admin/auth/forgot-password
POST /api/admin/auth/reset-password
POST /api/admin/auth/verify-email
GET  /admin/reset-password
GET  /admin/verify-email
```

Asserted by `deepEqual`, so an addition fails and so does a removal. It becomes
nine when the terminal plan adds `POST /api/terminal/pair`.

**Landed: the three naming sites moved, and the literal is gone.** This section
used to read *"the literal 'the settled four' is written in three places and all
three move together: `route-auth.test.js:33-36`, `router.js:75`, and the parent
spec at §6.1 and §8.5 rule 2."* All three moved, each in the same commit as the
route that forced it. `grep -rn "the settled four" apps docs` now returns **no
source file and no test** — only plan documents and this paragraph. The plans
(`…plan1-foundation.md`, which wrote the literal, and `…plan2b-authentication.md`,
which instructed its removal) are execution records rather than live claims, and
the two hits in this section are the quotation being corrected. A `grep` that
returns zero would mean this correction had been deleted too.

**Where the public set is pinned now:**

| Site | What it says |
| --- | --- |
| `apps/core-api/test/route-auth.test.js` | *"rule 2: the public set is exactly the Plan 1 set"* — a `deepEqual` on **three** keys, with the growth path in the comment above it. |
| `apps/core-api/http/router.js` | The `validateRouteTable` comment, recording that rule 2 is deliberately **not** a boot census — a census makes the service un-bootable at every intermediate commit — and that the teeth are in `route-auth.test.js`. |
| Parent spec §6.1 and §8.5 rule 2 | Both now name three, both carry an explicit *Amended by Plan 2b* note saying the earlier text said "exactly four entries" and named `POST /api/terminal/pair`, which no plan has registered. |

**Three, then eight, then nine — and never four.** Three today: `GET /health`,
`GET /health/ready`, `POST /api/admin/auth/login`. **Eight** once Plan 2d lands the
five it owes — `forgot-password`, `reset-password`, `verify-email`,
`GET /admin/reset-password`, `GET /admin/verify-email` — which is the set enumerated
above. **Nine** when the terminal plan registers `POST /api/terminal/pair`.

Why the record matters more than the correction: "four" was never a stage the
service passed through. It was a count taken by adding the *login* route and the
*pairing* route to the two health entries at the same time, and the two arrived in
different plans — pairing has still not arrived. A reader who finds "four"
somewhere and repairs it by widening a literal to four would put a route in the
public set that does not exist. Widen the literal **in the same commit as the
route**, never ahead of it; the `deepEqual` is set equality, so an early widening
is as red as a late one.

### 6.3 CSRF — §5.3 needs a genuine third clause

The parent rule reads: *a request authenticated by the `__Host-core_session`
cookie, plus the unauthenticated login route, must carry `Origin` and
`Content-Type: application/json`; bearer-authenticated and unauthenticated device
routes are exempt.*

The three new public POSTs are none of those things. They are unauthenticated,
non-device, browser-facing. The sentence cannot express them, and it is copied in
four places, so a fourth copy is not the fix.

**Amended rule.** The `Origin` and `Content-Type` requirements apply to:

1. every request authenticated by the `__Host-core_session` cookie, and
2. every **browser-facing public POST** — `login`, `forgot-password`,
   `reset-password`, `verify-email`.

Device routes under `/api/terminal/*` remain exempt, because kiosks, native shells
and `curl` send no `Origin` and pairing failures are deliberately opaque.

This stays **derived**, not declarative: §8.5 is exactly ten rules and adding an
`origin:` route option would be a design change rather than a repair. What the
slice adds instead is a **census test** beside the public-set test, asserting by
`deepEqual` exactly which registered routes are origin-gated — the same mechanism
that pins the public set.

**Placement matters.** The check runs **inside the dispatch wrapper**
(`router.js:198-206`), after route lookup. As an `app.use` between `:165` and
`:197` it would run before route matching, so an unknown path with no `Origin`
would answer `403 origin_not_allowed` instead of `404 not_found` — destroying the
`[credential-independent]` property §6.3.5 marks on step 2. `source-structure.test.js`
forbids `app.use(` outside `router.js`, so a pure `http/csrf.js` called from the
wrapper is the only compliant shape.

### 6.4 The landing pages

`sendJson` hard-codes `Content-Type: application/json` and applies a frozen header
table whose CSP is `default-src 'none'; frame-ancestors 'none'`. Under that policy
inline script, external script and `fetch()` are all blocked — and the token lives
in the fragment, which only script can read. **The existing table cannot serve
these pages**, and `respond.test.js:49-52` asserts a caller cannot weaken it for
one route.

`respond.js` therefore gains a second frozen table and `sendHtml(res, status, html)`:

```text
default-src 'none';
script-src 'sha256-<digest of the inline script>';
style-src  'sha256-<digest of the inline style>';
form-action 'self';
connect-src 'self';
frame-ancestors 'none'
```

Hash, not nonce: `respond.js` is Tier-1 pure and has no RNG. The hash is computed
at module load from the same string that is served, so a one-byte edit to the
script fails closed rather than silently loosening the policy.

The pages load **no external resource of any kind** — no font, no CDN, no image,
no analytics. `X-Content-Type-Options`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY` and `Cache-Control: no-store` carry over unchanged.

**Hazard with no mechanical guard:** a handler that writes `res.setHeader` /
`res.end` directly bypasses the header tables entirely, and none of C1–C13
mentions `res.end`, `res.writeHead` or `setHeader`. The slice adds that rule.

### 6.5 Two new error codes

Both `401`, added to `db/errors.js` `TOP_LEVEL_ERROR_CODES` and to `respond.js`
`ERROR_MESSAGES` in the same commit — a test asserts the key sets are equal.

| Code | Message |
| --- | --- |
| `reset_link_invalid` | `That password reset link is no longer valid.` |
| `verify_link_invalid` | `That verification link is no longer valid.` |

The incumbents do not fit: `invalid_credentials` says "Those sign-in details were
not accepted" and `pairing_failed` says "That pairing code was not accepted".

---

## 7. Rate limiting

The §5.7 roster grows from seven rows to ten.

| Limiter | Bucket key | Window | Ceiling | `Retry-After`? | Config |
| --- | --- | --- | --- | --- | --- |
| `forgot-global` | client IP | 1 min | `FORGOT_RATE_PER_MINUTE` (10) | **no** — would confirm the bucket | `FORGOT_RATE_PER_MINUTE` |
| `reset-consume` | client IP | 1 min | `RESET_CONSUME_RATE_PER_MINUTE` (20) | **no** | `RESET_CONSUME_RATE_PER_MINUTE` |
| `verify-request` | `users.id` | 10 min | `VERIFY_MINT_RATE_PER_10MIN` (5) | yes — authenticated, so no oracle | `VERIFY_MINT_RATE_PER_10MIN` |

### 7.1 §5.7 made a claim that was not true. Plan 2b made it true

**Status: shipped in Plan 2b, Task 2.** Recorded rather than deleted, because *why* the
check could not land earlier is the part worth keeping.

The parent states that *"`route()` rejects at boot any route whose `limit` names a limiter
absent from it."* When this slice was written it did not. `validateRouteTable` inspected
only `options.limit.key` — rejecting a principal-keyed bucket on a public route, which it
did correctly — and there was no roster constant and no `limit.name` membership check
anywhere in the service. `limit: { key: "ip", name: "forgot-global" }` registered fine and
the process listened.

It could not have landed before 2b for the reason that makes the check worth having: there
was nothing to check against. A roster is a closed set, and a closed set authored ahead of
the routes that populate it either blocks the routes or is padded with names for routes
that do not exist. 2b is the first slice with limiters, so it is the first slice that could
author the roster and the check in one commit — the frozen `LIMITERS` constant in
`lib/rate-limit.js`, read by `validateRouteTable` at boot, with
*"validateRouteTable rejects a limit naming a limiter outside the 5.7 roster"* and
*"…rejects a limit whose key disagrees with the roster"* in
`apps/core-api/test/router-registration.test.js`. §5.9's audit-vocabulary membership check, deferred by
the same reasoning at `router.js`, landed in Task 3 alongside it.

The roster is also named in three places despite §5.7 claiming it is *"defined
once here and nowhere else"* — §5.7, §6.3.5 and §11. All three move together.

### 7.2 nginx — a new zone, not a shared one

`location = /api/admin/auth/login` is an **exact** match. Without new blocks, both
new public POSTs fall to `location /` at `zone=core_api rate=20r/s` with
`burst=40 nodelay` and, deliberately, **no `limit_req_status`** — so they shed as
`503`, not `429`. That means a burst of forty unauthenticated, scrypt-invoking
requests arriving at a two-slot semaphore.

The catch-all's missing `limit_req_status` is the design's stated intent and must
not be changed. Instead the new routes get their own exact-match blocks with their
own `limit_req_status 429;`, and a new zone:

```nginx
limit_req_zone $binary_remote_addr zone=core_reset:5m rate=10r/m;
```

Zone declarations sit **unindented at `http{}` scope** — `nginx-config.test.js:108-110`
asserts that.

`core_login` is not reused: block 5 of the deploy already empties that bucket with
its twenty-POST burst, so a reset flood and a login flood would evict each other.

### 7.3 §9.12's semaphore claim is now false

The parent calls `LOGIN_RATE_PER_MINUTE` *"the control that stops one laptop on a
phone tether holding the 2-slot scrypt semaphore permanently full."* With a second
unauthenticated scrypt path holding a **separate** bucket, that sentence no longer
bounds occupancy on its own. Amended: occupancy is bounded by `core_login` and
`core_reset` at the edge, and by `login-global` and `reset-consume` in process —
four controls, and the sentence must name all four.

---

## 8. Audit vocabulary

Five additions to §5.9. **No DDL change:** `audit_events.action` carries a shape
regex (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`), not a list, and all five satisfy it.

| `action` | `actor_kind` | `outcome` | `target_kind` | permitted `detail` keys |
| --- | --- | --- | --- | --- |
| `auth.password_reset_requested` | `anonymous` | success, failure | `user`, or **none** | `email` |
| `auth.password_reset_completed` | `anonymous` | success | `user` | — |
| `auth.email_verify_requested` | `user` | success | `user` | — |
| `auth.email_verified` | `anonymous` | success | `user` | — |
| `auth.email_send_failed` | `system` | failure | `user` | `purpose`, `attempts` |

`auth.password_reset_completed` and `auth.email_verified` carry `actor_kind =
'anonymous'` because the caller presented a token, not a session — and the
`audit_events_actor_arc` CHECK requires `actor_user_id IS NULL` for that kind. The
subject is recorded as the target, which is the correct reading: the account was
acted upon by someone holding a mailed credential, not by an authenticated user.

**`auth.password_reset_requested` is the one row whose target is conditional**,
and the constraint forces the shape. When the probed address matches no row there
is no user to name, and `audit_events_target_pair` requires
`(target_kind IS NULL) = (target_id IS NULL)` — so both columns are `NULL` and the
probed address survives only in `detail.email`. Writing `target_kind = 'user'`
with a `NULL` id to keep the rows uniform is a check violation, and inventing a
sentinel id would make a forensic query for "resets requested against this user"
return rows for an account that never existed.

---

## 9. The lockstep change list

**Landed in part.** When this section was written, every literal below described
work that did not exist. Two plans have executed against it since — **Plan 2a**
took the migration and the invariant pins, **Plan 2b** took the authentication
half — so the list is no longer one undifferentiated backlog, and reading it as
one is how a later plan ends up scheduling work that shipped in June.

What has **not** changed is the rule the section exists for: *a literal frozen in
a test or in a configuration file moves in the same commit as the code it
describes.* That still binds every row marked **OWED** below, and §9.3's traps
still apply to them unaltered.

The landed rows are kept rather than deleted, because what each one recorded is
*which file goes red when the pair is split* — and that is the part not
recoverable from a diff. §9.3's last bullet is why the record has to be a status
rather than a deferral marker: a `match` on "this does not exist yet" goes green
forever and green is the wrong colour for a claim nobody checks.

**Read the Status column, not the Edits column.** The edit counts were estimates
made before execution and two are known wrong: `migrate.test.js` was five and is
six — the sixth is the ledger row-count assertion, which is not an array literal,
so a grep for the pinned filename finds five of six. It read
`assert.equal(ledger.rowCount, 1)` when this was written and reads `2` now, which
is the point: cite it by what it asserts, never by its value. Likewise
`schema-invariants.test.js` named three files when the invariant lists live in
six — `infra/restore-drill.sh` hand-mirrors S1 in SQL, and with `0002` applied it
would have raised on a **good** restore.

The residual: everything still owed belongs to **Plan 2d** (credential recovery
and the two landing pages), except §12's parent-spec rows, which §12 itemises
separately.

### 9.1 Blockers

| # | What |
| --- | --- |
| B1 | The landing pages cannot be served under the shipped CSP. Resolved by §6.4. |
| B2 | Both landing pages register through `route()` and so join the public set. `express.static` is unavailable: `source-structure.test.js` deep-equals the express-requiring file list to `["http/router.js"]`. |
| B3 | **RESOLVED by Plan 2b, Task 12 (`cc4ec12`).** It said: registering the login route trips `deploy-config.test.js:731-741`, whose failure message orders three further edits — and obeying it turns `:721` red, because the `PLAN 2` marker it matches exists only in the comment being deleted. That is what happened, and the resolution was to stop treating it as an ordering problem: **the route, `deploy.yml` block 4 and the test moved in one commit**. Block 4 stopped being a config-file read and became a behavioural gate — it asserts `401` with `"code":"invalid_credentials"` from a login probe carrying `X-Forwarded-For: 203.0.113.99`, and that the audit row's `source_ip` is neither that address nor NULL. The `routesDir` loop that generated the three-edit cascade is **deleted**, verified by `grep -rn routesDir apps/core-api` returning only `route-auth.test.js`'s own module loader, so the trap cannot re-arm for the routes Plan 2d registers. |
| B4 | `source-structure.test.js:40` deep-equals dependencies to `["express", "pg"]` and `:49` asserts `devDependencies === undefined`. `package-lock.json` must be regenerated in the same commit or `npm ci` fails in the image while local tests stay green. |
| B5 | `route-auth.test.js:90-97` requires `sample` on every entry, including all ~25 previously specified routes. |

### 9.2 Files and edit counts

Every row checked against the working tree, not against the plan documents.

| File | Edits | Principal change | Status |
| --- | --- | --- | --- |
| `test/route-auth.test.js` | 3 | public set 2 → 8; new origin-gating census | **PART 2b / PART OWED.** The public set moved 2 → **3** and the origin-gating census exists — a `deepEqual` on the five origin-gated keys, derived through `requiresOriginCheck` exactly as §6.3 specified rather than declared as a route option. 2d takes the public set 3 → 8 and widens the census by three. |
| `test/migrate.test.js` | 5 | the `["0001_init.sql"]` pins of §3.5 | **LANDED, Plan 2a Task 2.** Every pin now reads `["0001_init.sql", "0002_identity.sql"]`. Six sites, not five, and executing it also exposed that both multi-row ledger queries had no `ORDER BY` while the new two-element `deepEqual` had just made row order load-bearing. |
| `test/schema-invariants.test.js` | 4 | three lists plus a new positive assertion | **LANDED, Plan 2a Task 3.** `user_email_tokens` is in the table list, in the pre-tenant exemption list with its reason, and carries the positive assertion (`user_id` is `uuid NOT NULL`, `company_id` absent). The lists live in six files, not three — see the opening note. |
| `test/source-structure.test.js` | 3 | dependencies; the `nodemailer` rule; the `res.end` rule | **PART / MOSTLY OWED.** The dependency literal did move, but for `@restaurant/epaper-hub-sdk` (§11.9) rather than for `nodemailer`, and it brought C16 with it. The `nodemailer` rule and the `res.end` rule are unwritten: the roster stops at **C16**. Both are 2d's, and both arrive with the code that makes them necessary — 2d's mailer and 2d's landing pages. |
| `test/deploy-config.test.js` | 6 | 404 → 401; `not_found` → `invalid_credentials`; delete the `routesDir` loop | **LANDED, Plan 2b Task 12 (`cc4ec12`), plus Task 17 (`a1f6056`).** See B3 above. |
| `test/nginx-config.test.js` | 5 | zone count; include count 4 → 6; the "two credential routes" title | **OWED, 2d.** Still three zones, `includeCount` still pinned at 4, title unchanged. Correctly untouched: 2b registered no browser-facing route that needs an nginx location, and moving the pin ahead of `api.conf` is the lockstep failure this section is about. |
| `test/operations-docs.test.js` | 4 | the `Plan 2` tripwires | **LANDED, Plan 2b Task 17 (`a1f6056`).** Retired the way §9.3's last bullet demands — replaced with assertions on the claim that is now true (`audit_events`, `203.0.113.99`) rather than deleted. The two surviving `Plan 2` strings are `// WAS:` notes recording what each assertion replaced. |
| `test/config.test.js` | 2 | both frozen env fixtures | **OWED, 2d.** No mail configuration and none of §7's three new limiter variables. Plan 2b added no configuration at all. |
| `http/respond.js` | 5 | `sendHtml`; second header table; the Retry-After comment | **OWED, 2d.** Unchanged since Plan 1 (`a1b5748`): one frozen header table, no `sendHtml`. §6.4's hash-not-nonce reasoning is still unexecuted. |
| `http/router.js` | 4 | limiter roster check; audit membership check; three comments | **LANDED, Plan 2b Tasks 1–3 and 12.** Both boot checks live in `validateRouteTable`, each reading the one place its list is written (`lib/rate-limit.js`'s `LIMITERS`, `lib/audit-vocabulary.js`'s `AUDIT_ACTIONS`). §7.1 and §11.6 record why neither could land earlier. |
| `.github/workflows/deploy.yml` | 9 | block 4; the real forged-XFF probe | **LANDED, Plan 2b Task 12 (`cc4ec12`).** The probe asserts on the response and on the audit row it wrote, and runs **before** the `limit_req` burst — after it, nginx sheds the probe and every assertion is vacuous. |
| `infra/nginx/api.conf` | 3 | two exact-match locations; one zone | **OWED, 2d.** Unchanged since `016b04a`. |
| `infra/README.md` | 6 | see the line-budget hazard below | **PART 2b / PART OWED.** Plan 2b edited it three times (`fb1fc1c`, `7fbd771`, `a1f6056`) for the client-IP chain, the *Checked:* note and the retired markers. The landing-page and credential-zone documentation this row anticipates is 2d's, and the budget below is what it has to fit into. |
| Parent spec | 14 | §6.1, §8.5 rule 2, §5.3, §5.7, §9.5, §9.12, §10, §11 | **PART 2b / PART OWED, itemised at §12.** Plan 2b Task 17 carried §5.7, §5.9, §6.1, §8.5 rule 2, §9.5, §9.12 and §10, plus two the table did not anticipate. §5.3, §11 and §7 remain. |

### 9.3 Traps that look like ordinary edits

- **Do not paste §9.5's block-4 recipe.** The spec appendix writes the probe as
  `curl -fsS … || true`, and `deploy-config.test.js:700` bans that literal in
  `deploy.yml`. Keep the existing `-w '%{http_code}'` capture form — that is
  precisely why it tolerates a 401 without `-f` — and change only the expected
  status. The appendix should be corrected too, or the next reader copies it.

- **`probeAt` does not enforce position.** `deploy-config.test.js:687` takes
  `indexOf` of the first occurrence, which is already the existing probe, so
  adding the `psql` assertion anywhere leaves `:694` green. If the position is to
  be mechanically enforced, the assertion goes **inside** the existing `test(…)`
  at `:684`, which leaves `registered === 16` at `:901` undisturbed.

- **The client-IP section is on a line budget, and the budget is what to check.**
  `operations-docs.test.js` caps `## The client-IP chain` at **40 lines** and that
  ceiling has not moved. What has moved is the occupancy: this section said "39
  today, one line of headroom", and Plan 2b then rewrote the area twice — `fb1fc1c`
  and `7fbd771` added the `TRUSTED_PROXY_HOPS` ↔ proxy-depth note, `a1f6056` retired
  the `Plan 2` marker and the gate sentence with it. It now measures **37**, so
  there are **three** lines spare.

  Do not carry that 37 forward either; it is stale the next time anyone edits the
  section. **Measure it, with the test's own slicer** — `sectionSlice` runs from the
  heading to the next level-2 heading — terminating only on a newline followed by
  two hashes and a space — so a hand count off a text editor disagrees with it at
  the boundaries:

  ```bash
  node -e 'const r=require("fs").readFileSync("infra/README.md","utf8").replace(/\r\n/g,"\n");
  const s=r.slice(r.indexOf("\n## The client-IP chain\n")+1);const n=s.indexOf("\n## ");
  console.log((n===-1?s:s.slice(0,n)).split("\n").length)'
  ```

  The cap is not arbitrary and raising it is not the fix: the four silent breakers
  are written out once, in the nginx area, and this section summarises and points at
  them. The ceiling is the only mechanism that can ask "is this a second copy" —
  a text assertion cannot. If 2d's material does not fit in three lines, it belongs
  in the nginx area with a pointer from here.

- **`operations-docs.test.js:226` is not a one-line tripwire.** `sectionSlice`
  terminates only on a newline followed by `##` and a space, and the next heading is `###`,
  so the slice runs to EOF and contains three `Plan 2` hits. It goes red only
  when all three go.

- **`assert.match` on a deferred-plan literal cannot detect staleness.** A `match`
  goes red only when the literal is *removed* — which is the very edit it is meant
  to compel. Throughout this work, replace deferral markers with assertions on the
  claim that is now **true**.

---

## 10. Testing

Everything the parent §8 requires still applies. New obligations:

1. **Enumeration.** A test that `forgot-password` returns byte-identical bodies
   and status for a known-verified, known-unverified, and unknown address — and
   that the handler's response is written before the work function is invoked
   (assert on call ordering, not on wall-clock timing, which is flaky).
2. **Single use.** Two concurrent `reset-password` calls with the same token:
   exactly one succeeds.
3. **The live-token trap.** Mint, let it expire, mint again — the second must
   succeed. This is the assertion that would have caught the pairing-code bug the
   parent spec documents.
4. **Retry re-mints.** A failing transport, swept twice, produces a chain of three
   rows with `delivery_attempts` 0, 1, 2 and exactly one live at every point.
5. **Semaphore.** `reset-password` under load sheds `503` and never exceeds
   `SCRYPT_SLOTS` concurrent hashes.
6. **CSP.** The served hash matches the served script — computed, not hard-coded,
   in the test.
7. **No raw token at rest.** A repository-level assertion that after a full
   forgot-password cycle, `SELECT * FROM user_email_tokens` contains no value
   equal to the token that was emailed.

---

## 11. Residuals

### 11.1 A mistyped email address is unrecoverable

`users.email` is not patchable (decision 9) and there is no `DELETE` route. A user
created with a typo'd address can never verify, can never use forgot-password, and
cannot be corrected through the API.

**The remedy this section named does not exist.** It said *"out-of-band and already
exists: `scripts/set-password.js` over `docker compose exec`"*, which the parent spec
calls *"honest for a platform with one operator."* That was wrong when written and is
still wrong: `apps/core-api/scripts/` holds `reset-database.js`, `setup-template-db.js`
and, since Plan 2b, `create-platform-admin.js`. `set-password.js` and
`unlock-account.js` are named as shipped levers in five sections of the parent spec and
are built by no written plan. **They belong to Plan 2d**, which §11.8 gives the admin
CRUD and credential recovery; `set-password.js` is the operator half of exactly that.

Until 2d lands there is **no** remedy for a mistyped address, and an operator whose
`create-platform-admin.js` run refuses with `already_bootstrapped` is told by that error
to run a file that is not on the box. Said plainly here because a residual that
describes a missing tool as present is the one kind of residual that gets closed on
paper. Should the address problem itself become a support burden, the smallest fix is a
`scripts/set-user-email.js` CLI — operator-only, granting no role a new permission —
rather than an HTTP route.

### 11.2 Delivery is best-effort

`EMAIL_ENABLED=false` suppresses sending. It logs at error level on every
suppressed send, but a service running that way answers `202` to
forgot-password and delivers nothing. This is a deliberate escape hatch for local
development and tests; running production that way is a configuration error the
logs will show and nothing will prevent.

### 11.3 The duplicated-email window

See §5.4.

### 11.4 Naming collision risk

`POST /api/platform/admins/:userId/password-reset` and
`POST /api/admin/users/:userId/password-reset` are administrator-driven password
*minting*. `POST /api/admin/auth/reset-password` is the self-service link
consumer. Three similar names, two different mechanisms. The route table should
carry a one-line note at each, and the limiter names (`password-reset` versus
`reset-consume`) deliberately differ to keep the roster readable.

---

## 11.5 Carried into Plan 2b as a required item — LANDED

**Status: shipped in Plan 2b, Task 4.** The assertion is
*"TRUSTED_PROXY_HOPS equals the proxy depth infra/nginx actually deploys"* in
`apps/core-api/test/nginx-config.test.js`, which reads the configured value out of
`docker-compose.yml` and the deployed depth out of `infra/nginx/`, and fails naming both.
The deploy's block 4 is the second half at runtime: it POSTs a login carrying
`X-Forwarded-For: 203.0.113.99` and fails unless the `audit_events` row records the
address nginx actually saw. The reasoning below is kept because it is the argument for
why a build-time assertion was the only technique available.

**`TRUSTED_PROXY_HOPS` must be asserted against the deployed proxy chain.**
`lib/client-ip.js` counts from the right of `X-Forwarded-For` by that hop count.
Set to 2 behind a single proxy, the pick lands on the last client-controlled
entry and an attacker owns their own rate-limit bucket again — the exact attack
the module exists to prevent, reachable from a config typo alone.

No per-request test can catch it, and this was checked rather than assumed: a
forged `X-Forwarded-For: 1.2.3.4` under a one-proxy deployment produces a header
byte-identical to a legitimate two-proxy deployment whose real client is
`1.2.3.4`. There is nothing the module can assert about its own input.

It is still mitigable, by the technique that caught the trailing-slash bypass: a
build-time assertion between the configured hop count and the proxy depth
`infra/nginx/api.conf` actually deploys. Two locally-correct files, one wrong
pair. That assertion is a **required** item of Plan 2b's wiring, not a
nice-to-have — everything else in `lib/` fails safe, and this one fails open and
silently.

## 11.6 Two boot checks Plan 2b must land, and one false claim to settle — BOTH LANDED

**Status: shipped in Plan 2b, Tasks 2 and 3.** `validateRouteTable` now enforces both
memberships at boot. The roster half is covered in §7.1 above; the vocabulary half is
asserted by *"validateRouteTable rejects an audit action outside the 5.9 vocabulary"*,
*"…still rejects a malformed audit action before checking membership"* (shape first, so
the error names the real fault) and *"…accepts every action in the vocabulary"* in
`apps/core-api/test/router-registration.test.js`. The section is kept, not deleted,
because the reasoning about *why* both waited for 2b is the part that generalises — it is
the same argument any later plan will need before authoring a closed set.

`route()` validated the audit action's **shape** (`noun.verb`) and nothing more, and two
checks the design claimed to have did not exist.

**The audit vocabulary membership check was ready and was deliberately not landed
here.** `lib/audit-vocabulary.js` exists, and wiring it into `validateRouteTable`
is about six lines — I wrote it and reverted it. Without membership, a route may
declare `user.frobnicated`, which passes the shape check, reaches `audit_events`
— whose CHECK is *also* only a shape regex — and is written. The closed
vocabulary is what `audit_events_detail_no_credentials` is protecting, and it is
worthless if any handler can name an action nobody chose.

It was reverted for a specific reason worth recording, because it is the same
reason it must land in 2b rather than earlier. Plan 2a declared only the five
`auth.*` actions its own code emits; parent §5.9 lists roughly twenty-five.
Landing the check now would either block the synthetic route tables in
`router-registration.test.js` — which legitimately use `shop.created`,
`shop.updated` and `terminal.paired`, all real §5.9 entries — or force twenty
entries to be declared for routes that do not exist. **Complete the vocabulary
alongside the routes that emit each action, then land the check.** The three
synthetic actions already prove the mechanism works. That is what Task 3 did: the
vocabulary grew to the nine actions 2b's routes and CLI actually emit — asserted by
*"the nine actions Plan 2b's routes and CLI emit are declared"* in
`apps/core-api/test/audit-vocabulary.test.js` — and the check landed in the same commit.

**The limiter roster check did not exist at all, and §5.7 said it did.** That
section states *"`route()` rejects at boot any route whose `limit` names a
limiter absent from it."* `validateRouteTable` inspected only `options.limit.key`
(rejecting a principal-keyed bucket on a public route, which it does correctly).
There was no roster constant anywhere and no `limit.name` check. Registering
`limit: { key: "ip", name: "invented" }` threw nothing and the process
listened. Plan 2b had to either make the claim true or delete it — and since 2b is
the plan that introduces the first limited routes, making it true was the cheaper
of the two. Task 2 made it true; §7.1 records the constant and the tests, and the
check has a second half nobody had asked for: a route may not declare a
`limit.key` that disagrees with the roster's own key for that limiter, because a
name-only check would let a route silently re-key a shared bucket.

## 11.8 Settled: Phase 3 moves ahead of 2c and 2d

**New order: Plan 2b → Phase 3 → Plan 2c → Plan 2d.**

Parent §1's roadmap runs 2 → 3 → 4. This reorders the back half of Phase 2:
authentication still comes first, then table visits and e-paper move, and only
then the admin CRUD and credential recovery that 2c and 2d carry.

**Why.** §11.7's boundary — only core-api crosses to the SDK — is the
architecture, not a tidy-up. Today `apps/customer-order/epaper-client.js`
crosses it, which means a *front end* mints the visit credential and drives a
display directly. Every plan landed before Phase 3 is another plan built on top
of that, and 2c and 2d add no pressure to remove it. Doing Phase 3 second means
the shape is right while there is still little built on the wrong one.

The cost is accepted deliberately: the admin UI and forgot-password land later
than they otherwise would.

**Plan 2b cannot be skipped, and this is a hard dependency rather than a
preference.** `customer-order` has no credential for core-api at all —
`server.js:16` reads `EPAPER_API_KEY`, which is the *hub's* key, and core-api
exposes nothing to authenticate against. A service calling core-api does so as a
paired terminal, and that machinery is 2b's.

### What Phase 3 has to carry, measured rather than estimated

- **A new migration for `table_visits`.** No such table exists; `0001` and `0002`
  have none.
- **382 lines move**, not 31: `table-visit-store.js` (222) and `order-store.js`
  (129) as well as `epaper-client.js` (31). The QR is the visit token, so the
  display cannot move without the token's lifecycle, rotation and business-day
  clock coming with it.
- **`customer-order` becomes a paired terminal** so it can call core-api at all.
- Only then is `epaper-client.js` deleted, the SDK dependency moved to
  `core-api/package.json`, `source-structure.test.js:40`'s `["express", "pg"]`
  widened, and the one-permitted-caller rule added.

**The shortcut that does not work:** having `customer-order` pass the ordering
URL *to* core-api. That keeps the credential being minted in the front end, which
is the thing the boundary exists to stop.

## 11.7 Settled: core-api owns the display, end to end

The architecture, stated plainly so nothing downstream has to infer it:

> **core-api is the controlling API.** `customer-order` is a front end; its
> backend is core-api. To update an e-paper display you go *through* core-api,
> which calls the SDK. The QR frame reaches core-api too.

That makes the SDK's permitted-caller set a one-element list, and it makes the
whole rendered frame — label, status **and QR** — core-api's output rather than
something a front end assembles and hands over.

Recorded here because it is decided, is violated today, and the violation is
load-bearing until Phase 3.

Parent decision 5 says *"core-api owns business logic and calls it through the
SDK."* This sharpens it to an exclusive: **`@restaurant/epaper-hub-sdk` has
exactly one permitted caller, and it is `core-api`.** No other app drives an
e-paper display.

### What violates it today

`apps/customer-order/epaper-client.js` is the only runtime consumer in the
repository — a 27-line adapter that `server.js` uses to flip a table to
`Table is in use` on the first order. `epaper-hub` does not consume its own SDK,
and `core-api` does not depend on it at all: its manifest is `["express", "pg"]`,
pinned by `source-structure.test.js:40`.

So this cannot be enforced now. `customer-order` is the *only* thing that updates
a display, and deleting it before core-api can do the job leaves every table
showing the wrong status.

### What it costs, in the commit that lands it

Phase 3 already owns moving e-paper orchestration into core-api. This decision
makes three consequences explicit rather than incidental:

1. `apps/customer-order/epaper-client.js` and its test are **deleted**, not
   ported — the adapter's shape belongs to a service that owns table visits.
2. `@restaurant/epaper-hub-sdk` moves out of `apps/customer-order/package.json`
   and into `apps/core-api/package.json`. That is a **third** runtime dependency
   for core-api, and `source-structure.test.js:40`'s `deepEqual` on
   `["express", "pg"]` moves in the same commit. Both lockfiles regenerate.
3. The exclusivity gets a rule, in the shape this repository already uses twice —
   C1 (`pg` only in `db/pool.js`), C3 (`express` only in `http/router.js`). A
   repo-wide scan for `require("@restaurant/epaper-hub-sdk")` whose permitted set
   is a one-element list. Without it the rule is a convention, and every
   convention in this service that mattered has a test.

### The QR is the visit token, so it moves with it

Worth naming because it is the part that looks like presentation and is not.
`renderTableDisplay` draws the QR from a URL, and that URL *is* the credential:
parent §1 defines it as an opaque visit token, `.../t/AAAAAAAAAAAAAAAAAAAAAA`,
carrying no table number, shop id or business date. Scanning it enrols a phone
into that table's current visit.

Today `apps/customer-order/table-visit-store.js` mints it and
`server.js:274,319,411` reads it back through `visitStore.getOrderingUrl()` at
every display update. So "core-api owns the QR" is not a rendering change — it
means **the visit token, its lifecycle and its rotation move to core-api**, which
is exactly what parent §10 assigns to Phase 3 ("orders, table visits and e-paper
orchestration move into core-api"). The display is downstream of that move, not
separable from it.

The consequence for sequencing: a front end cannot be handed a token to draw. It
asks core-api to update a table, and core-api resolves the token, renders and
calls the hub. Any interim design that has `customer-order` passing a URL *to*
core-api would keep minting the credential in the front end and defeat the point.

### The coupling this does NOT fix

`epaper-client.js` passes `epaperId: tableNumber`, which looks like the thing to
correct while moving it. It is not, and parent §10 already worked this out: the
coupling lives in `packages/epaper-hub-sdk/index.js:24`, which hard-rejects any
`epaperId` outside 1..12, as does `table-template.js`'s `validateInput`. Moving
the caller changes nothing. The mapping belongs in the same change that widens
the SDK contract and decides whether a screen is scoped to a shop or to a
specific `epaper_hub` terminal.

## 11.9 Landed: the SDK boundary moved before the token did

**Status: shipped.** §11.7's exclusive is now a rule rather than a decision.
`apps/customer-order/epaper-client.js` is deleted, `@restaurant/epaper-hub-sdk` is a
dependency of `apps/core-api`, and `apps/core-api/epaper/hub-client.js` is the only
file in the repository that requires it — asserted as a one-element `deepEqual` by
rule C16 in `apps/core-api/test/source-structure.test.js`, both app-locally and
across `apps/` and `packages/`.

```text
customer-order  →  core-api  →  epaper-hub-sdk  →  epaper-hub
```

The route is `POST /api/terminal/table-displays/:tableNumber`, `auth: 'terminal'`,
audit action `table_display.updated`.

### This does not contradict §11.7, and the reason has to be stated

§11.7 says an interim design that has `customer-order` passing the ordering URL *to*
core-api "would keep minting the credential in the front end and defeat the point."
That is correct **about an end state**, and this is not one.

What shipped passes the URL in the request body. `table-visit-store.js` still mints,
rotates and expires the visit token inside `customer-order`. §11.7's own accounting
is why: moving the token means moving 382 lines, `order-store.js`'s business-day
clock, and a `table_visits` migration that does not exist — and §11.8 already
scheduled that as Phase 3.

The two moves are separable **in this direction only**:

- Moving the SDK without the token leaves the token where it already was. It removes
  a whole class of authority from a front end — nothing outside core-api can now
  address a physical panel, hold the hub's key, or render a frame — while the visit
  token's blast radius is unchanged.
- Moving the token without the SDK is not possible: core-api would be minting a
  credential it has no way to draw.

So the ordering is forced, and the residual is named rather than hidden: **until
Phase 3, a compromised `customer-order` can still mint a table's visit token.** It
can no longer drive the display it appears on. Phase 3 closes the first half by
moving the store; nothing else has to change at the boundary when it does, because
the route already takes a table number and core-api will simply resolve the URL
itself instead of reading it from the body.

### The credential: a configured shared service token, and it is interim

`customer-order` had no credential for core-api at all — §11.8 records that as a hard
dependency on the pairing machinery. Pairing is Phase 3 and far larger than this
change, so what shipped is a **configured shared service token**:
`TABLE_DISPLAY_SERVICE_TOKEN`, held in both secrets files, sent as
`Authorization: Bearer <token>`, compared with `crypto.timingSafeEqual` over SHA-256
digests of both sides.

**Why this was acceptable now.** It is the level the codebase already lives at, not a
mechanism invented for one route: `customer-order` → `epaper-hub` uses `EPAPER_API_KEY`
the same way, and the counter → `customer-order` checkout route uses `CHECKOUT_API_KEY`.
Introducing a *third* pattern to avoid a fourth copy of an existing one would have
made the boundary move the vehicle for an authentication design, and the boundary move
is the change worth reviewing on its own.

**What it costs, stated plainly.** One secret, shared between two services, with no
lifecycle: no expiry, no rotation record, no revocation short of editing two files and
restarting, and no way to tell from an audit row *which* holder of it acted. That last
point is why the audit entry declares `actorKinds: ["system"]` and carries
`actorLabel: "table-display-service"` — `audit_events_actor_arc` requires an id column
for `'user'` and for `'terminal'`, and this caller references neither row.

**Superseded by terminal pairing in Phase 3.** `customer-order` becomes a paired
terminal, presents a `terminal_tokens` bearer at the same header on the same route,
and the vocabulary entry becomes `actorKinds: ["terminal"]` with a real
`actorTerminalId`. The route path was chosen under `/api/terminal/` for exactly that
reason: the swap is a credential check and an audit actor kind, not a URL change.

### Two smaller decisions worth not re-deriving

**Both of core-api's display secrets are OPTIONAL, in every environment.** Unset,
`POST /api/terminal/table-displays/:tableNumber` answers 503 and nothing else in the
service notices. Requiring them would have made a forgotten line in `~/core-api.env`
into a deploy that refuses to listen *after* the migration has applied and then fails
the 90-second readiness gate — the failure shape §9.5 spends a page designing away.
The check is not lost, it is moved: `customer-order` refuses to start without its half,
so a half-configured deploy is one crash-looping container rather than silence. A token
that *is* set must be ≥ 32 characters, which does refuse to listen — unlike a missing
value, a weak one is a decision somebody made.

**A hub failure is 503, not 502.** `db/errors.js`'s code vocabulary is closed and has
no 502; inventing one would put a status in a response that nothing else in the service
can produce. 503 also carries `Retry-After: 5` from `http/respond.js`, which is the
correct instruction, and `customer-order`'s `isTransientEpaperError` reads the status out
of the message and retries on it. The accepted residual: an SDK *input* rejection — a URL
whose QR cannot fit the panel — also presents as a retryable 503. It cannot arise from the
one caller, whose URLs are a fixed `{orderBaseUrl}/t/{22 chars}`.

## 11.10 Landed: Plan 2b, the authentication pipeline and the first account

**Status: shipped.** `docs/superpowers/plans/2026-08-05-core-api-phase1-plan2b-authentication.md`,
seventeen tasks. The core-api suite went from 392 tests to 525.

What exists now that did not:

- **The §6.3.5 pipeline**, in `http/router.js`, with the role gate at step 7.5 reading
  `lib/authorization.js`. `http/authenticate.js` orchestrates and issues no SQL of its own.
- **Six routes**: `POST /api/admin/auth/login`, `GET .../me`, `POST .../logout`,
  `POST .../logout-all`, `POST .../password`, and `POST /api/admin/scope` (company
  selection, `["platform", "companyAdmin"]` — the narrowest static declaration §5.4's
  four aliases can express for "platform_admin, scoped or unscoped"; the handler closes
  the rest). Login materialises scope through
  `repositories/auth/scope-materialize.js`; the session cookie and its CSRF partner come
  from the two pure primitives `http/cookies.js` and `http/csrf.js`.
- **The two boot checks §11.6 says are missing** — the limiter roster and the audit
  vocabulary membership check — both in `validateRouteTable`, both refusing at boot.
- **The `TRUSTED_PROXY_HOPS` cross-file assertion** of §11.5, plus the deploy's block 4,
  which is now a behavioural gate rather than a config-file read.
- **`scripts/create-platform-admin.js`**, the first account, prompted for on a TTY with
  echo off and refused on a pipe, guarded by an advisory lock and a monotonic audit row.

Two things it deliberately did **not** do, and both are Plan 2c's:

1. **`lib/authorization.js` holds the alias half only.** No rank lattice, no shop
   containment, no self-modification rules. It answers "does this scope's role satisfy one
   of the route's declared aliases" and nothing else.
2. **Step 10's per-resource half does not exist.** The static route-roles check runs at
   step 7.5; deciding whether *this* caller may touch *that* row waits for the routes that
   have rows. §11.11 records the gap that follows from it.

## 11.11 Settled while executing Plan 2b: two aliases on four routes, and the 409 nobody owns

**Status: the first is shipped; the second is OPEN and belongs to Plan 2c.** Both were
settled by reading the parent spec against itself rather than by choosing, and neither
belongs in a plan about to be marked done — §11.5–§11.9 are this slice's amendment
mechanism precisely because a decision recorded in a finished plan is a decision nobody
reads again.

### The four identity routes declare two aliases, not one

`GET /api/admin/auth/me`, `POST /api/admin/auth/logout`, `POST /api/admin/auth/logout-all`
and `PUT /api/admin/auth/password` register `roles: ["platform", "anyUser"]`.

State the failure, not the change. Parent §5.4's alias table gives `anyUser` the four
*scoped* roles and deliberately excludes an **unscoped** `platform_admin`; §6.2 gives these
four rows `anyUser` alone. Login always materialises `actingCompanyId: null` for a platform
admin, and a platform admin is the only account this plan can create — so under plain
`anyUser` the bootstrap administrator cannot read its own identity, cannot sign out, and
cannot change the password `scripts/create-platform-admin.js` has just set. No test would
have caught it: every signed-in fixture in `auth-routes.test.js` is a `company_admin`.

So §5.4 and §6.2 disagree, and Plan 2b is the first plan to execute the disagreement. It is
settled **in §6.2's direction, for these four rows only**, and the parent is amended at
**§6.2, not at §5.4** — §5.4's exclusion is correct everywhere else. Two repairs were
rejected, and the reasons are the whole decision:

- **Widening `anyUser` inside `permits()`.** One line, and it admits an unscoped platform
  admin to *every* route declared `anyUser` — the roughly twenty tenant routes Plan 2c
  registers. A caller with no company selected would reach all of them.
- **A fifth alias.** `ROLE_ALIASES` is frozen at four and asserted twice; adding an entry
  to the role vocabulary to avoid writing a second element in one array is the larger
  change wearing the smaller one's clothes.

Declaring both is safe **only because these four routes bind no company**: each reads or
writes the caller's own row and issues no tenant-scoped query.

### Nothing in Plan 2b produces `409 scope_required`, and that is Plan 2c's first problem

Parent §6.3.3 promises **409 `scope_required`** when a tenant route is reached by an
unscoped platform admin. **Plan 2b builds no producer for it.** It registers no tenant
route, so the code has no home in the pipeline, no test asserts it, and nothing goes red
for its absence. §6.3.5's step-10 note — Plan 2b's departure (c) — defers the *per-resource*
half of authorization to Plan 2c without noticing that the **scope-state** half has no
owner at all.

Plan 2c registers roughly twenty tenant routes at `anyUser` and every one of them needs it.
The cheap wrong repair available at that moment is to let the unscoped admin through
because the alias above already admits them; that turns a platform administrator who has
selected no company into a caller with access to all of them, which is the hole this
section exists to refuse.

Where it should live: **beside the role gate at step 7.5**, reading `scope.kind` against
whether the route binds a company, and answering `409` with code `scope_required` rather
than 403. `POST /api/admin/scope` (Task 15) is the caller's way out of that state and
already ships, so the 409 has somewhere to point.

**Do not build it here.** Plan 2b has no route that could exercise it, and a producer with
no consumer is untested code in the credential path. What 2b leaves behind instead is a
closed door with a test on it: `"a tenant route alias still refuses an unscoped platform
admin"` in `apps/core-api/test/auth-routes.test.js` asserts
`permits(unscoped, ["anyUser"]) === false`, so Plan 2c inherits a known refusal to convert
into a 409 rather than an accident to discover.

## 12. Amendments required to the parent spec

**Plan 2b (Task 17) carried out the rows for §5.7, §5.9, §6.1, §8.5 rule 2, §9.5, §9.12
and §10**, plus two the table did not anticipate: §6.2's four identity rows (see §11.11)
and the §6.3.5 step-10 split. The remaining rows belong to the plans that ship the
routes they describe.

| Section | Amendment |
| --- | --- |
| §5.3 | The third clause of §6.3 above. |
| §5.7 | Roster seven → ten; delete the false claim about `route()` rejecting unknown limiter names, or make it true in the same commit (this slice makes it true). |
| §5.9 | The five actions of §8 above. |
| §6.1 | "exactly four entries" → the enumerated eight, with a note that it becomes nine with the terminal plan. |
| §8.5 rule 2 | The same literal. |
| §9.5 | Block 4's `curl -fsS … \|\| true` recipe, and the 404 → 401 expectation. |
| §9.12 | The semaphore-occupancy sentence of §7.3 above. |
| §10 | "Password reset / forgot-password — Phase 2" is superseded; it ships here. Likewise the invite-token row, which is **not** built — record it as cut, not deferred, since decision 2 chose minted passwords instead. |
| §11 | The roster's third naming site; the email-delivery residual. |
| §7 | "single dependency `pg`" is already false (`express` is declared) and becomes further false with `nodemailer`. |
