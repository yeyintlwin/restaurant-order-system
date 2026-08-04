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
mint site therefore runs `SELECT … FOR UPDATE` → revoke any live row → insert,
inside one transaction. This is the same remedy the parent spec prescribes for
`terminal_pairing_codes`, for the same reason.

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

The literal "the settled four" is written in three places and all three move
together: `route-auth.test.js:33-36`, `router.js:75`, and the parent spec at
§6.1 and §8.5 rule 2.

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

### 7.1 §5.7 makes a claim that is not true

The parent states that *"`route()` rejects at boot any route whose `limit` names a
limiter absent from it."* It does not. `validateRouteTable` inspects only
`options.limit.key` at `router.js:129-133`; there is no roster constant and no
`limit.name` membership check anywhere in the service. `limit: { key: "ip", name:
"forgot-global" }` registers today and the process listens fine.

This slice **authors that check**, because it is the first slice with limiters to
check. It also authors §5.9's audit-vocabulary membership check, deferred by
`router.js:78` with the same reasoning.

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

Every literal below describes work that does not exist yet. They are frozen in
tests and configuration **today**, and they must all move in the same commit as
the code they describe. This section exists so the implementation plan can be
written without re-deriving it.

### 9.1 Blockers

| # | What |
| --- | --- |
| B1 | The landing pages cannot be served under the shipped CSP. Resolved by §6.4. |
| B2 | Both landing pages register through `route()` and so join the public set. `express.static` is unavailable: `source-structure.test.js` deep-equals the express-requiring file list to `["http/router.js"]`. |
| B3 | Registering the login route trips `deploy-config.test.js:731-741`, whose failure message orders three further edits — and obeying it turns `:721` red, because the `PLAN 2` marker it matches exists only in the comment being deleted. |
| B4 | `source-structure.test.js:40` deep-equals dependencies to `["express", "pg"]` and `:49` asserts `devDependencies === undefined`. `package-lock.json` must be regenerated in the same commit or `npm ci` fails in the image while local tests stay green. |
| B5 | `route-auth.test.js:90-97` requires `sample` on every entry, including all ~25 previously specified routes. |

### 9.2 Files and edit counts

| File | Edits | Principal change |
| --- | --- | --- |
| `test/route-auth.test.js` | 3 | public set 2 → 8; new origin-gating census |
| `test/migrate.test.js` | 5 | the `["0001_init.sql"]` pins of §3.5 |
| `test/schema-invariants.test.js` | 4 | three lists plus a new positive assertion |
| `test/source-structure.test.js` | 3 | dependencies; the `nodemailer` rule; the `res.end` rule |
| `test/deploy-config.test.js` | 6 | 404 → 401; `not_found` → `invalid_credentials`; delete the `routesDir` loop |
| `test/nginx-config.test.js` | 5 | zone count; include count 4 → 6; the "two credential routes" title |
| `test/operations-docs.test.js` | 4 | the `Plan 2` tripwires |
| `test/config.test.js` | 2 | both frozen env fixtures |
| `http/respond.js` | 5 | `sendHtml`; second header table; the Retry-After comment |
| `http/router.js` | 4 | limiter roster check; audit membership check; three comments |
| `.github/workflows/deploy.yml` | 9 | block 4; the real forged-XFF probe |
| `infra/nginx/api.conf` | 3 | two exact-match locations; one zone |
| `infra/README.md` | 6 | see the line-budget hazard below |
| Parent spec | 14 | §6.1, §8.5 rule 2, §5.3, §5.7, §9.5, §9.12, §10, §11 |

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

- **The client-IP section has one line of headroom.** `operations-docs.test.js:78-81`
  caps `## The client-IP chain` at 40 lines and it is 39 today.

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

The remedy is out-of-band and already exists: `scripts/set-password.js` over
`docker compose exec`, which the parent spec calls *"honest for a platform with
one operator."* Should this become a support burden, the smallest fix is a
`scripts/set-user-email.js` CLI — operator-only, granting no role a new
permission — rather than an HTTP route.

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

## 12. Amendments required to the parent spec

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
