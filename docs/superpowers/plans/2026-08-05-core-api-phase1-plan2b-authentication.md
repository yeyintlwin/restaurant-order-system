# Core API Phase 1 — Plan 2b: Authentication, Sessions and the Request Pipeline

> ## ⚠️ REVIEWED, AND EXECUTION IS UNDER WAY — READ THE EXECUTION LOG
>
> All 17 tasks are written and the plan has been through an adversarial review: 57
> findings, 27 of which survived three independent attempts to refute each one. Two
> were decisions rather than defects and are settled in Part 5 departure (d) and in
> Task 7's `bootstrapPlatformAdmin`.
>
> **Tasks 1–6 are implemented and committed.** The execution log below is the state;
> this paragraph is not.
>
> This banner has now been wrong twice. It first said Part 4 was empty and the plan
> stopped at Task 9, while Tasks 10 and 11 were already written under it. It then
> said NOT YET EXECUTED while six tasks were committed. Both times the plan's own
> standing rule was the thing that caught it: **a status line is a mirror like any
> other, and this one drifts faster than any of them.** Trust the checkboxes and the
> execution log, never a prose summary — including this one.
>
> **The single most dangerous task is Task 12**, and it is dangerous in a specific,
> bounded way rather than a vague one. Registering `POST /api/admin/auth/login`
> trips `deploy-config.test.js`, because the deploy's block-4 probe expects a 404 at
> that path. The route, `deploy.yml` and that test move in **ONE commit** or a real
> deploy aborts *after* the migration has applied. The tripwire is red for the whole
> of that task; that is it working, not it breaking.
>
> **Three departures from what Parts 1–4 assume** are stated at the top of Part 5,
> before the task that acts on each. Read them before Task 15: one new file
> (`lib/authorization.js`), one pipeline step that Task 11 did not wire
> (`options.roles` is decorative until then), and one deliberate re-ordering inside
> §6.3.5 step 10.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the platform usable by a human. At the end of this plan a platform
administrator exists (created by a CLI that refuses a non-TTY stdin), can sign in,
read `me`, change their password, select a company to act inside, and sign out —
everywhere. The §6.3.5 request pipeline exists as one ordered function, the two
boot checks §5.7 and §5.9 claim but do not have are real, and the deploy's
forged-`X-Forwarded-For` probe finally asserts what it was written to assert.

**Architecture:** Three layers, and the boundaries are the enforcement suites, not
convention. `lib/rate-limit.js` is Tier-1 **pure** (no filesystem, no network, no
database, injected clock — rules C9/C14). `http/cookies.js` and `http/csrf.js` are
pure but may see `db/errors.js`, which is itself Tier 1. `repositories/auth/{users,
sessions,scope-materialize}.js` are the three remaining pre-tenant repositories
that `withUnscopedConnection`'s nine-entry allowlist **already names** — no rule
widens for them. `http/authenticate.js` orchestrates and issues no SQL of its own.
`http/router.js` grows the pipeline; it stays the only file that touches express.

**Tech Stack:** Node 20 (CommonJS, plain JavaScript), `node:crypto`, `node:net`
(`isIP`, supplied to `lib/client-ip.js` from `http/`), `process.stdin.setRawMode()`
(the bootstrap CLI's echo-off prompt), PostgreSQL 16, `node --test` +
`node:assert/strict`. **No new npm dependency, and no new configuration variable** —
see "Why 2b adds no config" below.

> An earlier draft of this line named `node:readline`. Task 16 does not use it: the
> readline recipe for echo-off overrides `_writeToOutput`, an underscore-prefixed
> Node internal, and this service does not put a credential prompt on a private API.
> `setRawMode` is the documented one.

**Spec:** [2026-08-04-core-api-identity-slice-design.md](../specs/2026-08-04-core-api-identity-slice-design.md),
whose §11.5–§11.9 are the amendments this plan carries out. Bare section
references (§5.1, §6.3.5, §8.5) point at the **parent**,
[2026-07-29-core-api-phase1-design.md](../specs/2026-07-29-core-api-phase1-design.md).

---

## Execution log

**Status: 6 of 17 tasks done. Next is Task 7.**

Append one row per working session. A task counts as finished only when all of its
steps are ticked and its commit exists.

| Date | Session did | Tasks finished | Commits | Next |
| --- | --- | --- | --- | --- |
| 2026-08-05 | Adversarial review of the whole plan before executing any of it: 57 findings, 27 surviving a three-lens refutation. Two were decisions an executor is forbidden to make. **(a)** Task 15's role gate 403s the only account this plan creates — `anyUser` admits a *scoped* platform admin and login always materialises `actingCompanyId: null`, so the bootstrap administrator could not read `me`, sign out, or change the password the CLI had just set. No test could see it: `signedIn()` resolves a `company_admin`. Settled as `["platform", "anyUser"]` on the four identity routes; both rejected repairs recorded with reasons. **(b)** The bootstrap CLI had no monotonic guard, though §12's acceptance checkbox demands one and §714/§855 make it the justification for the only peer-creating route in the system. Task 7 grew `bootstrapPlatformAdmin`: advisory lock, `audit_events` guard, audit row written *inside* the transaction. | **0/17** | `3c63fc8`, `60ec079` | Task 1 |
| 2026-08-05 | Tasks 1–6. The limiter roster, both boot checks §5.7 and §5.9 claimed but did not have, the `TRUSTED_PROXY_HOPS` ↔ proxy-depth assertion, and the two pure HTTP primitives. Three findings the review had missed came out of *executing* rather than reading: the identity-slice spec holds two now-false statements carrying no deferral keyword, so Task 17's greps walk past them (named explicitly now); `infra/README.md` gained a *Checked:* note that was backwards about what the new assertion covers (corrected — a proxy in front of nginx is outside the repository and no file check can see it); and "Why 2b adds no config" was short by three variables. **392 → 434 tests, 0 failures.** | **6/17** | `456d3a3`, `24cd69e`, `bf2021c`, `fb1fc1c`, `f2853ec`, `4098e3c`, `7fbd771` | Task 7 |

Baseline at the head of this plan, measured: **14 / 33 / 69 / 392**, 0 failures,
1 skip (C6, guarded on `repositories/platform/`, which arms in Plan 2c).

---

## How to pick this up

**The checkboxes are the state.** Tick them as you go and commit the plan file
with the code. There is no other progress tracker.

**Tick them with exact-string edits, NEVER with `sed -i`.** This file has CRLF line
endings — `.gitattributes` sets them — so `sed -i` rewrites every line ending in the
file and produces a diff of *seven thousand* insertions and seven thousand deletions
in place of your five characters. The Task 7 executor did exactly this, caught it in
`git diff --stat` before staging, and reverted. Check your own diff before you stage:

```bash
git diff --stat -- docs/superpowers/plans/2026-08-05-core-api-phase1-plan2b-authentication.md
git diff -U0 -- docs/superpowers/plans/2026-08-05-core-api-phase1-plan2b-authentication.md | grep '^[+-]- \['
```

The first should report single-digit line counts and the second should print only
`- [ ]` → `- [x]` pairs. While you are there: **line numbers from a file-reading tool
and from `grep -n` disagree on this file**, which is the other half of how that sed
went wrong. Address edits by quoted text, never by line number — which is what the
standing rule below already says about every other list in this repository.

**Every command below runs from the repository root**, not from `apps/core-api`.

**Database-backed tests need a live Postgres and are a HARD FAILURE without one** —
that is deliberate (*"a silently skipped tenant-isolation suite is worse than a red
one"*). Start one and export the URL before Task 7:

```bash
docker run -d --name core-db-dev -e POSTGRES_USER=core_api_owner \
  -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=core \
  -p 127.0.0.1:5433:5432 postgres:16-alpine
export CORE_API_TEST_DATABASE_URL='postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
```

PowerShell:

```powershell
$env:CORE_API_TEST_DATABASE_URL = 'postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
```

Tasks 1–6 and 10 need no database. Tasks 7, 8, 9 and 11 do.

**Tasks 12–17 drive stubs and need no database of their own** — the six routes are
tested against injected repositories, the bootstrap CLI's three guards all fire
before a pool is opened, and Task 17 edits documentation. That is not a licence to
skip Postgres: every task ends with `npm test`, which runs the database-backed suites
and **throws** without one, and Task 16 carries a manual end-to-end check that needs
both a database and a real terminal.

### Standing rule: every list in this repository is mirrored somewhere

Plan 2a undercounted its own edit sites **three times** — Task 2 named five pins
where there were six, Task 3 named three files where there were four, and Task 3's
list was still short by two after that. The pattern is not carelessness in any one
task; it is that this codebase deliberately pins invariants in more than one place
so a change cannot land quietly, and the mirrors are **not co-located with what
they mirror**.

`schema-invariants.test.js`'s exception lists are re-derived by
`backup-restore.test.js`, which cross-checks them against a **shell script** in
`infra/`. The public route set is written in `route-auth.test.js`, in a comment in
`router.js`, and twice in each of two specs. The audit vocabulary is consumed by a
runtime writer, a boot check, and three synthetic route tables in a test file that
has nothing to do with auditing.

**So: before editing any list, grep for its name and for the spelled-out count
across `apps/`, `infra/`, `.github/` and `docs/` — and treat a site this plan does
not mention as a finding to report, not a decision to make.** Every task below
gives the **grep**, never a line number. Line numbers in the 2a plan drifted three
separate times.

### Six things this plan will NOT let you do

**1. `0001_init.sql` and `0002_identity.sql` are untouchable.** Both are applied in
production with their SHA-256 recorded in `schema_migrations`. Editing one byte
yields `checksum_mismatch`, which is fatal, and `/health/ready` answers 503
forever. **This plan adds no migration at all** — every table it reads and writes
exists.

**2. Never name a `withUnscopedConnection` callback `client`.** Rule C2's first
needle is the literal text `/\b(?:pool|client)\.query\s*\(/` **outside `db/`,
including inside C4's allowlist**. The handle yielded is a narrow `{ query }`
object, not a pg `Client`, and calling it `client` misdescribes it *and* turns C2
red while the module's own tests stay green. Plan 2a shipped exactly this bug once,
because it copied the shape out of C4's deliberately-**violating** fixture string.
**This plan opens three such callbacks — Tasks 7, 8 and 9 — and all three are named
`connection`.** `db/health.js` and `repositories/auth/audit.js` are the working
precedent.

**3. Nothing under `lib/` may require `node:fs`, `node:http(s)`, `node:net`,
`node:dns`, `node:tls`, `node:child_process`, `pg` or `../db/*`** — C9, and it now
catches the un-prefixed forms too. C14 additionally bans `Math.random` and
`pseudoRandomBytes` there. C15 asserts required text is still **present**: it
exists because deleting `.normalize("NFKC")` from `verifyPassword` left the whole
suite green. `lib/rate-limit.js` (Task 1) inherits all three on arrival.

**4. Do not disturb C16.** `epaper/hub-client.js` is pinned as the SDK's one
permitted caller by a `deepEqual` against a one-element list, asserted both
app-locally and across `apps/` and `packages/`.

**5. `POST /api/terminal/table-displays/:tableNumber` already exists and your
pipeline must not break it.** It is the only authenticated route in the service. It
is `auth: 'terminal'`, and it authenticates a **configured shared service token
inside its own handler** — there is no `terminal_tokens` row behind it and there
will not be one until Phase 3 pairs `customer-order`. Task 11 therefore resolves
credentials for `auth: 'user'` **only**; `auth: 'terminal'` passes through the
pipeline untouched, exactly as today. Adding bearer resolution here would 401 the
one working route in the service before its handler ever ran. `test/table-displays.test.js`
is in the suite and is the thing that tells you.

**6. Registering `POST /api/admin/auth/login` trips a deliberate tripwire, and the
fix is in the same commit.** See Task 12. Do not read ahead and "prepare" it —
`deploy-config.test.js` is what stops the route from landing without the deploy
edit, and disarming it early removes the only thing holding the two together.

### Why 2b adds no config, and why that was the goal

The brief's rule is: *any new required config refuses to listen and fails the
deploy gate **after** the migration applied; prefer optional-with-a-loud-log on
core-api's side and put the strictness on the caller.* This plan takes the option
strictly better than either — **it introduces no environment variable at all.**

Everything it needs is already in `config.js` `DEFAULTS` and already in
`docker-compose.yml`'s `core-api` block: `SESSION_IDLE_SECONDS`,
`SESSION_ABSOLUTE_SECONDS`, `LOGIN_RATE_PER_MINUTE`, `LOGIN_TIME_BUDGET_MS`,
`SCRYPT_SLOTS`, `PASSWORD_ABUSE_THRESHOLD`, `ADMIN_MINT_RATE_PER_10MIN`,
`PAIR_RATE_PER_MINUTE`, `PAIRING_MINT_RATE_PER_10MIN`, `ROTATE_RATE_PER_HOUR`,
`TRUSTED_PROXY_HOPS`, `API_PUBLIC_ORIGIN`. Plan 1 defaulted them for exactly this
plan.

**The last three are in that list on purpose, even though no route in Plan 2b reads
them.** Task 1's roster declares all seven §5.7 limiters, and every one names the
config field that sizes it — `pair-global`, `pairing-code-mint` and `token-rotate`
included, because the roster is written once and the routes that consume those three
arrive with the terminal plan. An earlier draft of this paragraph named only the
rate knobs 2b's own routes use, which reads as though the other three do not exist;
they do (`config.js` `DEFAULTS`, and the matching camelCase readers below it), and a
later task that "fixes" a `ceilingKey` it believes is undefined would be breaking a
correct roster.

The consequence worth stating: **`config.js` `DEFAULTS`, `docker-compose.yml` and
`.env.example` do not move in this plan.** `config.test.js`'s `deepEqual(DEFAULTS,
COMPOSE_DEFAULTS)` and its `NOT_DEFAULTED_IN_CODE` exclusion list stay exactly as
they are. If you find yourself adding a knob, stop: it is almost certainly a value
that belongs in the §5.7 roster (Task 1) or in `lib/` as a constant.

`lib/time.js` from §7's file layout is **not** built here either. The two things
2b needs from it — clamping a renewed session to `absolute_expires_at`, and the
60-second renewal throttle — are `LEAST(...)` and a `WHERE last_seen_at < now() -
interval '60 seconds'`, both of which belong in the SQL that does the write.
`lib/time.js`'s real content is the IANA-zone and business-day-rollover proof, and
that arrives with shops, in Plan 2c.

---

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `apps/core-api/lib/rate-limit.js` | The §5.7 roster + fixed-window buckets, injected clock | 1 |
| `apps/core-api/http/router.js` | Roster boot check; vocabulary boot check; the §6.3.5 pipeline; the step-10 role gate | 2, 3, 11, 15 |
| `apps/core-api/lib/audit-vocabulary.js` | The nine actions 2b's routes and CLI emit | 3 |
| `apps/core-api/test/nginx-config.test.js` | §11.5's `TRUSTED_PROXY_HOPS` ↔ proxy-depth assertion | 4 |
| `apps/core-api/http/cookies.js` | Collect every value for a name; build the `__Host-` cookie | 5 |
| `apps/core-api/http/csrf.js` | The amended §5.3 rule, gated on the channel | 6 |
| `apps/core-api/repositories/auth/users.js` | Login lookup, atomic backoff, password write, the sessions_valid_from lever | 7, 13 |
| `apps/core-api/repositories/auth/sessions.js` | create / resolve / renew / delete / acting company | 8 |
| `apps/core-api/repositories/auth/scope-materialize.js` | `shopIds` and `administeredShopIds` | 9 |
| `apps/core-api/http/authenticate.js` | Cookie resolution, strict channel binding, read-only | 10 |
| `apps/core-api/http/routes/auth.js` | The six routes, and the me-document they share | 12–15 |
| `.github/workflows/deploy.yml` | Block 4 becomes the behavioural forged-XFF gate | 12 |
| `apps/core-api/lib/authorization.js` | §5.4's alias table — the half of `lib/authorization.js` this plan builds | 15 |
| `apps/core-api/scripts/create-platform-admin.js` | §5.6/§9.10 bootstrap CLI | 16 |
| `apps/core-api/server.js` | Route requires, the new collaborators, the platform-admin boot warning | 12, 16 |
| `infra/README.md`, both specs | Retire every deferral marker this plan made false | 17 |

Test files mirror these under `apps/core-api/test/`, one per module.

`lib/rate-limit.js` holds the roster rather than `http/router.js` for the same
reason `lib/audit-vocabulary.js` is separate from the audit writer: **two consumers
must agree on it** — `validateRouteTable`, which rejects an unknown `limit.name` at
boot, and the pipeline, which consumes the bucket at request time. Two copies would
disagree the first time somebody adds a limiter.

---

## Part 1 — The two boot checks, and the one cross-file assertion

### Task 1: `lib/rate-limit.js` — the §5.7 roster and the buckets

**Files:**

- Create: `apps/core-api/lib/rate-limit.js`
- Create: `apps/core-api/test/rate-limit.test.js`

**Why the roster is all seven, and the audit vocabulary is only what 2b emits.**
These look like the same decision and they are not. §11.6 tells Plan 2b to
*"complete the vocabulary alongside the routes that emit each action"* because
`lib/audit-vocabulary.js` is consulted by a **runtime writer**: an entry with no
emitting route is a standing permission to write a row nobody chose, and
`audit_events`' own CHECK is a shape regex that would not notice. The limiter
roster is consulted **only at boot** and grants nothing; an entry naming no route
is inert. §5.7 also says the roster is *"defined once here and nowhere else"* and
enumerates all seven as settled. So all seven land now, and Plan 2d widens it to
ten.

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/rate-limit.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { LIMITERS, createRateLimiter } = require("../lib/rate-limit");

// A hand-cranked clock. lib/ reads no ambient clock (Tier 1), which is the whole
// reason these tests can assert window expiry without sleeping.
function clock(start = 1_700_000_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

test("the roster is exactly the seven limiters of spec 5.7", () => {
  // deepEqual on a sorted array, not a subset: adding an eighth fails and so does
  // removing one. Plan 2d widens this to ten (forgot-global, reset-consume,
  // verify-request) in the same commit as the routes that declare them.
  assert.deepEqual(Object.keys(LIMITERS).sort(), [
    "create-user",
    "login-global",
    "pair-global",
    "pairing-code-mint",
    "password-change-abuse",
    "password-reset",
    "token-rotate"
  ]);
  assert.ok(Object.isFrozen(LIMITERS));
});

test("every roster entry declares a key, a window, a Retry-After policy, a bucket and a ceiling", () => {
  const { DEFAULTS } = require("../config");
  // config.js's naming rule: every DEFAULTED key is the camelCase of its
  // environment variable. Re-derived here rather than hand-listed, so a renamed
  // variable turns this red instead of silently sizing a bucket at undefined.
  const camel = (name) =>
    name.toLowerCase().replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
  const configFields = new Set(Object.keys(DEFAULTS).map(camel));

  for (const [name, entry] of Object.entries(LIMITERS)) {
    assert.ok(["ip", "user", "terminal"].includes(entry.key), `${name} keys on ${entry.key}`);
    assert.ok(Number.isInteger(entry.windowMs) && entry.windowMs > 0, `${name} window`);
    assert.equal(typeof entry.retryAfter, "boolean", `${name} retryAfter`);
    assert.ok(["request", "failure"].includes(entry.consume), `${name} consume`);
    assert.ok(Object.prototype.hasOwnProperty.call(LIMITERS, entry.bucket), `${name} bucket`);
    // The ceiling is a CONFIG FIELD THAT EXISTS. Without this the pipeline reads
    // deps[undefined-key], passes undefined as the ceiling, and lib/rate-limit.js
    // throws inside a request -- a 500 on the login path, from a typo in a table.
    assert.ok(configFields.has(entry.ceilingKey), `${name} names config field ${entry.ceilingKey}, which does not exist`);
    assert.ok(Object.isFrozen(entry));
  }
});

test("login-global and pair-global refuse Retry-After, because it would confirm the bucket", () => {
  // Spec 5.7 states this for both, and 6.2 repeats it for login: a Retry-After on
  // a credential-independent bucket tells an attacker their probes are landing.
  assert.equal(LIMITERS["login-global"].retryAfter, false);
  assert.equal(LIMITERS["pair-global"].retryAfter, false);
  // ...and every principal-keyed limiter does carry it: the caller is
  // authenticated, so there is no oracle left to protect.
  for (const name of ["create-user", "password-reset", "pairing-code-mint", "password-change-abuse", "token-rotate"]) {
    assert.equal(LIMITERS[name].retryAfter, true, name);
  }
});

test("create-user and password-reset SHARE one bucket", () => {
  // Spec 5.7: they mint the same credential, and separating them would double the
  // email-probing ceiling 5.8(b) exists to bound.
  assert.equal(LIMITERS["create-user"].bucket, "create-user");
  assert.equal(LIMITERS["password-reset"].bucket, "create-user");

  const time = clock();
  const limiter = createRateLimiter({ now: time.now });
  for (let n = 0; n < 20; n += 1) {
    assert.equal(limiter.consume("create-user", "u1", 20).allowed, true, `call ${n}`);
  }
  // The 21st arrives through the OTHER name and must still be refused.
  assert.equal(limiter.consume("password-reset", "u1", 20).allowed, false);
});

test("password-change-abuse is consumed on FAILURE, not per request", () => {
  // Spec 5.7's ceiling is "5 consecutive current_password_invalid", which is not a
  // per-request count. The pipeline consumes `request` limiters at 6.3.5 step 4a
  // and 5b; `failure` limiters are consumed by the handler, and reset on success.
  assert.equal(LIMITERS["password-change-abuse"].consume, "failure");
  assert.equal(LIMITERS["login-global"].consume, "request");
});

test("a fixed window admits the ceiling and refuses the next call", () => {
  const time = clock();
  const limiter = createRateLimiter({ now: time.now });

  for (let n = 1; n <= 30; n += 1) {
    assert.equal(limiter.consume("login-global", "203.0.113.9", 30).allowed, true, `call ${n}`);
  }
  const shed = limiter.consume("login-global", "203.0.113.9", 30);
  assert.equal(shed.allowed, false);
  assert.equal(shed.retryAfterSeconds, null, "login-global must not disclose a Retry-After");
});

test("a different key is a different bucket, so one address cannot lock out another", () => {
  const time = clock();
  const limiter = createRateLimiter({ now: time.now });

  for (let n = 1; n <= 30; n += 1) limiter.consume("login-global", "198.51.100.1", 30);
  assert.equal(limiter.consume("login-global", "198.51.100.1", 30).allowed, false);
  assert.equal(limiter.consume("login-global", "198.51.100.2", 30).allowed, true);
});

test("the window really expires, and the boundary is exclusive", () => {
  const time = clock();
  const limiter = createRateLimiter({ now: time.now });

  limiter.consume("login-global", "k", 1);
  assert.equal(limiter.consume("login-global", "k", 1).allowed, false);

  // One millisecond short of the window: still shed.
  time.advance(LIMITERS["login-global"].windowMs - 1);
  assert.equal(limiter.consume("login-global", "k", 1).allowed, false);

  time.advance(1);
  assert.equal(limiter.consume("login-global", "k", 1).allowed, true, "the window did not roll");
});

test("a principal-keyed limiter reports a Retry-After that shrinks as the window drains", () => {
  const time = clock();
  const limiter = createRateLimiter({ now: time.now });

  limiter.consume("create-user", "user-1", 1);
  const first = limiter.consume("create-user", "user-1", 1);
  assert.equal(first.allowed, false);
  assert.equal(first.retryAfterSeconds, 600);

  time.advance(599_000);
  const later = limiter.consume("create-user", "user-1", 1);
  assert.equal(later.allowed, false);
  assert.equal(later.retryAfterSeconds, 1, "Retry-After must never round down to 0");
});

test("reset() clears one bucket and nothing else", () => {
  const time = clock();
  const limiter = createRateLimiter({ now: time.now });

  limiter.consume("password-change-abuse", "user-1", 5);
  limiter.consume("password-change-abuse", "user-2", 5);
  limiter.reset("password-change-abuse", "user-1");

  assert.equal(limiter.consume("password-change-abuse", "user-1", 1).allowed, true);
  assert.equal(limiter.consume("password-change-abuse", "user-2", 1).allowed, false);
});

test("an unknown limiter name is a programming error, not a silent allow", () => {
  const time = clock();
  const limiter = createRateLimiter({ now: time.now });
  assert.throws(() => limiter.consume("invented", "k", 1), /not in the .*roster/);
});

test("the tracked-key table is bounded, and expired windows go first", () => {
  const time = clock();
  const limiter = createRateLimiter({ now: time.now, maxKeys: 4 });

  for (let n = 0; n < 4; n += 1) limiter.consume("login-global", `a${n}`, 30);
  assert.equal(limiter.size(), 4);

  // Every one of those windows is now dead. A fifth key sweeps them rather than
  // growing the table -- an unauthenticated map that only ever grows is a memory
  // vector, which is the same objection 6.3.5 raises against keying on a
  // credential.
  time.advance(LIMITERS["login-global"].windowMs + 1);
  limiter.consume("login-global", "b0", 30);
  assert.equal(limiter.size(), 1);
});

test("when every window is live, the table still refuses to grow past maxKeys", () => {
  const time = clock();
  const limiter = createRateLimiter({ now: time.now, maxKeys: 3 });

  for (let n = 0; n < 10; n += 1) limiter.consume("login-global", `live${n}`, 30);
  assert.ok(limiter.size() <= 3, `size grew to ${limiter.size()}`);
});

test("createRateLimiter refuses to read an ambient clock", () => {
  assert.throws(() => createRateLimiter(), /injected now/);
  assert.throws(() => createRateLimiter({ now: Date.now() }), /injected now/);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/rate-limit.test.js
```

Expected: FAIL — `Cannot find module '../lib/rate-limit'`.

- [x] **Step 3: Write the module**

Create `apps/core-api/lib/rate-limit.js`:

```js
"use strict";

// PURE (spec 8.8, Tier 1): no database, no filesystem, no network, and NO AMBIENT
// CLOCK -- `now` is injected, which is what lets every window boundary below be
// asserted without sleeping. Rules C9 (impure require) and C14 (weak randomness)
// both scan this directory.
//
// THE ROSTER IS SPEC 5.7's TABLE, and 5.7 says it is "defined once here and
// nowhere else". That sentence is only true if the roster is a single constant
// two consumers read: http/router.js's validateRouteTable, which rejects at boot
// any route whose limit names a limiter absent from it, and the request pipeline,
// which consumes the bucket. Spec 5.7 CLAIMED that boot check existed before Plan
// 2b; it did not, and this file plus Task 2 is what makes the claim true.
//
// The in-process state is correct rather than a compromise: these buckets bound
// THIS process's CPU and this deployment has exactly one replica. The network half
// of the same shed lives in infra/nginx/api.conf (zone=core_login), and neither
// half substitutes for the other -- nginx cannot see users.id and this cannot see
// a request nginx already dropped.

const MINUTE = 60 * 1000;
const TEN_MINUTES = 10 * MINUTE;
const HOUR = 60 * MINUTE;

// `bucket` names the SHARED counter. It is almost always the limiter's own name;
// spec 5.7 makes exactly one pair share, and it says why: create-user and
// password-reset mint the same credential, so separating them would double the
// email-probing ceiling 5.8(b) exists to bound.
//
// `consume` is "request" for a bucket the pipeline decrements on every call, and
// "failure" for one the HANDLER decrements only when the attempt failed.
// password-change-abuse is the only "failure" limiter today, and 5.8(a) is why:
// its ceiling is five CONSECUTIVE current_password_invalid results, reset by a
// correct password -- a per-request count would lock a user out of their own
// password-change route for succeeding at it.
// `ceilingKey` is the CONFIG FIELD that sizes the bucket, and it is here rather
// than in the pipeline so the roster stays the one place 5.7's table is written.
// config.js's naming rule makes the mapping mechanical: every defaulted key is the
// camelCase of its environment variable (ADMIN_MINT_RATE_PER_10MIN ->
// adminMintRatePer10min), so the pipeline reads deps[declared.ceilingKey] and no
// fourth copy of the roster exists.
function limiter(key, windowMs, retryAfter, consume, bucket, ceilingKey) {
  return Object.freeze({ key, windowMs, retryAfter, consume, bucket, ceilingKey });
}

const LIMITERS = Object.freeze({
  // Retry-After is deliberately absent on both credential-independent buckets:
  // the header would confirm to an attacker that their probes are landing, and
  // login and pair are the two 429s spec 6.2 marks as carrying no Retry-After.
  "login-global": limiter("ip", MINUTE, false, "request", "login-global", "loginRatePerMinute"),
  "pair-global": limiter("ip", MINUTE, false, "request", "pair-global", "pairRatePerMinute"),
  "create-user": limiter("user", TEN_MINUTES, true, "request", "create-user", "adminMintRatePer10min"),
  // Shares create-user's BUCKET and its CEILING: spec 5.7 says separating them
  // would double the email-probing ceiling 5.8(b) exists to bound.
  "password-reset": limiter("user", TEN_MINUTES, true, "request", "create-user", "adminMintRatePer10min"),
  "pairing-code-mint": limiter("user", TEN_MINUTES, true, "request", "pairing-code-mint", "pairingMintRatePer10min"),
  "password-change-abuse": limiter("user", HOUR, true, "failure", "password-change-abuse", "passwordAbuseThreshold"),
  "token-rotate": limiter("terminal", HOUR, true, "request", "token-rotate", "rotateRatePerHour")
});

// A ceiling on how many windows are tracked at once. Keying on a client IP is
// keying on something an attacker can vary, so without a bound the map is an
// unauthenticated memory-growth vector -- the same objection spec 6.3.5 raises
// against keying a bucket on a presented credential.
const MAX_TRACKED_KEYS = 10000;

// "::" cannot collide: every bucket name comes from the frozen roster above and
// none of them contains a colon, so no (bucket, key) pair can spell the same
// composite id as another.
const SEPARATOR = "::";

function createRateLimiter({ now, maxKeys = MAX_TRACKED_KEYS } = {}) {
  if (typeof now !== "function") {
    throw new Error("createRateLimiter requires an injected now() function (lib/ reads no ambient clock)");
  }
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new Error(`createRateLimiter: maxKeys must be a positive integer, got ${JSON.stringify(maxKeys)}`);
  }

  // Insertion-ordered by construction: a window is re-inserted at the back when it
  // STARTS, so the front is the least recently started.
  const windows = new Map();

  function evict(at) {
    if (windows.size <= maxKeys) return;
    for (const [id, window] of windows) {
      if (window.resetAt <= at) windows.delete(id);
    }
    // Still over the ceiling, so every remaining window is live and something has
    // to go. Dropping the least recently started one hands that key a fresh
    // allowance, and that residual is stated rather than hidden: an attacker can
    // flush the table only by spending maxKeys DISTINCT source addresses, which is
    // exactly the resource the bucket keys on, and nginx's core_login zone bounds
    // the arrival rate of each of them independently.
    while (windows.size > maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done) break;
      windows.delete(oldest.value);
    }
  }

  function declaredFor(name) {
    if (!Object.prototype.hasOwnProperty.call(LIMITERS, name)) {
      throw new Error(`rateLimit: "${String(name)}" is not in the spec 5.7 roster`);
    }
    return LIMITERS[name];
  }

  function idFor(declared, key) {
    if (typeof key !== "string" || key === "") {
      throw new Error("rateLimit: a bucket key must be a non-empty string");
    }
    return `${declared.bucket}${SEPARATOR}${key}`;
  }

  function consume(name, key, ceiling) {
    const declared = declaredFor(name);
    if (!Number.isInteger(ceiling) || ceiling < 1) {
      throw new Error(`rateLimit: ${name} needs a positive integer ceiling, got ${JSON.stringify(ceiling)}`);
    }

    const at = now();
    const id = idFor(declared, key);
    let window = windows.get(id);

    if (window === undefined || window.resetAt <= at) {
      window = { count: 0, resetAt: at + declared.windowMs };
      // delete-then-set so a rolled window moves to the BACK of the eviction
      // order. Map.set on an existing key keeps its original position.
      windows.delete(id);
      windows.set(id, window);
      evict(at);
    }

    window.count += 1;
    const allowed = window.count <= ceiling;
    // Ceil, and never below 1: a Retry-After of 0 invites an immediate retry that
    // is guaranteed to be shed again.
    const retryAfterSeconds = declared.retryAfter
      ? Math.max(1, Math.ceil((window.resetAt - at) / 1000))
      : null;

    return { allowed, count: window.count, retryAfterSeconds };
  }

  // Spec 5.8(a): a correct current password clears the consecutive-failure count.
  function reset(name, key) {
    windows.delete(idFor(declaredFor(name), key));
  }

  function size() {
    return windows.size;
  }

  return { consume, reset, size };
}

module.exports = { LIMITERS, createRateLimiter, MAX_TRACKED_KEYS };
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/rate-limit.test.js apps/core-api/test/source-structure.test.js
```

Expected: both pass. `source-structure.test.js` is run because C9 (impure require)
and C14 (weak randomness) now have one more `lib/` file to scan and must stay
green, and because the walker floor is a **minimum** — 26 scanned files clears the
floor of 25, so nothing breaks here. The floor is raised to its new exact value in
Task 17.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/lib/rate-limit.js apps/core-api/test/rate-limit.test.js
git commit -m "feat(core-api): the 5.7 limiter roster, as one constant two consumers read"
```

---

### Task 2: Make §5.7's boot check real

§5.7 states that *"`route()` rejects at boot any route whose `limit` names a
limiter absent from it."* It does not. `validateRouteTable` inspects only
`options.limit.key`. §11.6 says Plan 2b must *"either make the claim true or delete
it — and since 2b is the plan that introduces the first limited routes, making it
true is the cheaper of the two."* This is that.

**Files:**

- Modify: `apps/core-api/http/router.js`
- Modify: `apps/core-api/test/router-registration.test.js`
- Modify: `docs/superpowers/specs/2026-07-29-core-api-phase1-design.md` (§5.7)

**The mirrors.** Find them, do not trust this list:

```bash
grep -rn "limit.name\|limiter absent\|login-global" apps/core-api docs/superpowers/specs --include=*.js --include=*.md | grep -v node_modules
```

- [x] **Step 1: Write the failing test**

Append to `apps/core-api/test/router-registration.test.js`, after the existing
`validateRouteTable` cases:

```js
const { LIMITERS } = require("../lib/rate-limit");

test("validateRouteTable rejects a limit naming a limiter outside the 5.7 roster", () => {
  // Spec 5.7 claimed route() already did this. It did not: limit: { key: "ip",
  // name: "invented" } registered cleanly and the process listened. A limiter name
  // nobody declared is a bucket nobody sized, so the ceiling the route thinks it
  // has does not exist.
  assert.throws(
    () =>
      validateRouteTable([
        entry("POST", "/x", {
          auth: "public",
          body: null,
          audit: "auth.login",
          limit: { key: "ip", name: "invented" }
        })
      ]),
    /limit\.name "invented".*roster/s
  );
});

test("validateRouteTable rejects a limit whose key disagrees with the roster", () => {
  // The half that is easy to miss: "login-global" IS in the roster, so a name-only
  // check passes, while the route has quietly asked for a per-user bucket on a
  // public route. Rule 8 catches THAT particular pair; this catches the general
  // case, including terminal-vs-user on an authenticated route where rule 8 is
  // silent.
  assert.throws(
    () =>
      validateRouteTable([
        entry("POST", "/x", {
          auth: "user",
          roles: ["anyUser"],
          body: null,
          audit: "auth.login",
          limit: { key: "terminal", name: "create-user" }
        })
      ]),
    /keys "create-user" on "user"/
  );
});

test("validateRouteTable accepts every name in the roster", () => {
  // The anti-vacuity half. A regex typo that made the membership test always throw
  // would pass both cases above and make the whole roster unusable at boot.
  for (const [name, declared] of Object.entries(LIMITERS)) {
    const options = {
      auth: declared.key === "ip" ? "public" : "user",
      body: null,
      audit: "auth.login",
      limit: { key: declared.key, name }
    };
    if (options.auth === "user") options.roles = ["anyUser"];
    assert.doesNotThrow(() => validateRouteTable([entry("POST", "/x", options)]), name);
  }
});

test("validateRouteTable rejects a limit that is not an object", () => {
  for (const bad of ["login-global", 5, true]) {
    assert.throws(
      () => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: "auth.login", limit: bad })]),
      /must be an object/,
      JSON.stringify(bad)
    );
  }
});
```

> The `audit: "auth.login"` in these fixtures is deliberate and is Task 3's
> constraint arriving early: once the vocabulary membership check lands, a
> synthetic route declaring `shop.created` throws for the wrong reason. Writing
> them against a 2b action now means Task 3 does not have to come back and edit
> them.

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/router-registration.test.js
```

Expected: FAIL — three of the four new cases report
`Missing expected exception`; `validateRouteTable` currently returns the entries
unchanged for all of them.

- [x] **Step 3: Implement**

In `apps/core-api/http/router.js`, add the require beside the existing ones:

```js
const { LIMITERS } = require("../lib/rate-limit");
```

Then replace the existing principal-key check inside `validateRouteTable` — find it
with:

```bash
grep -n "PRINCIPAL_LIMIT_KEYS.includes" apps/core-api/http/router.js
```

— with this block:

```js
    if (options.limit !== undefined) {
      if (options.limit === null || typeof options.limit !== "object") {
        throw new Error(`route table: ${where} declares a limit that must be an object { key, name }`);
      }
      // Spec 5.7's own claim, made true. Until Plan 2b there was no roster
      // constant and no membership check anywhere in the service, so
      // limit: { key: "ip", name: "invented" } registered and the process
      // listened -- a route believing it was throttled by a bucket that did not
      // exist. The list is printed because the failure is a typo nine times in
      // ten and the reader needs the spelling.
      if (!Object.prototype.hasOwnProperty.call(LIMITERS, options.limit.name)) {
        throw new Error(
          `route table: ${where} declares limit.name ${JSON.stringify(
            options.limit.name
          )}, which is not in the spec 5.7 roster (${Object.keys(LIMITERS).sort().join(", ")})`
        );
      }
      // The roster owns the bucket key, and a route that disagrees with it is
      // asking for a bucket nobody sized. Rule 8 below catches only the
      // principal-on-public case; this catches user-vs-terminal too.
      const declared = LIMITERS[options.limit.name];
      if (declared.key !== options.limit.key) {
        throw new Error(
          `route table: ${where} declares limit.key ${JSON.stringify(options.limit.key)} but the roster keys "${
            options.limit.name
          }" on "${declared.key}"`
        );
      }
      // Rule 8, unchanged and deliberately kept as its own statement: spec 6.3.5
      // splits step 4a from 5b because five of the seven limiters key on a
      // principal that does not exist until credential resolution. route-auth.test.js
      // mirrors this assertion, so the two can disagree only by someone editing both.
      if (PRINCIPAL_LIMIT_KEYS.includes(options.limit.key) && options.auth === "public") {
        throw new Error(
          `route table: ${where} keys a rate-limit bucket on "${options.limit.key}" but is auth:'public' — that principal does not exist yet`
        );
      }
    }
```

Also update the "Deliberately NOT here" comment block above `validateRouteTable` —
find it with `grep -n "Plan 2, with the" apps/core-api/http/router.js` — so the
`§5.7 limiter roster` line no longer says it is deferred:

```js
//   rule 4's audit-vocabulary membership (§5.9) — Task 3 of Plan 2b, once the
//           vocabulary names every action a registered route emits.
//           The §5.7 limiter roster check IS here, above: it reads lib/rate-limit.js's
//           LIMITERS, which is the one place the roster is written.
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/router-registration.test.js apps/core-api/test/route-auth.test.js apps/core-api/test/rate-limit.test.js
```

Expected: all pass. `route-auth.test.js` is unaffected — no registered route
declares a `limit` yet.

- [x] **Step 5: Commit**

Amend the parent spec §5.7 in the same commit. Find the sentence with:

```bash
grep -n "rejects at boot any route whose" docs/superpowers/specs/2026-07-29-core-api-phase1-design.md
```

Replace *"`route()` rejects at boot any route whose `limit` names a limiter absent
from it"* with:

> `validateRouteTable()` rejects at boot any route whose `limit` names a limiter
> absent from it, or whose `limit.key` disagrees with the key declared here. The
> table itself lives in `apps/core-api/lib/rate-limit.js` as `LIMITERS`; this
> section and that constant are the same list, and it is read by the boot check and
> by the request pipeline so the two cannot drift.

```bash
git add apps/core-api/http/router.js apps/core-api/test/router-registration.test.js \
        docs/superpowers/specs/2026-07-29-core-api-phase1-design.md
git commit -m "feat(core-api): 5.7 said route() checked the limiter roster; now it does"
```

---

### Task 3: Land the audit-vocabulary membership check

§11.6: *"`lib/audit-vocabulary.js` exists, and wiring it into `validateRouteTable`
is about six lines — I wrote it and reverted it."* It was reverted because Plan 2a
declared only the five `auth.*` actions its own code emits, and landing the check
then would have blocked `router-registration.test.js`'s synthetic tables, which use
`shop.created`, `shop.updated` and `terminal.paired`. The instruction is to
*"complete the vocabulary alongside the routes that emit each action, then land the
check."*

**So this task does three things, and the third is the one the standing rule is
about:** add the nine actions 2b's routes and CLI emit; wire the check; and
**retarget `router-registration.test.js`'s three synthetic actions**, one of which
is a route in the LIVE registry that `createApp()` validates.

**Files:**

- Modify: `apps/core-api/lib/audit-vocabulary.js`
- Modify: `apps/core-api/http/router.js`
- Modify: `apps/core-api/test/audit-vocabulary.test.js`
- Modify: `apps/core-api/test/router-registration.test.js`

**The mirrors.** The three synthetic actions are not in an obvious place:

```bash
grep -rn "shop\.created\|shop\.updated\|terminal\.paired" apps/core-api --include=*.js | grep -v node_modules
```

That returns five sites in `router-registration.test.js`, and one of them —
`route("POST", "/__probe/ok", …)` at the top of the file — registers into the live
table, so `createApp()` in that same file throws the moment the check lands.

- [x] **Step 1: Write the failing test**

Add to `apps/core-api/test/audit-vocabulary.test.js`, beside the existing
`"the five identity-slice actions are declared"` test:

```js
test("the nine actions Plan 2b's routes and CLI emit are declared", () => {
  for (const action of [
    "auth.login",
    "auth.login_failed",
    "auth.logout",
    "auth.logout_all",
    "auth.password_changed",
    "platform.admin_created",
    "scope.cleared",
    "scope.selected",
    "user.password_change_abuse"
  ]) {
    assert.ok(AUDIT_ACTIONS[action], `${action} is not declared`);
  }
});

test("the two actions with no target declare targetKind null, not a sentinel", () => {
  // audit_events_target_pair is (target_kind IS NULL) = (target_id IS NULL), so a
  // uniform-looking target_kind = 'user' with a NULL id is a CHECK violation, and
  // inventing a sentinel id would make "everything done to this user" return rows
  // for an account that never existed. Spec 5.9 writes both of these as "—".
  assert.equal(AUDIT_ACTIONS["auth.login_failed"].targetKind, null);
  assert.equal(AUDIT_ACTIONS["scope.cleared"].targetKind, null);
});

test("auth.login_failed carries the probed address and nothing else", () => {
  // Spec 5.7: "every failed login writes an audit_events row ... and the probed
  // address in detail.email. That row is not only for forensics: it is the only
  // externally observable evidence of what the server derived as the client IP,
  // and the deploy gate in 9.5 asserts against it."
  assert.deepEqual([...AUDIT_ACTIONS["auth.login_failed"].detail], ["email"]);
  assert.deepEqual([...AUDIT_ACTIONS["auth.login_failed"].actorKinds], ["anonymous"]);
  assert.deepEqual([...AUDIT_ACTIONS["auth.login_failed"].outcomes], ["failure"]);
});
```

And add to `apps/core-api/test/router-registration.test.js`:

```js
const { AUDIT_ACTIONS } = require("../lib/audit-vocabulary");

test("validateRouteTable rejects an audit action outside the 5.9 vocabulary", () => {
  // The shape check has always been here: user.frobnicated is a legal noun.verb,
  // and audit_events' CHECK is ALSO only a shape regex, so the row would be
  // written. The closed vocabulary is what audit_events_detail_no_credentials is
  // protecting, and it is worthless if any handler can name an action nobody chose.
  assert.throws(
    () => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: "user.frobnicated" })]),
    /not in the .*vocabulary/
  );
});

test("validateRouteTable still rejects a malformed audit action before checking membership", () => {
  // Ordering matters for the message: "Frobnicated" fails the SHAPE, and reporting
  // it as "not in the vocabulary" would send the reader to the wrong file.
  assert.throws(
    () => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: "Frobnicated" })]),
    /must declare an audit action of the form/
  );
});

test("validateRouteTable accepts every action in the vocabulary", () => {
  for (const action of Object.keys(AUDIT_ACTIONS)) {
    assert.doesNotThrow(
      () => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: action })]),
      action
    );
  }
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/audit-vocabulary.test.js apps/core-api/test/router-registration.test.js
```

Expected: FAIL — the nine actions are undeclared, and the two membership cases
report `Missing expected exception`.

- [x] **Step 3: Implement**

**(a)** In `apps/core-api/lib/audit-vocabulary.js`, insert the nine entries into
`AUDIT_ACTIONS`. **The object must stay sorted** —
`audit-vocabulary.test.js`'s *"the vocabulary is sorted, so a diff adding one is
readable"* deep-equals `Object.keys(...)` against its own sort. The merged order is:

```js
  "auth.email_send_failed": …,          // existing
  "auth.email_verified": …,             // existing
  "auth.email_verify_requested": …,     // existing
  // --- new, Plan 2b ---
  "auth.login": entry(["user"], ["success"], "user", []),
  // No target and no detail beyond the probed address. actor_kind 'anonymous'
  // because nobody authenticated -- audit_events_actor_arc then requires BOTH
  // actor id columns NULL, which is exactly right for a failed sign-in.
  "auth.login_failed": entry(["anonymous"], ["failure"], null, ["email"]),
  "auth.logout": entry(["user"], ["success"], "user", []),
  "auth.logout_all": entry(["user"], ["success"], "user", ["revokedSessionCount"]),
  "auth.password_changed": entry(["user"], ["success"], "user", []),
  // --- end new ---
  "auth.password_reset_completed": …,   // existing
  "auth.password_reset_requested": …,   // existing
  // 'system' as well as 'user': scripts/create-platform-admin.js is the CLI that
  // writes the FIRST one, and there is no authenticated actor at that moment.
  // POST /api/platform/admins (Plan 2c) writes it as 'user'.
  "platform.admin_created": entry(["user", "system"], ["success"], "user", ["email"]),
  // Clearing a selection names no company, so both target columns are NULL --
  // the same conditional-target shape auth.password_reset_requested carries.
  "scope.cleared": entry(["user"], ["success"], null, []),
  // 'failure' is declared because 6.2 lists 404 not_found and 409 company_suspended
  // on this route, and a platform admin probing company ids is worth a row.
  "scope.selected": entry(["user"], ["success", "failure"], "company", []),
  "table_display.updated": …,           // existing
  "user.password_change_abuse": entry(["user"], ["failure"], "user", ["consecutiveFailures"])
```

Keep each existing entry and its comment byte-for-byte; only the ordering neighbours
change.

**(b)** In `apps/core-api/http/router.js`, add the require:

```js
const { AUDIT_ACTIONS } = require("../lib/audit-vocabulary");
```

and extend the existing non-GET branch inside `validateRouteTable` — find it with
`grep -n "must declare an audit action of the form" apps/core-api/http/router.js` —
adding this **immediately after** the shape check:

```js
      // Spec 8.5 rule 4's second half, and spec 11.6 explains why it waited: the
      // shape check alone lets a route declare user.frobnicated, which reaches
      // audit_events -- whose CHECK is ALSO only a shape regex -- and is written.
      // It could not land in Plan 2a because the vocabulary then held five actions
      // and roughly twenty-five routes were still unwritten. It lands here because
      // this is the plan whose routes complete the auth.* half of the table.
      if (!Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, options.audit)) {
        throw new Error(
          `route table: ${where} declares audit action ${JSON.stringify(
            options.audit
          )}, which is not in the spec 5.9 vocabulary (apps/core-api/lib/audit-vocabulary.js)`
        );
      }
```

**(c)** Retarget the three synthetic actions in
`apps/core-api/test/router-registration.test.js`. Every `shop.created`,
`shop.updated` and `terminal.paired` becomes `auth.logout` — a real §5.9 action
whose route lands in this plan. The change is semantics-free: not one of those
tests is about auditing, they needed *any* legal action string. Add a comment at
the scratch route so the next reader knows why it is not a shop action:

```js
// auth.logout, not shop.updated: validateRouteTable now asserts membership of the
// spec 5.9 vocabulary, and shop.* arrives with the shop routes in Plan 2c. This
// route registers into the LIVE table, so createApp() below validates it.
route("POST", "/__probe/ok", { auth: "public", body: null, audit: "auth.logout" }, (req, res) =>
  sendJson(res, 201, { probe: "post" })
);
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/audit-vocabulary.test.js \
            apps/core-api/test/router-registration.test.js \
            apps/core-api/test/route-auth.test.js \
            apps/core-api/test/audit-writer.test.js \
            apps/core-api/test/table-displays.test.js
```

Expected: all pass. `table-displays.test.js` matters here: its route declares
`table_display.updated`, which is already in the vocabulary, and this is the proof
the check does not break the one route in the service that emits an audit row.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/lib/audit-vocabulary.js apps/core-api/http/router.js \
        apps/core-api/test/audit-vocabulary.test.js apps/core-api/test/router-registration.test.js
git commit -m "feat(core-api): a route may no longer name an audit action nobody chose"
```

---

### Task 4: §11.5's `TRUSTED_PROXY_HOPS` cross-file assertion

§11.5 marks this **required for 2b**, and the reason is that it is the one thing in
`lib/` that fails **open** and silently: *"Set to 2 behind a single proxy, the pick
lands on the last client-controlled entry and an attacker owns their own rate-limit
bucket again."* No per-request test can catch it — a forged
`X-Forwarded-For: 1.2.3.4` under a one-proxy deployment produces a header
byte-identical to a legitimate two-proxy deployment whose real client is `1.2.3.4`.
There is nothing the module can assert about its own input.

The mitigation is the technique that caught the trailing-slash bypass: **a
build-time assertion between two locally-correct files.** `infra/nginx/` already
has strong assertions about its own directives, and `config.test.js` already pins
`docker-compose.yml` against `config.js` `DEFAULTS`. Nothing joins them.

**Files:**

- Modify: `apps/core-api/test/nginx-config.test.js`

`nginx-config.test.js` is chosen over `config.test.js` deliberately: the value that
has to be checked is a property of the **nginx topology**, and every fact this
assertion derives (`proxy_pass` appears only in the snippet, the snippet appends
exactly one entry, no `real_ip` directive rewrites `$remote_addr`) is already
asserted in that file. Putting it anywhere else means restating them.

- [x] **Step 1: Write the failing test**

Append to `apps/core-api/test/nginx-config.test.js`:

```js
const { composeEnvironment } = require("../testing/compose");

test("TRUSTED_PROXY_HOPS equals the proxy depth infra/nginx actually deploys", () => {
  // Spec 11.5, and it is REQUIRED rather than nice-to-have. lib/client-ip.js counts
  // entries from the RIGHT of X-Forwarded-For by this number. Set to 2 behind a
  // single proxy the pick lands on the last CLIENT-CONTROLLED entry, and an
  // attacker owns their own rate-limit bucket again -- the exact attack the module
  // exists to prevent, reachable from one wrong digit in a file that is not the
  // module's.
  //
  // No per-request test can see it. A forged "X-Forwarded-For: 1.2.3.4" under a
  // one-proxy deployment is BYTE-IDENTICAL to a legitimate two-proxy deployment
  // whose real client is 1.2.3.4, so the module has nothing to assert about its
  // own input. Two locally-correct files, one wrong pair -- which is the shape the
  // trailing-slash bypass had, and the technique that caught that one is this.
  //
  // proxySnippet(), not readText: the snippet's header comment NAMES
  // $proxy_add_x_forwarded_for to explain it, above the one directive that sets
  // it, so a raw read counts two appends and this assertion is red against a tree
  // that is correct. The comment stripper is load-bearing, not tidiness.
  const snippet = proxySnippet();

  // (1) Exactly one hop is APPENDED. $proxy_add_x_forwarded_for is the incoming
  //     header with $remote_addr appended on the right, so one occurrence of it
  //     in the one snippet every proxying location includes means the chain grows
  //     by exactly one entry between the client and core-api.
  const appends = (snippet.match(/\$proxy_add_x_forwarded_for/g) || []).length;
  assert.equal(appends, 1, "core-api-proxy.conf must append X-Forwarded-For exactly once");

  // (2) There is no SECOND proxy layer: the snippet's single proxy_pass names the
  //     upstream group rather than another nginx.
  assert.equal((snippet.match(/^[ \t]*proxy_pass\s/gm) || []).length, 1);
  assert.match(snippet, /^proxy_pass http:\/\/core_api;$/m);

  // The two remaining premises are asserted by their own tests in this file and
  // are deliberately NOT restated here -- restating them is how a copy drifts from
  // the original, and the copy is the one that gets weakened. "every location that
  // forwards to core-api does so through the proxy snippet" pins api.conf's zero
  // proxy_pass (a bare proxy_pass would set no X-Forwarded-For at all and pass the
  // client's own header straight through); "no real_ip directive can rewrite
  // $remote_addr before the XFF chain is built" pins the real_ip trio --
  // real_ip_recursive included, which a hand-copied pair drops -- and with
  // real_ip_header set a forged header gets appended to ITSELF, so the deployed
  // depth would no longer be derivable from the count above at all.

  // The deployed depth, DERIVED from those facts rather than restated.
  const deployedProxyDepth = appends;

  // ...and the value the container will actually run with. Read out of the real
  // docker-compose.yml, which is the file the deploy scp's to the box -- not out of
  // a copy, and not out of config.js's DEFAULTS, which deliberately excludes this
  // variable (a development default of 0 is fail-safe; production must state it).
  const configured = composeEnvironment("core-api").TRUSTED_PROXY_HOPS;
  assert.equal(
    Number(configured),
    deployedProxyDepth,
    `docker-compose.yml sets TRUSTED_PROXY_HOPS=${configured} but infra/nginx deploys ${deployedProxyDepth} proxy hop(s). ` +
      "Too high and lib/client-ip.js picks a client-controlled entry (forgeable buckets, forgeable source_ip); " +
      "too low and it picks nginx's own address (one shared bucket, every user locked out by one attacker). " +
      "Both fail silently at runtime -- this assertion is the only place the pair is checked."
  );
});

test("the hop-count assertion is not vacuous: it moves when either side moves", () => {
  // The mutation proof, in the file, because the assertion above is a cross-file
  // one and cross-file assertions are the ones that rot into tautologies. Both
  // directions are re-derived here from strings rather than from the real files,
  // so this cannot pass because the real files happen to agree.
  const twoHopSnippet = "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n".repeat(2);
  assert.notEqual((twoHopSnippet.match(/\$proxy_add_x_forwarded_for/g) || []).length, 1);

  const oneHopSnippet = "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n";
  assert.equal((oneHopSnippet.match(/\$proxy_add_x_forwarded_for/g) || []).length, 1);
  assert.notEqual(Number("2"), (oneHopSnippet.match(/\$proxy_add_x_forwarded_for/g) || []).length);
});
```

> `apiConf()` and `proxySnippet()` already exist at the top of
> `nginx-config.test.js`, and both run the file through `stripComments` before
> returning it. Confirm with
> `grep -n "function apiConf\|function proxySnippet\|function stripComments" apps/core-api/test/nginx-config.test.js`
> before pasting; if the helpers are named differently, use the file's own — but
> use the **stripping** ones, never `readText` directly. If a later edit needs
> api.conf here, do not name the local `apiConf`: `const apiConf = apiConf();` is a
> TDZ `ReferenceError` against the module-level `function apiConf()`, and the error
> it throws names the variable, not the shadowing, so it reads like a missing
> helper.

- [x] **Step 2: Run test to verify it fails**

Temporarily change `docker-compose.yml`'s `TRUSTED_PROXY_HOPS: 1` to `2`, then:

```bash
node --test apps/core-api/test/nginx-config.test.js
```

Expected: FAIL — `docker-compose.yml sets TRUSTED_PROXY_HOPS=2 but infra/nginx
deploys 1 proxy hop(s)`. **Revert the compose edit immediately** — it is a
production file and `config.test.js` reads it too.

If instead the run dies on `appends` with `2 !== 1`, the reads were pasted as
`readText` rather than the stripping accessors, and this step proves nothing:
`appends` would be 2 for the header comment, the run would never reach
`composeEnvironment`, and if it did, a mutated compose of `2` would compare 2 to 2
and **pass**. The proof that the assertion is not vacuous only exists once the
stripping is in place.

- [x] **Step 3: Implement**

Nothing to implement. The assertion passes against the tree as it stands **because
every read goes through the comment strippers**; Step 2 is the proof it is not
vacuous. This is the one task in this plan whose deliverable is the test.

The stripping is the whole reason this task can be a no-op. Both nginx files
document the very strings the assertions count:

```bash
grep -n 'proxy_add_x_forwarded_for' infra/nginx/core-api-proxy.conf
grep -n 'real_ip_header' infra/nginx/api.conf
```

The first prints **two** lines — a header comment explaining the variable, and the
one `proxy_set_header` that uses it — so a raw read makes `appends` 2 and the
assertion fails `2 !== 1` against a tree that is correct. The second prints a
comment reading `# NO real_ip_header AND NO set_real_ip_from ANYWHERE IN THIS
FILE.`, which is a raw match for both directives the sibling real_ip test forbids.

That leaves a repair that must not be taken. **Nothing in the suite pins the text of
those warning comments**, so an executor who sees the red and deletes them turns the
suite green and leaves no detector behind: the next person to add a second proxy
layer, or to reach for `real_ip_header` because a header arrives wrong, gets no
failure and no comment telling them why they must not. The comments are the
documentation the assertions exist to keep honest; the fix is always on the reading
side.

- [x] **Step 4: Run the tests to verify they pass**

```bash
git diff --stat docker-compose.yml
node --test apps/core-api/test/nginx-config.test.js apps/core-api/test/config.test.js
```

Expected: `git diff --stat` prints nothing (the Step 2 edit is reverted), and both
suites pass.

- [x] **Step 5: Commit**

Also record it in `infra/README.md`'s `### TRUSTED_PROXY_HOPS=1, and the four ways
it breaks silently` section — one line, because
`operations-docs.test.js` caps the neighbouring `## The client-IP chain` section at
40 lines and it is 39 today. Put it in the **detailed** section, not the summary:

```bash
grep -n "the four ways it breaks silently" infra/README.md
```

Add, inside that section:

> **Checked:** `apps/core-api/test/nginx-config.test.js` derives the deployed proxy
> depth from `core-api-proxy.conf` (one `$proxy_add_x_forwarded_for`, one
> `proxy_pass`, no `real_ip_*`) and asserts it equals `docker-compose.yml`'s
> `TRUSTED_PROXY_HOPS`. Adding a second proxy in front of nginx therefore fails CI
> until the variable moves with it.

```bash
git add apps/core-api/test/nginx-config.test.js infra/README.md
git commit -m "test(core-api): join TRUSTED_PROXY_HOPS to the proxy depth nginx deploys"
```

---

## Part 2 — The pure HTTP primitives

### Task 5: `http/cookies.js` — collect every value, build the `__Host-` cookie

**Files:**

- Create: `apps/core-api/http/cookies.js`
- Create: `apps/core-api/test/cookies.test.js`

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/cookies.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SESSION_COOKIE_NAME,
  readCookieValues,
  buildSessionCookie,
  buildClearingCookie
} = require("../http/cookies");

test("the cookie is __Host- prefixed, and that is the whole point", () => {
  // Spec 5.2. Host-only scoping controls only what THIS server sets. Any sibling
  // under yeyintlwin.com -- order., epaper-hub., the Phase-7 captive portal serving
  // untrusted guest devices, or a network attacker answering plain HTTP for a
  // non-existent *.yeyintlwin.com name -- can set core_session=<value>;
  // Domain=yeyintlwin.com. The __Host- prefix is what makes that impossible at the
  // browser, and the browser enforces it only if Secure is set, Path is exactly /,
  // and there is NO Domain attribute.
  assert.equal(SESSION_COOKIE_NAME, "__Host-core_session");
});

test("a built cookie carries every attribute the __Host- prefix requires, and no Domain", () => {
  const header = buildSessionCookie("AAAAAAAAAAAAAAAAAAAAAA", 28800);

  assert.match(header, /^__Host-core_session=AAAAAAAAAAAAAAAAAAAAAA;/);
  assert.match(header, /;\s*Path=\/(?:;|$)/);
  assert.match(header, /;\s*Secure(?:;|$)/);
  assert.match(header, /;\s*HttpOnly(?:;|$)/);
  assert.match(header, /;\s*SameSite=Lax(?:;|$)/);
  assert.match(header, /;\s*Max-Age=28800(?:;|$)/);
  // A Domain attribute makes the browser REJECT a __Host- cookie outright, so the
  // failure is "the user can never sign in" rather than a weakened cookie.
  assert.doesNotMatch(header, /Domain=/i);
});

test("SameSite is Lax, not None and not Strict", () => {
  // None would require Secure AND would let any site's fetch carry it, which is
  // the CSRF surface the Origin rule then has to close alone. Strict breaks the
  // ordinary case of following a link into /admin from an email or a bookmark and
  // arriving signed out.
  assert.match(buildSessionCookie("x".repeat(22), 1), /SameSite=Lax/);
});

test("the clearing cookie empties the value and expires immediately", () => {
  const header = buildClearingCookie();
  assert.match(header, /^__Host-core_session=;/);
  assert.match(header, /;\s*Max-Age=0(?:;|$)/);
  // Same attribute set, because a browser matches the cookie to delete on
  // name+path+domain: a clearing header with a different Path deletes nothing and
  // the stale cookie is presented on the next request.
  assert.match(header, /;\s*Path=\/(?:;|$)/);
  assert.match(header, /;\s*Secure(?:;|$)/);
  assert.match(header, /;\s*HttpOnly(?:;|$)/);
});

test("a token that could break out of the header is refused, not escaped", () => {
  // The value is minted by lib/tokens.js as 22 Base64URL characters, so anything
  // else is a programming error. Refusing beats encoding: an encoded value would
  // be stored by the browser and returned in a form the resolver never matches,
  // and the symptom would be "login succeeds and me returns 401".
  for (const bad of ["a;b", "a\nb", "", "not-22-chars", 5, null]) {
    assert.throws(() => buildSessionCookie(bad, 60), /22 Base64URL/, JSON.stringify(bad));
  }
  assert.throws(() => buildSessionCookie("A".repeat(22), 0), /positive integer/);
});

test("readCookieValues returns EVERY value for a name, not the first", () => {
  // Spec 6.3.4: "No session cookie, unresolvable, or MORE THAN ONE
  // __Host-core_session" is 401. A parser that returns one value cannot express
  // "more than one", and the classic bug is that it returns the FIRST -- so an
  // attacker who can set a cookie on a sibling host shadows the real session with
  // one the server then trusts.
  const header = "__Host-core_session=first; other=x; __Host-core_session=second";
  assert.deepEqual(readCookieValues(header, SESSION_COOKIE_NAME), ["first", "second"]);
});

test("readCookieValues tolerates the shapes a real Cookie header takes", () => {
  assert.deepEqual(readCookieValues("a=1;b=2", "b"), ["2"]);
  assert.deepEqual(readCookieValues("  a=1 ;  b = 2  ", "b"), ["2"]);
  assert.deepEqual(readCookieValues("a=1; b=", "b"), [""]);
  assert.deepEqual(readCookieValues("a=1; b", "b"), []);
  assert.deepEqual(readCookieValues("", "b"), []);
  assert.deepEqual(readCookieValues(undefined, "b"), []);
  // A repeated Cookie header arrives as an ARRAY. Stringifying it would join with
  // a comma and invent a boundary no browser wrote -- the same trap
  // lib/client-ip.js documents for X-Forwarded-For.
  assert.deepEqual(readCookieValues(["a=1", "b=2"], "b"), []);
});

test("readCookieValues does not match a name by prefix", () => {
  // "__Host-core_session_backup=evil" must not answer for "__Host-core_session".
  assert.deepEqual(readCookieValues("__Host-core_session_backup=evil", SESSION_COOKIE_NAME), []);
  assert.deepEqual(readCookieValues("x__Host-core_session=evil", SESSION_COOKIE_NAME), []);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/cookies.test.js
```

Expected: FAIL — `Cannot find module '../http/cookies'`.

- [x] **Step 3: Write the module**

Create `apps/core-api/http/cookies.js`:

```js
"use strict";

// PURE (spec 8.8, Tier 1): no database, no filesystem, no network, no clock, and
// no `req`/`res` -- it takes header STRINGS and returns header STRINGS, which is
// what lets every case below be a unit test.
//
// It lives in http/ rather than lib/ because it is HTTP vocabulary, not a
// credential primitive; nothing here mints or hashes anything.

const { TOKEN_LENGTH } = require("../lib/tokens");

// Spec 5.2, and the prefix is load-bearing rather than decorative. Host-only
// scoping controls only what THIS server sets; any sibling under yeyintlwin.com --
// order., epaper-hub., the Phase-7 captive portal serving untrusted guest devices,
// the Phase-4/5 terminal subdomains, or a network attacker answering plain HTTP for
// a non-existent *.yeyintlwin.com name -- can set
// core_session=<value>; Domain=yeyintlwin.com. __Host- is what makes that
// impossible at the browser.
const SESSION_COOKIE_NAME = "__Host-core_session";

// The browser enforces the prefix only when ALL THREE hold: Secure is present,
// Path is exactly "/", and there is NO Domain attribute. Getting any of them wrong
// does not weaken the cookie, it makes the browser refuse to store it -- so the
// symptom is "nobody can stay signed in", which is at least loud.
//
// SameSite=Lax is the second layer (5.3): None would let any site's fetch carry it
// and leave the Origin rule as the only CSRF control, while Strict signs the user
// out of any link followed in from outside.
const BASE_ATTRIBUTES = Object.freeze(["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]);

// http://localhost is a "potentially trustworthy origin" in every current browser,
// so Secure and __Host- both work against the development server that
// API_PUBLIC_ORIGIN allows there. No environment-dependent attribute set exists,
// deliberately: one that dropped Secure outside production would be a config value
// away from dropping it in production.

const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);

function assertToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new Error(
      `session cookie value must be ${TOKEN_LENGTH} Base64URL characters as minted by lib/tokens.js`
    );
  }
}

function buildSessionCookie(token, maxAgeSeconds) {
  assertToken(token);
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new Error(`session cookie Max-Age must be a positive integer, got ${JSON.stringify(maxAgeSeconds)}`);
  }
  return [`${SESSION_COOKIE_NAME}=${token}`, ...BASE_ATTRIBUTES, `Max-Age=${maxAgeSeconds}`].join("; ");
}

// The SAME attribute set, because a browser matches the cookie to delete on
// name + path + domain. A clearing header with a different Path deletes nothing,
// and the stale cookie is presented again on the next request -- which reads as
// "logout does not work" and is diagnosed as a server bug.
function buildClearingCookie() {
  return [`${SESSION_COOKIE_NAME}=`, ...BASE_ATTRIBUTES, "Max-Age=0"].join("; ");
}

// EVERY value for the name, in header order. Returning one value cannot express
// spec 6.3.4's "more than one __Host-core_session", and the natural
// implementation returns the FIRST -- so an attacker able to set a cookie on a
// sibling host shadows the real session with one the server then trusts.
function readCookieValues(header, name) {
  // A repeated Cookie header arrives as an array. Joining it would invent an entry
  // boundary no browser wrote; treat it as absent, which is fail-closed.
  if (typeof header !== "string" || header === "") return [];

  const values = [];
  for (const pair of header.split(";")) {
    const equals = pair.indexOf("=");
    // A bare token with no "=" is not a cookie. RFC 6265 has no such form.
    if (equals === -1) continue;
    // Exact name match, never a prefix: "__Host-core_session_backup=evil" must not
    // answer for "__Host-core_session".
    if (pair.slice(0, equals).trim() !== name) continue;
    values.push(pair.slice(equals + 1).trim());
  }
  return values;
}

module.exports = {
  SESSION_COOKIE_NAME,
  BASE_ATTRIBUTES,
  buildSessionCookie,
  buildClearingCookie,
  readCookieValues
};
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/cookies.test.js apps/core-api/test/source-structure.test.js
```

Expected: both pass.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/http/cookies.js apps/core-api/test/cookies.test.js
git commit -m "feat(core-api): the __Host- session cookie, and a parser that can see two of them"
```

---

### Task 6: `http/csrf.js` — the rule is gated on the channel, not the verb

§5.3 is explicit: *"CSRF is gated on the **authentication channel**, not the HTTP
verb."* The blanket rule — every state-changing request must carry an allowlisted
`Origin` — breaks the headline feature, because `POST /api/terminal/pair` is called
by kiosks, native shells and `curl`, none of which send `Origin`.

Identity §6.3 amends the rule to two clauses, because the three new public POSTs of
Plan 2d are unauthenticated, non-device and browser-facing and the original
sentence cannot express them:

1. every request authenticated by the `__Host-core_session` cookie, and
2. every **browser-facing public POST** — `login` now, plus `forgot-password`,
   `reset-password` and `verify-email` in 2d.

Device routes under `/api/terminal/*` stay exempt. **That exemption is what keeps
`POST /api/terminal/table-displays/:tableNumber` working**, and it is not a
special case for it — it is the rule §5.3 already had.

**One narrowing, stated because §5.3's prose and §6.3.4's table differ.** §5.3 says
*"every request authenticated by the cookie"*; §6.3.4's exhaustive condition table
and §6.3.3's baseline sets both say *"cookie-auth **non-GET**"*. This plan follows
the tables: `GET /api/admin/auth/me` is not origin-gated. A cross-site top-level
navigation is the only way `SameSite=Lax` lets a GET carry the cookie, it changes
no state, and the JSON it returns is unreadable to the initiating page without
CORS — which this service never emits for cookie routes. The residual is that such
a navigation slides the idle window (§5.2 step 14); it is recorded here rather than
fixed, because fixing it means origin-gating a safe method and 415ing a GET.

**Files:**

- Create: `apps/core-api/http/csrf.js`
- Create: `apps/core-api/test/csrf.test.js`

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/csrf.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ORIGIN_GATED_PUBLIC_KEYS, requiresOriginCheck, assertOriginAndContentType } = require("../http/csrf");
const { ApiError } = require("../db/errors");

const ORIGIN = "https://api.yeyintlwin.com";

function entry(method, path, options) {
  return { key: `${method} ${path}`, method, path, options };
}

test("cookie-authenticated non-GET routes are gated", () => {
  assert.equal(requiresOriginCheck(entry("POST", "/api/admin/auth/logout", { auth: "user" })), true);
  assert.equal(requiresOriginCheck(entry("PATCH", "/api/admin/users/:userId", { auth: "user" })), true);
  assert.equal(requiresOriginCheck(entry("PUT", "/api/admin/users/:userId/shops", { auth: "user" })), true);
  assert.equal(requiresOriginCheck(entry("DELETE", "/api/admin/x", { auth: "user" })), true);
});

test("cookie-authenticated GETs are not, and spec 6.3.4 is why", () => {
  // 5.3's prose says "every request authenticated by the cookie"; 6.3.4's
  // exhaustive table and 6.3.3's baseline sets both say "cookie-auth NON-GET".
  // The tables win: SameSite=Lax lets a GET carry the cookie only on a top-level
  // navigation, that changes no state, and the JSON is unreadable to the
  // initiating page because this service emits no CORS for cookie routes.
  assert.equal(requiresOriginCheck(entry("GET", "/api/admin/auth/me", { auth: "user" })), false);
});

test("login is gated even though it is public", () => {
  assert.equal(requiresOriginCheck(entry("POST", "/api/admin/auth/login", { auth: "public" })), true);
  assert.deepEqual(ORIGIN_GATED_PUBLIC_KEYS, ["POST /api/admin/auth/login"]);
});

test("device routes under /api/terminal/ are exempt, which is the rule and not an exception", () => {
  // 5.3: kiosks, native shells and curl send no Origin, and pairing failures are
  // deliberately opaque -- so a 403 there is read as a bad code and the operator
  // burns through reissues. This clause is also what keeps the ONE working
  // authenticated route in the service reachable.
  assert.equal(
    requiresOriginCheck(entry("POST", "/api/terminal/table-displays/:tableNumber", { auth: "terminal" })),
    false
  );
  assert.equal(requiresOriginCheck(entry("POST", "/api/terminal/pair", { auth: "public" })), false);
  assert.equal(requiresOriginCheck(entry("GET", "/health", { auth: "public" })), false);
});

test("a missing or mismatched Origin is 403 origin_not_allowed", () => {
  for (const origin of [undefined, "", "https://evil.test", "https://api.yeyintlwin.com.evil.test", ORIGIN.toUpperCase()]) {
    assert.throws(
      () => assertOriginAndContentType({ origin, contentType: "application/json", apiPublicOrigin: ORIGIN }),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 403);
        assert.equal(error.code, "origin_not_allowed");
        return true;
      },
      JSON.stringify(origin)
    );
  }
});

test("a wrong Content-Type is 415, and the two accepted spellings both pass", () => {
  for (const contentType of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON"]) {
    assert.doesNotThrow(() =>
      assertOriginAndContentType({ origin: ORIGIN, contentType, apiPublicOrigin: ORIGIN })
    );
  }
  for (const contentType of [undefined, "", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    assert.throws(
      () => assertOriginAndContentType({ origin: ORIGIN, contentType, apiPublicOrigin: ORIGIN }),
      (error) => {
        assert.equal(error.status, 415);
        assert.equal(error.code, "unsupported_media_type");
        return true;
      },
      JSON.stringify(contentType)
    );
  }
});

test("Origin is checked BEFORE Content-Type", () => {
  // 6.3.5's ordering is the security property. A request from evil.test with a
  // text/plain body must be told 403, not 415: answering 415 confirms the origin
  // was acceptable, which is a one-bit oracle for whichever origin the attacker is
  // guessing.
  assert.throws(
    () => assertOriginAndContentType({ origin: "https://evil.test", contentType: "text/plain", apiPublicOrigin: ORIGIN }),
    (error) => {
      assert.equal(error.code, "origin_not_allowed");
      return true;
    }
  );
});

test("the header list is exactly the one http/body.js already enforces", () => {
  // Two places must agree about what "JSON" means, and the second is
  // http/body.js's JSON_CONTENT_TYPE. Read it rather than restate it: a route with
  // no body still has to pass the gate, and a gate that accepted a spelling the
  // body reader then rejected would answer 415 AFTER the Origin check, from a
  // different file, for a request that carried nothing.
  const { JSON_CONTENT_TYPE } = require("../http/body");
  assert.match("application/json; charset=utf-8", JSON_CONTENT_TYPE);
  assert.doesNotMatch("application/json; charset=utf-16", JSON_CONTENT_TYPE);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/csrf.test.js
```

Expected: FAIL — `Cannot find module '../http/csrf'`.

- [x] **Step 3: Write the module**

Create `apps/core-api/http/csrf.js`:

```js
"use strict";

// PURE: it takes header strings and a route entry and either returns or throws an
// ApiError. It never touches `res`, which is what identity spec 6.3 requires --
// "source-structure.test.js forbids app.use( outside router.js, so a pure
// http/csrf.js called from the [dispatch] wrapper is the only compliant shape."
//
// PLACEMENT MATTERS AND IS NOT A STYLE CHOICE. This runs INSIDE the dispatch
// wrapper, after route lookup. As an app.use() ahead of the routes it would run
// BEFORE matching, so an unknown path with no Origin would answer
// 403 origin_not_allowed instead of 404 not_found -- destroying the
// [credential-independent] property spec 6.3.5 marks on step 2, and handing an
// attacker a route-existence oracle that needs no credential at all.

const { ApiError } = require("../db/errors");
const { JSON_CONTENT_TYPE } = require("./body");

// Clause 2 of identity spec 6.3: browser-facing PUBLIC posts. Plan 2d adds
// forgot-password, reset-password and verify-email here, in the same commit as the
// routes. It is a list of route KEYS rather than paths so a GET on the same path
// could never inherit the gate by accident.
//
// MIRROR: route-auth.test.js carries a census that deep-equals the derived
// origin-gated set. Find both with:
//   grep -rn "origin-gated\|ORIGIN_GATED_PUBLIC_KEYS" apps/core-api
const ORIGIN_GATED_PUBLIC_KEYS = Object.freeze(["POST /api/admin/auth/login"]);

// Spec 5.3, amended by identity spec 6.3. Gated on the AUTHENTICATION CHANNEL,
// never on the verb: the blanket "every state-changing request needs an Origin"
// rule would 403 every kiosk, native shell and curl on /api/terminal/*, and
// because pairing failures are deliberately opaque the operator would read it as a
// bad code and burn through reissues.
function requiresOriginCheck(entry) {
  // Device routes, exempt. What makes the exemption safe is strict channel binding
  // in http/authenticate.js, not an Origin header nobody sends.
  if (entry.path.startsWith("/api/terminal/")) return false;
  if (entry.options.auth === "user") return entry.method !== "GET";
  if (entry.options.auth === "public") return ORIGIN_GATED_PUBLIC_KEYS.includes(entry.key);
  return false;
}

// ORIGIN FIRST. A request from evil.test carrying text/plain must be told 403 and
// not 415: answering 415 would confirm the origin was acceptable, which is a
// one-bit oracle for whichever origin the attacker is guessing.
//
// Exact string equality against API_PUBLIC_ORIGIN, never a suffix or hostname
// test: "https://api.yeyintlwin.com.evil.test" ends with nothing useful, and
// endsWith(".yeyintlwin.com") would admit every sibling this cookie's __Host-
// prefix exists to exclude. Origin is case-sensitive per the URL standard, and
// config.js already normalises API_PUBLIC_ORIGIN through new URL().origin.
function assertOriginAndContentType({ origin, contentType, apiPublicOrigin }) {
  if (typeof apiPublicOrigin !== "string" || apiPublicOrigin === "") {
    throw new Error("csrf: apiPublicOrigin is required (config.js makes it a required variable)");
  }
  if (typeof origin !== "string" || origin !== apiPublicOrigin) {
    throw new ApiError(403, "origin_not_allowed");
  }
  if (!JSON_CONTENT_TYPE.test(String(contentType || ""))) {
    throw new ApiError(415, "unsupported_media_type");
  }
}

module.exports = { ORIGIN_GATED_PUBLIC_KEYS, requiresOriginCheck, assertOriginAndContentType };
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/csrf.test.js apps/core-api/test/body.test.js apps/core-api/test/source-structure.test.js
```

Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/http/csrf.js apps/core-api/test/csrf.test.js
git commit -m "feat(core-api): the CSRF rule, gated on the channel and callable from the wrapper"
```

---

## Part 3 — The three pre-tenant repositories

All three are **already named** in `source-structure.test.js`'s
`UNSCOPED_ALLOWLIST`, so no rule widens for them. Verify before you start:

```bash
grep -n -A 12 "const UNSCOPED_ALLOWLIST" apps/core-api/test/source-structure.test.js
```

**Every `withUnscopedConnection` callback in this Part is named `connection`.**
C2's first needle is `/\b(?:pool|client)\.query\s*\(/` **outside `db/` and
including the allowlist**; naming it `client` turns C2 red while the module's own
tests stay green. Plan 2a shipped that bug once. This is where it bites three
times.

### Task 7: `repositories/auth/users.js`

**Files:**

- Create: `apps/core-api/repositories/auth/users.js`
- Create: `apps/core-api/test/auth-users.test.js`

**Needs a database.** Export `CORE_API_TEST_DATABASE_URL` first.

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/auth-users.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const { seedTwoTenant, IDS, FIXTURE_PASSWORD } = require("../testing/fixtures/two-tenant");
const { openRuntimePool, closeAllPools } = require("../db");
const { verifyPassword, hashPassword } = require("../lib/password");
const users = require("../repositories/auth/users");

const skip = skipDatabaseTests();
let db;

test("setup", { skip }, async () => {
  db = await cloneTemplate(__filename);
  await db.resetFixtures();
  await seedTwoTenant(db);
  // The repository reaches the database through db/index.js's runtime pool, which
  // is process-wide state. The harness DSN connects as the OWNER; that is fine
  // here because these statements are DML and the two-role split is enforced by
  // the grants, not by this test.
  await openRuntimePool({ connectionString: db.connectionString, max: 4 });
});

test("the login lookup returns the hash and the two suspension facts in one read", { skip }, async () => {
  const row = await users.findByEmailForLogin("a-admin@example.test");

  assert.equal(row.id, IDS.userAAdmin);
  assert.equal(row.role, "company_admin");
  assert.equal(row.companyId, IDS.companyA);
  assert.equal(row.status, "active");
  assert.equal(row.companyStatus, "active");
  assert.equal(row.mustChangePassword, false);
  assert.equal(await verifyPassword(FIXTURE_PASSWORD, row.passwordHash), true);
});

test("a platform admin has no company, and companyStatus is null rather than missing", { skip }, async () => {
  // users_platform_admin_has_no_company makes (role = 'platform_admin') =
  // (company_id IS NULL) an invariant, so the LEFT JOIN produces NULL here on
  // every correct row. A caller writing `row.companyStatus !== 'active'` must not
  // lock the platform admin out of the platform.
  const row = await users.findByEmailForLogin("padmin@example.test");
  assert.equal(row.companyId, null);
  assert.equal(row.companyStatus, null);
});

test("the email lookup is exact and case-folded the way the column is", { skip }, async () => {
  // users.email carries CHECK (email = lower(btrim(email))), so every stored
  // address is already folded. The LOOKUP has to fold too, or a user who types
  // "A-Admin@Example.test" gets 401 invalid_credentials forever and reads it as a
  // forgotten password.
  assert.ok(await users.findByEmailForLogin("  A-Admin@Example.TEST  "));
  assert.equal(await users.findByEmailForLogin("nobody@example.test"), null);
  assert.equal(await users.findByEmailForLogin(""), null);
  assert.equal(await users.findByEmailForLogin(null), null);
});

test("failures 1 and 2 carry no lockout; the third starts the backoff", { skip }, async () => {
  // Spec 5.7: "Failures 1-2 carry no delay; from the third,
  // locked_until = now() + min(2^(n-3) minutes, 15 minutes)". A cashier who
  // mistypes twice must not be locked out mid-service.
  const first = await users.recordFailedLogin(IDS.userAStaff);
  assert.equal(first.failedLoginCount, 1);
  assert.equal(first.lockedUntil, null);

  const second = await users.recordFailedLogin(IDS.userAStaff);
  assert.equal(second.failedLoginCount, 2);
  assert.equal(second.lockedUntil, null);

  const third = await users.recordFailedLogin(IDS.userAStaff);
  assert.equal(third.failedLoginCount, 3);
  assert.ok(third.lockedUntil instanceof Date, "the third failure must set locked_until");
  const minutes = (third.lockedUntil.getTime() - Date.now()) / 60000;
  assert.ok(minutes > 0.5 && minutes < 1.5, `expected ~1 minute, got ${minutes}`);
});

test("the backoff caps at 15 minutes and never overflows the cast", { skip }, async () => {
  // power(2, n)::int overflows for n around 31 and raises 22003 INSIDE the login
  // path -- a 500 where a 401 belongs, and reachable by anyone willing to spend
  // thirty-one wrong passwords. The exponent is clamped BEFORE the cast, not after.
  await db.unscoped("UPDATE users SET failed_login_count = 200 WHERE id = $1", [IDS.userAUnassigned]);
  const row = await users.recordFailedLogin(IDS.userAUnassigned);
  assert.equal(row.failedLoginCount, 201);
  const minutes = (row.lockedUntil.getTime() - Date.now()) / 60000;
  assert.ok(minutes > 14 && minutes < 15.5, `expected the 15-minute cap, got ${minutes}`);
});

test("a successful login clears the counter and the lock, so a correct password always works", { skip }, async () => {
  await users.recordSuccessfulLogin(IDS.userAStaff);
  const { rows } = await db.unscoped(
    "SELECT failed_login_count, locked_until, last_login_at FROM users WHERE id = $1",
    [IDS.userAStaff]
  );
  assert.equal(rows[0].failed_login_count, 0);
  assert.equal(rows[0].locked_until, null);
  assert.ok(rows[0].last_login_at instanceof Date);
});

test("writing a password bumps sessions_valid_from, which is what kills every session", { skip }, async () => {
  // Spec 5.2: sessions_valid_from is the bulk-invalidation lever and the resolver
  // requires user_sessions.created_at >= it, so revocation is a fail-closed UPDATE
  // that cannot miss a row. A password change that did not bump it would leave a
  // stolen session alive after the remedy for a stolen session.
  const before = await db.unscoped("SELECT sessions_valid_from FROM users WHERE id = $1", [IDS.userAManager]);
  const hash = await hashPassword("a-brand-new-password");
  await users.writePasswordHash(IDS.userAManager, hash, { mustChangePassword: false });

  const after = await db.unscoped(
    "SELECT sessions_valid_from, password_hash, must_change_password FROM users WHERE id = $1",
    [IDS.userAManager]
  );
  assert.ok(after.rows[0].sessions_valid_from > before.rows[0].sessions_valid_from);
  assert.equal(after.rows[0].password_hash, hash);
  assert.equal(after.rows[0].must_change_password, false);
  assert.equal(await verifyPassword("a-brand-new-password", after.rows[0].password_hash), true);
});

test("the bootstrap is MONOTONIC: the guard is an audit row, not the current state", { skip }, async () => {
  // Spec 12's acceptance checkbox, verbatim: "a second run with a different address
  // exits NON-ZERO; DELETE the platform_admin row and re-run -- still non-zero (the
  // audit_events guard is monotonic, not current-state)".
  //
  // THIS IS NOT A TIDY-UP. design.md:714 and :855 make "create-platform-admin.js is
  // monotonic" the load-bearing justification for POST /api/platform/admins being the
  // ONE route in the system permitted to create a peer. A current-state guard --
  // "does a platform_admin row exist" -- would let anyone who can delete a row mint an
  // unlimited number of them, and Plan 2c would inherit an escalation exception whose
  // premise had quietly been removed.
  const hash = await hashPassword("bootstrap-password-1");

  // TRUNCATE FIRST, and it is not tidiness. seedTwoTenant makes IDS.userPlatformAdmin
  // the created_by_user_id of every company, user, shop, shop_table, user_shop,
  // terminal and pairing code it writes, and 0001_init.sql makes every attribution FK
  // ON DELETE RESTRICT -- two of them (terminals, terminal_pairing_codes) NOT NULL as
  // well, so the reference cannot even be nulled. The DELETE below therefore raises
  // 23503 users_created_by_user_id_fkey against the seeded fixture.
  //
  // Excluding the fixture admin instead -- `AND id <> IDS.userPlatformAdmin`, or
  // deleting only the three addresses this test creates -- would run green and WEAKEN
  // the test: with a platform_admin row still standing, a current-state guard ("does a
  // platform_admin exist") also answers already_bootstrapped for `third`, so the one
  // assertion this test exists to make would pass against the very implementation it
  // is meant to reject. Clearing the fixture is what leaves genuinely ZERO platform
  // admins at the DELETE below, which is the only state in which "still
  // already_bootstrapped" distinguishes the audit-row guard from a current-state one.
  await db.resetFixtures();

  await db.unscoped("DELETE FROM audit_events WHERE action = 'platform.admin_created'");
  await db.unscoped("DELETE FROM users WHERE role = 'platform_admin'");

  const first = await users.bootstrapPlatformAdmin({
    email: "boot@example.test",
    displayName: "Boot",
    passwordHash: hash
  });
  assert.equal(first.reason, null);
  assert.ok(first.created && first.created.id);

  // The audit row is written INSIDE the same transaction as the user row. If it were
  // written afterwards by appendAuditEvent -- which opens its own connection -- a
  // crash between the two would leave the guard disarmed forever.
  const audited = await db.unscoped(
    "SELECT actor_kind, target_id, detail FROM audit_events WHERE action = 'platform.admin_created'"
  );
  assert.equal(audited.rows.length, 1);
  assert.equal(audited.rows[0].actor_kind, "system");
  assert.equal(audited.rows[0].target_id, first.created.id);
  assert.deepEqual(audited.rows[0].detail, { email: "boot@example.test" });

  // A DIFFERENT address. A current-state guard would happily create a second admin.
  const second = await users.bootstrapPlatformAdmin({
    email: "second@example.test",
    displayName: "Second",
    passwordHash: hash
  });
  assert.equal(second.created, null);
  assert.equal(second.reason, "already_bootstrapped");

  // THE MONOTONIC HALF, and spec 12's checkbox names this exact sequence. It is safe
  // to delete here and it was not at the top of the test: the only platform admin
  // standing now is the one this test made, and the bootstrap inserts it with
  // created_by_user_id NULL, so nothing references it.
  await db.unscoped("DELETE FROM users WHERE role = 'platform_admin'");
  const third = await users.bootstrapPlatformAdmin({
    email: "third@example.test",
    displayName: "Third",
    passwordHash: hash
  });
  assert.equal(third.created, null);
  assert.equal(third.reason, "already_bootstrapped");

  // Restore the fixture for the tests below, which expect one active platform admin.
  await db.unscoped("DELETE FROM audit_events WHERE action = 'platform.admin_created'");
  await db.unscoped("DELETE FROM users WHERE role = 'platform_admin'");
  await users.bootstrapPlatformAdmin({ email: "boot@example.test", displayName: "Boot", passwordHash: hash });
});

test("a repeated address inside the same bootstrap is email_taken, not already_bootstrapped", { skip }, async () => {
  // Two distinguishable refusals, because the operator's next move differs: one says
  // "the platform is already bootstrapped, use set-password.js", the other says "that
  // address is taken". Collapsing them into one null was the earlier draft's mistake.
  //
  // It leans on the test above having restored boot@example.test, and clears ONLY the
  // guard -- so this attempt gets past the guard, reaches the INSERT, and is stopped
  // by users_email_key. That is the branch this test exists to tell apart from the
  // one above.
  //
  // ACCEPTED RESIDUAL: node --test runs tests within a file serially, so the
  // dependency holds today. It would break the day somebody inserts a third test
  // between these two, and the failure would read as a bug in bootstrapPlatformAdmin
  // rather than as a fixture problem. Left as it is because making it self-contained
  // means a second full bootstrap per run for a coupling this comment now names.
  const hash = await hashPassword("bootstrap-password-2");
  await db.unscoped("DELETE FROM audit_events WHERE action = 'platform.admin_created'");

  const again = await users.bootstrapPlatformAdmin({
    email: "boot@example.test",
    displayName: "Boot",
    passwordHash: hash
  });
  assert.equal(again.created, null);
  assert.equal(again.reason, "email_taken");
});

test("countActivePlatformAdmins sees only active ones", { skip }, async () => {
  const before = await users.countActivePlatformAdmins();
  assert.ok(before >= 1);
  await db.unscoped("UPDATE users SET status = 'suspended' WHERE role = 'platform_admin'");
  assert.equal(await users.countActivePlatformAdmins(), 0);
  await db.unscoped("UPDATE users SET status = 'active' WHERE role = 'platform_admin'");
});

test("teardown", { skip }, async () => {
  await closeAllPools();
  await db.drop();
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/auth-users.test.js
```

Expected: FAIL — `Cannot find module '../repositories/auth/users'`.

- [x] **Step 3: Write the module**

Create `apps/core-api/repositories/auth/users.js`:

```js
"use strict";

// PRE_TENANT_REASON: the login lookup runs before any company_id exists -- the
// tenant is DISCOVERED by it. One of the nine files source-structure.test.js rule
// C4 sanctions to call withUnscopedConnection, and the path is pinned by that
// allowlist.
const PRE_TENANT_REASON =
  "the login lookup and the bootstrap insert run before any tenant scope exists";

const { withUnscopedConnection } = require("../../db");
// The bootstrap writes its own audit row INSIDE its transaction (see
// bootstrapPlatformAdmin below), so it needs the vocabulary check without needing
// repositories/auth/audit.js's writer, which would open a second connection.
// lib/ is Tier 1 and this require is legal from anywhere.
const { assertAuditEvent } = require("../../lib/audit-vocabulary");

// One read, and it returns the two SUSPENSION facts alongside the hash. Splitting
// them into a second query would make "unknown email" and "suspended company"
// take measurably different times on the one path spec 5.1 requires to be
// indistinguishable.
//
// LEFT JOIN, not JOIN: users_platform_admin_has_no_company makes company_id NULL
// for every platform admin, and an inner join would return zero rows for exactly
// the account that can repair the platform.
const SELECT_FOR_LOGIN = `
  SELECT u.id,
         u.email,
         u.display_name          AS "displayName",
         u.role,
         u.company_id            AS "companyId",
         u.password_hash         AS "passwordHash",
         u.must_change_password  AS "mustChangePassword",
         u.status,
         u.locked_until          AS "lockedUntil",
         u.failed_login_count    AS "failedLoginCount",
         c.status                AS "companyStatus"
    FROM users u
    LEFT JOIN companies c ON c.id = u.company_id
   WHERE u.email = lower(btrim($1))
`;

// The folding is done in SQL rather than in JavaScript because the CHECK on
// users.email is written in SQL: `email = lower(btrim(email))`. Two different
// implementations of "fold an address" is how a user ends up unable to sign in
// with the address an administrator typed.
async function findByEmailForLogin(email) {
  if (typeof email !== "string" || email.trim() === "") return null;
  // The handle is named `connection`, NOT `client`, and that is load-bearing:
  // withUnscopedConnection yields a narrow { query } handle rather than a pg
  // Client, and rule C2 matches the literal text /\b(?:pool|client)\.query\s*\(/
  // across every scanned file outside db/. A rename turns C2 red while this
  // module's own tests stay green.
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(SELECT_FOR_LOGIN, [email]);
    return rows.length === 0 ? null : rows[0];
  });
}

const SELECT_BY_ID = `
  SELECT u.id,
         u.email,
         u.display_name          AS "displayName",
         u.role,
         u.company_id            AS "companyId",
         u.password_hash         AS "passwordHash",
         u.must_change_password  AS "mustChangePassword",
         u.status,
         c.status                AS "companyStatus"
    FROM users u
    LEFT JOIN companies c ON c.id = u.company_id
   WHERE u.id = $1
`;

async function findById(userId) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(SELECT_BY_ID, [userId]);
    return rows.length === 0 ? null : rows[0];
  });
}

// ONE STATEMENT, so the read-modify-write cannot interleave. Two concurrent wrong
// passwords must produce count 2, not count 1 twice -- and a SELECT-then-UPDATE
// pair on the unauthenticated path is exactly where that race is reachable on
// demand.
//
// THE EXPONENT IS CLAMPED BEFORE THE CAST. power(2, n) is a double, and
// power(2, 31)::int raises 22003 numeric_value_out_of_range -- INSIDE the login
// path, so a 500 where a 401 belongs, reachable by anyone willing to spend
// thirty-one wrong passwords. LEAST() after the cast is too late; the cast is what
// raises. Clamping the exponent at 10 is arbitrary only in the sense that any
// value >= 4 gives 2^n > 15 and the outer LEAST decides.
const BUMP_FAILED_LOGIN = `
  UPDATE users
     SET failed_login_count = failed_login_count + 1,
         locked_until = CASE
           WHEN failed_login_count + 1 < 3 THEN NULL
           ELSE now() + make_interval(
                  mins => LEAST(power(2, LEAST(failed_login_count + 1 - 3, 10))::int, 15))
         END,
         updated_at = now()
   WHERE id = $1
  RETURNING failed_login_count AS "failedLoginCount", locked_until AS "lockedUntil"
`;

async function recordFailedLogin(userId) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(BUMP_FAILED_LOGIN, [userId]);
    return rows.length === 0 ? null : rows[0];
  });
}

// Spec 5.7: "reset to zero on any successful login. A correct password therefore
// always eventually works." Without the clear, a user who is locked out and then
// signs in during a gap stays one failure away from a 15-minute lock forever.
const CLEAR_FAILED_LOGIN = `
  UPDATE users
     SET failed_login_count = 0,
         locked_until = NULL,
         last_login_at = now(),
         updated_at = now()
   WHERE id = $1
`;

async function recordSuccessfulLogin(userId) {
  await withUnscopedConnection(async (connection) => {
    await connection.query(CLEAR_FAILED_LOGIN, [userId]);
  });
}

// sessions_valid_from is bumped HERE and nowhere else on this path. Spec 5.2 makes
// it the bulk-invalidation lever and the resolver requires
// user_sessions.created_at >= it, so revocation is a fail-closed UPDATE that
// cannot miss a row -- which is the property a DELETE over user_sessions does not
// have, because a session created between the DELETE and the COMMIT survives it.
//
// failed_login_count and locked_until are DELIBERATELY NOT TOUCHED here. Spec
// 5.8(a)/6.3.7(a): those columns belong to the unauthenticated login credential,
// and writing them from the authenticated password route lets a stolen session
// drive the legitimate owner's login lockout.
const WRITE_PASSWORD = `
  UPDATE users
     SET password_hash = $2,
         must_change_password = $3,
         sessions_valid_from = now(),
         updated_at = now()
   WHERE id = $1
`;

async function writePasswordHash(userId, passwordHash, { mustChangePassword } = {}) {
  if (typeof passwordHash !== "string" || !passwordHash.startsWith("scrypt$")) {
    throw new Error("writePasswordHash requires a PHC string from lib/password.js");
  }
  if (typeof mustChangePassword !== "boolean") {
    throw new Error("writePasswordHash requires an explicit mustChangePassword");
  }
  await withUnscopedConnection(async (connection) => {
    await connection.query(WRITE_PASSWORD, [userId, passwordHash, mustChangePassword]);
  });
}

// ---------------------------------------------------------------------------
// THE BOOTSTRAP. One transaction, an advisory lock, and a MONOTONIC guard.
// ---------------------------------------------------------------------------
//
// Spec 5.6, 9.10 and -- most precisely -- 12's acceptance checkbox: "a second run
// with a different address exits NON-ZERO; DELETE the platform_admin row and re-run
// -- still non-zero (the audit_events guard is monotonic, not current-state)".
//
// WHY MONOTONIC RATHER THAN "does a platform_admin already exist". design.md:714 and
// :855 make this function's monotonicity the load-bearing justification for
// POST /api/platform/admins being the ONE route in the system permitted to create a
// peer. A current-state guard is defeated by a DELETE, so anyone who can remove a row
// could mint platform admins without limit -- and Plan 2c would inherit an escalation
// exception whose premise had quietly gone.
//
// WHY ONE TRANSACTION. pg_advisory_xact_lock is transaction-scoped, so the lock, the
// guard read, the INSERT and the audit write must share a transaction or the lock
// bounds nothing. It also means the guard cannot be left disarmed by a crash between
// the user row and its audit row -- which is exactly what calling appendAuditEvent()
// afterwards would risk, because that function opens its OWN connection.
//
// WHY THE AUDIT INSERT IS WRITTEN OUT HERE rather than delegated: same reason. The
// VOCABULARY check is not skipped -- assertAuditEvent() is called first, so an
// undeclared action still fails as a programming error rather than as a 23514.
//
// NAMED bootstrapPlatformAdmin, not createPlatformAdmin, and the difference is
// load-bearing: source-structure.test.js rule C6 budgets repositories/platform/ at
// exactly ten exported functions and `createPlatformAdmin` is one of them, arriving
// in Plan 2c with POST /api/platform/admins. Two functions with one name in two
// exempt zones is the kind of collision that gets "fixed" by widening C6.

// A fixed, arbitrary key. It only has to be distinct from db/migrate.js's
// 4264071001; nothing else in the service takes an advisory lock.
const BOOTSTRAP_LOCK_KEY = 4264071002;

const BOOTSTRAP_ALREADY_RUN = `
  SELECT 1 FROM audit_events WHERE action = 'platform.admin_created' LIMIT 1
`;

// ON CONFLICT DO NOTHING, so a repeated address is zero rows rather than a 23505 the
// CLI would have to translate. users_email_key is UNCONDITIONAL (email is identity,
// and freeing a suspended user's address would let a second row shadow the first in
// the login lookup), so it is the only conflict reachable.
const INSERT_PLATFORM_ADMIN = `
  INSERT INTO users (company_id, role, email, display_name, password_hash, must_change_password)
  VALUES (NULL, 'platform_admin', lower(btrim($1)), $2, $3, false)
  ON CONFLICT DO NOTHING
  RETURNING id, email, display_name AS "displayName"
`;

const INSERT_BOOTSTRAP_AUDIT = `
  INSERT INTO audit_events (actor_kind, actor_label, action, outcome, target_kind, target_id, detail)
  VALUES ('system', 'create-platform-admin', 'platform.admin_created', 'success', 'user', $1, $2::jsonb)
`;

// Returns { created, reason }. Two distinguishable refusals, because the operator's
// next move differs: "already_bootstrapped" means use scripts/set-password.js,
// "email_taken" means pick another address.
async function bootstrapPlatformAdmin({ email, displayName, passwordHash }) {
  if (typeof passwordHash !== "string" || !passwordHash.startsWith("scrypt$")) {
    throw new Error("bootstrapPlatformAdmin requires a PHC string from lib/password.js");
  }
  // The vocabulary check, run BEFORE the transaction opens so an undeclared action is
  // a programming error at the call site rather than a 23514 inside a rollback.
  assertAuditEvent({
    actorKind: "system",
    actorLabel: "create-platform-admin",
    action: "platform.admin_created",
    outcome: "success",
    targetKind: "user",
    // A stand-in: the real id is not known until the INSERT returns, and
    // assertAuditEvent only checks that the pair is set together.
    targetId: "pending",
    detail: { email }
  });

  // `connection`, never `client` -- see the note at the top of this file.
  return withUnscopedConnection(async (connection) => {
    await connection.query("BEGIN");
    try {
      // Transaction-scoped, so it is released by the COMMIT or the ROLLBACK below and
      // cannot be orphaned by a killed CLI the way a session lock can.
      await connection.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK_KEY]);

      const guard = await connection.query(BOOTSTRAP_ALREADY_RUN, []);
      if (guard.rows.length > 0) {
        await connection.query("ROLLBACK");
        return { created: null, reason: "already_bootstrapped" };
      }

      const inserted = await connection.query(INSERT_PLATFORM_ADMIN, [email, displayName, passwordHash]);
      if (inserted.rows.length === 0) {
        await connection.query("ROLLBACK");
        return { created: null, reason: "email_taken" };
      }

      const created = inserted.rows[0];
      await connection.query(INSERT_BOOTSTRAP_AUDIT, [created.id, JSON.stringify({ email: created.email })]);
      await connection.query("COMMIT");
      return { created, reason: null };
    } catch (error) {
      try {
        await connection.query("ROLLBACK");
      } catch {
        // The connection is already gone; releasing it is all that is left, and
        // withUnscopedConnection's own finally does that.
      }
      throw error;
    }
  });
}

// Read by server.js at boot to WARN, never to refuse. Spec 9.10: the bootstrap CLI
// runs through `docker compose exec`, so the container must already be up -- which
// makes "no platform admin exists" the one deliberate exception to this repo's
// refuse-to-start convention. Refusing here would make the platform unbootstrappable.
const COUNT_ACTIVE_PLATFORM_ADMINS = `
  SELECT count(*)::int AS count FROM users WHERE role = 'platform_admin' AND status = 'active'
`;

async function countActivePlatformAdmins() {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(COUNT_ACTIVE_PLATFORM_ADMINS, []);
    return rows[0].count;
  });
}

module.exports = {
  PRE_TENANT_REASON,
  findByEmailForLogin,
  findById,
  recordFailedLogin,
  recordSuccessfulLogin,
  writePasswordHash,
  bootstrapPlatformAdmin,
  countActivePlatformAdmins
};
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/auth-users.test.js apps/core-api/test/source-structure.test.js
```

Expected: both pass. **`source-structure.test.js` is not optional here** — it is
the only thing that catches a callback named `client`, and C4's allowlist already
names this file so nothing else would.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/repositories/auth/users.js apps/core-api/test/auth-users.test.js
git commit -m "feat(core-api): the login lookup, and a backoff whose cast cannot overflow"
```

---

### Task 8: `repositories/auth/sessions.js`

**Files:**

- Create: `apps/core-api/repositories/auth/sessions.js`
- Create: `apps/core-api/test/auth-sessions.test.js`

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/auth-sessions.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const { seedTwoTenant, IDS, SESSION_TOKENS } = require("../testing/fixtures/two-tenant");
const { openRuntimePool, closeAllPools } = require("../db");
const { mintToken, hashToken } = require("../lib/tokens");
const sessions = require("../repositories/auth/sessions");

const skip = skipDatabaseTests();
const IDLE = 28800;
const ABSOLUTE = 604800;
let db;

test("setup", { skip }, async () => {
  db = await cloneTemplate(__filename);
  await db.resetFixtures();
  await seedTwoTenant(db);
  await openRuntimePool({ connectionString: db.connectionString, max: 4 });
});

test("a created session stores only the hash, never the token", { skip }, async () => {
  const token = mintToken();
  const created = await sessions.createSession({
    userId: IDS.userAAdmin,
    tokenHash: hashToken(token),
    idleSeconds: IDLE,
    absoluteSeconds: ABSOLUTE
  });

  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.ok(created.expiresAt instanceof Date);
  assert.ok(created.absoluteExpiresAt > created.expiresAt);

  // Spec 5.2: "core-api retains no raw credential in memory at all", and the
  // column is bytea(32). A repository that stored the raw value would still pass
  // every behavioural test in this file.
  const { rows } = await db.unscoped("SELECT token_hash FROM user_sessions WHERE id = $1", [created.id]);
  assert.ok(Buffer.isBuffer(rows[0].token_hash));
  assert.equal(rows[0].token_hash.length, 32);
  assert.equal(rows[0].token_hash.includes(Buffer.from(token, "utf8")), false);
});

test("resolve returns the identity, the acting company and both suspension facts", { skip }, async () => {
  const row = await sessions.resolveSession(hashToken(SESSION_TOKENS.aAdmin));

  assert.equal(row.sessionId, IDS.sessionAAdmin);
  assert.equal(row.userId, IDS.userAAdmin);
  assert.equal(row.role, "company_admin");
  assert.equal(row.companyId, IDS.companyA);
  assert.equal(row.actingCompanyId, IDS.companyA);
  assert.equal(row.mustChangePassword, false);
  assert.equal(row.actingCompanyStatus, "active");
});

test("resolve refuses an unknown, expired or absolutely-expired session", { skip }, async () => {
  assert.equal(await sessions.resolveSession(hashToken(mintToken())), null);

  const token = mintToken();
  const created = await sessions.createSession({
    userId: IDS.userAStaff, tokenHash: hashToken(token), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });
  await db.unscoped("UPDATE user_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [created.id]);
  assert.equal(await sessions.resolveSession(hashToken(token)), null);
});

test("bumping sessions_valid_from kills every session, without touching a session row", { skip }, async () => {
  // Spec 5.2's fail-closed revocation. The resolver requires
  // created_at >= users.sessions_valid_from, so a DELETE is not needed and cannot
  // miss a row created between the DELETE and the COMMIT.
  assert.ok(await sessions.resolveSession(hashToken(SESSION_TOKENS.bAdmin)));
  await db.unscoped("UPDATE users SET sessions_valid_from = now() WHERE id = $1", [IDS.userBAdmin]);
  assert.equal(await sessions.resolveSession(hashToken(SESSION_TOKENS.bAdmin)), null);
});

test("resolve refuses a suspended user and a suspended OWN company", { skip }, async () => {
  // Company C is seeded suspended, and c-admin belongs to it.
  assert.equal(await sessions.resolveSession(hashToken(SESSION_TOKENS.cAdmin)), null);

  await db.unscoped("UPDATE users SET status = 'suspended' WHERE id = $1", [IDS.userAStaff]);
  const token = mintToken();
  await db.unscoped(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, now() + interval '1 hour', now() + interval '7 days')`,
    [IDS.userAStaff, hashToken(token)]
  );
  assert.equal(await sessions.resolveSession(hashToken(token)), null);
  await db.unscoped("UPDATE users SET status = 'active' WHERE id = $1", [IDS.userAStaff]);
});

test("a SUSPENDED ACTING company resolves, and is reported rather than refused", { skip }, async () => {
  // 6.3.2 is explicit that this is 409 acting_company_suspended, not 401: "the
  // remedy is a state change via POST /api/admin/scope, not a permission change".
  // Refusing it here would sign the platform admin out and leave them no way to
  // clear the selection.
  await db.unscoped("UPDATE user_sessions SET acting_company_id = $1 WHERE id = $2", [
    IDS.companyC, IDS.sessionPlatformInA
  ]);
  const row = await sessions.resolveSession(hashToken(SESSION_TOKENS.platformInA));
  assert.ok(row, "a suspended acting company must not be a 401");
  assert.equal(row.actingCompanyStatus, "suspended");
  await db.unscoped("UPDATE user_sessions SET acting_company_id = $1 WHERE id = $2", [
    IDS.companyA, IDS.sessionPlatformInA
  ]);
});

test("renewal clamps to absolute_expires_at and is throttled to once a minute", { skip }, async () => {
  const token = mintToken();
  const created = await sessions.createSession({
    userId: IDS.userAAdmin, tokenHash: hashToken(token), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });

  // Fresh: last_seen_at is now, so the throttle refuses.
  assert.equal(await sessions.renewSession({ sessionId: created.id, idleSeconds: IDLE, lastSeenIp: null }), null);

  await db.unscoped("UPDATE user_sessions SET last_seen_at = now() - interval '90 seconds' WHERE id = $1", [created.id]);
  const renewed = await sessions.renewSession({
    sessionId: created.id, idleSeconds: IDLE, lastSeenIp: "203.0.113.9"
  });
  assert.ok(renewed, "a session idle for 90 seconds must renew");
  assert.ok(renewed.expiresAt > created.expiresAt);

  // The clamp. user_sessions_idle_within_absolute is CHECK (expires_at <=
  // absolute_expires_at), so an UNCLAMPED bump raises 23514 for the whole final
  // idle window of every session -- the last eight hours of every seven-day
  // session, every time.
  await db.unscoped(
    `UPDATE user_sessions
        SET last_seen_at = now() - interval '90 seconds',
            absolute_expires_at = now() + interval '30 seconds'
      WHERE id = $1`,
    [created.id]
  );
  const clamped = await sessions.renewSession({ sessionId: created.id, idleSeconds: IDLE, lastSeenIp: null });
  assert.ok(clamped, "the clamped renewal must succeed, not raise");
  assert.ok(clamped.expiresAt <= clamped.absoluteExpiresAt);
});

test("an untrusted client address is written NULL, not as a raw header", { skip }, async () => {
  // Spec 5.7: last_seen_ip is inet. Writing the raw comma-separated header raises
  // "invalid input syntax for type inet" INSIDE the request, so the derivation
  // fails soft to NULL and lib/client-ip.js returns ip: null for exactly that.
  const token = mintToken();
  const created = await sessions.createSession({
    userId: IDS.userAAdmin, tokenHash: hashToken(token), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });
  await db.unscoped("UPDATE user_sessions SET last_seen_at = now() - interval '90 seconds' WHERE id = $1", [created.id]);
  await sessions.renewSession({ sessionId: created.id, idleSeconds: IDLE, lastSeenIp: null });
  const { rows } = await db.unscoped("SELECT last_seen_ip FROM user_sessions WHERE id = $1", [created.id]);
  assert.equal(rows[0].last_seen_ip, null);
});

test("deleteSession removes one row; deleteAllSessionsForUser reports how many it removed", { skip }, async () => {
  const a = await sessions.createSession({
    userId: IDS.userAManager, tokenHash: hashToken(mintToken()), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });
  assert.equal(await sessions.deleteSession(a.id), 1);
  assert.equal(await sessions.deleteSession(a.id), 0, "a second delete is idempotent, not an error");

  await sessions.createSession({
    userId: IDS.userAManager, tokenHash: hashToken(mintToken()), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });
  await sessions.createSession({
    userId: IDS.userAManager, tokenHash: hashToken(mintToken()), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });
  // The seeded session plus the two just created.
  assert.equal(await sessions.deleteAllSessionsForUser(IDS.userAManager), 3);
});

test("selecting an acting company reports unknown and suspended differently", { skip }, async () => {
  // 6.2: 404 not_found for an unknown company, 409 company_suspended for a
  // suspended one. One combined "no rows" answer cannot produce both.
  assert.equal(await sessions.findCompanyForScopeSelection("00000000-0000-4000-8000-000000000000"), null);
  assert.deepEqual(await sessions.findCompanyForScopeSelection(IDS.companyC), {
    id: IDS.companyC, status: "suspended"
  });

  assert.equal(await sessions.setActingCompany(IDS.sessionPlatformUnscoped, IDS.companyB), 1);
  const row = await sessions.resolveSession(hashToken(SESSION_TOKENS.platformUnscoped));
  assert.equal(row.actingCompanyId, IDS.companyB);

  assert.equal(await sessions.setActingCompany(IDS.sessionPlatformUnscoped, null), 1);
  const cleared = await sessions.resolveSession(hashToken(SESSION_TOKENS.platformUnscoped));
  assert.equal(cleared.actingCompanyId, null);
});

test("teardown", { skip }, async () => {
  await closeAllPools();
  await db.drop();
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/auth-sessions.test.js
```

Expected: FAIL — `Cannot find module '../repositories/auth/sessions'`.

- [x] **Step 3: Write the module**

Create `apps/core-api/repositories/auth/sessions.js`:

```js
"use strict";

// PRE_TENANT_REASON: a session is resolved in order to DISCOVER the tenant, so
// there is no company_id to bind when this runs. One of the nine files rule C4
// sanctions to call withUnscopedConnection.
const PRE_TENANT_REASON = "sessions are resolved before any tenant scope exists";

const { withUnscopedConnection } = require("../../db");

// make_interval(secs => $n) rather than string concatenation into an interval
// literal: the value comes from config and a concatenated interval is one typo
// away from being a SQL fragment.
const INSERT_SESSION = `
  INSERT INTO user_sessions (user_id, token_hash, expires_at, absolute_expires_at)
  VALUES ($1, $2, now() + make_interval(secs => $3), now() + make_interval(secs => $4))
  RETURNING id,
            expires_at          AS "expiresAt",
            absolute_expires_at AS "absoluteExpiresAt"
`;

async function createSession({ userId, tokenHash, idleSeconds, absoluteSeconds }) {
  if (!Buffer.isBuffer(tokenHash) || tokenHash.length !== 32) {
    // The column is bytea CHECK (octet_length = 32). Binding the RAW token by
    // mistake would raise "invalid input syntax for type bytea" -- loud -- but a
    // hex STRING would bind cleanly and match zero rows forever, so the shape is
    // asserted here where the failure names the caller.
    throw new Error("createSession requires a 32-byte Buffer from lib/tokens.js hashToken()");
  }
  if (!Number.isInteger(idleSeconds) || !Number.isInteger(absoluteSeconds) || absoluteSeconds <= idleSeconds) {
    throw new Error("createSession requires integer idleSeconds < absoluteSeconds");
  }
  // `connection`, never `client` -- see the note in repositories/auth/users.js.
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(INSERT_SESSION, [userId, tokenHash, idleSeconds, absoluteSeconds]);
    return rows[0];
  });
}

// READ-ONLY, and spec 6.3.5 step 5 says so: resolution happens before the
// must_change_password gate, before the Origin gate and before authorization, so a
// write here would mean a rejected request had already extended a session. Step 14
// owns the write.
//
// THE ACTING COMPANY IS RETURNED, NOT FILTERED. A suspended acting company is
// 409 acting_company_suspended (6.3.2), because the remedy is a state change via
// POST /api/admin/scope; refusing it here would sign the platform admin out and
// leave them no way to clear the selection they are stuck in.
//
// The OWN company is filtered, because a suspended company's users have no
// remedy available to themselves.
const RESOLVE_SESSION = `
  SELECT s.id                   AS "sessionId",
         s.user_id              AS "userId",
         s.acting_company_id    AS "actingCompanyId",
         s.expires_at           AS "expiresAt",
         s.absolute_expires_at  AS "absoluteExpiresAt",
         s.last_seen_at         AS "lastSeenAt",
         u.email,
         u.display_name         AS "displayName",
         u.role,
         u.company_id           AS "companyId",
         u.must_change_password AS "mustChangePassword",
         acting.status          AS "actingCompanyStatus"
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN companies own    ON own.id = u.company_id
    LEFT JOIN companies acting ON acting.id = s.acting_company_id
   WHERE s.token_hash = $1
     AND s.expires_at > now()
     AND s.absolute_expires_at > now()
     AND s.created_at >= u.sessions_valid_from
     AND u.status = 'active'
     AND (u.company_id IS NULL OR own.status = 'active')
`;

async function resolveSession(tokenHash) {
  if (!Buffer.isBuffer(tokenHash) || tokenHash.length !== 32) return null;
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(RESOLVE_SESSION, [tokenHash]);
    return rows.length === 0 ? null : rows[0];
  });
}

// THE CLAMP IS THE STATEMENT'S JOB, not the caller's.
// user_sessions_idle_within_absolute is CHECK (expires_at <= absolute_expires_at),
// and 0001_init.sql's own comment says the CHECK is the backstop rather than the
// clamp: an unclamped bump raises 23514 for the whole final idle window of every
// session -- the last eight hours of every seven-day session, every time.
//
// The 60-second throttle is in the WHERE clause rather than in JavaScript so that
// two concurrent requests cannot both decide they are the one allowed to renew.
// Zero rows is the ordinary case, not an error.
const RENEW_SESSION = `
  UPDATE user_sessions
     SET expires_at   = LEAST(now() + make_interval(secs => $2), absolute_expires_at),
         last_seen_at = now(),
         last_seen_ip = $3
   WHERE id = $1
     AND last_seen_at < now() - make_interval(secs => $4)
  RETURNING expires_at AS "expiresAt", absolute_expires_at AS "absoluteExpiresAt"
`;

async function renewSession({ sessionId, idleSeconds, lastSeenIp = null, throttleSeconds = 60 }) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(RENEW_SESSION, [sessionId, idleSeconds, lastSeenIp, throttleSeconds]);
    return rows.length === 0 ? null : rows[0];
  });
}

async function deleteSession(sessionId) {
  return withUnscopedConnection(async (connection) => {
    const { rowCount } = await connection.query("DELETE FROM user_sessions WHERE id = $1", [sessionId]);
    return rowCount;
  });
}

// The count is returned because auth.logout_all declares revokedSessionCount in
// its detail, and 6.2 puts it in the response body.
async function deleteAllSessionsForUser(userId) {
  return withUnscopedConnection(async (connection) => {
    const { rowCount } = await connection.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
    return rowCount;
  });
}

// Read BEFORE the write, and separately, because 6.2 distinguishes 404 not_found
// (unknown company) from 409 company_suspended, and one zero-row UPDATE cannot
// produce both. The race -- the company is suspended between this read and the
// write -- is one request wide and self-correcting: the resolver reports
// actingCompanyStatus on the very next request and every tenant route answers
// 409 acting_company_suspended.
//
// This is a cross-tenant READ by an unscoped platform admin, and it deliberately
// does NOT go through repositories/platform/. dangerouslyQueryAcrossTenants is
// C5-scoped to that directory and C6 budgets its exports at ten; selecting an
// acting company is scope MATERIALISATION, which is this file's job, and it reads
// one row by primary key rather than querying across tenants.
async function findCompanyForScopeSelection(companyId) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query("SELECT id, status FROM companies WHERE id = $1", [companyId]);
    return rows.length === 0 ? null : rows[0];
  });
}

async function setActingCompany(sessionId, companyId) {
  return withUnscopedConnection(async (connection) => {
    const { rowCount } = await connection.query(
      "UPDATE user_sessions SET acting_company_id = $2 WHERE id = $1",
      [sessionId, companyId]
    );
    return rowCount;
  });
}

module.exports = {
  PRE_TENANT_REASON,
  createSession,
  resolveSession,
  renewSession,
  deleteSession,
  deleteAllSessionsForUser,
  findCompanyForScopeSelection,
  setActingCompany
};
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/auth-sessions.test.js apps/core-api/test/source-structure.test.js
```

Expected: both pass.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/repositories/auth/sessions.js apps/core-api/test/auth-sessions.test.js
git commit -m "feat(core-api): sessions - read-only resolution, and a renewal SQL clamps itself"
```

---

### Task 9: `repositories/auth/scope-materialize.js`

**Files:**

- Create: `apps/core-api/repositories/auth/scope-materialize.js`
- Create: `apps/core-api/test/scope-materialize.test.js`

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/scope-materialize.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const { seedTwoTenant, IDS } = require("../testing/fixtures/two-tenant");
const { openRuntimePool, closeAllPools } = require("../db");
const { assertTenantScope } = require("../db/scope");
const { materialiseScope } = require("../repositories/auth/scope-materialize");

const skip = skipDatabaseTests();
let db;

const SESSION = IDS.sessionAAdmin;

test("setup", { skip }, async () => {
  db = await cloneTemplate(__filename);
  await db.resetFixtures();
  await seedTwoTenant(db);
  await openRuntimePool({ connectionString: db.connectionString, max: 4 });
});

test("an unscoped platform admin gets a platform scope and reaches no tenant query", { skip }, async () => {
  const scope = await materialiseScope({
    userId: IDS.userPlatformAdmin, sessionId: IDS.sessionPlatformUnscoped,
    role: "platform_admin", companyId: null, actingCompanyId: null
  });

  assert.equal(scope.kind, "platform");
  assert.equal(scope.userId, IDS.userPlatformAdmin);
  // 5.4: "there is no if (scope.kind === 'platform') skip the filter inside any
  // tenant repository". db/scope.js's assertTenantScope is the gate that makes it
  // structural rather than a promise.
  assert.throws(() => assertTenantScope(scope), /platform scope cannot drive a tenant query/);
});

test("a SCOPED platform admin materialises role platform_admin and auditCrossTenant", { skip }, async () => {
  // 5.4: "a scoped platform_admin materialises role: 'platform_admin' -- rank 3,
  // above company_admin -- so the rank lattice does the work and no alias needs a
  // special case." That is what makes the documented tenant bootstrap possible:
  // create the company's first company_admin through the ordinary users route.
  const scope = await materialiseScope({
    userId: IDS.userPlatformAdmin, sessionId: IDS.sessionPlatformInA,
    role: "platform_admin", companyId: null, actingCompanyId: IDS.companyA
  });

  assert.equal(scope.kind, "tenant");
  assert.equal(scope.role, "platform_admin");
  assert.equal(scope.companyId, IDS.companyA);
  assert.equal(scope.auditCrossTenant, true);
  assert.deepEqual([...scope.shopIds].sort(), [IDS.shopA1, IDS.shopA2].sort());
  assert.deepEqual([...scope.administeredShopIds].sort(), [IDS.shopA1, IDS.shopA2, IDS.shopA3].sort());
  assert.doesNotThrow(() => assertTenantScope(scope));
});

test("administeredShopIds is what makes suspension REVERSIBLE", { skip }, async () => {
  // Shop A3 is seeded suspended. 5.4: it "must disappear from its manager's world
  // while staying reachable by the company admin who has to un-suspend it."
  const admin = await materialiseScope({
    userId: IDS.userAAdmin, sessionId: SESSION,
    role: "company_admin", companyId: IDS.companyA, actingCompanyId: IDS.companyA
  });
  assert.equal(admin.shopIds.includes(IDS.shopA3), false);
  assert.equal(admin.administeredShopIds.includes(IDS.shopA3), true);
});

test("a shop_manager sees only ASSIGNED and ACTIVE shops, and carries no administered set", { skip }, async () => {
  // A-manager is assigned to A1 (active) and A3 (suspended).
  const scope = await materialiseScope({
    userId: IDS.userAManager, sessionId: IDS.sessionAManager,
    role: "shop_manager", companyId: IDS.companyA, actingCompanyId: null
  });

  assert.deepEqual(scope.shopIds, [IDS.shopA1]);
  assert.equal("administeredShopIds" in scope, false);
});

test("a staff user with zero assignments gets [], never null", { skip }, async () => {
  // The fixture's whole reason for A-unassigned: array_agg over zero rows returns
  // NULL, and without COALESCE(..., '{}') that scope is byte-identical to a
  // company admin's -- revocation ESCALATING privilege.
  const scope = await materialiseScope({
    userId: IDS.userAUnassigned, sessionId: IDS.sessionAUnassigned,
    role: "staff", companyId: IDS.companyA, actingCompanyId: null
  });
  assert.deepEqual(scope.shopIds, []);
  assert.equal(Object.isFrozen(scope.shopIds), true);
});

test("a tenant user's own company wins over any acting_company_id on their session", { skip }, async () => {
  // acting_company_id is a platform-admin lever. A row set on a tenant user's
  // session -- by a bug, or by a future route -- must not move them into another
  // company. This is the one place that could go wrong silently and cross a tenant
  // boundary, so it is asserted rather than assumed.
  await db.unscoped("UPDATE user_sessions SET acting_company_id = $1 WHERE id = $2", [
    IDS.companyA, IDS.sessionBAdmin
  ]);
  const scope = await materialiseScope({
    userId: IDS.userBAdmin, sessionId: IDS.sessionBAdmin,
    role: "company_admin", companyId: IDS.companyB, actingCompanyId: IDS.companyA
  });
  assert.equal(scope.companyId, IDS.companyB);
  assert.deepEqual(scope.shopIds, [IDS.shopB1]);
});

test("shop ids come back in a stable order", { skip }, async () => {
  // Not cosmetic: the me-document echoes shopIds, and an unordered array_agg makes
  // a response body that changes between identical requests -- which is a flaky
  // assertion in every suite downstream of this one.
  const a = await materialiseScope({
    userId: IDS.userAAdmin, sessionId: SESSION,
    role: "company_admin", companyId: IDS.companyA, actingCompanyId: IDS.companyA
  });
  const b = await materialiseScope({
    userId: IDS.userAAdmin, sessionId: SESSION,
    role: "company_admin", companyId: IDS.companyA, actingCompanyId: IDS.companyA
  });
  assert.deepEqual(a.shopIds, b.shopIds);
  assert.deepEqual([...a.shopIds], [...a.shopIds].sort());
});

test("teardown", { skip }, async () => {
  await closeAllPools();
  await db.drop();
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/scope-materialize.test.js
```

Expected: FAIL — `Cannot find module '../repositories/auth/scope-materialize'`.

- [x] **Step 3: Write the module**

Create `apps/core-api/repositories/auth/scope-materialize.js`:

```js
"use strict";

// PRE_TENANT_REASON: this is the code that PRODUCES the tenant scope, so by
// definition it runs before one exists. One of the nine files rule C4 sanctions to
// call withUnscopedConnection.
const PRE_TENANT_REASON = "this module materialises the scope every tenant query then binds";

const { withUnscopedConnection } = require("../../db");
const { createScope } = require("../../db/scope");

// COALESCE(..., '{}') is not defensive style, it is the fix for a privilege
// ESCALATION: array_agg over zero rows returns NULL, and a scope carrying
// shopIds: null is byte-identical to one that means "all shops" in every
// hand-written predicate. db/scope.js refuses null independently; both are needed,
// because this one keeps the value out of the object and that one keeps a wrong
// object out of the SQL.
//
// ORDER BY inside the aggregate: the me-document echoes shopIds, and an unordered
// array_agg makes a response body that differs between two identical requests.
const COMPANY_SHOPS = `
  SELECT COALESCE(array_agg(id ORDER BY id) FILTER (WHERE status = 'active'), '{}') AS "activeShopIds",
         COALESCE(array_agg(id ORDER BY id), '{}')                                  AS "administeredShopIds"
    FROM shops
   WHERE company_id = $1
`;

// An EXISTS-free straight join is correct here because user_shops is unique on
// (user_id, shop_id) -- 0001 makes it the primary key -- so no duplicate can be
// produced. The EXISTS semi-join spec 6.2 demands is for the USER LIST route,
// where the join is on the other side.
const ASSIGNED_SHOPS = `
  SELECT COALESCE(array_agg(sh.id ORDER BY sh.id), '{}') AS "activeShopIds"
    FROM user_shops us
    JOIN shops sh ON sh.id = us.shop_id
   WHERE us.user_id = $1
     AND us.company_id = $2
     AND sh.status = 'active'
`;

const ADMINISTERED_ROLES = ["platform_admin", "company_admin"];

// Spec 5.4's table, and every branch of it. The one thing that is easy to get
// wrong and impossible to see afterwards: acting_company_id is a PLATFORM-ADMIN
// lever. A tenant user whose session somehow carries one must stay in their own
// company, or a bug in a future route becomes a tenant crossing.
async function materialiseScope({ userId, sessionId, role, companyId, actingCompanyId }) {
  if (role === "platform_admin") {
    if (actingCompanyId === null || actingCompanyId === undefined) {
      // Reaches only platform routes. 6.3.2: a tenant route answers
      // 409 scope_required, never 403 -- the remedy is a state change.
      return createScope({ kind: "platform", userId, sessionId });
    }
    const { activeShopIds, administeredShopIds } = await readCompanyShops(actingCompanyId);
    return createScope({
      kind: "tenant",
      userId,
      sessionId,
      companyId: actingCompanyId,
      // Rank 3, above company_admin, so the rank lattice does the work and no
      // fifth role alias is needed. auditCrossTenant is set by db/scope.js itself
      // for this role.
      role: "platform_admin",
      shopIds: activeShopIds,
      administeredShopIds
    });
  }

  if (ADMINISTERED_ROLES.includes(role)) {
    const { activeShopIds, administeredShopIds } = await readCompanyShops(companyId);
    return createScope({ kind: "tenant", userId, sessionId, companyId, role, shopIds: activeShopIds, administeredShopIds });
  }

  // shop_manager and staff: driven by user_shops, active shops only, and NO
  // administeredShopIds at all -- db/scope.js throws if one is supplied, which is
  // what stops a suspended shop from staying visible to its manager.
  const activeShopIds = await readAssignedShops(userId, companyId);
  return createScope({ kind: "tenant", userId, sessionId, companyId, role, shopIds: activeShopIds });
}

// `connection`, never `client` -- see the note in repositories/auth/users.js.
async function readCompanyShops(companyId) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(COMPANY_SHOPS, [companyId]);
    return rows[0];
  });
}

async function readAssignedShops(userId, companyId) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(ASSIGNED_SHOPS, [userId, companyId]);
    return rows[0].activeShopIds;
  });
}

module.exports = { PRE_TENANT_REASON, materialiseScope };
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/scope-materialize.test.js apps/core-api/test/scope.test.js apps/core-api/test/source-structure.test.js
```

Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/repositories/auth/scope-materialize.js apps/core-api/test/scope-materialize.test.js
git commit -m "feat(core-api): materialise the scope, with [] and never null for zero shops"
```

---

## Part 4 — The pipeline

### Task 10: `http/authenticate.js` — resolution and strict channel binding

**Files:**

- Create: `apps/core-api/http/authenticate.js`
- Create: `apps/core-api/test/authenticate.test.js`

**This resolves `auth: 'user'` and nothing else.** `auth: 'terminal'` is left
untouched, and that is not a simplification — `POST /api/terminal/table-displays/:tableNumber`
authenticates a **configured shared service token inside its own handler**, and
there is no `terminal_tokens` row behind it until Phase 3 pairs `customer-order`
(§11.9). `repositories/auth/terminal-tokens.js` and `pairing.js` are already on
C4's allowlist and stay unwritten.

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/authenticate.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { sessionTokensPresented, clientAddressOf, authenticateUser } = require("../http/authenticate");
const { SESSION_COOKIE_NAME } = require("../http/cookies");
const { hashToken } = require("../lib/tokens");
const { ApiError } = require("../db/errors");

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBBBB";
const USER = "aaaaaaaa-0003-4000-8000-000000000001";
const SESSION = "aaaaaaaa-0008-4000-8000-000000000001";
const COMPANY = "aaaaaaaa-0001-4000-8000-000000000001";

function request(headers = {}) {
  return { headers, core: { deps: {} } };
}

// A stub pair standing in for the two repositories. No database: this file is
// about the CHANNEL, and both repositories have their own database suites.
function deps(overrides = {}) {
  return {
    sessions: {
      resolveSession: async (tokenHash) =>
        tokenHash.equals(hashToken(TOKEN))
          ? {
              sessionId: SESSION, userId: USER, actingCompanyId: null,
              expiresAt: new Date(), absoluteExpiresAt: new Date(), lastSeenAt: new Date(),
              email: "a-admin@example.test", displayName: "A Admin",
              role: "company_admin", companyId: COMPANY,
              mustChangePassword: false, actingCompanyStatus: null
            }
          : null
    },
    scopes: {
      materialiseScope: async (input) => ({ kind: "tenant", role: input.role, companyId: input.companyId, shopIds: [] })
    },
    ...overrides
  };
}

test("a session presented in the cookie resolves", async () => {
  const result = await authenticateUser(request({ cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` }), deps());
  assert.equal(result.session.userId, USER);
  assert.equal(result.scope.companyId, COMPANY);
});

test("no cookie is 401 unauthenticated", async () => {
  await assert.rejects(() => authenticateUser(request(), deps()), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "unauthenticated");
    return true;
  });
});

test("TWO session cookies is 401, and is not resolved by picking one", async () => {
  // Spec 6.3.4 names it explicitly. Picking the first is the natural
  // implementation and it is the vulnerability: an attacker who can set a cookie
  // on a sibling host shadows the real session with one the server then trusts.
  // Picking the LAST is no better -- it just moves which one wins.
  const req = request({ cookie: `${SESSION_COOKIE_NAME}=${TOKEN}; ${SESSION_COOKIE_NAME}=${OTHER}` });
  await assert.rejects(() => authenticateUser(req, deps()), /unauthenticated/);
  assert.equal(sessionTokensPresented(req).length, 2);
});

test("a session token in Authorization is NOT accepted -- strict channel binding", async () => {
  // Spec 5.3: "a session cookie is never accepted from an Authorization header, a
  // terminal token is never accepted from a cookie or a query string, and
  // presenting both credentials does not widen access." The last clause is the one
  // that gets lost: a resolver that tries the cookie and FALLS BACK to the header
  // satisfies the first two sentences and violates the third.
  await assert.rejects(
    () => authenticateUser(request({ authorization: `Bearer ${TOKEN}` }), deps()),
    /unauthenticated/
  );
});

test("presenting both a bad cookie and a good bearer does not widen access", async () => {
  await assert.rejects(
    () => authenticateUser(
      request({ cookie: `${SESSION_COOKIE_NAME}=${OTHER}`, authorization: `Bearer ${TOKEN}` }),
      deps()
    ),
    /unauthenticated/
  );
});

test("a malformed cookie value is refused before it reaches the database", async () => {
  // hashToken() would happily digest any string, so an unfiltered value turns
  // every junk cookie into an indexed lookup. The shape check is free and keeps
  // the unauthenticated path off the database.
  let calls = 0;
  const spy = deps({ sessions: { resolveSession: async () => { calls += 1; return null; } } });
  await assert.rejects(() => authenticateUser(request({ cookie: `${SESSION_COOKIE_NAME}=nope` }), spy), /unauthenticated/);
  assert.equal(calls, 0, "a malformed token must not reach resolveSession");
});

test("authenticateUser never writes: it returns the session and leaves renewal to step 14", async () => {
  // Spec 6.3.5: "Resolution at step 5 is read-only ... Invariant: a rejected
  // request never extends a session." Without it, a script on a same-site sibling
  // can fetch(..., {credentials:'include'}) every five minutes, collect
  // 403 origin_not_allowed each time, and hold an unattended till session alive to
  // the 7-day absolute cap instead of letting it die at the 8-hour idle horizon.
  const calls = [];
  const spy = deps({
    sessions: {
      resolveSession: async () => { calls.push("resolve"); return null; },
      renewSession: async () => { calls.push("renew"); return null; }
    }
  });
  await assert.rejects(() => authenticateUser(request({ cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` }), spy));
  assert.deepEqual(calls, ["resolve"]);
});

test("clientAddressOf counts from the right and fails closed", () => {
  assert.deepEqual(clientAddressOf({ headers: { "x-forwarded-for": "1.2.3.4, 9.9.9.9" } }, 1), {
    ip: "9.9.9.9", bucketKey: "9.9.9.9", trusted: true
  });
  // Hop count 0 (the development default) trusts nothing, so every request lands
  // in the one shared "unknown" bucket -- strictest, and the correct fail-closed
  // answer when no proxy is declared.
  assert.deepEqual(clientAddressOf({ headers: { "x-forwarded-for": "1.2.3.4" } }, 0), {
    ip: null, bucketKey: "unknown", trusted: false
  });
  assert.equal(clientAddressOf({ headers: {} }, 1).bucketKey, "unknown");
  // A repeated header arrives as an array; joining it would invent an entry
  // boundary no proxy wrote.
  assert.equal(clientAddressOf({ headers: { "x-forwarded-for": ["1.2.3.4", "5.6.7.8"] } }, 1).trusted, false);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/authenticate.test.js
```

Expected: FAIL — `Cannot find module '../http/authenticate'`.

- [x] **Step 3: Write the module**

Create `apps/core-api/http/authenticate.js`:

```js
"use strict";

// Pipeline step 5 (spec 6.3.5): credential resolution and strict channel binding,
// READ-ONLY. Every write that touches a session -- renewal, deletion -- belongs to
// step 14 or to a handler.
//
// THIS MODULE ISSUES NO SQL. It calls the two pre-tenant repositories, which are
// on rule C4's allowlist; this file is not, and rule C2's second needle bans a
// `.query(` here regardless of what the handle is called.
//
// IT RESOLVES auth:'user' AND NOTHING ELSE. auth:'terminal' passes through the
// pipeline untouched, because the only terminal route in the service authenticates
// a CONFIGURED SHARED SERVICE TOKEN inside its own handler and has no
// terminal_tokens row behind it until Phase 3 pairs apps/customer-order (spec
// 11.9). Resolving a bearer here would 401 the one working authenticated route in
// the service before its handler ever ran.

// lib/client-ip.js takes `isIP` as an ARGUMENT because rule C9 bans node:net under
// lib/, and its own header says http/ is what supplies it. This is that supply --
// the second one, alongside http/routes/table-displays.js, which was written
// before this module existed and is left alone deliberately: changing a shipped,
// tested route to reach a helper is a risk with no benefit.
const { isIP } = require("node:net");

const { ApiError } = require("../db/errors");
const { deriveClientIp } = require("../lib/client-ip");
const { hashToken, TOKEN_LENGTH } = require("../lib/tokens");
const { SESSION_COOKIE_NAME, readCookieValues } = require("./cookies");

const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);

function sessionTokensPresented(req) {
  return readCookieValues(req.headers.cookie, SESSION_COOKIE_NAME);
}

function clientAddressOf(req, trustedProxyHops) {
  return deriveClientIp({ header: req.headers["x-forwarded-for"], trustedProxyHops, isIP });
}

async function authenticateUser(req, deps) {
  const presented = sessionTokensPresented(req);

  // EXACTLY ONE. Spec 6.3.4: "No session cookie, unresolvable, or MORE THAN ONE
  // __Host-core_session" is 401. Picking the first is the natural implementation
  // and it is the vulnerability -- an attacker who can set a cookie on a sibling
  // host shadows the real session with one the server then trusts. Picking the
  // last only moves which one wins.
  if (presented.length !== 1) throw new ApiError(401, "unauthenticated");

  const token = presented[0];
  // Shape first, so a junk cookie never becomes an indexed lookup. hashToken()
  // would digest any string, so without this every 22-byte-or-not value on the
  // internet is a database round trip on the unauthenticated path.
  if (!TOKEN_PATTERN.test(token)) throw new ApiError(401, "unauthenticated");

  // The Authorization header is NEVER consulted for a session, and it is never
  // consulted as a FALLBACK either. Spec 5.3's third clause -- "presenting both
  // credentials does not widen access" -- is the one a try-cookie-then-header
  // resolver satisfies on paper and violates in fact.
  const session = await deps.sessions.resolveSession(hashToken(token));
  if (session === null) throw new ApiError(401, "unauthenticated");

  const scope = await deps.scopes.materialiseScope({
    userId: session.userId,
    sessionId: session.sessionId,
    role: session.role,
    companyId: session.companyId,
    actingCompanyId: session.actingCompanyId
  });

  return { session, scope };
}

module.exports = { sessionTokensPresented, clientAddressOf, authenticateUser, TOKEN_PATTERN };
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/authenticate.test.js apps/core-api/test/client-ip.test.js apps/core-api/test/source-structure.test.js
```

Expected: all pass. C7's `CREDENTIAL_QUERY` rule is the one to watch here — this
module must never read `req.query.<anything>`.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/http/authenticate.js apps/core-api/test/authenticate.test.js
git commit -m "feat(core-api): resolve a session from the cookie, and from nowhere else"
```

---

### Task 11: Wire the §6.3.5 pipeline into the dispatch wrapper

This is the task that can break the one working route in the service. Read
"Six things this plan will NOT let you do", item 5, before starting.

**Files:**

- Modify: `apps/core-api/http/router.js`
- Modify: `apps/core-api/server.js`
- Modify: `apps/core-api/test/server-bootstrap.test.js`
- Modify: `apps/core-api/test/health.test.js`
- Modify: `apps/core-api/test/router-registration.test.js`
- Create: `apps/core-api/test/pipeline.test.js`

**The mirrors.** Two of them, and the second is the one this task creates: every
shipped harness that builds a `deps` object by hand becomes a mirror of
`runPipeline`, because step 4a runs on **every** route before the auth branch.

**(1)** `server-bootstrap.test.js` asserts `start()`'s collaborator order with a
`deepEqual` on an array of strings:

```bash
grep -n "deepEqual(calls" apps/core-api/test/server-bootstrap.test.js
```

That array does **not** move under this task: the new collaborators go into the
`createApp` **argument**, not into `start()`'s ordered section. What does move is
the frozen `CONFIG` at the top of the same file — see Step 3(c). Its failure is a
thrown `Error` from `createSemaphore`, never a `deepEqual` mismatch, so a reader
who takes Step 4's troubleshooting note as the only symptom will look in the wrong
place.

**(2)** The `deps` literals in `health.test.js` and `router-registration.test.js`,
which predate `lib/client-ip.js` and carry no `trustedProxyHops`:

```bash
grep -n "log: captureLog()\|checkReadiness:" apps/core-api/test/health.test.js apps/core-api/test/router-registration.test.js
```

See Step 3(d). `apps/core-api/test/table-displays.test.js` is the precedent — it
already carries `trustedProxyHops: 0` in its harness, which is the only reason that
suite survives this task:

```bash
grep -rn "trustedProxyHops" apps/core-api/test/
```

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/pipeline.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { route, createApp } = require("../http/router");
const { sendJson } = require("../http/respond");
const { SESSION_COOKIE_NAME } = require("../http/cookies");
const { createRateLimiter } = require("../lib/rate-limit");
const { createSemaphore } = require("../lib/semaphore");

// Scratch routes for this file only, exercising each pipeline branch. route-auth
// deliberately registers nothing, so these cannot pollute its census.
const ORIGIN = "https://api.yeyintlwin.com";
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";

route("GET", "/__pipe/open", { auth: "public", sample: {} }, (req, res) => sendJson(res, 200, { ok: true }));
route("GET", "/__pipe/me", { auth: "user", roles: ["anyUser"], sample: {} }, (req, res) =>
  sendJson(res, 200, { userId: req.core.scope.userId, actorKind: req.core.actorKind })
);
route(
  "POST",
  "/__pipe/change",
  { auth: "user", roles: ["anyUser"], body: null, audit: "auth.logout", exemptFromPasswordChange: true, sample: {} },
  (req, res) => sendJson(res, 200, { ok: true })
);
route(
  "POST",
  "/__pipe/guarded",
  { auth: "user", roles: ["anyUser"], body: null, audit: "auth.logout", sample: {} },
  (req, res) => sendJson(res, 200, { ok: true })
);
route(
  "POST",
  "/__pipe/limited",
  { auth: "public", body: null, audit: "auth.login_failed", limit: { key: "ip", name: "login-global" }, sample: {} },
  (req, res) => sendJson(res, 200, { ok: true })
);

const USER = "aaaaaaaa-0003-4000-8000-000000000001";
const SESSION_ID = "aaaaaaaa-0008-4000-8000-000000000001";

function harness(overrides = {}) {
  const renewals = [];
  let at = 1_700_000_000_000;
  const deps = {
    log: () => {},
    apiPublicOrigin: ORIGIN,
    trustedProxyHops: 1,
    sessionIdleSeconds: 28800,
    sessionAbsoluteSeconds: 604800,
    loginRatePerMinute: 3,
    passwordAbuseThreshold: 5,
    adminMintRatePer10min: 20,
    pairingMintRatePer10min: 30,
    pairRatePerMinute: 20,
    rotateRatePerHour: 5,
    rateLimiter: createRateLimiter({ now: () => at }),
    scryptSemaphore: createSemaphore({ slots: 2 }),
    mustChangePassword: false,
    sessions: {
      resolveSession: async () => ({
        sessionId: SESSION_ID, userId: USER, actingCompanyId: null,
        expiresAt: new Date(at + 1000), absoluteExpiresAt: new Date(at + 100000),
        lastSeenAt: new Date(at), email: "a@example.test", displayName: "A",
        role: "company_admin", companyId: "aaaaaaaa-0001-4000-8000-000000000001",
        mustChangePassword: deps.mustChangePassword, actingCompanyStatus: null
      }),
      renewSession: async (input) => { renewals.push(input); return null; }
    },
    scopes: {
      materialiseScope: async (input) => ({ kind: "tenant", userId: input.userId, sessionId: input.sessionId, companyId: input.companyId, role: input.role, shopIds: [] })
    },
    appendAuditEvent: async () => "1",
    ...overrides
  };
  return { deps, renewals, advance: (ms) => { at += ms; } };
}

async function withServer(deps, run) {
  const app = createApp(deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const cookie = { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` };
const jsonPost = { Origin: ORIGIN, "Content-Type": "application/json", ...cookie };

test("a public route is unaffected by the pipeline", async () => {
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/open`);
    assert.equal(response.status, 200);
  });
});

test("an unknown path is 404 BEFORE any credential or Origin is considered", async () => {
  // Spec 6.3.5 marks step 2 [credential-independent]. Running the Origin gate as
  // an app.use() ahead of matching would answer 403 here, handing an attacker a
  // route-existence oracle that needs no credential at all.
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/nonexistent`, { method: "POST" });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "not_found");
  });
});

test("a cookie-authenticated GET resolves and sets the log actor", async () => {
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/me`, { headers: cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { userId: USER, actorKind: "user" });
  });
});

test("a 401 clears the cookie only when one was presented", async () => {
  // Spec 6.3.4: "+ clearing Set-Cookie only when one was presented". Sending one
  // unconditionally would let any unauthenticated request instruct a browser to
  // drop a cookie it never sent.
  const { deps } = harness({ sessions: { resolveSession: async () => null, renewSession: async () => null } });
  await withServer(deps, async (base) => {
    const without = await fetch(`${base}/__pipe/me`);
    assert.equal(without.status, 401);
    assert.deepEqual(without.headers.getSetCookie(), []);

    const with_ = await fetch(`${base}/__pipe/me`, { headers: cookie });
    assert.equal(with_.status, 401);
    assert.match(with_.headers.getSetCookie().join(), /__Host-core_session=;.*Max-Age=0/);
  });
});

test("must_change_password is 403 on a non-exempt route and passes on an exempt one", async () => {
  // Spec 5.4: "must_change_password is enforced IN THE RESOLVER, not the UI:
  // while true, every route except POST /api/admin/auth/password and
  // POST /api/admin/auth/logout returns 403."
  const { deps } = harness();
  deps.mustChangePassword = true;
  await withServer(deps, async (base) => {
    const blocked = await fetch(`${base}/__pipe/guarded`, { method: "POST", headers: jsonPost });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, "password_change_required");

    const allowed = await fetch(`${base}/__pipe/change`, { method: "POST", headers: jsonPost });
    assert.equal(allowed.status, 200);
  });
});

test("the gate order is 401, then 403 password_change_required, then 403 origin", async () => {
  // 6.3.5 puts step 6 before step 7. Reversed, an attacker with no session learns
  // whether their Origin is allowed before being asked for a credential.
  const { deps } = harness();
  deps.mustChangePassword = true;
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/guarded`, {
      method: "POST",
      headers: { ...cookie, Origin: "https://evil.test", "Content-Type": "text/plain" }
    });
    assert.equal((await response.json()).error.code, "password_change_required");
  });
});

test("a cookie-authenticated POST needs Origin and Content-Type; a GET does not", async () => {
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const noOrigin = await fetch(`${base}/__pipe/change`, {
      method: "POST", headers: { ...cookie, "Content-Type": "application/json" }
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((await noOrigin.json()).error.code, "origin_not_allowed");

    const badType = await fetch(`${base}/__pipe/change`, {
      method: "POST", headers: { ...cookie, Origin: ORIGIN, "Content-Type": "text/plain" }
    });
    assert.equal(badType.status, 415);

    const get = await fetch(`${base}/__pipe/me`, { headers: cookie });
    assert.equal(get.status, 200, "a cookie-auth GET is not origin-gated (6.3.3, 6.3.4)");
  });
});

test("a credential-independent bucket sheds with 429 and NO Retry-After", async () => {
  const { deps } = harness();
  await withServer(deps, async (base) => {
    for (let n = 1; n <= 3; n += 1) {
      const ok = await fetch(`${base}/__pipe/limited`, {
        method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.5" }
      });
      assert.equal(ok.status, 200, `call ${n}`);
    }
    const shed = await fetch(`${base}/__pipe/limited`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.5" }
    });
    assert.equal(shed.status, 429);
    assert.equal(shed.headers.get("retry-after"), null, "login-global must not confirm the bucket");
    assert.equal((await shed.json()).error.code, "rate_limited");
  });
});

test("the credential-independent bucket is consumed BEFORE any credential is read", async () => {
  // Spec 6.3.5 step 4a: "before any scrypt is queued". A limiter that ran after
  // resolution would let an attacker queue work by presenting junk.
  let resolved = 0;
  const { deps } = harness({
    sessions: { resolveSession: async () => { resolved += 1; return null; }, renewSession: async () => null }
  });
  await withServer(deps, async (base) => {
    for (let n = 0; n < 5; n += 1) {
      await fetch(`${base}/__pipe/limited`, {
        method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.6" }
      });
    }
  });
  assert.equal(resolved, 0, "a public route must not resolve a credential at all");
});

test("a rejected request never extends a session; a successful one does", async () => {
  // The invariant of 5.2 and 6.3.5 step 14, and the attack it closes: a script on
  // order.yeyintlwin.com can fetch(..., {credentials:'include'}) every five
  // minutes, collect 403 origin_not_allowed each time, and hold an unattended till
  // session alive to the 7-day absolute cap.
  const { deps, renewals } = harness();
  await withServer(deps, async (base) => {
    await fetch(`${base}/__pipe/change`, { method: "POST", headers: { ...cookie, "Content-Type": "application/json" } });
    assert.deepEqual(renewals, [], "a 403 renewed a session");

    await fetch(`${base}/__pipe/me`, { headers: { ...cookie, "X-Forwarded-For": "198.51.100.7" } });
    assert.equal(renewals.length, 1);
    assert.equal(renewals[0].sessionId, SESSION_ID);
    assert.equal(renewals[0].lastSeenIp, "198.51.100.7");
  });
});

test("a renewal failure is logged on its own line and never surfaces", async () => {
  // Step 14 runs after the response is written, so a throw there must not be
  // surfaced: the request succeeded, and the only casualty is an idle window that
  // slides a minute later. The log half is asserted because the obvious way to
  // write it -- req.core.logExtra.renewal = "failed" -- is a DEAD WRITE. A real
  // renewSession awaits a database round trip, so res.on("finish") has long since
  // fired and spread logExtra by the time the catch runs, and the write is
  // discarded unread. That mistake passes a status-only test, which is why this
  // one reads the lines.
  const lines = [];
  const { deps } = harness({
    log: (line) => lines.push(line),
    sessions: {
      resolveSession: async () => ({
        sessionId: SESSION_ID, userId: USER, actingCompanyId: null,
        expiresAt: new Date(), absoluteExpiresAt: new Date(), lastSeenAt: new Date(),
        email: "a@example.test", displayName: "A", role: "company_admin",
        companyId: "aaaaaaaa-0001-4000-8000-000000000001",
        mustChangePassword: false, actingCompanyStatus: null
      }),
      renewSession: async () => { throw new Error("connection terminated unexpectedly"); }
    }
  });
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/me`, { headers: cookie });
    assert.equal(response.status, 200);
  });

  // Two lines for one request: the access line from res.on("finish") and the
  // renewal failure. Selected by `level`, never by index -- whether "finish" beats
  // the catch depends on whether the socket write completes in a nextTick or in an
  // I/O callback, and a test that pins that ordering pins the wrong thing.
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed.length, 2, lines.join(" | "));
  const access = parsed.find((line) => line.level === undefined);
  const failure = parsed.find((line) => line.level === "error");
  assert.equal(access.status, 200);
  assert.equal(access.renewal, undefined, "the access log is one line per request and carries no renewal field");
  assert.equal(failure.route, "/__pipe/me");
  assert.equal(failure.status, 200);
  assert.equal(failure.requestId, access.requestId, "the two lines must be joinable on requestId");
  assert.match(failure.message, /^renewSession: connection terminated unexpectedly$/);
});

test("the existing terminal route still works: the pipeline resolves nothing for it", async () => {
  // THE REGRESSION THIS WHOLE TASK RISKS. POST /api/terminal/table-displays/:tableNumber
  // authenticates a configured service token in its own handler and has no
  // terminal_tokens row behind it. A pipeline that resolved a bearer would 401 it
  // before the handler ran, and a pipeline that origin-gated /api/terminal/* would
  // 403 it.
  require("../http/routes/table-displays");
  const { deps } = harness({
    tableDisplay: { configured: true, updateTableDisplay: async () => ({ ok: true }) },
    tableDisplayServiceToken: "0123456789abcdef0123456789abcdef"
  });
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/api/terminal/table-displays/7`, {
      method: "POST",
      headers: { Authorization: "Bearer 0123456789abcdef0123456789abcdef", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "Welcome", orderingUrl: "https://order.example.test/t/AAAAAAAAAAAAAAAAAAAAAA" })
    });
    assert.equal(response.status, 200, "no Origin header, no cookie, and it must still be 200");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/pipeline.test.js
```

Expected: FAIL — the cookie route answers 200 with `req.core.scope` undefined
(a `TypeError` → 500), no 401, no 429, no renewal.

- [x] **Step 3: Implement**

**(a)** In `apps/core-api/http/router.js` add the requires:

```js
const { LIMITERS } = require("../lib/rate-limit");
const { AUDIT_ACTIONS } = require("../lib/audit-vocabulary");
const { buildClearingCookie } = require("./cookies");
const { requiresOriginCheck, assertOriginAndContentType } = require("./csrf");
const { sessionTokensPresented, clientAddressOf, authenticateUser } = require("./authenticate");
```

(The first two are already there from Tasks 2 and 3.)

Then add the pipeline above `createApp`:

```js
// Spec 6.3.5, steps 3 through 7, in order, and THE ORDERING IS THE SECURITY
// PROPERTY. It runs INSIDE the dispatch wrapper -- after route lookup -- because
// as an app.use() ahead of the routes it would answer 403 origin_not_allowed for
// an unknown path instead of 404 not_found, destroying the
// [credential-independent] property step 2 is marked with. And a pure
// http/csrf.js called from here is the only compliant shape anyway:
// source-structure.test.js rule C3 forbids app.use( outside this file.
//
// Returns true when the handler should run. Every refusal RESPONDS HERE and
// returns false, rather than throwing: two of them (429, 401) have to set a
// header, ApiError cannot carry one, and one style for all five beats a mix a
// reader has to hold in their head.
async function runPipeline(entry, req, res, deps) {
  // Step 3 -- the declared auth mode. Nothing to do at runtime: route() and
  // validateRouteTable() have already refused a table with a missing or unknown
  // mode, which is why 6.3.5 marks this step "never a runtime 500".

  // Step 4a -- CREDENTIAL-INDEPENDENT buckets, before any scrypt is queued.
  const address = clientAddressOf(req, deps.trustedProxyHops);
  req.core.clientIp = address.ip;
  req.core.clientBucketKey = address.bucketKey;
  if (!consumeLimit(entry, req, res, deps, "ip", address.bucketKey)) return false;

  if (entry.options.auth === "user") {
    // Step 5 -- credential resolution and channel binding, READ-ONLY.
    const authenticate = deps.authenticate || authenticateUser;
    let resolved;
    try {
      resolved = await authenticate(req, deps);
    } catch (error) {
      if (!(error && error.status === 401)) throw error;
      // A clearing Set-Cookie ONLY when one was presented (6.3.4). Sending it
      // unconditionally would let any unauthenticated request instruct a browser
      // to drop a cookie it never sent.
      const headers = sessionTokensPresented(req).length > 0 ? { "Set-Cookie": buildClearingCookie() } : {};
      sendError(res, error, req.core.requestId, headers);
      return false;
    }

    req.core.session = resolved.session;
    req.core.scope = resolved.scope;
    req.core.actorKind = "user";
    req.core.actorId = resolved.session.userId;

    // Step 5b -- PRINCIPAL-KEYED buckets. They could not run at 4a: the principal
    // does not exist until now, and keying them on the presented credential string
    // would put every probe in a fresh empty bucket AND make the map an
    // unauthenticated memory-growth vector.
    if (!consumeLimit(entry, req, res, deps, "user", resolved.session.userId)) return false;

    // Step 6 -- the must_change_password gate, in the RESOLVER and not the UI.
    // Spec 8.5 rule 3 fixes the exempt set at exactly two routes, and
    // route-auth.test.js asserts it by set equality.
    if (resolved.session.mustChangePassword && entry.options.exemptFromPasswordChange !== true) {
      sendError(res, { status: 403, code: "password_change_required" }, req.core.requestId);
      return false;
    }
  }

  // Step 7 -- Origin and Content-Type, AFTER the password gate. Reversed, an
  // attacker with no session learns whether their Origin is allowed before being
  // asked for a credential.
  if (requiresOriginCheck(entry)) {
    try {
      assertOriginAndContentType({
        origin: req.headers.origin,
        contentType: req.headers["content-type"],
        apiPublicOrigin: deps.apiPublicOrigin
      });
    } catch (error) {
      sendError(res, error, req.core.requestId);
      return false;
    }
  }

  return true;
}

// One helper for both 4a and 5b: `stage` is the key kind this call is responsible
// for, so a principal-keyed limiter is invisible at 4a and an ip-keyed one is not
// consumed twice.
function consumeLimit(entry, req, res, deps, stage, bucketKey) {
  const declared = entry.options.limit ? LIMITERS[entry.options.limit.name] : null;
  if (declared === null || declared.key !== stage) return true;
  // "failure" limiters are the handler's to consume -- password-change-abuse
  // counts consecutive failures, and a per-request decrement would lock a user out
  // of their own password-change route for succeeding at it.
  if (declared.consume !== "request") return true;

  const ceiling = deps[declared.ceilingKey];
  const verdict = deps.rateLimiter.consume(entry.options.limit.name, bucketKey, ceiling);
  if (verdict.allowed) return true;

  const headers = verdict.retryAfterSeconds === null ? {} : { "Retry-After": String(verdict.retryAfterSeconds) };
  sendError(res, { status: 429, code: "rate_limited" }, req.core.requestId, headers);
  return false;
}

// Step 14 -- sliding renewal, at most once per 60 seconds, and ONLY on a request
// that reached the handler and succeeded. The throttle itself lives in the SQL so
// two concurrent requests cannot both decide they are the one allowed to renew.
//
// `log` is createApp's NORMALISED local, threaded in by the caller, not deps.log.
// server.js passes `log: options.log`, which is undefined on a normal boot, so
// deps.log(...) here is a TypeError in production on the one path that only fires
// when the database is already in trouble.
async function renewIfSucceeded(entry, req, res, deps, log) {
  if (entry.options.auth !== "user" || req.core.session === undefined) return;
  if (res.statusCode >= 400) return;
  try {
    await deps.sessions.renewSession({
      sessionId: req.core.session.sessionId,
      idleSeconds: deps.sessionIdleSeconds,
      lastSeenIp: req.core.clientIp
    });
  } catch (error) {
    // The response is already written. A failure here costs one minute of idle
    // window, and turning a successful request into a 500 because of it would be
    // strictly worse.
    //
    // NOT req.core.logExtra. Step 14 runs after the handler resolved, and the
    // access line is assembled inside res.on("finish"), which has already fired
    // and already spread logExtra -- a write there is discarded unread, and the
    // renewal failure would be invisible everywhere. So this is a second line for
    // the same request, in the shape of the error tail's, and `level` is what keeps
    // the access log one line per request.
    log(
      JSON.stringify({
        level: "error",
        requestId: req.core.requestId,
        route: req.core.routePattern,
        status: res.statusCode,
        message: `renewSession: ${String((error && error.message) || error)}`
      })
    );
  }
}
```

**(b)** Replace the dispatch wrapper's body — find it with
`grep -n "req.core.routePattern = entry.path" apps/core-api/http/router.js`:

```js
  for (const entry of routes) {
    app[entry.method.toLowerCase()](entry.path, (req, res, next) => {
      req.core.routePattern = entry.path;
      // async, because steps 5 and 14 both await. The whole body is one promise
      // chain so a rejection anywhere reaches next() and the error tail, which is
      // the only thing that may build a response from an exception.
      (async () => {
        if (!(await runPipeline(entry, req, res, deps))) return;
        await entry.handler(req, res);
        // `log`, not `deps.log`: this loop already sits inside createApp, one scope
        // below the `const log = typeof deps.log === "function" ? ... ` normalisation,
        // and that default is the only reason a normal boot logs at all.
        await renewIfSucceeded(entry, req, res, deps, log);
      })().catch(next);
    });
  }
```

**(c)** In `apps/core-api/server.js`, build the new collaborators and pass them:

```js
const { createSemaphore } = require("./lib/semaphore");
const { createRateLimiter } = require("./lib/rate-limit");
const sessionsRepository = require("./repositories/auth/sessions");
const scopesRepository = require("./repositories/auth/scope-materialize");
```

and inside `start()`, in the `createApp({ … })` call, add:

```js
    apiPublicOrigin: config.apiPublicOrigin,
    sessionIdleSeconds: config.sessionIdleSeconds,
    sessionAbsoluteSeconds: config.sessionAbsoluteSeconds,
    loginRatePerMinute: config.loginRatePerMinute,
    loginTimeBudgetMs: config.loginTimeBudgetMs,
    passwordAbuseThreshold: config.passwordAbuseThreshold,
    adminMintRatePer10min: config.adminMintRatePer10min,
    pairingMintRatePer10min: config.pairingMintRatePer10min,
    pairRatePerMinute: config.pairRatePerMinute,
    rotateRatePerHour: config.rotateRatePerHour,
    // Date.now is injected HERE rather than read inside lib/, which is what keeps
    // lib/rate-limit.js Tier 1 and every window boundary unit-testable.
    rateLimiter: options.rateLimiter || createRateLimiter({ now: Date.now }),
    // Spec 5.1: SCRYPT_SLOTS concurrent hashes with a queue depth of 4x, shedding
    // 503 rather than queueing -- "a lengthening queue converts a CPU limit into a
    // timeout storm". ONE semaphore for the whole process: two would be two limits.
    scryptSemaphore: options.scryptSemaphore || createSemaphore({ slots: config.scryptSlots }),
    sessions: options.sessions || sessionsRepository,
    scopes: options.scopes || scopesRepository,
```

Then add **`scryptSlots: 2`** to the frozen `CONFIG` at the top of
`apps/core-api/test/server-bootstrap.test.js` — `createSemaphore` refuses a
non-integer `slots` and that fixture states seven keys, none of them this one, so
the one test that reaches `createApp` dies on a thrown `Error` before it can assert
anything. `2` is `config.js`'s own `SCRYPT_SLOTS` default. **Add only that key.**
`createApp` validates no deps at all, so `apiPublicOrigin`, the `session*`, the
`*Rate*` keys and `loginTimeBudgetMs` all arrive as `undefined` and nothing reads
them on a boot that never serves a request. Adding the rest of the block above to
make the fixture "complete" states a requirement the code does not have, and hands
the next person to touch `config.js` a list to keep in sync instead of one key.

**Do not write `config.scryptSlots ?? 2` in `server.js`.** That plants a second
default for a value `config.js` already bounds to 1–8 — *"above 8 the memory-hard
parameters put the process inside OOM-killer range"* — in a file that cannot
enforce the bound, and the two disagree the first time the bound moves. The fixture
is what is wrong, not the wiring.

**(d)** Add `trustedProxyHops: 0` to every `deps` object built by hand in
`apps/core-api/test/health.test.js` and
`apps/core-api/test/router-registration.test.js`.

`runPipeline` calls `clientAddressOf(req, deps.trustedProxyHops)` at step 4a — on
**every** route, before the `auth === "user"` branch — and `lib/client-ip.js` throws
on anything that is not a non-negative integer, `undefined` included. Both files
were written before `lib/client-ip.js` existed and neither states the key, so both
go red the moment this task lands:

- `health.test.js` — **all six** tests. Four `deps` sites: the inline literal in
  "GET /health is 200", the inline literal in the `HEAD /health` test, the
  `readyDeps()` helper (which covers three tests), and the inline literal in "a
  probe that throws". The 503 cases collapse to 500, so the symptom is not even the
  status the test names.
- `router-registration.test.js` — **four of eight**, at the `withServer({ log: … })`
  literals. The 405 and the two 404 cases are unaffected because the tail is an
  `app.use` registered after the routes and never enters the dispatch wrapper, and
  `/__probe/boom` passes **for the wrong reason**: it already expects
  `500 internal_error`, and its `doesNotMatch` on leaked internals does not list
  `deriveClientIp`.

Give the key to the ones that already pass as well. A fixture that omits it in four
places and states it in four others says the pipeline runs on some routes, and the
next person to add a test copies whichever literal is nearest.

**Do not write `deps.trustedProxyHops ?? 0` — or a `Number.isInteger()` guard — in
`runPipeline`.** Four shipped sites say the throw is the point:
`test/client-ip.test.js` pins `undefined` among the must-throw inputs;
`config.js` refuses to default it at all in production because *"a wrong hop count
fails silently in both directions"*; `http/router.js` says *"Two derivation paths
is one too many"*; and `http/routes/table-displays.js` passes `deps.trustedProxyHops`
straight through, so it would keep throwing there whatever `runPipeline` did. The
default would buy nothing except silence when a deps object is wired wrong — which
is exactly the mistake these two files just made.

Production is unaffected: `server.js` passes `config.trustedProxyHops` and
`config.js` always yields an integer. This is a red suite, not a broken deploy — but
it stays red under the full `npm test` this plan runs twice and under the test gate
in `.github/workflows/deploy.yml`, so it blocks the commit either way.

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/pipeline.test.js apps/core-api/test/table-displays.test.js \
            apps/core-api/test/route-auth.test.js apps/core-api/test/router-registration.test.js \
            apps/core-api/test/health.test.js apps/core-api/test/server-bootstrap.test.js
```

Expected: all pass. **`table-displays.test.js` is the one that matters** — it is
the proof the pipeline did not 401 or 403 the only working authenticated route.

Three failures and what each one means:

- `server-bootstrap.test.js` fails on its `deepEqual(calls, …)` — the new
  collaborators were added to `start()`'s ordered section rather than to the
  `createApp` argument; move them.
- `server-bootstrap.test.js` fails with `createSemaphore: slots must be a positive
  integer, got undefined` — Step 3(c)'s `scryptSlots: 2` did not reach the frozen
  `CONFIG`. This is a thrown `Error`, not a `deepEqual` mismatch, so the bullet
  above does not describe it and the collaborator order is not the problem.
- A bare `500 !== 200` anywhere in `health.test.js` or `router-registration.test.js`
  — the `deps` object for that test lacks `trustedProxyHops` (Step 3(d)). The
  message says nothing because `captureLog()` swallows the log line the error tail
  writes; read it with `log.raw()`, or run the one test with a real `console.log`
  as `log`, and `deriveClientIp: trustedProxyHops must be a non-negative integer`
  is sitting there.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/http/router.js apps/core-api/server.js \
        apps/core-api/test/pipeline.test.js apps/core-api/test/server-bootstrap.test.js \
        apps/core-api/test/health.test.js apps/core-api/test/router-registration.test.js
git commit -m "feat(core-api): the 6.3.5 pipeline, inside the wrapper where 404 still beats 403"
```

---

## Part 5 — The routes

All six routes live in **one file**, `apps/core-api/http/routes/auth.js`, and they
share three helpers that only exist because they are shared: the me-document
builder, the login time-budget pad, and the ISO date coercion. Splitting them
across six files would mean six copies of the me-document, which §6.2 defines once
and four routes return.

`POST /api/admin/scope` lives there too, despite its path. It is an
authentication-state change — it writes `user_sessions.acting_company_id` — and it
returns the me-document. `http/routes/scope.js` would be a file whose only content
is a route that imports every helper from `auth.js`.

### Three departures from what Parts 1–4 wrote down, stated before they surprise anybody

**(a) `lib/authorization.js` is new, and it is not in the file-structure table
above.** The table was written before Task 15 existed. §5.4 says *"privilege rules
live in one module, unit-tested by name"* and §6.2 names that module
`lib/authorization.js`; this plan builds the **alias half** of it and nothing else.
Plan 2c adds the rank lattice, shop containment and the self-modification rules to
the same file. The table at the top of this plan is amended in Task 17.

**(b) `runPipeline` stops at step 7 today, so `options.roles` is decorative.**
Task 11's comment says *"steps 3 through 7"* and it is accurate. Nothing enforces
`roles`. Task 15 lands it — and landing it is what surfaces departure (d), below.

**(d) SETTLED: the four identity routes declare `["platform", "anyUser"]`, not
`["anyUser"]`.** This is the most important paragraph in Part 5. Read it before
Task 13.

An earlier draft gave `me`, `logout`, `logout-all` and `password` the plain
`anyUser` that §6.2's route table gives them. **That combination bricks the only
account this plan creates.** §5.4's alias table admits a *scoped* `platform_admin`
to `anyUser` and deliberately excludes an *unscoped* one — an unscoped platform
scope carries no `companyId`, so a tenant route reached by it would have nothing to
bind. Login always materialises `actingCompanyId: null`, so the administrator
`scripts/create-platform-admin.js` creates is unscoped from the moment they sign in.
Under `["anyUser"]` they can reach exactly one route, `POST /api/admin/scope`, and
in Plan 2b no company exists for them to select. They cannot read `me`, cannot sign
out, and cannot change the password the CLI just set.

**No test in the plan could have caught it**, which is why it is written down here
rather than left to be found: `signedIn()` resolves a `company_admin` and
`platformAdmin()` is pointed only at `/api/admin/scope`. The suite stays green while
the product is unusable. Task 15 Step 1 adds the case that would have failed.

Two repairs were considered and **both are wrong**:

- **Widening `anyUser` in `permits()` to admit `scope.kind === "platform"`** — this
  contradicts the pinned alias table at parent §5.4, and it is the actual security
  hole. Plan 2c registers roughly twenty *tenant* routes at `anyUser`; an unscoped
  platform scope has no `companyId`, and §6.3.3 promises those routes answer
  **409 `scope_required`**, not admission.
- **Adding a fifth alias** — `ROLE_ALIASES` is frozen at four and asserted twice,
  in `router-registration.test.js` and in the `deepEqual` this plan itself writes in
  Task 15.

Declaring **both** aliases is the same construction the plan already uses for
`POST /api/admin/scope`, it touches no frozen list, and it is safe precisely because
these four routes **bind no company**: they read the session, delete a session, or
write a password hash. There is no tenant query for a missing `companyId` to widen.

**The residual, recorded rather than hidden.** §6.2 gives those four rows `anyUser`
and "Errors: none beyond the baseline", while §5.4's table excludes the unscoped
platform admin — the two sections disagree, and Plan 2b is simply the first plan to
execute the disagreement. Task 17 amends §6.2's Roles column. What Task 17 does
**not** do is invent a producer for **409 `scope_required`**: §6.3.3 promises that
code for a tenant route reached by an unscoped platform admin, no route in Plan 2b
is a tenant route, and nothing in this plan produces it. **That is Plan 2c's first
problem, and it must not be discovered there.** Task 17 records it in the slice spec
as §11.11.

**(c) The role gate runs at step 7.5, not at step 10, and the split is deliberate.**
§6.3.5 step 10 reads *"AUTHORIZATION: route roles → 403; then each path resource
resolved in path order"*. Those are two halves with different inputs. The first
depends on the credential alone and on nothing the caller can vary, so it can run
the moment the credential is resolved. The second depends on step 9's path
parameters and must run after them — and it is Plan 2c's, with the first route that
has a path parameter. Running the static half early costs nothing and buys the one
thing that matters: it is in the pipeline, once, rather than a line every handler
has to remember. Task 15 writes the comment that says so, because a reader
comparing the code to §6.3.5 will otherwise think a step was skipped.

### One finding to report rather than fix

`http/body.js` answers **`400 invalid_json`** for a body that parses but is not an
object (`readJsonBody`, the `Array.isArray(parsed)` branch). §6.3.4 assigns that
condition **`400 invalid_request`**, and `db/errors.js` declares the code. Both are
400, so nothing observable breaks and no test is red.

It is a shipped file this plan does not otherwise touch, and the standing rule at
the top says a site the plan does not mention is **a finding to report, not a
decision to make**. Report it; do not fix it here. It belongs in a commit of its
own with `body.test.js` moving alongside.

---

### Task 12: `POST /api/admin/auth/login` — and the deploy tripwire, in ONE commit

**Read "Six things this plan will NOT let you do", item 6, before starting.** The
tripwire is not incidental to this task; it *is* this task's second half.
`deploy-config.test.js` scans every file under `http/routes/` for the literal
`"/api/admin/auth/login"` and fails the moment one appears. It is red for the whole
of this task and green only when `deploy.yml` has moved too. Committing the route
without the deploy edit aborts a real deploy **after the migration has applied**.

**Files:**

- Create: `apps/core-api/http/routes/auth.js`
- Create: `apps/core-api/test/auth-routes.test.js`
- Modify: `apps/core-api/server.js`
- Modify: `apps/core-api/http/router.js`
- Modify: `apps/core-api/test/route-auth.test.js`
- Modify: `.github/workflows/deploy.yml`
- Modify: `apps/core-api/test/deploy-config.test.js`

**The mirrors.** Four lists move, and none of them is in the file being edited:

```bash
grep -rn "GET /health/ready" apps/core-api/test/route-auth.test.js   # the public set
grep -rn "ORIGIN_GATED_PUBLIC_KEYS" apps/core-api                    # Task 6's list, already correct
grep -rn "xff-probe@invalid.test" .github/workflows apps/core-api    # the probe, both ends
grep -rn "the settled four" apps/core-api docs                       # http/router.js and two specs
```

`ORIGIN_GATED_PUBLIC_KEYS` already reads `["POST /api/admin/auth/login"]` — Task 6
wrote it that way on purpose, so it needs no edit here and the census in
`route-auth.test.js` should already agree the moment the route registers. If it does
not, the census is what is wrong.

`http/router.js`'s comment and the two specs say *"the settled four"* about the public
set. **"Four" was never right and this is not the plan that makes it wrong.** Identity
slice §6.2 is titled *"The public set is eight"* and enumerates them; its §12 already
carries the amendment row against parent §6.1. This plan takes the set from two to
**three**; it reaches **eight** when Plan 2d adds `forgot-password`, `reset-password`,
`verify-email`, `GET /admin/reset-password` and `GET /admin/verify-email`, and **nine**
when the **terminal plan** — not Plan 2c, which registers tenant CRUD and adds nothing
public — adds `POST /api/terminal/pair`. Update the comment to say three-of-eight with
the growth named, rather than deleting the count: a count is what makes the `deepEqual`
in `route-auth.test.js` legible, and the `deepEqual` itself is set equality and stays
correct at three, so nothing about it changes here. That edit is why
`apps/core-api/http/router.js` is in this task's Files list and in the Step 6
`git add` — an earlier draft named the file here and nowhere else, which is how a
file gets edited and then left out of the commit.

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/auth-routes.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../http/router");
const { createRateLimiter } = require("../lib/rate-limit");
const { createSemaphore } = require("../lib/semaphore");
const { hashPassword } = require("../lib/password");
const { SESSION_COOKIE_NAME } = require("../http/cookies");

require("../http/routes/auth");

const ORIGIN = "https://api.yeyintlwin.com";
const USER = "aaaaaaaa-0003-4000-8000-000000000001";
const COMPANY = "aaaaaaaa-0001-4000-8000-000000000001";
const SESSION_ID = "aaaaaaaa-0008-4000-8000-000000000001";
const PASSWORD = "correct-horse-battery";

// Hashed ONCE for the whole file. scrypt at N=32768 costs ~100 ms, and a fixture
// rebuilt per test turns this suite into a minute of CPU for no coverage.
let storedHash;

function activeUser(overrides = {}) {
  return {
    id: USER,
    email: "till@example.test",
    displayName: "Till",
    role: "company_admin",
    companyId: COMPANY,
    passwordHash: storedHash,
    mustChangePassword: false,
    status: "active",
    lockedUntil: null,
    failedLoginCount: 0,
    companyStatus: "active",
    ...overrides
  };
}

function harness(overrides = {}) {
  const audits = [];
  const bumped = [];
  const cleared = [];
  const deps = {
    log: () => {},
    apiPublicOrigin: ORIGIN,
    trustedProxyHops: 1,
    sessionIdleSeconds: 28800,
    sessionAbsoluteSeconds: 604800,
    loginRatePerMinute: 30,
    // Small on purpose. The pad is asserted by call ordering, never by wall clock:
    // a timing assertion is the flakiest test a CI box can run.
    loginTimeBudgetMs: 250,
    passwordAbuseThreshold: 5,
    adminMintRatePer10min: 20,
    pairingMintRatePer10min: 30,
    pairRatePerMinute: 20,
    rotateRatePerHour: 5,
    rateLimiter: createRateLimiter({ now: () => 1_700_000_000_000 }),
    scryptSemaphore: createSemaphore({ slots: 2 }),
    users: {
      findByEmailForLogin: async () => activeUser(),
      recordFailedLogin: async (id) => { bumped.push(id); return { failedLoginCount: 1, lockedUntil: null }; },
      recordSuccessfulLogin: async (id) => { cleared.push(id); }
    },
    sessions: {
      createSession: async () => ({
        id: SESSION_ID,
        expiresAt: new Date("2026-08-05T08:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-08-12T00:00:00.000Z")
      })
    },
    scopes: {
      materialiseScope: async (input) => ({
        kind: "tenant",
        userId: input.userId,
        sessionId: input.sessionId,
        companyId: input.companyId,
        role: input.role,
        shopIds: [],
        administeredShopIds: []
      })
    },
    appendAuditEvent: async (event) => { audits.push(event); return "1"; },
    ...overrides
  };
  return { deps, audits, bumped, cleared };
}

async function withServer(deps, run) {
  const app = createApp(deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function login(base, body, headers = {}) {
  return fetch(`${base}/api/admin/auth/login`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7", ...headers },
    body: JSON.stringify(body)
  });
}

test.before(async () => { storedHash = await hashPassword(PASSWORD); });

test("a correct password returns the me-document and a __Host- cookie", async () => {
  const { deps, cleared } = harness();
  await withServer(deps, async (base) => {
    const response = await login(base, { email: "Till@Example.test", password: PASSWORD });
    assert.equal(response.status, 200);

    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=`), cookie);
    assert.match(cookie, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800$/);

    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["scope", "session", "user"]);
    assert.deepEqual(body.user, {
      id: USER,
      email: "till@example.test",
      displayName: "Till",
      role: "company_admin",
      companyId: COMPANY,
      mustChangePassword: false
    });
    assert.deepEqual(body.scope.shopIds, []);
    assert.deepEqual(body.scope.administeredShopIds, []);
    assert.equal(body.session.expiresAt, "2026-08-05T08:00:00.000Z");
    assert.deepEqual(cleared, [USER]);
  });
});

test("the response carries no password hash anywhere in it", async () => {
  // The login lookup selects password_hash, so the row that reaches the handler
  // holds it. A me-document built by spreading that row would ship a scrypt PHC
  // string to the client, and the 6.3.6 leak scanner does not read 200 bodies.
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const text = await (await login(base, { email: "till@example.test", password: PASSWORD })).text();
    assert.doesNotMatch(text, /scrypt\$/);
    assert.doesNotMatch(text, /passwordHash/);
  });
});

test("every failure cause produces a byte-identical 401", async () => {
  // Spec 6.2: "401 invalid_credentials (uniform: unknown email, wrong password,
  // locked, suspended user, suspended company)". Compared as TEXT with the
  // requestId stripped -- requestId is per-request random and is the only field
  // that legitimately differs.
  const causes = {
    unknown: { findByEmailForLogin: async () => null },
    wrongPassword: { findByEmailForLogin: async () => activeUser() },
    suspendedUser: { findByEmailForLogin: async () => activeUser({ status: "suspended" }) },
    suspendedCompany: { findByEmailForLogin: async () => activeUser({ companyStatus: "suspended" }) },
    locked: { findByEmailForLogin: async () => activeUser({ lockedUntil: new Date(Date.now() + 600_000) }) }
  };

  const seen = new Set();
  for (const [name, users] of Object.entries(causes)) {
    const { deps } = harness();
    deps.users = { ...deps.users, ...users };
    await withServer(deps, async (base) => {
      const response = await login(base, { email: "till@example.test", password: "wrong-password-here" });
      assert.equal(response.status, 401, name);
      assert.equal(response.headers.get("set-cookie"), null, `${name} must not set a cookie`);
      const text = (await response.text()).replace(/"requestId":"[^"]+"/, '"requestId":"X"');
      seen.add(text);
    });
  }
  assert.equal(seen.size, 1, `the five failure causes produced ${seen.size} distinct bodies`);
});

test("an unknown address still writes auth.login_failed with the derived source_ip", async () => {
  // THE ROW THE DEPLOY GATE READS. Spec 5.7: the audit row "is the only externally
  // observable evidence of what the server derived as the client IP, and the deploy
  // gate in 9.5 asserts against it". Its probe uses an address that matches NO user,
  // so a handler that writes the row only when the user exists makes the gate assert
  // on nothing and pass whatever TRUSTED_PROXY_HOPS is set to.
  const { deps, audits, bumped } = harness({
    users: { findByEmailForLogin: async () => null, recordFailedLogin: async () => null, recordSuccessfulLogin: async () => {} }
  });
  await withServer(deps, async (base) => {
    await login(base, { email: "xff-probe@invalid.test", password: "x" }, { "X-Forwarded-For": "203.0.113.99, 10.0.0.1" });
  });

  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], {
    actorKind: "anonymous",
    action: "auth.login_failed",
    outcome: "failure",
    sourceIp: "10.0.0.1",
    detail: { email: "xff-probe@invalid.test" }
  });
  // No user row, so nothing to bump -- and recordFailedLogin(null) would be an
  // UPDATE ... WHERE id = NULL, which matches nothing and hides the mistake.
  assert.deepEqual(bumped, []);
});

test("only a wrong password on an otherwise-eligible account bumps the counter", async () => {
  // A locked account must NOT bump: one request every 14 minutes would then hold
  // the 15-minute cap forever, which is the permanent-DoS shape spec 5.8(a) rejects
  // on the password route for the same reason. A suspended user and a suspended
  // company have no login to throttle.
  for (const [name, user] of Object.entries({
    locked: activeUser({ lockedUntil: new Date(Date.now() + 600_000) }),
    suspendedUser: activeUser({ status: "suspended" }),
    suspendedCompany: activeUser({ companyStatus: "suspended" })
  })) {
    const { deps, bumped } = harness();
    deps.users = { ...deps.users, findByEmailForLogin: async () => user };
    await withServer(deps, async (base) => {
      await login(base, { email: "till@example.test", password: PASSWORD });
    });
    assert.deepEqual(bumped, [], `${name} bumped failed_login_count`);
  }

  const { deps, bumped } = harness();
  await withServer(deps, async (base) => {
    await login(base, { email: "till@example.test", password: "wrong-password-here" });
  });
  assert.deepEqual(bumped, [USER]);
});

test("the scrypt slot is released on the failure path too", async () => {
  // A `finally`-less release leaks one slot per failed login, and with SCRYPT_SLOTS
  // at 2 the service stops answering login after two wrong passwords -- as a 503,
  // which reads as a database problem.
  const semaphore = createSemaphore({ slots: 1, queueDepth: 0 });
  const { deps } = harness({ scryptSemaphore: semaphore });
  await withServer(deps, async (base) => {
    await login(base, { email: "till@example.test", password: "wrong-password-here" });
    assert.deepEqual(semaphore.stats(), { running: 0, queued: 0, slots: 1, queueDepth: 0 });
    const second = await login(base, { email: "till@example.test", password: PASSWORD });
    assert.equal(second.status, 200, "the second login was shed: the first never released");
  });
});

test("a missing field is 422 and names both fields at once", async () => {
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const response = await login(base, {});
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, "validation_failed");
    assert.deepEqual(body.error.errors, [
      { field: "email", code: "required" },
      { field: "password", code: "required" }
    ]);
  });
});

test("an over-long address is refused before the lookup, and 254 exactly is not", async () => {
  // The bound the users.email CHECK already carries. Without it the folded address
  // lands in audit_events.detail on every failure -- see the login_failed row above,
  // which is written for an address that matches nothing -- and that column has no
  // length CHECK and no sweeper until Plan 2d.
  let looked = 0;
  const { deps, audits } = harness({
    users: {
      findByEmailForLogin: async () => { looked += 1; return null; },
      recordFailedLogin: async () => null,
      recordSuccessfulLogin: async () => {}
    }
  });
  await withServer(deps, async (base) => {
    // 242 + "@example.test" (13) = 255, one character past the CHECK.
    const tooLong = await login(base, { email: `${"a".repeat(242)}@example.test`, password: PASSWORD });
    assert.equal(tooLong.status, 422);
    const body = await tooLong.json();
    assert.equal(body.error.code, "validation_failed");
    assert.deepEqual(body.error.errors, [{ field: "email", code: "too_long" }]);
    // The two properties that make this a shape check rather than an oracle: nothing
    // was looked up, and nothing was written. A 422 that reached the database would
    // tell an anonymous caller which addresses are cheap to ask about.
    assert.equal(looked, 0);
    assert.deepEqual(audits, []);

    // 241 + 13 = 254, the last legal length, so it must reach the uniform 401. An
    // exclusive bound here would lock out an address the database would have stored,
    // and the account holder would read it as a wrong password.
    const legal = await login(base, { email: `${"a".repeat(241)}@example.test`, password: PASSWORD });
    assert.equal(legal.status, 401, "254 characters is inside the CHECK, not outside it");
    assert.equal(looked, 1);
  });
});

test("login is origin-gated and content-type-gated, and Origin is answered first", async () => {
  // The one public route that carries the gate (Task 6's ORIGIN_GATED_PUBLIC_KEYS).
  // Origin before Content-Type: answering 415 to a request from evil.test would
  // confirm the origin was acceptable.
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const wrongOrigin = await fetch(`${base}/api/admin/auth/login`, {
      method: "POST",
      headers: { Origin: "https://evil.test", "Content-Type": "text/plain" },
      body: "{}"
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal((await wrongOrigin.json()).error.code, "origin_not_allowed");

    const wrongType = await fetch(`${base}/api/admin/auth/login`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
      body: "{}"
    });
    assert.equal(wrongType.status, 415);
  });
});

test("login's 429 carries NO Retry-After, on the real route", async () => {
  // Spec 6.2 marks login and pair as the two 429s that must not carry the header:
  // it would confirm to an attacker that their probes are landing in a bucket.
  // pipeline.test.js proves the roster honours that on a SCRATCH route; this proves
  // the shipped route declares the right limiter, which is the half that can regress.
  const { deps } = harness({ loginRatePerMinute: 2 });
  await withServer(deps, async (base) => {
    await login(base, { email: "till@example.test", password: "wrong-password-here" });
    await login(base, { email: "till@example.test", password: "wrong-password-here" });
    const shed = await login(base, { email: "till@example.test", password: "wrong-password-here" });
    assert.equal(shed.status, 429);
    assert.equal(shed.headers.get("retry-after"), null);
  });
});
```

And widen the public set in `apps/core-api/test/route-auth.test.js` — find it with
`grep -n 'GET /health/ready' apps/core-api/test/route-auth.test.js`:

```js
  // Set EQUALITY, not containment: adding a fourth fails and so does removing one.
  // Three of the eight that identity spec 6.2 enumerates. The next five are Plan 2d's
  // recovery routes; POST /api/terminal/pair makes nine and arrives with the terminal
  // plan. Widen this literal in the same commit as the route, never ahead of it.
  assert.deepEqual(
    publicKeys,
    new Set(["GET /health", "GET /health/ready", "POST /api/admin/auth/login"])
  );
```

Add the origin-gating census beside it, which is the mirror identity spec §6.3 asks
for:

```js
test("the origin-gated set is derived and pinned, so a new public POST cannot skip the gate", () => {
  const { requiresOriginCheck } = require("../http/csrf");
  const gated = new Set(entries.filter(requiresOriginCheck).map((entry) => entry.key));

  // Identity spec 6.3's amended rule, asserted as a CENSUS rather than declared as a
  // route option: 8.5 is exactly ten rules and adding an `origin:` option would be a
  // design change rather than a repair. Plan 2d adds forgot-password, reset-password
  // and verify-email; the auth routes below arrive across Tasks 12-15.
  assert.deepEqual(gated, new Set([
    "POST /api/admin/auth/login"
  ]));
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
node --test apps/core-api/test/auth-routes.test.js apps/core-api/test/route-auth.test.js
```

Expected: `auth-routes.test.js` fails with `Cannot find module '../http/routes/auth'`;
`route-auth.test.js` fails its public-set `deepEqual` in the other direction (two
where three are now expected).

```bash
node --test apps/core-api/test/deploy-config.test.js
```

Expected: **PASS**, because `http/routes/auth.js` does not exist yet. It goes red in
Step 3 and comes back in Step 4. That sequence is the tripwire working.

- [x] **Step 3: Write the route**

Create `apps/core-api/http/routes/auth.js`:

```js
"use strict";

// The six routes of spec 6.2's authentication block, in one file because they share
// the me-document -- which 6.2 defines once and four of them return.
//
// WHAT IS NOT HERE: any SQL. Every statement lives in repositories/auth/*, which are
// the files rule C4's nine-entry allowlist sanctions to call withUnscopedConnection.
// Rule C2's second needle bans a `.query(` in this file whatever the handle is called.

const { route } = require("../router");
const { readJsonBody } = require("../body");
const { sendJson } = require("../respond");
const { ApiError } = require("../../db/errors");
const { verifyPassword } = require("../../lib/password");
const { mintToken, hashToken } = require("../../lib/tokens");
const { buildSessionCookie } = require("../cookies");

// ---------------------------------------------------------------------------
// The me-document (spec 6.2), built by NAMING every field rather than by spreading
// a row. The login lookup selects password_hash, so a spread would put a scrypt PHC
// string in a 200 body -- and the 6.3.6 leak scanner reads error bodies only.
// ---------------------------------------------------------------------------

// pg hands timestamptz back as a Date; a stub in a test may hand back a string.
// Both become the same ISO-8601 text, so the response shape cannot depend on which.
function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function meDocument({ user, scope, session }) {
  const document = {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      // null for an unscoped platform admin, and 6.2 says so: scope.kind is what
      // the Phase-2 UI branches on to show the company selector.
      companyId: user.companyId ?? null,
      mustChangePassword: user.mustChangePassword
    },
    scope: {
      kind: scope.kind,
      companyId: scope.companyId ?? null,
      // ALWAYS an array, never null. Spec 6.2: this is what exercises the 3.3(c)
      // materialised-scope rule end to end, so a regression is visible from outside
      // the process. A platform scope carries no shopIds at all, and [] is the
      // honest rendering of "reaches no shop", not a stand-in for "reaches all".
      shopIds: [...(scope.shopIds ?? [])]
    },
    session: {
      expiresAt: iso(session.expiresAt),
      absoluteExpiresAt: iso(session.absoluteExpiresAt)
    }
  };
  // Present ONLY for company_admin and scoped platform_admin -- db/scope.js throws
  // if any other role is handed one, so its absence here is the same fact.
  if (scope.administeredShopIds !== undefined) {
    document.scope.administeredShopIds = [...scope.administeredShopIds];
  }
  return document;
}

// ---------------------------------------------------------------------------
// The login time budget (spec 5.1)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// MEASURED FROM SLOT ACQUISITION, not from request arrival -- spec 5.1 in as many
// words. Queue wait sits outside the budget, which is exactly why
// LOGIN_RATE_PER_MINUTE sheds BEFORE the queue rather than lengthening it: if queue
// time counted, a burst would stretch every login past the budget and the
// byte-identical-outcome property would leak through timing.
//
// Paid on the SUCCESS path too. Padding only failures makes success the fast answer,
// which is the same oracle wearing the other hat.
async function payTimeBudget(startedAt, budgetMs) {
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (elapsedMs < budgetMs) await sleep(budgetMs - elapsedMs);
}

// ---------------------------------------------------------------------------
// POST /api/admin/auth/login
// ---------------------------------------------------------------------------

// Returns { ok, bumpUserId }. Written as one function so the five uniform failure
// causes of 6.2 are visibly ONE list rather than five early returns scattered
// through a handler, and so the "which failures bump the counter" question has a
// single place to be answered.
//
// A LOCKED ACCOUNT DOES NOT BUMP, and that is the same argument spec 5.8(a) makes
// about the password route: bumping while locked lets one request every fourteen
// minutes hold the fifteen-minute cap forever, so a lockout designed to expire
// becomes permanent and the victim reads their own uniform 401 as a typo.
// A suspended user and a suspended company have no login to throttle at all.
async function evaluateLogin(user, password, now) {
  if (user === null) return { ok: false, bumpUserId: null };
  if (user.status !== "active") return { ok: false, bumpUserId: null };
  if (user.companyId !== null && user.companyStatus !== "active") return { ok: false, bumpUserId: null };
  if (user.lockedUntil !== null && new Date(user.lockedUntil).getTime() > now) {
    return { ok: false, bumpUserId: null };
  }
  // Reached only for an eligible account, so this is the ONLY path that spends
  // scrypt. Every other cause is a comparison, and the budget pad is what keeps
  // that difference off the wire.
  if (!(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, bumpUserId: user.id };
  }
  return { ok: true, bumpUserId: null };
}

route(
  "POST",
  "/api/admin/auth/login",
  {
    auth: "public",
    body: { email: "string", password: "string" },
    // ONE declared action, because `audit` is one string. The handler also writes
    // auth.login_failed, which is in the vocabulary and is what the deploy gate
    // reads. Nothing asserts that a route emits ONLY its declared action -- the
    // declaration is a boot-time membership check, not a runtime contract.
    audit: "auth.login",
    // Credential-independent, consumed by the pipeline at step 4a before any scrypt
    // is queued. NO Retry-After: spec 5.7 says the header would confirm the bucket.
    limit: { key: "ip", name: "login-global" },
    sample: { body: { email: "sample@example.test", password: "not-a-real-password" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const body = await readJsonBody(req);

    // Shape, not semantics. A missing field says nothing about any account, so 422
    // here is not the oracle a 422-versus-401 split would be further down.
    const errors = [];
    if (typeof body.email !== "string" || body.email.trim() === "") {
      errors.push({ field: "email", code: "required" });
    } else if (body.email.trim().length > 254) {
      // 254 is the users.email CHECK -- `length(email) BETWEEN 3 AND 254` in
      // migrations/0001_init.sql -- and the same bound the bootstrap CLI applies
      // before it opens a pool. Unbounded here, the folded address is written into
      // audit_events.detail on EVERY failure including one that matches no row, and
      // that table has no length CHECK on detail and nothing sweeping it until
      // Plan 2d: an unauthenticated caller would choose the row size.
      //
      // Still shape, not semantics. It runs before findByEmailForLogin, so it says
      // nothing about whether any address exists, and no legal address reaches it --
      // an address the database would accept cannot be longer than the bound.
      errors.push({ field: "email", code: "too_long" });
    }
    if (typeof body.password !== "string" || body.password === "") {
      errors.push({ field: "password", code: "required" });
    }
    // THERE IS DELIBERATELY NO COMPANION `too_long` ON password, and this is the
    // note that exists so nobody adds one. lib/password.js says it in as many words:
    // "The length policy is deliberately NOT applied here. It guards what is
    // written; applying it on the read path would lock out every existing account
    // the day the minimum is raised." A check here would also measure the raw
    // string while normalise() measures after NFKC, so it would reject a password
    // that hashPassword accepted and contracted. And it saves nothing: scrypt's cost
    // is fixed by the N, r and p in the stored hash, not by how long the candidate
    // is -- and unlike the email, the password reaches no durable row on this path.
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    // Folded the way the users.email CHECK folds it -- lower(btrim(...)). The
    // repository folds again in SQL; doing it here as well is what makes the audit
    // row's detail.email the same string the lookup used.
    const email = body.email.trim().toLowerCase();

    // Acquired BEFORE the lookup, so the budget clock covers every path and the
    // 503 shed happens before anything credential-dependent has been read.
    await deps.scryptSemaphore.acquire();
    const startedAt = process.hrtime.bigint();
    try {
      const user = await deps.users.findByEmailForLogin(email);
      const verdict = await evaluateLogin(user, body.password, Date.now());

      if (!verdict.ok) {
        if (verdict.bumpUserId !== null) await deps.users.recordFailedLogin(verdict.bumpUserId);
        // WRITTEN FOR EVERY FAILURE, INCLUDING AN ADDRESS THAT MATCHES NO ROW.
        // Spec 5.7: this row is the only externally observable evidence of what the
        // server derived as the client IP, and deploy.yml block 4 selects it by
        // detail.email for an address no user has. Skip it when the user is unknown
        // and the deploy gate asserts on nothing.
        await deps.appendAuditEvent({
          actorKind: "anonymous",
          action: "auth.login_failed",
          outcome: "failure",
          sourceIp: req.core.clientIp,
          detail: { email }
        });
        await payTimeBudget(startedAt, deps.loginTimeBudgetMs);
        throw new ApiError(401, "invalid_credentials");
      }

      await deps.users.recordSuccessfulLogin(user.id);

      const token = mintToken();
      const session = await deps.sessions.createSession({
        userId: user.id,
        tokenHash: hashToken(token),
        idleSeconds: deps.sessionIdleSeconds,
        absoluteSeconds: deps.sessionAbsoluteSeconds
      });
      // A FRESH session selects no company. A platform admin therefore signs in
      // unscoped every time and chooses again through POST /api/admin/scope, which
      // is the property that keeps an acting company from outliving a sign-out.
      const scope = await deps.scopes.materialiseScope({
        userId: user.id,
        sessionId: session.id,
        role: user.role,
        companyId: user.companyId,
        actingCompanyId: null
      });

      await deps.appendAuditEvent({
        actorKind: "user",
        actorUserId: user.id,
        companyId: user.companyId,
        action: "auth.login",
        outcome: "success",
        targetKind: "user",
        targetId: user.id,
        sourceIp: req.core.clientIp
      });

      // The request log's actor. The pipeline sets these for auth:'user' routes at
      // step 5; login is public, so this is the one route that has to say who it
      // turned out to be.
      req.core.actorKind = "user";
      req.core.actorId = user.id;

      await payTimeBudget(startedAt, deps.loginTimeBudgetMs);
      sendJson(res, 200, meDocument({ user, scope, session }), {
        // Max-Age tracks the IDLE window, not the absolute one: a cookie outliving
        // its session leaves the browser presenting a credential the server has
        // already stopped honouring, which reads as a broken sign-out.
        "Set-Cookie": buildSessionCookie(token, deps.sessionIdleSeconds)
      });
    } finally {
      // Without this, one slot leaks per failed login and the service stops
      // answering login after SCRYPT_SLOTS wrong passwords -- as a 503, which
      // reads as a database problem.
      deps.scryptSemaphore.release();
    }
  }
);

module.exports = { meDocument, evaluateLogin, payTimeBudget };
```

In `apps/core-api/server.js`, add the route require beside the other two — find it
with `grep -n 'require("./http/routes/' apps/core-api/server.js`:

```js
require("./http/routes/auth");
```

and the users repository, which Task 11 did not add because nothing called it yet:

```js
const usersRepository = require("./repositories/auth/users");
```

then inside the `createApp({ … })` call:

```js
    users: options.users || usersRepository,
```

- [x] **Step 4: Move the deploy tripwire, in this same commit**

**(a)** In `.github/workflows/deploy.yml`, block 4. Find it with
`grep -n "xff-probe@invalid.test" .github/workflows/deploy.yml`.

**Block 4's header comment is part of this edit, not a tidy-up for Task 17.** Three
of its claims become false the moment the two expectations below change, and the
worst of them is the paragraph declaring in capitals that NOTHING IN THIS BLOCK CAN
FAIL BECAUSE THE HOP COUNT PRODUCES THE WRONG ADDRESS — after this step it would sit
at the top of a block whose last three assertions exist for no other purpose than to
fail on a wrong hop count, and it is the first thing anyone debugging a red deploy at
22:00 will read.
Two more: the header advertises *"the XFF assertion arrives in Plan 2"*, and the
paragraph attributing the answer to core-api names the 404 tail's
`{"error":{"code":"not_found"}}`, which is exactly the pair being changed. A fourth
sentence in it is already false at HEAD — *"Plan 1 ships no login route, no
`lib/client-ip.js` and no audit writer"* — both files exist
(`apps/core-api/lib/client-ip.js`, `apps/core-api/repositories/auth/audit.js`).

This cannot be deferred to Task 17: Task 17's greps carry `--include=*.md
--include=*.js` and cannot match a `.yml` file, its Files list has no `.github/`
path, and this plan's one-commit rule requires `deploy.yml` to move with the route
anyway. Replace the header — from the `# ---- 4.` line through the line ending
*"The behavioural assertion is Plan 2's."*, both ends found with
`grep -n "LOGIN-PATH ROUTING PROBE\|behavioural assertion is Plan 2" .github/workflows/deploy.yml`
— with:

```sh
          # ---- 4. LOGIN-PATH ROUTING PROBE, AND THE FORGEABILITY ASSERTION ----
          # THIS MUST RUN BEFORE THE limit_req BURST IN BLOCK 5. Run after it and the
          # burst has already exhausted the core_login bucket for this source address,
          # so nginx sheds the probe, it never reaches core-api, and every assertion
          # below passes vacuously.
          #
          # What the status pair proves: the login path resolves through the real TLS
          # chain, nginx's `location = /api/admin/auth/login` includes the proxy snippet,
          # and CORE-API ITSELF answered -- the route returns application/json
          # {"error":{"code":"invalid_credentials",...}} for an address that does not
          # exist, where an nginx-level 404 returns text/html and a dead upstream returns
          # nginx's own 502 page.
          #
          # What the psql proves, and no file in this repository can prove about itself:
          # that a client-sent X-Forwarded-For is NOT honoured. That 401 is a real login
          # failure, so it writes an audit row, and the row carries the address the
          # DEPLOYED chain derived rather than the one the header asked for. SO THIS
          # BLOCK NOW FAILS WHEN THE HOP COUNT PRODUCES THE WRONG ADDRESS -- that is what
          # the three tests after the psql are for, and the earlier `hops` check stays
          # only because it names the variable's actual value in its message.
```

Then change the two expectations:

```sh
          test "$probe_status" = "401" || { echo "login probe: expected 401 from core-api, got $probe_status"; cat /tmp/xff-probe.body; exit 1; }
          grep -q '"code":"invalid_credentials"' /tmp/xff-probe.body || { echo 'login probe: that 401 did not come from core-api'; cat /tmp/xff-probe.body; exit 1; }
```

Delete the whole `# PLAN 2: restore the full forgeability assertion here …` comment
block and put the assertion it describes in its place, immediately after the `hops`
check:

```sh
          # THE FORGEABILITY ASSERTION. Two locally-correct files can still be a wrong
          # PAIR, and nothing inside core-api can tell: a forged `X-Forwarded-For:
          # 1.2.3.4` under one proxy produces a header byte-identical to a legitimate
          # two-proxy deployment whose real client IS 1.2.3.4. Only the deployed chain
          # can answer, and this is where it is asked.
          #
          # Selected by THIS probe's address, never by recency: a shed request writes
          # nothing at all, and block 5's burst leaves a row that would satisfy both
          # tests whatever the hop count is.
          probe=$(docker compose exec -T core-db sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -tAq -U core_api_owner -d core -c \"SELECT coalesce(host(source_ip), 'null') FROM audit_events WHERE detail->>'email' = 'xff-probe@invalid.test' ORDER BY id DESC LIMIT 1\"" </dev/null)
          test -n "$probe"                || { echo 'XFF probe wrote no audit row - it never reached core-api'; exit 1; }
          test "$probe" != "203.0.113.99" || { echo 'FORGEABLE X-Forwarded-For: TRUSTED_PROXY_HOPS is wrong'; exit 1; }
          test "$probe" != "null"         || { echo 'client IP derivation collapsed; check TRUSTED_PROXY_HOPS'; exit 1; }
```

**Three traps in that one line, and all three have a test behind them.**

1. **Do not paste spec §9.5's recipe.** The appendix writes the curl as
   `curl -fsS … || true`, and `deploy-config.test.js` bans that literal in
   `deploy.yml`. Keep the existing `-w '%{http_code}'` capture form — that is
   precisely why it tolerates a 401 without `-f`.
2. **Do not paste spec §9.5's psql quoting either.** The appendix wraps the SQL in a
   single-quoted `sh -c` and escapes every inner quote as `'"'"'`, which spells
   `detail->>'"'"'email'"'"'` — and `deploy-config.test.js` matches the literal
   `detail->>'email' = 'xff-probe@invalid.test'`. The double-quoted `sh -c` above
   keeps the SQL readable and byte-identical to what the test looks for.
   The appendix should be corrected too; Task 17 does it.
3. **`</dev/null`.** Every command in this heredoc that could read stdin carries it,
   because the heredoc *is* the shell's stdin — a `docker compose exec` without it
   eats the rest of the deploy script.

**(b)** In `apps/core-api/test/deploy-config.test.js`, inside
`test("deploy heredoc probes the login path before it exhausts the limit_req bucket")`.
Find it with `grep -n 'probe_status' apps/core-api/test/deploy-config.test.js`.

Change the two expectations, and **replace the deferral marker with an assertion on
the claim that is now true** — a `match` on a deferral literal goes red only when the
literal is removed, which is the very edit it exists to compel:

```js
  assert.match(workflow, /test "\$probe_status" = "401"/);
  assert.match(workflow, /grep -q '"code":"invalid_credentials"' \/tmp\/xff-probe\.body/);
  assert.doesNotMatch(workflow, /xff-probe@invalid\.test[^\n]*\|\| true/);

  // The forgeability half, which used to be a PLAN 2 marker. All three assertions,
  // because each catches a different wrong answer: no row means the probe never
  // reached core-api, 203.0.113.99 means the header is forgeable, and null means the
  // derivation collapsed into the shared "unknown" bucket.
  assert.match(workflow, /detail->>'email' = 'xff-probe@invalid\.test'/);
  assert.match(workflow, /test -n "\$probe"/);
  assert.match(workflow, /test "\$probe" != "203\.0\.113\.99"/);
  assert.match(workflow, /test "\$probe" != "null"/);
  assert.doesNotMatch(workflow, /PLAN 2: restore the full forgeability assertion/);
```

Then **delete the `routesDir` loop entirely** — the whole `const routesDir = …` block
through its closing brace. It existed for exactly one purpose, to make this commit
impossible to forget, and it has now done it. Leaving it in place fails forever.

- [x] **Step 5: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/auth-routes.test.js apps/core-api/test/route-auth.test.js \
            apps/core-api/test/deploy-config.test.js apps/core-api/test/csrf.test.js \
            apps/core-api/test/pipeline.test.js apps/core-api/test/table-displays.test.js \
            apps/core-api/test/source-structure.test.js apps/core-api/test/server-bootstrap.test.js
```

Expected: all pass. Then the whole suite, because this is the commit that changes
what the deploy asserts:

```bash
npm test
```

- [x] **Step 6: Commit**

```bash
git add apps/core-api/http/routes/auth.js apps/core-api/test/auth-routes.test.js \
        apps/core-api/server.js apps/core-api/http/router.js \
        apps/core-api/test/route-auth.test.js \
        .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js
git commit -m "feat(core-api): sign in, and make the deploy assert that X-Forwarded-For is not forgeable"
```

---

### Task 13: `me`, `logout` and `logout-all`

Three routes, one commit, because two of them are four lines and the third is the
only in-band lever against a stolen session in Phase 1 (§6.2) — and that third one
needs a column writer that does not exist yet.

**Files:**

- Modify: `apps/core-api/http/routes/auth.js`
- Modify: `apps/core-api/repositories/auth/users.js`
- Modify: `apps/core-api/test/auth-users.test.js`
- Modify: `apps/core-api/test/auth-routes.test.js`
- Modify: `apps/core-api/test/route-auth.test.js`

**The mirrors.** `route-auth.test.js` rule 3 needs **no edit** and that is the point:
it computes `SETTLED_EXEMPT.filter((key) => keys.includes(key))`, so registering
`POST /api/admin/auth/logout` **without** `exemptFromPasswordChange: true` turns it
red by itself. Do not "fix" it by widening the literal.

```bash
grep -n "SETTLED_EXEMPT" apps/core-api/test/route-auth.test.js
grep -n "sessions_valid_from" apps/core-api --include=*.js --include=*.sql
```

**Why `logout-all` needs a second statement, and why the ORDER of the two is the
whole correctness argument.** A bare `DELETE FROM user_sessions WHERE user_id = $1`
does not sign anybody out everywhere: a session created between the DELETE and the
response survives it, which Task 8's own comment states about this exact table.
§5.2 names `users.sessions_valid_from` as the bulk-invalidation lever, *"bumped on
password change, suspension and sign out everywhere"* — and this route is the third
of those three, with no writer for it yet.

**DELETE first, then bump.** Not the other way round, and not because it reads
better:

- Bump, then delete → a session created in the gap has `created_at > sessions_valid_from`, so the resolver **accepts** it and the DELETE has already run. It survives. That is the attacker's session surviving the button that exists to kill it.
- Delete, then bump → a session created in the gap has `created_at < sessions_valid_from`, so the resolver **rejects** it. Anything created after the bump is a deliberate new sign-in and is meant to live.

So the ordering makes the pair fail closed without a transaction, which is worth
more than a transaction would be: the bump is a monotonic cutoff and cannot miss a
row. The only cost is that `revokedSessionCount` under-reports by whatever was
created in the gap — an informational number, and the plan says so rather than
pretending the count is exact.

- [x] **Step 1: Write the failing tests**

Add to `apps/core-api/test/auth-users.test.js`:

```js
test("bumpSessionsValidFrom moves the lever and touches nothing else", { skip }, async () => {
  const columns = "sessions_valid_from, failed_login_count, locked_until, password_hash";
  const before = await db.unscoped(`SELECT ${columns} FROM users WHERE id = $1`, [IDS.userAStaff]);
  await users.bumpSessionsValidFrom(IDS.userAStaff);
  const after = await db.unscoped(`SELECT ${columns} FROM users WHERE id = $1`, [IDS.userAStaff]);

  assert.ok(after.rows[0].sessions_valid_from > before.rows[0].sessions_valid_from);
  // The login credential's columns are NOT this route's to write -- spec 5.8(a).
  assert.equal(after.rows[0].failed_login_count, before.rows[0].failed_login_count);
  assert.equal(after.rows[0].locked_until?.getTime() ?? null, before.rows[0].locked_until?.getTime() ?? null);
  assert.equal(after.rows[0].password_hash, before.rows[0].password_hash);
});
```

Written in the shape Task 7 gave that file, because that file has no helpers: its
`writePasswordHash` test is the template, every read there is a bare
`await db.unscoped(…)`, and every test carries `{ skip }`. Both details are
load-bearing rather than stylistic. Drop `{ skip }` and the file stops being
skippable on a box with no database — it fails instead of standing down, which is the
one thing `skipDatabaseTests()` exists to prevent. Drop the `.rows[0].` and the four
assertions read properties off the result object rather than off the row: the first
one fails as `undefined > undefined` against a perfectly correct repository function,
and the other three go green against one that writes nothing at all.

Add to `apps/core-api/test/auth-routes.test.js`:

```js
const SESSION_ROW = {
  sessionId: SESSION_ID,
  userId: USER,
  actingCompanyId: null,
  expiresAt: new Date("2026-08-05T08:00:00.000Z"),
  absoluteExpiresAt: new Date("2026-08-12T00:00:00.000Z"),
  lastSeenAt: new Date("2026-08-05T00:00:00.000Z"),
  email: "till@example.test",
  displayName: "Till",
  role: "company_admin",
  companyId: COMPANY,
  mustChangePassword: false,
  actingCompanyStatus: null
};

// A harness whose session resolver answers, for the five authenticated routes.
// `calls` records the ORDER of repository writes, which is the only way to assert
// "delete before bump" without a clock.
function signedIn(overrides = {}) {
  const calls = [];
  const base = harness();
  const deps = {
    ...base.deps,
    sessions: {
      ...base.deps.sessions,
      resolveSession: async () => ({ ...SESSION_ROW, ...(overrides.session || {}) }),
      renewSession: async () => null,
      deleteSession: async (id) => { calls.push(["deleteSession", id]); return 1; },
      deleteAllSessionsForUser: async (id) => { calls.push(["deleteAllSessionsForUser", id]); return 3; }
    },
    users: {
      ...base.deps.users,
      findById: async () => activeUser(),
      writePasswordHash: async (id, hash, options) => { calls.push(["writePasswordHash", id, options]); },
      bumpSessionsValidFrom: async (id) => { calls.push(["bumpSessionsValidFrom", id]); }
    },
    ...(overrides.deps || {})
  };
  return { deps, calls, audits: base.audits };
}

const COOKIE = { cookie: `${SESSION_COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAA` };
const POST_HEADERS = { Origin: ORIGIN, "Content-Type": "application/json", ...COOKIE };

test("GET me returns the same document login returned", async () => {
  const { deps } = signedIn();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/api/admin/auth/me`, { headers: COOKIE });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.id, USER);
    assert.equal(body.user.mustChangePassword, false);
    assert.equal(body.scope.kind, "tenant");
    assert.deepEqual(body.scope.shopIds, []);
    assert.equal(body.session.expiresAt, "2026-08-05T08:00:00.000Z");
  });
});

test("me is NOT exempt from the password-change gate; logout is", async () => {
  // Spec 6.2 states both, and gives the reason for the asymmetry: me's 403 is
  // self-describing and login already returned mustChangePassword, while a user who
  // cannot sign out has no way to abandon a session they must not use.
  const { deps } = signedIn({ session: { mustChangePassword: true } });
  await withServer(deps, async (base) => {
    const me = await fetch(`${base}/api/admin/auth/me`, { headers: COOKIE });
    assert.equal(me.status, 403);
    assert.equal((await me.json()).error.code, "password_change_required");

    const out = await fetch(`${base}/api/admin/auth/logout`, { method: "POST", headers: POST_HEADERS });
    assert.equal(out.status, 200);
  });
});

test("logout deletes the presenting session and clears the cookie", async () => {
  const { deps, calls, audits } = signedIn();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/api/admin/auth/logout`, { method: "POST", headers: POST_HEADERS });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    // The SAME attributes as the setting cookie: a browser matches the cookie to
    // delete on name + path + domain, so a clearing header with a different Path
    // deletes nothing and the stale cookie comes back on the next request.
    assert.match(response.headers.get("set-cookie"), /^__Host-core_session=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/);
  });
  assert.deepEqual(calls, [["deleteSession", SESSION_ID]]);
  assert.equal(audits[0].action, "auth.logout");
  assert.equal(audits[0].actorUserId, USER);
});

test("logout-all deletes THEN bumps, and reports the count it deleted", async () => {
  // The ordering IS the correctness argument. Bump-then-delete leaves a session
  // created in the gap with created_at > sessions_valid_from, so the resolver
  // accepts it and it survives the one button that exists to kill it.
  const { deps, calls, audits } = signedIn();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/api/admin/auth/logout-all`, { method: "POST", headers: POST_HEADERS });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, revokedSessionCount: 3 });
    assert.match(response.headers.get("set-cookie"), /Max-Age=0$/);
  });
  assert.deepEqual(calls, [
    ["deleteAllSessionsForUser", USER],
    ["bumpSessionsValidFrom", USER]
  ]);
  assert.deepEqual(audits[0].detail, { revokedSessionCount: 3 });
});

test("logout-all IS gated by the password-change requirement", async () => {
  // Only logout and password are exempt -- spec 8.5 rule 3 fixes the set at two, and
  // route-auth.test.js asserts it by set equality. Adding a third here would be a
  // design change, not a convenience.
  const { deps } = signedIn({ session: { mustChangePassword: true } });
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/api/admin/auth/logout-all`, { method: "POST", headers: POST_HEADERS });
    assert.equal(response.status, 403);
  });
});

test("no cookie is 401 and sets no clearing header; a bad cookie is 401 and does", async () => {
  // Spec 6.3.4: the clearing Set-Cookie goes out "only when one was presented".
  // Unconditional, it would let any unauthenticated request instruct a browser to
  // drop a cookie it never sent.
  const { deps } = signedIn({ deps: { sessions: { resolveSession: async () => null, renewSession: async () => null } } });
  await withServer(deps, async (base) => {
    const none = await fetch(`${base}/api/admin/auth/me`);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("set-cookie"), null);

    const stale = await fetch(`${base}/api/admin/auth/me`, { headers: COOKIE });
    assert.equal(stale.status, 401);
    assert.match(stale.headers.get("set-cookie"), /Max-Age=0$/);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
node --test apps/core-api/test/auth-routes.test.js apps/core-api/test/auth-users.test.js
```

Expected: the route tests 404 (`not_found`) because none of the three paths is
registered; the repository test fails with
`users.bumpSessionsValidFrom is not a function`, thrown from the line between the two
reads. If it fails anywhere earlier than that line, the test is wrong and not the
repository — the two `db.unscoped` reads and `IDS` are all Task 7's, and a
`ReferenceError` there means a helper was invented rather than reused.

- [x] **Step 3: Implement**

**(a)** In `apps/core-api/repositories/auth/users.js`, beside `writePasswordHash`:

```js
// The THIRD writer of sessions_valid_from. Spec 5.2 names all three -- password
// change, suspension, and "sign out everywhere" -- and writePasswordHash owns the
// first. This one exists because a DELETE over user_sessions is not a revocation:
// a session created between the DELETE and the response survives it, and the whole
// point of this route is that nothing survives it.
//
// failed_login_count and locked_until are DELIBERATELY NOT TOUCHED. They belong to
// the unauthenticated login credential (spec 5.8(a)); signing out everywhere is not
// a failed login and must not push anybody toward a lockout.
const BUMP_SESSIONS_VALID_FROM = `
  UPDATE users
     SET sessions_valid_from = now(),
         updated_at = now()
   WHERE id = $1
`;

async function bumpSessionsValidFrom(userId) {
  // `connection`, never `client` -- see the note at the top of this file.
  await withUnscopedConnection(async (connection) => {
    await connection.query(BUMP_SESSIONS_VALID_FROM, [userId]);
  });
}
```

and add `bumpSessionsValidFrom` to `module.exports`.

**(b)** In `apps/core-api/http/routes/auth.js`, add the two requires that were not
needed by login:

```js
const { buildClearingCookie } = require("../cookies");
```

(merge it into the existing `require("../cookies")` destructure rather than adding a
second require of the same module.)

Add the session→user adapter beside `meDocument`:

```js
// resolveSession returns the joined user columns under different names than the
// login lookup does (userId, not id), and every route except login builds its
// me-document from a resolved session. One adapter, so the shape cannot drift
// between four routes.
//
// user.companyId is the user's OWN company and is null for every platform_admin --
// users_platform_admin_has_no_company makes that a constraint. The ACTING company
// lives in scope.companyId, which is exactly the distinction spec 6.2 draws when it
// says scope.kind is what the UI branches on.
function userFromSession(session) {
  return {
    id: session.userId,
    email: session.email,
    displayName: session.displayName,
    role: session.role,
    companyId: session.companyId,
    mustChangePassword: session.mustChangePassword
  };
}
```

Then the three routes:

```js
// ---------------------------------------------------------------------------
// GET /api/admin/auth/me
// ---------------------------------------------------------------------------

// DELIBERATELY NOT exempt from the password-change gate (spec 6.2): the 403 is
// self-describing, and login already told the caller mustChangePassword.
route(
  "GET",
  "/api/admin/auth/me",
  // BOTH aliases -- Part 5 departure (d). `anyUser` admits a SCOPED platform admin
  // and deliberately excludes an unscoped one, and the account the bootstrap CLI
  // creates is unscoped from the moment it signs in. This route binds no company, so
  // admitting it here widens no tenant query.
  { auth: "user", roles: ["platform", "anyUser"], sample: {} },
  async (req, res) => {
    sendJson(
      res,
      200,
      meDocument({
        user: userFromSession(req.core.session),
        scope: req.core.scope,
        session: req.core.session
      })
    );
  }
);

// ---------------------------------------------------------------------------
// POST /api/admin/auth/logout
// ---------------------------------------------------------------------------

route(
  "POST",
  "/api/admin/auth/logout",
  {
    auth: "user",
    // Part 5 departure (d). Signing out is the one thing every actor must be able to
    // do, and an unscoped platform admin is an actor.
    roles: ["platform", "anyUser"],
    body: null,
    audit: "auth.logout",
    // One of exactly two exemptions (spec 8.5 rule 3). A user who must change their
    // password and cannot sign out is stuck holding a session they must not use.
    exemptFromPasswordChange: true,
    sample: {}
  },
  async (req, res) => {
    const deps = req.core.deps;
    const session = req.core.session;

    await deps.sessions.deleteSession(session.sessionId);
    await deps.appendAuditEvent({
      actorKind: "user",
      actorUserId: session.userId,
      companyId: session.companyId,
      action: "auth.logout",
      outcome: "success",
      targetKind: "user",
      targetId: session.userId,
      sourceIp: req.core.clientIp
    });

    // Step 14 runs after this handler and will try to renew a session that no longer
    // exists. That is a zero-row UPDATE, not an error, and renewSession is written to
    // treat zero rows as the ordinary case. Do not "fix" it by clearing
    // req.core.session -- the pipeline reads it to decide whether to renew at all,
    // and a handler reaching back into the pipeline's state is worse than one
    // harmless statement.
    sendJson(res, 200, { ok: true }, { "Set-Cookie": buildClearingCookie() });
  }
);

// ---------------------------------------------------------------------------
// POST /api/admin/auth/logout-all
// ---------------------------------------------------------------------------

route(
  "POST",
  "/api/admin/auth/logout-all",
  // Part 5 departure (d).
  { auth: "user", roles: ["platform", "anyUser"], body: null, audit: "auth.logout_all", sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const session = req.core.session;

    // DELETE FIRST, THEN BUMP, and the order is the correctness argument rather than
    // a style choice. Bump-then-delete leaves a session created in the gap with
    // created_at > sessions_valid_from, so the resolver accepts it and the DELETE has
    // already run -- the stolen session survives the one button that exists to kill
    // it. This way round, anything created in the gap has created_at <
    // sessions_valid_from and is rejected, so the pair fails closed with no
    // transaction. The residual is that the COUNT under-reports by whatever landed in
    // the gap; it is an informational number, not a guarantee.
    const revokedSessionCount = await deps.sessions.deleteAllSessionsForUser(session.userId);
    await deps.users.bumpSessionsValidFrom(session.userId);

    await deps.appendAuditEvent({
      actorKind: "user",
      actorUserId: session.userId,
      companyId: session.companyId,
      action: "auth.logout_all",
      outcome: "success",
      targetKind: "user",
      targetId: session.userId,
      sourceIp: req.core.clientIp,
      detail: { revokedSessionCount }
    });

    sendJson(res, 200, { ok: true, revokedSessionCount }, { "Set-Cookie": buildClearingCookie() });
  }
);
```

Extend the export at the bottom of the file:

```js
module.exports = { meDocument, userFromSession, evaluateLogin, payTimeBudget };
```

**(c)** Widen the origin-gating census in `apps/core-api/test/route-auth.test.js`.
Every non-GET `auth:'user'` route is origin-gated by `requiresOriginCheck`, so both
new POSTs join the set the moment they register — the census is a `deepEqual` and
will say so:

```js
  assert.deepEqual(gated, new Set([
    "POST /api/admin/auth/login",
    "POST /api/admin/auth/logout",
    "POST /api/admin/auth/logout-all"
  ]));
```

It grows again in Tasks 14 and 15. That is the census doing its job: a new
browser-facing POST cannot land without a line in it.

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/auth-routes.test.js apps/core-api/test/auth-users.test.js \
            apps/core-api/test/route-auth.test.js apps/core-api/test/pipeline.test.js
```

Expected: all pass. **`route-auth.test.js` is the one that matters** — its rule 3
arms itself the moment `POST /api/admin/auth/logout` registers, and it is what
catches a missing `exemptFromPasswordChange`.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/http/routes/auth.js apps/core-api/repositories/auth/users.js \
        apps/core-api/test/auth-routes.test.js apps/core-api/test/auth-users.test.js \
        apps/core-api/test/route-auth.test.js
git commit -m "feat(core-api): me, logout, and a sign-out-everywhere that deletes before it bumps"
```

---

### Task 14: `POST /api/admin/auth/password`

The route that clears `must_change_password`, and the one place §5.8(a)'s correction
becomes code: it must **not** write `users.failed_login_count` or
`users.locked_until`.

**Files:**

- Modify: `apps/core-api/http/routes/auth.js`
- Modify: `apps/core-api/test/auth-routes.test.js`
- Modify: `apps/core-api/test/route-auth.test.js`

**The mirrors.**

```bash
grep -n "password-change-abuse" apps/core-api            # roster, pipeline, this route
grep -n "SETTLED_EXEMPT" apps/core-api/test/route-auth.test.js
grep -n "origin-gated" apps/core-api/test/route-auth.test.js
```

**The abuse counter, with the arithmetic written down.** `password-change-abuse` is
the roster's only `consume: "failure"` limiter, so `consumeLimit` in the pipeline
returns early for it and **the handler owns it**. §5.7 words the ceiling as *"5
consecutive `current_password_invalid`, then the presenting session is deleted"*,
which admits an off-by-one; this plan fixes it as:

| `verdict.count` | Response | Session |
| --- | --- | --- |
| `< PASSWORD_ABUSE_THRESHOLD` | `403 current_password_invalid` | untouched |
| `>= PASSWORD_ABUSE_THRESHOLD` | `429 rate_limited` + `Retry-After` + clearing cookie | deleted, `user.password_change_abuse` written |

A correct current password calls `rateLimiter.reset(…)` — §5.8(a): *"reset by a
correct password"* — so the count is **consecutive**, not cumulative.

This is also what makes §6.2's error list for this route true as written. It lists
both `403 current_password_invalid` and `429 rate_limited (+Retry-After)`, and the
429 is reachable exactly as the table above says: sign in again after the breach and
try a sixth wrong current password inside the same hour.

- [ ] **Step 1: Write the failing tests**

Add to `apps/core-api/test/auth-routes.test.js`:

```js
function changePassword(base, body) {
  return fetch(`${base}/api/admin/auth/password`, {
    method: "POST",
    headers: POST_HEADERS,
    body: JSON.stringify(body)
  });
}

test("a correct current password rewrites the hash, kills every session and mints one", async () => {
  const { deps, calls } = signedIn();
  const created = [];
  deps.sessions = {
    ...deps.sessions,
    createSession: async (input) => {
      created.push(input);
      return {
        id: "aaaaaaaa-0008-4000-8000-000000000002",
        expiresAt: new Date("2026-08-05T09:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-08-12T00:00:00.000Z")
      };
    }
  };

  await withServer(deps, async (base) => {
    const response = await changePassword(base, { currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /^__Host-core_session=[A-Za-z0-9_-]{22}; Path=\/; Secure/);
    const body = await response.json();
    assert.equal(body.user.mustChangePassword, false);
    assert.equal(body.session.expiresAt, "2026-08-05T09:00:00.000Z");
  });

  // WRITE, THEN DELETE, THEN CREATE. writePasswordHash bumps sessions_valid_from, so
  // creating before deleting would delete the session just minted, and creating
  // before writing would mint one the bump then invalidates.
  assert.deepEqual(calls, [
    ["writePasswordHash", USER, { mustChangePassword: false }],
    ["deleteAllSessionsForUser", USER]
  ]);
  assert.equal(created.length, 1);
});

test("a wrong current password is 403, and never touches the login credential", async () => {
  // Spec 5.8(a)/6.3.7(a): writing users.locked_until here lets a STOLEN SESSION drive
  // the legitimate owner's LOGIN lockout -- three 403s, then one request every
  // fourteen minutes holds the fifteen-minute cap forever while the victim reads
  // their own uniform 401 as a typo.
  const { deps, calls } = signedIn();
  await withServer(deps, async (base) => {
    const response = await changePassword(base, { currentPassword: "not-the-password", newPassword: "a-brand-new-passphrase" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "current_password_invalid");
    assert.equal(response.headers.get("set-cookie"), null);
  });
  assert.deepEqual(calls, [], "a failed attempt wrote something");
});

test("the Nth consecutive failure destroys the presenting session, not the account", async () => {
  const { deps, calls, audits } = signedIn();
  deps.passwordAbuseThreshold = 3;

  await withServer(deps, async (base) => {
    for (let n = 0; n < 2; n += 1) {
      const response = await changePassword(base, { currentPassword: "wrong", newPassword: "a-brand-new-passphrase" });
      assert.equal(response.status, 403, `attempt ${n + 1}`);
    }
    const breach = await changePassword(base, { currentPassword: "wrong", newPassword: "a-brand-new-passphrase" });
    assert.equal(breach.status, 429);
    assert.equal((await breach.json()).error.code, "rate_limited");
    assert.ok(Number(breach.headers.get("retry-after")) >= 1);
    assert.match(breach.headers.get("set-cookie"), /Max-Age=0$/);
  });

  assert.deepEqual(calls, [["deleteSession", SESSION_ID]]);
  const abuse = audits.find((event) => event.action === "user.password_change_abuse");
  assert.equal(abuse.outcome, "failure");
  assert.equal(abuse.detail.consecutiveFailures, 3);
});

test("a correct password resets the consecutive count", async () => {
  // Spec 5.8(a): the ceiling counts CONSECUTIVE failures. Without the reset, a user
  // who mistypes twice a month is eventually signed out for succeeding.
  const { deps } = signedIn();
  deps.passwordAbuseThreshold = 2;
  deps.sessions = { ...deps.sessions, createSession: async () => ({ id: SESSION_ID, expiresAt: new Date(), absoluteExpiresAt: new Date() }) };

  await withServer(deps, async (base) => {
    assert.equal((await changePassword(base, { currentPassword: "wrong", newPassword: "a-brand-new-passphrase" })).status, 403);
    assert.equal((await changePassword(base, { currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" })).status, 200);
    assert.equal((await changePassword(base, { currentPassword: "wrong", newPassword: "a-brand-new-passphrase" })).status, 403);
  });
});

test("a policy violation on the new password is 422 on that field", async () => {
  const { deps } = signedIn();
  await withServer(deps, async (base) => {
    const response = await changePassword(base, { currentPassword: PASSWORD, newPassword: "short" });
    assert.equal(response.status, 422);
    assert.deepEqual((await response.json()).error.errors, [{ field: "newPassword", code: "too_short" }]);
  });
});

test("a user who must change their password can reach this route and only this route", async () => {
  const { deps } = signedIn({ session: { mustChangePassword: true } });
  deps.sessions = { ...deps.sessions, createSession: async () => ({ id: SESSION_ID, expiresAt: new Date(), absoluteExpiresAt: new Date() }) };
  await withServer(deps, async (base) => {
    // Spec 6.2: currentPassword is required in ALL cases, including the forced-change
    // flow -- the server-minted initialPassword IS the current password.
    const response = await changePassword(base, { currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" });
    assert.equal(response.status, 200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test apps/core-api/test/auth-routes.test.js
```

Expected: every new test 404s — the route is not registered.

- [ ] **Step 3: Implement**

In `apps/core-api/http/routes/auth.js`, extend the requires:

```js
const { sendJson, sendError } = require("../respond");
const { hashPassword, verifyPassword, PasswordPolicyError } = require("../../lib/password");
```

(merge into the existing destructures; do not add second requires of the same
modules).

Then:

```js
// ---------------------------------------------------------------------------
// POST /api/admin/auth/password
// ---------------------------------------------------------------------------

// Responds in place rather than throwing, for the same reason the pipeline does:
// both branches may need to set a header, and ApiError cannot carry one.
async function refuseCurrentPassword(req, res, deps, session) {
  // The roster's only consume:"failure" limiter, so the pipeline skipped it -- a
  // per-request decrement would lock a user out of their own password-change route
  // for SUCCEEDING at it.
  const verdict = deps.rateLimiter.consume(
    "password-change-abuse",
    session.userId,
    deps.passwordAbuseThreshold
  );

  if (verdict.count < deps.passwordAbuseThreshold) {
    // 403, not 401, and spec 6.3.7(a) is explicit about why: the session credential
    // IS valid, and a client's global "401 -> drop the session and redirect" handler
    // would otherwise let a stolen session grief the real user out of theirs.
    sendError(res, { status: 403, code: "current_password_invalid" }, req.core.requestId);
    return;
  }

  // Punish the credential ACTUALLY being abused. Writing users.locked_until instead
  // -- the obvious move -- hands a stolen session a permanent denial of service
  // against the legitimate owner's login, which is the whole of spec 5.8(a).
  await deps.sessions.deleteSession(session.sessionId);
  await deps.appendAuditEvent({
    actorKind: "user",
    actorUserId: session.userId,
    companyId: session.companyId,
    action: "user.password_change_abuse",
    outcome: "failure",
    targetKind: "user",
    targetId: session.userId,
    sourceIp: req.core.clientIp,
    detail: { consecutiveFailures: verdict.count }
  });

  const headers = { "Set-Cookie": buildClearingCookie() };
  // Retry-After IS sent here, unlike on login and pair. This bucket is keyed on a
  // principal the caller has already authenticated as, so the header confirms
  // nothing they did not already know -- which is the exact test spec 5.7 applies.
  if (verdict.retryAfterSeconds !== null) headers["Retry-After"] = String(verdict.retryAfterSeconds);
  sendError(res, { status: 429, code: "rate_limited" }, req.core.requestId, headers);
}

route(
  "POST",
  "/api/admin/auth/password",
  {
    auth: "user",
    // Part 5 departure (d), and this is the route where it bites hardest: the
    // bootstrap admin's FIRST action is usually to change the password the CLI set,
    // and under a plain `anyUser` they would get 403 for it.
    roles: ["platform", "anyUser"],
    body: { currentPassword: "string", newPassword: "string" },
    audit: "auth.password_changed",
    // The second of exactly two exemptions (spec 8.5 rule 3). Without it, the only
    // route that can clear must_change_password is gated on must_change_password.
    exemptFromPasswordChange: true,
    limit: { key: "user", name: "password-change-abuse" },
    sample: {
      body: { currentPassword: "not-a-real-password", newPassword: "not-a-real-password-either" }
    }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const session = req.core.session;
    const body = await readJsonBody(req);

    const errors = [];
    if (typeof body.currentPassword !== "string" || body.currentPassword === "") {
      errors.push({ field: "currentPassword", code: "required" });
    }
    if (typeof body.newPassword !== "string" || body.newPassword === "") {
      errors.push({ field: "newPassword", code: "required" });
    }
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    // ONE slot for BOTH scrypt calls on this path -- the verify and the hash. Taking
    // two would let a caller hold half the service's CPU budget with one request.
    await deps.scryptSemaphore.acquire();
    try {
      const user = await deps.users.findById(session.userId);
      // The resolver already proved the session live and the user active, so null
      // here means the row went away mid-request. 401, never a 500.
      if (user === null) throw new ApiError(401, "unauthenticated");

      if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
        await refuseCurrentPassword(req, res, deps, session);
        return;
      }
      // CONSECUTIVE, not cumulative (spec 5.8(a)).
      deps.rateLimiter.reset("password-change-abuse", session.userId);

      let passwordHash;
      try {
        passwordHash = await hashPassword(body.newPassword);
      } catch (error) {
        // PasswordPolicyError carries `code` but deliberately NOT `status`: the same
        // policy failure is a 400 on a create route and a 422 here, so the route
        // decides. Anything else is a real fault and belongs in the 500 tail.
        if (!(error instanceof PasswordPolicyError)) throw error;
        throw new ApiError(422, "validation_failed", [{ field: "newPassword", code: error.code }]);
      }

      // WRITE, DELETE, CREATE -- in that order, and none of the three is
      // interchangeable. writePasswordHash bumps sessions_valid_from, so a session
      // minted before it would be invalidated by it; and the DELETE has to run before
      // the mint or it takes out the session this response is about to hand back.
      //
      // writePasswordHash does NOT touch failed_login_count or locked_until, by
      // construction -- see its own comment in repositories/auth/users.js.
      await deps.users.writePasswordHash(session.userId, passwordHash, { mustChangePassword: false });
      await deps.sessions.deleteAllSessionsForUser(session.userId);

      const token = mintToken();
      const fresh = await deps.sessions.createSession({
        userId: session.userId,
        tokenHash: hashToken(token),
        idleSeconds: deps.sessionIdleSeconds,
        absoluteSeconds: deps.sessionAbsoluteSeconds
      });

      // actingCompanyId is null because acting_company_id is a per-SESSION column and
      // this is a new row. A platform admin who changes their password re-selects
      // their company, which is the same thing that happens after any sign-in.
      const scope = await deps.scopes.materialiseScope({
        userId: session.userId,
        sessionId: fresh.id,
        role: session.role,
        companyId: session.companyId,
        actingCompanyId: null
      });

      await deps.appendAuditEvent({
        actorKind: "user",
        actorUserId: session.userId,
        companyId: session.companyId,
        action: "auth.password_changed",
        outcome: "success",
        targetKind: "user",
        targetId: session.userId,
        sourceIp: req.core.clientIp
      });

      sendJson(
        res,
        200,
        meDocument({
          // They just chose it themselves, so the gate is cleared -- and the document
          // must say so or the client re-prompts forever.
          user: { ...userFromSession(session), mustChangePassword: false },
          scope,
          session: fresh
        }),
        { "Set-Cookie": buildSessionCookie(token, deps.sessionIdleSeconds) }
      );
    } finally {
      deps.scryptSemaphore.release();
    }
  }
);
```

Then widen the origin-gating census in `apps/core-api/test/route-auth.test.js` again:

```js
  assert.deepEqual(gated, new Set([
    "POST /api/admin/auth/login",
    "POST /api/admin/auth/logout",
    "POST /api/admin/auth/logout-all",
    "POST /api/admin/auth/password"
  ]));
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/auth-routes.test.js apps/core-api/test/route-auth.test.js \
            apps/core-api/test/rate-limit.test.js apps/core-api/test/source-structure.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/http/routes/auth.js apps/core-api/test/auth-routes.test.js \
        apps/core-api/test/route-auth.test.js
git commit -m "feat(core-api): change your own password, without handing a stolen session a login lockout"
```

---

### Task 15: the role gate, and `POST /api/admin/scope`

Two things in one commit because neither is testable without the other. The gate has
nothing to refuse until a route declares roles narrower than `anyUser`, and the route
cannot be written safely while `options.roles` is decorative.

**Read departures (b) and (c) at the top of Part 5 before starting.**

**Files:**

- Create: `apps/core-api/lib/authorization.js`
- Create: `apps/core-api/test/authorization.test.js`
- Modify: `apps/core-api/http/router.js`
- Modify: `apps/core-api/http/routes/auth.js`
- Modify: `apps/core-api/test/pipeline.test.js`
- Modify: `apps/core-api/test/auth-routes.test.js`
- Modify: `apps/core-api/test/route-auth.test.js`

**The mirrors.**

```bash
grep -rn "ROLE_ALIASES" apps/core-api                      # router.js's list of names
grep -rn "origin-gated" apps/core-api/test/route-auth.test.js
grep -n "scope_required\|scope_selected" apps/core-api docs/superpowers/specs
```

`router.js` already exports `ROLE_ALIASES` — the four **names**. `lib/authorization.js`
owns the four **memberships**. They are different facts and both are needed: `route()`
rejects an unknown alias at registration, and the gate decides admission at request
time. Task 15 adds an assertion that the two key sets are equal, because a fifth alias
added to one and not the other is a route that boots and admits nobody.

**Why `POST /api/admin/scope` declares two aliases and then narrows in the handler.**
§6.2 gives its roles as *"role === 'platform_admin' (scoped or unscoped)"*, and §5.4's
four aliases cannot say that:

| Alias | Unscoped platform admin | Scoped platform admin | company_admin |
| --- | --- | --- | --- |
| `platform` | ✅ | ❌ | ❌ |
| `companyAdmin` | ❌ | ✅ | ✅ |

So `["platform", "companyAdmin"]` is the narrowest static declaration that admits both
platform-admin states — and it also admits a real `company_admin`, who must be
refused. A fifth alias would be a design change: `ROLE_ALIASES` is frozen at four,
§5.4's table is pinned, and §8.5 is exactly ten rules.

The precedent for closing that last gap in the handler is already in the spec. §6.2
says of `PATCH /api/admin/users/:userId` that a body carrying `role` or `shopIds`
*"additionally requires companyAdmin — that is a **body-dependent** check performed at
pipeline step 10 by `lib/authorization.js` raising 403 forbidden, not a static route
declaration."* This is the same shape with a simpler input.

**The check reads `session.role`, never `scope.role`.** A scoped platform admin
materialises `scope.role = 'platform_admin'` and a company admin materialises
`scope.role = 'company_admin'` — so reading the scope would work by accident today and
break the moment §5.4's *"the rank lattice does the work"* is extended.
`session.role` is the `users.role` column, which is the fact being tested.

- [ ] **Step 1: Write the failing tests**

Create `apps/core-api/test/authorization.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { TENANT_ALIAS_MEMBERS, permits } = require("../lib/authorization");
const { ROLE_ALIASES } = require("../http/router");

const platform = { kind: "platform", userId: "u", sessionId: "s" };
const tenant = (role) => ({ kind: "tenant", role, userId: "u", sessionId: "s", companyId: "c", shopIds: [] });

test("the alias NAMES and the alias MEMBERSHIPS are the same four", () => {
  // Two files hold two halves of one fact: router.js rejects an unknown alias at
  // registration, lib/authorization.js decides admission. A fifth added to one and
  // not the other is a route that boots and admits nobody.
  assert.deepEqual(Object.keys(TENANT_ALIAS_MEMBERS).sort(), [...ROLE_ALIASES].sort());
});

test("an UNSCOPED platform admin is admitted by `platform` and by nothing else", () => {
  // Their scope carries no companyId, so a tenant route reached by them would have no
  // company to bind. 6.3.2 answers that with 409 scope_required -- a state to change,
  // not a permission to grant -- which only works if the gate lets them nowhere near it.
  assert.equal(permits(platform, ["platform"]), true);
  assert.equal(permits(platform, ["companyAdmin"]), false);
  assert.equal(permits(platform, ["manager"]), false);
  assert.equal(permits(platform, ["anyUser"]), false);
});

test("a SCOPED platform admin is admitted everywhere EXCEPT `platform`", () => {
  // Rank 3, above company_admin, so the lattice does the work (spec 5.4) -- and NOT by
  // `platform`, whose whole meaning is "has not chosen a company". This pair is what
  // makes the documented tenant bootstrap executable: select scope, then create the
  // company's first company_admin through the ordinary user route.
  const scoped = tenant("platform_admin");
  assert.equal(permits(scoped, ["platform"]), false);
  assert.equal(permits(scoped, ["companyAdmin"]), true);
  assert.equal(permits(scoped, ["manager"]), true);
  assert.equal(permits(scoped, ["anyUser"]), true);
});

test("the other three roles match spec 5.4's table exactly", () => {
  assert.deepEqual(
    ["company_admin", "shop_manager", "staff"].map((role) =>
      ["platform", "companyAdmin", "manager", "anyUser"].filter((alias) => permits(tenant(role), [alias]))
    ),
    [
      ["companyAdmin", "manager", "anyUser"],
      ["manager", "anyUser"],
      ["anyUser"]
    ]
  );
});

test("a declaration that is empty or names an unknown alias throws rather than admitting", () => {
  // Fail loud, never fail open. A gate that returned false for an unknown alias would
  // turn a typo into a route nobody can reach, which is diagnosed as a permissions bug
  // for a week; a gate that returned true would be the other thing.
  assert.throws(() => permits(tenant("staff"), []), /non-empty roles array/);
  assert.throws(() => permits(tenant("staff"), ["superuser"]), /unknown role alias/);
});
```

Add to `apps/core-api/test/pipeline.test.js`, and register one more scratch route
beside the others at the top of that file:

```js
route(
  "POST",
  "/__pipe/platform-only",
  { auth: "user", roles: ["platform"], body: null, audit: "auth.logout", sample: {} },
  (req, res) => sendJson(res, 200, { ok: true })
);
```

```js
test("step 10's first half: a role the route does not admit is 403 forbidden", async () => {
  // The harness resolves a company_admin, whom `platform` does not admit.
  const { deps } = harness();
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/platform-only`, { method: "POST", headers: jsonPost });
    assert.equal(response.status, 403);
    // The GENERIC code. Spec 6.3.2: specific 403 codes exist only where the client
    // must take a different UI action, and "you are the wrong role" is not one.
    assert.equal((await response.json()).error.code, "forbidden");
  });
});

test("the role gate runs AFTER the credential and the password gate, not before", async () => {
  // Ordering, asserted by the status a request with two problems gets. An
  // unauthenticated caller must learn 401 and not "the role you do not have is
  // wrong", which would be a route-shape oracle available without a credential.
  const { deps } = harness({ sessions: { resolveSession: async () => null, renewSession: async () => null } });
  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/__pipe/platform-only`, { method: "POST", headers: jsonPost });
    assert.equal(response.status, 401);
  });
});
```

Add to `apps/core-api/test/auth-routes.test.js`:

```js
function selectScope(base, body) {
  return fetch(`${base}/api/admin/scope`, { method: "POST", headers: POST_HEADERS, body: JSON.stringify(body) });
}

function platformAdmin(overrides = {}) {
  const { deps, calls, audits } = signedIn({
    session: { role: "platform_admin", companyId: null, actingCompanyId: null }
  });
  deps.sessions = {
    ...deps.sessions,
    findCompanyForScopeSelection: async () => ({ id: COMPANY, status: "active" }),
    setActingCompany: async (sessionId, companyId) => { calls.push(["setActingCompany", sessionId, companyId]); return 1; },
    ...(overrides.sessions || {})
  };
  deps.scopes = {
    materialiseScope: async (input) =>
      input.actingCompanyId === null
        ? { kind: "platform", userId: input.userId, sessionId: input.sessionId }
        : {
            kind: "tenant", userId: input.userId, sessionId: input.sessionId,
            companyId: input.actingCompanyId, role: "platform_admin",
            shopIds: [], administeredShopIds: [], auditCrossTenant: true
          }
  };
  return { deps, calls, audits };
}

test("selecting a company writes acting_company_id and returns the new scope", async () => {
  const { deps, calls, audits } = platformAdmin();
  await withServer(deps, async (base) => {
    const response = await selectScope(base, { companyId: COMPANY });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.scope.kind, "tenant");
    assert.equal(body.scope.companyId, COMPANY);
    // The user's OWN company stays null -- users_platform_admin_has_no_company makes
    // that a constraint, and the acting company is a session fact, not a user fact.
    assert.equal(body.user.companyId, null);
    assert.deepEqual(body.scope.administeredShopIds, []);
  });
  assert.deepEqual(calls, [["setActingCompany", SESSION_ID, COMPANY]]);
  assert.equal(audits[0].action, "scope.selected");
  assert.equal(audits[0].companyId, COMPANY);
});

test("clearing returns the platform scope and writes scope.cleared with no target", async () => {
  const { deps, calls, audits } = platformAdmin();
  await withServer(deps, async (base) => {
    const response = await selectScope(base, { companyId: null });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.scope.kind, "platform");
    assert.equal(body.scope.companyId, null);
    // ALWAYS an array. A platform scope reaches no shop, and [] is the honest
    // rendering of that -- never a missing key the client has to guess about.
    assert.deepEqual(body.scope.shopIds, []);
    assert.equal("administeredShopIds" in body.scope, false);
  });
  assert.deepEqual(calls, [["setActingCompany", SESSION_ID, null]]);
  assert.equal(audits[0].action, "scope.cleared");
  // audit_events_target_pair is (target_kind IS NULL) = (target_id IS NULL), so a
  // uniform-looking target_kind:'company' with a null id is a CHECK violation.
  assert.equal(audits[0].targetKind, undefined);
  assert.equal(audits[0].targetId, undefined);
});

test("a missing companyId key is 422; an explicit null is not", async () => {
  // Spec 6.2 makes the key required and explicitly nullable, so {} and
  // {"companyId": null} are two different requests and must not collapse into one.
  const { deps } = platformAdmin();
  await withServer(deps, async (base) => {
    const missing = await selectScope(base, {});
    assert.equal(missing.status, 422);
    assert.deepEqual((await missing.json()).error.errors, [{ field: "companyId", code: "required" }]);

    assert.equal((await selectScope(base, { companyId: null })).status, 200);
  });
});

test("an unknown company is 404 and a suspended one is 409, and both are audited", async () => {
  for (const [company, status, code] of [
    [null, 404, "not_found"],
    [{ id: COMPANY, status: "suspended" }, 409, "company_suspended"]
  ]) {
    const { deps, audits } = platformAdmin({ sessions: { findCompanyForScopeSelection: async () => company } });
    await withServer(deps, async (base) => {
      const response = await selectScope(base, { companyId: COMPANY });
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
    });
    assert.equal(audits[0].outcome, "failure");
    // The probed id goes in target_id, which is text with NO foreign key. The
    // company_id COLUMN references companies, so an id that matches no row would
    // raise 23503 inside the failure path and turn a 404 into a 500.
    assert.equal(audits[0].targetId, COMPANY);
    assert.equal(audits[0].companyId, undefined);
  }
});

test("a real company_admin is refused even though `companyAdmin` admits them", async () => {
  // The gap the four aliases cannot close. Without the handler's narrowing, every
  // company admin on the platform could set their own session's acting_company_id.
  const { deps } = signedIn();
  deps.sessions = { ...deps.sessions, setActingCompany: async () => 1, findCompanyForScopeSelection: async () => ({ id: COMPANY, status: "active" }) };
  await withServer(deps, async (base) => {
    const response = await selectScope(base, { companyId: COMPANY });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "forbidden");
  });
});

test("THE BOOTSTRAP ADMIN CAN STILL USE THE FOUR IDENTITY ROUTES", async () => {
  // Part 5 departure (d), and the regression that no other test in this file can see.
  // signedIn() resolves a company_admin and platformAdmin() is otherwise pointed only
  // at /api/admin/scope, so under a plain roles:["anyUser"] the whole suite stays
  // green while the ONLY account this plan creates gets 403 for reading `me`, for
  // signing out, and for changing the password the CLI just set.
  //
  // An unscoped platform admin is what login always produces: it materialises
  // actingCompanyId: null, and materialiseScope answers that with { kind: "platform" }.
  const { deps } = platformAdmin();
  deps.users = {
    ...deps.users,
    findById: async () => activeUser({ role: "platform_admin", companyId: null })
  };
  deps.sessions = {
    ...deps.sessions,
    createSession: async () => ({
      id: SESSION_ID,
      expiresAt: new Date("2026-08-05T08:00:00.000Z"),
      absoluteExpiresAt: new Date("2026-08-12T00:00:00.000Z")
    })
  };

  await withServer(deps, async (base) => {
    const me = await fetch(`${base}/api/admin/auth/me`, { headers: COOKIE });
    assert.equal(me.status, 200, "an unscoped platform admin cannot read me");
    assert.equal((await me.json()).scope.kind, "platform");

    const changed = await fetch(`${base}/api/admin/auth/password`, {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" })
    });
    assert.equal(changed.status, 200, "an unscoped platform admin cannot change their password");

    for (const path of ["/api/admin/auth/logout", "/api/admin/auth/logout-all"]) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: POST_HEADERS });
      assert.equal(response.status, 200, `an unscoped platform admin cannot ${path}`);
    }
  });
});

test("a tenant route alias still refuses an unscoped platform admin", async () => {
  // The other half, and the reason the fix is two aliases rather than a wider
  // `anyUser`. Plan 2c registers ~20 TENANT routes at anyUser; an unscoped platform
  // scope carries no companyId, so admitting it there would drive a tenant query with
  // nothing to bind. 6.3.3 promises those routes answer 409 scope_required -- which
  // NOTHING IN PLAN 2b PRODUCES. This test pins the refusal so Plan 2c inherits a
  // known-closed door rather than an accident.
  const { permits } = require("../lib/authorization");
  const unscoped = { kind: "platform", userId: USER, sessionId: SESSION_ID };
  assert.equal(permits(unscoped, ["anyUser"]), false);
  assert.equal(permits(unscoped, ["manager"]), false);
  assert.equal(permits(unscoped, ["companyAdmin"]), false);
  assert.equal(permits(unscoped, ["platform", "anyUser"]), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test apps/core-api/test/authorization.test.js apps/core-api/test/pipeline.test.js \
            apps/core-api/test/auth-routes.test.js
```

Expected: `Cannot find module '../lib/authorization'`; the pipeline's role test
answers 200 because nothing enforces `roles`; the scope tests 404.

- [ ] **Step 3: Implement**

**(a)** Create `apps/core-api/lib/authorization.js`:

```js
"use strict";

// PURE (spec 8.8, Tier 1): no requires at all, so C9 and C14 are satisfied by
// construction.
//
// Spec 5.4: "privilege rules live in one module, unit-tested by name", and spec 6.2
// names that module lib/authorization.js. This is the ALIAS half and nothing else.
// Plan 2c adds the rank lattice, shop containment and the self-modification rules to
// THIS file -- which is why it is not called lib/role-aliases.js.

// Spec 5.4's table. The membership that is easy to get wrong and impossible to see
// afterwards is platform_admin's, because it appears twice with opposite answers:
//
//   - An UNSCOPED platform admin is admitted by `platform` and by NOTHING else. They
//     are not in any list below, because they have no tenant role at all; scope.kind
//     is the whole answer for them.
//   - A SCOPED platform admin materialises role 'platform_admin' at rank 3 and IS in
//     three of the lists -- and deliberately not in `platform`, whose entire meaning
//     is "has not chosen a company".
const TENANT_ALIAS_MEMBERS = Object.freeze({
  platform: Object.freeze([]),
  companyAdmin: Object.freeze(["company_admin", "platform_admin"]),
  manager: Object.freeze(["shop_manager", "company_admin", "platform_admin"]),
  anyUser: Object.freeze(["staff", "shop_manager", "company_admin", "platform_admin"])
});

// THROWS on a malformed declaration rather than returning false, and the direction
// matters. Returning false would turn a typo'd alias into a route nobody can reach,
// which is diagnosed as a permissions bug for a week; returning true would be the
// other thing. route() already refuses an unknown alias at registration, so reaching
// either throw means the two lists have drifted.
function permits(scope, roles) {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error("permits(): a route with auth:'user' must declare a non-empty roles array");
  }
  for (const alias of roles) {
    if (!Object.prototype.hasOwnProperty.call(TENANT_ALIAS_MEMBERS, alias)) {
      throw new Error(`permits(): unknown role alias ${JSON.stringify(alias)}`);
    }
  }
  if (scope.kind === "platform") return roles.includes("platform");
  return roles.some((alias) => TENANT_ALIAS_MEMBERS[alias].includes(scope.role));
}

module.exports = { TENANT_ALIAS_MEMBERS, permits };
```

**(b)** In `apps/core-api/http/router.js`, add the require:

```js
const { permits } = require("../lib/authorization");
```

and add the gate to `runPipeline`, **after** the Origin/Content-Type block and
immediately before `return true` — find it with
`grep -n "requiresOriginCheck(entry)" apps/core-api/http/router.js`:

```js
  // Step 10, FIRST HALF. Spec 6.3.5 writes step 10 as "AUTHORIZATION: route roles ->
  // 403; then each path resource resolved in path order". Those are two halves with
  // different inputs, and only the second one has an ordering constraint.
  //
  // This half depends on the resolved credential and on NOTHING the caller can vary,
  // so it runs as soon as the credential exists rather than after steps 8 and 9. The
  // second half needs step 9's path parameters -- it is what makes "exists but not
  // yours" and "does not exist" the same zero-row result -- and it arrives with the
  // first route that HAS a path parameter, in Plan 2c.
  //
  // It is here, once, rather than a line in every handler, for the same reason route()
  // exists at all: one place where authorization can be forgotten.
  if (entry.options.auth === "user" && !permits(req.core.scope, entry.options.roles)) {
    sendError(res, { status: 403, code: "forbidden" }, req.core.requestId);
    return false;
  }
```

**(c)** In `apps/core-api/http/routes/auth.js`, add the scope route.

```js
// ---------------------------------------------------------------------------
// POST /api/admin/scope
// ---------------------------------------------------------------------------

// Lives in this file despite its path: it changes AUTHENTICATION state -- it writes
// user_sessions.acting_company_id -- and it returns the me-document. A
// http/routes/scope.js would import every helper above and add nothing.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Materialised AFTER the write, never reused from req.core.scope: the pipeline's
// scope was built from the session as it was when this request arrived, so it is one
// selection out of date by construction.
async function respondWithScope(req, res, deps, session, actingCompanyId) {
  const scope = await deps.scopes.materialiseScope({
    userId: session.userId,
    sessionId: session.sessionId,
    role: session.role,
    companyId: session.companyId,
    actingCompanyId
  });
  sendJson(res, 200, meDocument({ user: userFromSession(session), scope, session }));
}

route(
  "POST",
  "/api/admin/scope",
  {
    auth: "user",
    // BOTH, because spec 5.4's four aliases cannot express "platform_admin, scoped or
    // unscoped": `platform` admits only the unscoped one, `companyAdmin` admits the
    // scoped one AND every real company admin. This is the narrowest static
    // declaration available; the handler closes the rest.
    roles: ["platform", "companyAdmin"],
    body: { companyId: "uuid|null" },
    // The handler writes scope.cleared for a null body. `audit` is one string, and
    // this is the route's principal action.
    audit: "scope.selected",
    sample: { body: { companyId: null } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const session = req.core.session;

    // session.role is users.role -- the fact being tested. scope.role would work by
    // accident today (a scoped platform admin materialises 'platform_admin' and a
    // company admin materialises 'company_admin') and stop working the moment spec
    // 5.4's rank lattice is extended.
    if (session.role !== "platform_admin") throw new ApiError(403, "forbidden");

    const body = await readJsonBody(req);

    // REQUIRED and explicitly NULLABLE (spec 6.2). hasOwnProperty rather than an
    // `=== undefined` test, because {} and {"companyId": null} are two different
    // requests: one is a mistake and the other clears the selection.
    if (!Object.prototype.hasOwnProperty.call(body, "companyId")) {
      throw new ApiError(422, "validation_failed", [{ field: "companyId", code: "required" }]);
    }
    const companyId = body.companyId;
    if (companyId !== null && (typeof companyId !== "string" || !UUID_PATTERN.test(companyId))) {
      // 422, and the "422 never describes a path segment" rule does not apply: that
      // rule is about PATH parameters, where a malformed segment cannot name a
      // resource. This is a body field and step 11 owns it.
      throw new ApiError(422, "validation_failed", [{ field: "companyId", code: "invalid_uuid" }]);
    }

    if (companyId === null) {
      await deps.sessions.setActingCompany(session.sessionId, null);
      await deps.appendAuditEvent({
        actorKind: "user",
        actorUserId: session.userId,
        action: "scope.cleared",
        outcome: "success",
        sourceIp: req.core.clientIp
      });
      await respondWithScope(req, res, deps, session, null);
      return;
    }

    // Read BEFORE the write, and separately, because 6.2 distinguishes 404 not_found
    // from 409 company_suspended and one zero-row UPDATE cannot produce both.
    const company = await deps.sessions.findCompanyForScopeSelection(companyId);

    // THE PROBED ID GOES IN target_id, NOT IN company_id. audit_events.company_id
    // REFERENCES companies (0001_init.sql), so an id matching no row raises 23503
    // inside the failure path and turns a 404 into a 500 -- reachable by anyone who
    // can reach this route, with any uuid at all. target_id is text with no FK, and
    // 0001's own comment says why: "a target may legitimately be gone".
    const attempt = {
      actorKind: "user",
      actorUserId: session.userId,
      action: "scope.selected",
      outcome: "failure",
      targetKind: "company",
      targetId: companyId,
      sourceIp: req.core.clientIp
    };

    if (company === null) {
      await deps.appendAuditEvent(attempt);
      throw new ApiError(404, "not_found");
    }
    if (company.status !== "active") {
      await deps.appendAuditEvent(attempt);
      throw new ApiError(409, "company_suspended");
    }

    await deps.sessions.setActingCompany(session.sessionId, companyId);
    await deps.appendAuditEvent({
      ...attempt,
      outcome: "success",
      // Only now that the row is known to exist can the tenant column carry it --
      // which is what makes "everything done inside this company" a query.
      companyId
    });
    await respondWithScope(req, res, deps, session, companyId);
  }
);
```

**(d)** Widen the origin-gating census in `apps/core-api/test/route-auth.test.js` to
its final Plan 2b value — every non-GET `auth:'user'` route plus login:

```js
  assert.deepEqual(gated, new Set([
    "POST /api/admin/auth/login",
    "POST /api/admin/auth/logout",
    "POST /api/admin/auth/logout-all",
    "POST /api/admin/auth/password",
    "POST /api/admin/scope"
  ]));
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/authorization.test.js apps/core-api/test/pipeline.test.js \
            apps/core-api/test/auth-routes.test.js apps/core-api/test/route-auth.test.js \
            apps/core-api/test/table-displays.test.js apps/core-api/test/source-structure.test.js
```

Expected: all pass. **`table-displays.test.js` again** — it is `auth: 'terminal'`, so
the gate must skip it entirely; a gate written as "if `options.roles` exists" instead
of "if `auth === 'user'`" passes every test above and 500s that route on
`permits(undefined, undefined)`.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/lib/authorization.js apps/core-api/test/authorization.test.js \
        apps/core-api/http/router.js apps/core-api/http/routes/auth.js \
        apps/core-api/test/pipeline.test.js apps/core-api/test/auth-routes.test.js \
        apps/core-api/test/route-auth.test.js
git commit -m "feat(core-api): make declared roles mean something, and let a platform admin choose a company"
```

---

## Part 6 — Bootstrap

### Task 16: `scripts/create-platform-admin.js`, and the boot warning that must not be a refusal

Everything above is unreachable until one account exists, and §5.6 settles how:
**CLI only.** No bootstrap HTTP endpoint, no bootstrap token, no seeded row in a
migration, and no `BOOTSTRAP_ADMIN_PASSWORD` variable. The environment-variable
variant was rejected outright because `DATABASE_URL` is exploitable only from inside
the host — Postgres publishes no port — while an email/password pair is a
cross-tenant credential usable from any browser on the internet.

**Files:**

- Create: `apps/core-api/scripts/create-platform-admin.js`
- Modify: `apps/core-api/test/scripts.test.js`
- Modify: `apps/core-api/server.js`
- Modify: `apps/core-api/test/server-bootstrap.test.js`

**The mirrors.**

```bash
grep -rn "create-platform-admin" apps/core-api infra docs .github
grep -n "deepEqual(calls" apps/core-api/test/server-bootstrap.test.js
grep -n "countActivePlatformAdmins" apps/core-api
```

`countActivePlatformAdmins` was written in Task 7 and **nothing has called it since**.
This is its caller. Its own comment says what it is for: *"Read by server.js at boot
to WARN, never to refuse."*

**The one deliberate exception to this repository's refuse-to-start convention, and
the mechanism that forces it.** §9.10 has the CLI run through
`docker compose exec` — so the container must already be up. A service that refused
to listen while no platform admin exists could therefore never be bootstrapped: the
only way to create the first admin requires a running container, and the container
will not run until the admin exists. It is a deadlock, not a policy preference, and
that is why the check is a log line.

**`docker compose exec`, never `exec -T`.** The script refuses when
`process.stdin.isTTY` is false. Without that refusal
`echo 'pw' | docker compose exec -T …` works, and the password lands in shell
history — which is exactly what "never from argv" exists to prevent. The refusal is
the enforcement; the documentation is not.

**One departure from this plan's own Tech Stack line.** It names `node:readline` for
the echo-off prompt. The readline recipe for echo-off overrides `_writeToOutput`, an
underscore-prefixed Node internal, and this service does not put a credential path on
a private API. `process.stdin.setRawMode()` is the public one and is what the script
uses; `node:readline` is not required at all. The Tech Stack line is corrected in
Task 17.

- [ ] **Step 1: Write the failing tests**

Add to `apps/core-api/test/scripts.test.js`, reusing that file's existing
`runScript` helper:

```js
const BOOTSTRAP_SCRIPT = path.join(__dirname, "..", "scripts", "create-platform-admin.js");

// A complete, valid configuration that reaches NO database: every guard under test
// fires before the pool is opened, so these cases need no Postgres.
const BOOTSTRAP_ENV = {
  NODE_ENV: "development",
  POSTGRES_PASSWORD: "devpassword",
  DATABASE_MIGRATION_URL: "postgres://core_api_owner:devpassword@127.0.0.1:5433/core",
  DATABASE_URL: "postgres://core_api_app:apppassword@127.0.0.1:5433/core",
  API_PUBLIC_ORIGIN: "http://localhost:3200"
};

test("the bootstrap CLI refuses a piped password and exits non-zero", () => {
  // THE GUARD THE WHOLE DESIGN RESTS ON. spawnSync gives the child a pipe, never a
  // TTY, so this is the `docker compose exec -T` case exactly. Without the refusal,
  // `echo 'pw' | docker compose exec -T ...` works and the password is in shell
  // history -- which is the thing "never from argv" exists to prevent.
  const { status, output } = runScript(BOOTSTRAP_SCRIPT, {
    env: BOOTSTRAP_ENV,
    argv: ["ops@example.test"]
  });
  assert.notEqual(status, 0);
  assert.match(output, /interactive terminal/i);
  // And it names the fix, because the operator's next move is to drop one flag.
  assert.match(output, /docker compose exec/);
  assert.doesNotMatch(output, /exec -T/);
});

test("the bootstrap CLI refuses a missing or malformed email before opening a pool", () => {
  // Checked against the users.email CHECK's own shape. Reaching the database to be
  // told 23514 would surface a constraint name to an operator, and the message would
  // be about DDL rather than about what they typed.
  for (const argv of [[], ["not-an-email"], ["two words@example.test"]]) {
    const { status, output } = runScript(BOOTSTRAP_SCRIPT, { env: BOOTSTRAP_ENV, argv });
    assert.notEqual(status, 0, JSON.stringify(argv));
    assert.match(output, /email/i);
  }
});

// COMMENTS STRIPPED FIRST, and that is not a nicety. The script's own header explains
// why there is no force flag, so a raw match would be red against a CORRECT file --
// and both repairs available to whoever hits it lose: deleting the documentation, or
// weakening the regex until it stops checking. source-structure.test.js:327-334 names
// this exact trap and carries the stripper this one copies.
function withoutComments(text) {
  return text.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

test("the bootstrap CLI has no force flag and never reads a password from argv", () => {
  // Spec 9.10, stated as an absence. A force flag would mean "overwrite the account
  // that is already there", and the remedy for a forgotten password is
  // scripts/set-password.js.
  const source = withoutComments(fs.readFileSync(BOOTSTRAP_SCRIPT, "utf8"));
  assert.doesNotMatch(source, /--force/);
  // The same rule seen from the other side: argv carries the address and the display
  // name, never the secret.
  assert.doesNotMatch(source, /argv\[2\]|argv\.slice\(3\)/);
});

test("the bootstrap guard is monotonic, and the script says so where an operator will read it", () => {
  // Spec 12's acceptance checkbox depends on it and design.md:714/:855 make it the
  // justification for the only peer-creating route in the system. A script that
  // silently lost the guard would pass every other test in this file.
  const source = fs.readFileSync(BOOTSTRAP_SCRIPT, "utf8");
  assert.match(source, /already been bootstrapped/);
  assert.match(source, /bootstrapPlatformAdmin/);
  // And it must NOT reach for the current-state question, which a DELETE defeats.
  assert.doesNotMatch(withoutComments(source), /countActivePlatformAdmins/);
});
```

> `fs` is not required by `scripts.test.js` today. Add `const fs = require("node:fs");`
> at the top rather than inlining a second read helper.

Add to `apps/core-api/test/server-bootstrap.test.js`:

```js
test("an empty platform_admin set warns and still listens", () => {
  // The ONE deliberate exception to this repository's refuse-to-start convention, and
  // it is forced by mechanism rather than chosen: spec 9.10 runs the bootstrap CLI
  // through `docker compose exec`, so the container must already be up. Refusing here
  // would make the platform unbootstrappable -- the admin needs the container and the
  // container would need the admin.
  const lines = [];
  // ... start() with countActivePlatformAdmins: async () => 0 and log: (line) => lines.push(line)
  assert.ok(lines.some((line) => /platform administrator/i.test(line)));
});

test("a failed platform-admin count warns and still listens", () => {
  // It runs after waitForDatabase, so a throw here means the database went away in
  // the gap. Turning that into a refusal to listen would fail the deploy's 90-second
  // readiness gate AFTER the migration applied -- the failure shape spec 9.5 spends a
  // page designing away.
});
```

> Write both against whatever injection shape `server-bootstrap.test.js` already uses
> for `start()`'s collaborators. Do **not** invent a second one.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test apps/core-api/test/scripts.test.js apps/core-api/test/server-bootstrap.test.js
```

Expected: the script tests fail with `Cannot find module`; the bootstrap tests fail
because nothing counts platform admins.

- [ ] **Step 3: Write the script**

Create `apps/core-api/scripts/create-platform-admin.js`:

```js
"use strict";

// Spec 5.6 and 9.10. The ONLY way the first account comes into existence.
//
//   cd ~/restaurant-order-system
//   CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec core-api \
//     node apps/core-api/scripts/create-platform-admin.js you@example.com
//
// BOTH variables, on a subcommand that touches only core-api. Compose validates
// every service's env_file on every subcommand, so a one-variable invocation dies at
// project load complaining about the OTHER file and never reaches this script. This
// is the form apps/core-api/README.md ships, and deploy-config.test.js enforces it
// per line -- but only in .md files, so these two copies are on their author.
//
// `docker compose exec`, NEVER `exec -T`: this reads the password from a TTY with
// echo disabled and REFUSES a pipe. The path inside the container is
// apps/core-api/scripts/... because WORKDIR is /app and the Dockerfile copies into
// ./apps/core-api.
//
// It connects with DATABASE_URL -- core_api_app, the RUNTIME role -- and not with the
// owner. It performs pure DML, so the superuser credential stays unused.
//
// There is no --force. Creating the same address twice is a no-op (ON CONFLICT DO
// NOTHING in the repository) that exits non-zero, and the remedy for a forgotten
// password is scripts/set-password.js, not a second row.

const { startupConfiguration } = require("../config");
const { loadDotEnv } = require("../env-file");
const { openRuntimePool, closeAllPools } = require("../db");
const { hashPassword, PasswordPolicyError, PASSWORD_MIN_LENGTH } = require("../lib/password");
const users = require("../repositories/auth/users");
// NO require of repositories/auth/audit.js. The audit row is written inside
// bootstrapPlatformAdmin's transaction; appendAuditEvent would open a second
// connection and put it outside, which is the whole defect the guard exists to avoid.

// The users.email CHECK, mirrored. Reaching the database to be told 23514 would put a
// constraint name in front of an operator and describe DDL rather than what they typed.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// users.display_name is CHECK (length(btrim(display_name)) BETWEEN 1 AND 80).
const DISPLAY_NAME_MAX = 80;

function usage() {
  return [
    "usage: node apps/core-api/scripts/create-platform-admin.js <email> [display name]",
    "",
    "Run it through an interactive session -- `docker compose exec`, without -T.",
    "Both env-file variables, or compose refuses the project before this runs:",
    "  CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec core-api \\",
    "    node apps/core-api/scripts/create-platform-admin.js you@example.com"
  ].join("\n");
}

// PUBLIC API, deliberately. readline's echo-off recipe overrides _writeToOutput, an
// underscore-prefixed internal, and a credential prompt is the last place to depend on
// one. setRawMode is documented and stable.
function promptSecret(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let value = "";
    const finish = (error, answer) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(answer);
    };

    function onData(chunk) {
      // Compared by CODE POINT, never against string literals. The three that matter
      // -- EOT, ETX and DEL -- have no printable spelling, so source carrying them raw
      // is one careless editor, diff tool or copy-paste away from silent repair.
      const ENTER = 13;
      const NEWLINE = 10;
      const EOT = 4;
      const ETX = 3;
      const DEL = 127;
      const BACKSPACE = 8;

      for (const character of chunk) {
        const code = character.codePointAt(0);

        // EOT is here because raw mode delivers Ctrl-D as a BYTE rather than as
        // end-of-stream, so without it the prompt hangs on the key an operator who
        // wants to abandon it is most likely to reach for.
        if (code === ENTER || code === NEWLINE || code === EOT) {
          finish(null, value);
          return;
        }
        // Raw mode also suppresses SIGINT, so this is the only way out.
        if (code === ETX) {
          finish(new Error("cancelled"));
          return;
        }
        // Terminals disagree about which byte the backspace key sends.
        if (code === DEL || code === BACKSPACE) {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    }

    process.stdin.on("data", onData);
  });
}

async function main(argv) {
  const email = typeof argv[0] === "string" ? argv[0].trim().toLowerCase() : "";
  // btrim + a bound, matching the column. Defaulting to the local part means the
  // one-argument invocation spec 9.10 documents actually works.
  const displayName = (typeof argv[1] === "string" && argv[1].trim() !== ""
    ? argv[1].trim()
    : email.split("@")[0]
  ).slice(0, DISPLAY_NAME_MAX);

  if (email === "" || !EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new Error(`a valid email address is required\n\n${usage()}`);
  }

  // THE GUARD. A pipe means `docker compose exec -T`, which means the password came
  // from a shell command and is now in that shell's history.
  if (!process.stdin.isTTY) {
    throw new Error(
      "this script will not read a password from a pipe: run it on an interactive terminal " +
        `(\`docker compose exec\`, without -T)\n\n${usage()}`
    );
  }

  loadDotEnv(undefined, process.env);
  const config = startupConfiguration(process.env);

  const password = await promptSecret(`Password for ${email} (min ${PASSWORD_MIN_LENGTH} characters): `);
  const again = await promptSecret("Repeat it: ");
  // Typed blind, twice, because the cost of a typo here is an account nobody can sign
  // in to and no way to tell that from a wrong password at the login screen.
  if (password !== again) throw new Error("the two passwords did not match");

  let passwordHash;
  try {
    passwordHash = await hashPassword(password);
  } catch (error) {
    if (!(error instanceof PasswordPolicyError)) throw error;
    throw new Error(`the password was rejected: ${error.code}`);
  }

  // max: 1. This process issues one transaction and exits; a pool sized for the server
  // would open connections against max_connections=40 for no reason.
  await openRuntimePool({ connectionString: config.databaseUrl, max: 1 });
  try {
    // The lock, the monotonic guard, the user row and its audit row are ONE
    // transaction inside the repository. That is not tidiness: pg_advisory_xact_lock
    // is transaction-scoped, and an audit row written afterwards by appendAuditEvent
    // -- on its own connection -- could be lost to a crash, leaving the guard
    // disarmed and the platform bootstrappable a second time.
    //
    // 'system' is the actor kind, and audit_events_actor_arc settles it rather than
    // taste: 'user' requires actor_user_id and 'terminal' requires actor_terminal_id,
    // and there is no authenticated actor at the moment the first account comes into
    // existence. platform.admin_created declares both 'user' and 'system' for exactly
    // this reason -- POST /api/platform/admins (Plan 2c) writes it as 'user'.
    const { created, reason } = await users.bootstrapPlatformAdmin({ email, displayName, passwordHash });

    // Two distinguishable refusals, because the operator's next move differs. Exiting
    // 0 on either would let a bootstrap report success while creating nothing.
    if (reason === "already_bootstrapped") {
      throw new Error(
        "this platform has already been bootstrapped, and that is permanent by design: " +
          "the guard is an audit_events row, so deleting the administrator does not re-open it. " +
          "Use scripts/set-password.js to recover an account, or POST /api/platform/admins to add one."
      );
    }
    if (reason === "email_taken") {
      throw new Error(`${email} already exists; use scripts/set-password.js to change its password`);
    }

    process.stdout.write(`created platform administrator ${created.email} (${created.id})\n`);
  } finally {
    await closeAllPools();
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```

**(b)** Wire the boot warning in `apps/core-api/server.js`.

Add the require beside the other repositories:

```js
const usersRepository = require("./repositories/auth/users");   // already added in Task 12
```

and, inside `start()`, **after `waitForDb(...)` and before `createApp(...)`**:

```js
  // Spec 9.10's one deliberate exception to refuse-to-start, and it is forced rather
  // than chosen: the bootstrap CLI runs through `docker compose exec`, so the
  // container must be up before the first admin can exist. Refusing here is a
  // deadlock -- the admin needs the container and the container would need the admin.
  //
  // Wrapped, because a throw would turn a transient database blip in the gap after
  // waitForDatabase into a process that never listens, which fails the deploy's
  // 90-second readiness gate AFTER the migration applied.
  const countAdmins = options.countActivePlatformAdmins || usersRepository.countActivePlatformAdmins;
  try {
    if ((await countAdmins()) === 0) {
      logLine(
        "WARNING: no active platform administrator exists. Create one with: " +
          "docker compose exec core-api node apps/core-api/scripts/create-platform-admin.js <email>"
      );
    }
  } catch (error) {
    logLine("WARNING: could not count platform administrators; continuing to listen");
  }
```

> `logLine` is whatever `start()` already uses to write a line — reuse it. If `start()`
> has no logger of its own and only passes `options.log` into `createApp`, hoist it:
> `const logLine = options.log || ((line) => process.stdout.write(`${line}\n`));` and
> pass the same function to `createApp` so there is one logger, not two.

**`server-bootstrap.test.js` asserts `start()`'s collaborator order with a `deepEqual`
on an array of strings.** This adds a step, so that array moves. Find it with
`grep -n "deepEqual(calls" apps/core-api/test/server-bootstrap.test.js` and insert the
new name in the position the code actually calls it — after `waitForDatabase`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/scripts.test.js apps/core-api/test/server-bootstrap.test.js \
            apps/core-api/test/source-structure.test.js apps/core-api/test/deploy-config.test.js
```

Expected: all pass. `deploy-config.test.js` matters because the Dockerfile's single
`COPY` is what carries `scripts/` into the image — its comment already says so — and
this is the first script the runbook tells an operator to run inside the container.

Then, with a database, run it end to end. This is the only task in the plan whose
proof is a human at a terminal:

```bash
node apps/core-api/scripts/create-platform-admin.js ops@example.test
# type a password twice; it must not echo
# then, in another shell, curl the login route and expect 200
```

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/scripts/create-platform-admin.js apps/core-api/server.js \
        apps/core-api/test/scripts.test.js apps/core-api/test/server-bootstrap.test.js
git commit -m "feat(core-api): the first account, from a terminal that refuses a pipe"
```

---

## Part 7 — Reconciliation

### Task 17: retire every deferral marker this plan has made false

Sixteen tasks have made a set of documented claims wrong. They are wrong in the
**safe** direction — every one of them under-states what the service now does — which
is exactly why they will survive indefinitely if this task is skipped: nothing goes
red, and the next reader plans around a gap that closed months earlier.

**The rule this task follows, from "How to pick this up":** *an `assert.match` on a
deferred-plan literal cannot detect staleness. A `match` goes red only when the
literal is removed — which is the very edit it is meant to compel. Replace deferral
markers with assertions on the claim that is now TRUE.*

**Files:**

- Modify: `infra/README.md`
- Modify: `apps/core-api/README.md`
- Modify: `apps/core-api/test/operations-docs.test.js`
- Modify: `apps/core-api/test/source-structure.test.js`
- Modify: `apps/core-api/test/deploy-config.test.js`
- Modify: `apps/core-api/test/backup-restore.test.js`
- Modify: `docs/superpowers/specs/2026-07-29-core-api-phase1-design.md`
- Modify: `docs/superpowers/specs/2026-08-04-core-api-identity-slice-design.md`

**Two of those test files are here because Step 2 turns them red.**
`deploy-config.test.js` and `backup-restore.test.js` each carry one `assert.match` on a
sentence Step 2 retires. The first mirror below does return both, but it returns them on
their **comment** lines, buried in thirty-odd hits across nine files — and
`deploy-config.test.js`'s assertion is on the literal *"Ships in a later plan of this
phase"*, which contains no `Plan 2` at all, so the only thing tying it to this task is
the comment above it. That is what the second mirror is for. Step 1 retargets all three
test files, `operations-docs.test.js` included, before `npm test` is run: a documentation
edit that lands with its assertions untouched is a red suite blamed on the last thing
committed rather than on the edit that caused it.

**The mirrors — run all five and reconcile every hit, not just the ones listed here:**

```bash
grep -rn "Plan 2" infra apps/core-api --include=*.md --include=*.js | grep -v node_modules
grep -rn "Ships in a later plan" apps/core-api
grep -rn "runs a forged-XFF probe as a gate" .
grep -rn "the settled four\|exactly four entries" apps docs
grep -rn "SOURCE_FILES.length >=" apps/core-api/test/source-structure.test.js
```

**Two passages no grep above will find, reported by the Task 2 executor.** Landing
the limiter-roster boot check made both of these FALSE, and neither carries a
deferral keyword — they are flat assertions about what the code does, so a
marker-hunting sweep walks straight past them:

| Site | What it now claims falsely |
| --- | --- |
| slice spec `§7.1` | *"It does not. `validateRouteTable` inspects only `options.limit.key` … there is no roster constant and no `limit.name` membership check anywhere in the service."* |
| slice spec `§11.6` | *"The limiter roster check does not exist at all, and §5.7 says it does … Registering `limit: { key: "ip", name: "invented" }` today throws nothing and the process listens."* |

Both were **true when written** and are the reason Tasks 1 and 2 exist. Rewrite each
as a record of what was wrong and what fixed it — the slice spec's own §11.9 is the
model for that shape — rather than deleting them, because the reasoning about *why*
the check waited until 2b is worth keeping. Find them with:

```bash
grep -n "limit.name\|roster constant" docs/superpowers/specs/2026-08-04-core-api-identity-slice-design.md
```

The same treatment is owed to §11.6's audit-vocabulary paragraph, which says the
membership check "is ready and was deliberately not landed here" — Task 3 landed it.

**Not every `Plan 2` is this plan.** `infra/README.md`'s `AUDIT_RETENTION_DAYS`
sentence points at `scripts/sweep-expired.js`, which is **Plan 2d** and is not built
here. Retarget that one to say `Plan 2d` rather than deleting it — "Plan 2" was
unambiguous when it was written and stopped being so the day 2a shipped. Its assertion,
`assert.match(doc, /AUDIT_RETENTION_DAYS[\s\S]{0,120}Plan 2/)` in
`backup-restore.test.js`, stays **green** through that retarget and needs no edit: the
pattern has no word boundary, so it matches `Plan 2d`. Leave it exactly as it is —
adding a `\b` there is a repair nobody asked for that turns a passing assertion red.

**`scripts/set-password.js` and `scripts/unlock-account.js` get the same retarget, and
this plan is what makes them urgent.** Neither file exists — `apps/core-api/scripts/`
holds `reset-database.js`, `setup-template-db.js` and, after Task 16,
`create-platform-admin.js`. Both are named as shipped levers in five sections of the
parent spec — §7's file layout, §9.3's "`scripts/` in the image is required", §9.10's
neighbouring-levers sentence, §10's Phase-1 recovery line, and §12's acceptance checkbox
— and slice §11.1 calls `set-password.js` the remedy that "already exists". Find every
one with `grep -rn "set-password.js\|unlock-account.js" docs apps`.
**Do not reword the two error messages Task 16 writes.** The name is
pinned at all five spec sites, in Plan 5's image-contents rule, and in a live comment in
`apps/core-api/test/deploy-config.test.js`; renaming the script here would make six
documents wrong to make one message accurate. The bookkeeping is the fix: they belong to
**Plan 2d**, which slice §11.8 gives "the admin CRUD and credential recovery", and
`set-password.js` is the operator half of exactly that. Until 2d lands, an operator who
hits `already_bootstrapped` is told to run a file that is not there — which is why Step 4
corrects slice §11.1 rather than leaving "already exists" standing.

- [ ] **Step 1: Retarget the documentation tripwires**

In `apps/core-api/test/operations-docs.test.js`, three assertions currently pin
deferrals. Find them with `grep -n "Plan 2\|forged-XFF" apps/core-api/test/operations-docs.test.js`.

```js
  // WAS: assert.match(chain, /Plan 2/) plus a doesNotMatch on the gate sentence.
  // The behavioural probe now exists, so the assertion is on the claim itself: the
  // runbook must describe a gate that reads an audit_events row back, because that
  // is what deploy.yml block 4 does.
  assert.match(chain, /audit_events/);
  assert.match(chain, /203\.0\.113\.99/);
```

```js
  // WAS: assert.match(cutover, /Plan 2/) on the bootstrap step.
  // The script exists; the checklist must name the path an operator can actually run.
  assert.match(cutover, /scripts\/create-platform-admin\.js/);
  assert.match(cutover, /docker compose exec/);
  // ...and must NOT tell them to use -T, which the script refuses by design.
  assert.doesNotMatch(cutover, /docker compose exec -T[^\n]*create-platform-admin/);
```

Then **delete both `assert.doesNotMatch(…, /runs a forged-XFF probe as a gate/)`**
— one is inside the client-IP test and one is document-wide in
`"no section of infra/README.md over-states what the pipeline proves"`. That sentence
was banned because it was false. It is now true, and a ban on a true sentence is a
tripwire pointing backwards.

**The trap in this step, and it is a hard one.** `operations-docs.test.js` caps
`## The client-IP chain` at **40 lines** and the section is **39** today. There is one
line of headroom for a change that wants three or four. Do not raise the cap: the cap
exists because the nginx area already carries the detailed breaker list, and the whole
point of the section is that it is a summary and a pointer rather than a second copy.
Rewrite within the budget — the sentences being replaced are longer than the ones
replacing them, because "this arrives in Plan 2" plus its explanation is longer than
"the deploy asserts it".

Measure before and after:

```bash
awk '/^## The client-IP chain$/,/^## /' infra/README.md | wc -l
```

**Two more tripwires live outside that file, and Step 2 breaks both.** They are the
reason `deploy-config.test.js` and `backup-restore.test.js` are in this task's Files
list. Retarget them in this step, not after `npm test` reports them.

In `apps/core-api/test/deploy-config.test.js`, at the end of *"the operator docs name
the second secrets file and why core-db publishes no port"*:

```js
  // WAS: assert.match(coreReadme, /Ships in a later plan of this phase/) — the marker
  // that told a reader not to look for the script. The script exists, so the assertion
  // moves onto what the Bootstrapping section must now carry: the in-container path,
  // and the `exec -T` ban the script enforces by refusing a non-TTY stdin. The
  // two-variable rule above already covers this section's compose line.
  assert.match(coreReadme, /node apps\/core-api\/scripts\/create-platform-admin\.js/);
  assert.match(coreReadme, /never `exec -T`/);
  assert.doesNotMatch(coreReadme, /Ships in a later plan of this phase/);
```

The `doesNotMatch` is not symmetry for its own sake. The forged-XFF ban is deleted above
because the banned sentence became **true**; this sentence became **false**, and a ban is
the only shape that goes red if a later edit restores it.

In `apps/core-api/test/backup-restore.test.js`, in *"the runbook covers a fresh instance
and the password-rotation ordering"*:

```js
  // WAS: assert.match(doc, /create-platform-admin\.js[\s\S]{0,200}Plan 2/) — the runbook
  // was required to say the script did not exist yet. It does, and this is the paragraph
  // an operator reads on the one deploy where there is no dump to restore, so it must
  // carry the command rather than a forward reference.
  assert.match(doc, /create-platform-admin\.js[\s\S]{0,400}docker compose exec/);
  assert.doesNotMatch(doc, /script ships in Plan 2/);
```

**Measure the 400, do not inherit it.** The bound must be the real distance between the
sentence and the fenced command after Step 2 has written them, plus room for one edit —
too wide and the assertion starts passing off the *cutover* invocation further down the
file, which is a different site and would leave this paragraph free to rot. Read it back
and count the gap yourself:

```bash
grep -n "create-platform-admin.js" infra/README.md
```

- [ ] **Step 2: Update `infra/README.md` and `apps/core-api/README.md`**

Every site the greps found. The four that carry real operator consequences:

| What it says today | What is true now |
| --- | --- |
| *"`create-platform-admin.js` … **That script ships in Plan 2.** Until it does, a fresh instance has no way to create the first user"* | It ships. Give the invocation, and say `docker compose exec` **without `-T`** and why the script refuses one. |
| *"the forged-XFF probe … arrives with Plan 2"* (three sites) | It is block 4 of the deploy and it is a gate. It POSTs a login with `X-Forwarded-For: 203.0.113.99` and reads the `audit_events` row back. |
| Cutover step 7, *"Bootstrap the first platform administrator — **Plan 2**"* | A runnable command. This is the step that turns a deployed service into a usable one. |
| The reconciliation table row *"The deploy proves `X-Forwarded-For` is unforgeable → It does not."* | It does, and the row should now say **how** — the three assertions of block 4 — rather than being deleted. A reconciliation table that only ever removes rows stops being read. |

`apps/core-api/README.md` already matches `/create-platform-admin/` (spec §12's grep),
so that test stays green either way — which is precisely why the entry has to be
checked by eye rather than by grep. Make it a runbook entry with the real command.

**Every `docker compose` line this step writes carries BOTH env-file variables.**
Compose validates every service's `env_file` on every subcommand, so
`CORE_ENV_FILE=../core-api.env docker compose exec core-api …` dies at project load
complaining about the *other* file, and the operator reading a fresh-instance runbook
has nothing to fall back on. The shipped form to copy is the Bootstrapping line in
`apps/core-api/README.md`:

```bash
grep -n "EPAPER_ENV_FILE" apps/core-api/README.md infra/README.md
```

The `.md` sites are guarded and the script is not. `deploy-config.test.js` asserts the
rule **per line** across the four `.md` files, so a one-variable line in either README
goes red and the message names the offending line — but the same command also appears
twice inside `scripts/create-platform-admin.js`, in the header comment and in `usage()`,
and no assertion reaches those. Task 16 writes both with both variables; if this step
rewords the invocation, reword all four copies together.

- [ ] **Step 3: Raise the walker floor, with one sentinel per load-bearing new file**

In `apps/core-api/test/source-structure.test.js`. The floor is `>=`, so nothing has
gone red while ten files landed — and a walker that silently stopped descending would
go on comparing `[]` to `[]`, which is the failure C9 lived with for the whole of
Plan 1.

**Measure, do not estimate.** Break the floor deliberately and read the number back:

```bash
# set the floor to something absurd, run, and read "scanned only N files"
node --test apps/core-api/test/source-structure.test.js 2>&1 | grep "scanned only"
```

Set the floor to exactly that N, then add the sentinels — the floor alone cannot catch
a walker that stops descending into ONE area, because the count clears on the strength
of the others:

```js
    // Plan 2b. One per file that a rule would silently stop checking if the walker
    // lost it: C9 and C14 scan lib/, C2 and C4 scan repositories/auth/, and the two
    // http/ files below are the entire credential path.
    "lib/rate-limit.js",
    "lib/authorization.js",
    "http/cookies.js",
    "http/csrf.js",
    "http/authenticate.js",
    "http/routes/auth.js",
    "repositories/auth/users.js",
    "repositories/auth/sessions.js",
    "repositories/auth/scope-materialize.js",
    "scripts/create-platform-admin.js"
```

Then **mutation-test the floor** the way Plan 2a's Task 11 did: set it to `N + 1`,
confirm the test fails, set it back to `N`, confirm it passes. A floor nobody has seen
fail is a floor nobody has seen work.

If `scripts/create-platform-admin.js` is **not** in `SOURCE_FILES`, the walker does not
descend into `scripts/` — report that as a finding rather than dropping the sentinel.
It would mean C7, C8 and C9 have never seen a script, and the one this plan just added
handles a plaintext password.

- [ ] **Step 4: Amend both specs**

`docs/superpowers/specs/2026-07-29-core-api-phase1-design.md` (the parent):

| Section | Amendment |
| --- | --- |
| §5.7 | *"`route()` rejects at boot any route whose `limit` names a limiter absent from it"* was false when written. Task 2 made it true. Note that it is now enforced, and where. |
| §5.9 | Same for the vocabulary membership check, landed in Task 3. |
| §6.1 / §8.5 rule 2 | *"exactly four entries"* / *"the settled four"* → **three** after this plan, and say what it grows to rather than implying it stops: **eight** once Plan 2d adds `forgot-password`, `reset-password`, `verify-email`, `GET /admin/reset-password` and `GET /admin/verify-email`, and **nine** when the terminal plan adds `POST /api/terminal/pair`. Do not write "four". The slice settled this at §6.2 — *"The public set is eight"* — and its §12 already carries the amendment row; a plan that re-derives four here would put the parent back in conflict with the slice one commit after the slice was written. |
| §6.2, the four identity rows | The Roles column reads `anyUser`; it becomes **`anyUser` + `platform`**. §5.4's alias table excludes an unscoped `platform_admin` from `anyUser` and §6.2 gives these four rows `anyUser`, so the two sections disagree and Plan 2b is the first plan to execute the disagreement — see Part 5 departure (d). It is settled in §6.2's direction *for these four rows only*, by declaring both aliases on routes that bind no company, and **not** by widening `anyUser` in `permits()`, which would admit an unscoped platform admin to the roughly twenty tenant routes Plan 2c registers at `anyUser`. |
| §6.3.5 | Step 10 is two halves. The static route-roles half runs at step 7.5 and the per-resource half arrives in Plan 2c — see Part 5 departure (c). |
| §7 file layout, §9.10, §12 | Not a correction — a **confirmation**, and it is worth a row precisely because three sites would otherwise stay unverified. All three describe `create-platform-admin.js` as holding an advisory lock and a monotonic audit guard: §7's file-layout line, §9.10's justification for connecting as `core_api_app` rather than the owner, and §12's checkbox (*"a second run with a different address exits NON-ZERO; DELETE the platform_admin row and re-run — still non-zero"*). Task 7's `bootstrapPlatformAdmin` takes `pg_advisory_xact_lock` and refuses on an existing `platform.admin_created` audit row, in one transaction, and Task 16 calls it. Record that they are now implemented and name the tests, so the next reader does not re-litigate a guard that exists. |
| §6.2's `POST /api/platform/admins` row, and the peer-creation paragraph in the prose below the same table | Follows from the row above: that route is *"the sole route in the system that creates a peer"* and its only stated justification is that `create-platform-admin.js` is monotonic. It is. Leave both sentences standing and note that the premise was checked here — an earlier draft of this plan shipped a `created === null` guard that would have removed it, and Plan 2c inherits the exception. |
| §9.5 | **The block-4 appendix is wrong twice** and must be corrected or the next reader copies it: it writes the curl as `curl -fsS … \|\| true`, which `deploy-config.test.js` bans, and it writes the psql with `'"'"'`-style quoting that no longer matches what the test asserts. Replace both with what `deploy.yml` actually carries after Task 12. |
| §9.12 | The semaphore-occupancy sentence names `LOGIN_RATE_PER_MINUTE` as *"the control"*. With `login-global` in a roster and `core_login` at the edge it is one of two, and identity spec §7.3 already says so. |

`docs/superpowers/specs/2026-08-04-core-api-identity-slice-design.md` (this slice):

- **§11.1** — *"The remedy is out-of-band and already exists: `scripts/set-password.js`"*. It does not exist and no written plan builds it; see the retarget above. Correct the sentence to name **Plan 2d** as its owner and say plainly that until 2d lands there is **no** remedy for a mistyped address — a residual section that describes a missing tool as present is the one kind of residual that gets closed on paper.
- **§11.5** — the `TRUSTED_PROXY_HOPS` cross-file assertion is marked **required**. Task 4 landed it. Mark it shipped and name the test.
- **§11.6** — *"two boot checks Plan 2b must land, and one false claim to settle"*. Both landed, in Tasks 2 and 3. Mark it shipped; the section's reasoning about *why* they waited is worth keeping.
- Add a short **§11.10** in the shape of §11.9, recording what 2b shipped: the pipeline, the six routes, the bootstrap CLI, and the two things it deliberately did **not** do — `lib/authorization.js` holds the alias half only, and step 10's per-resource half is Plan 2c's.
- Add **§11.11**, detailed below. It is the section Part 5 departure (d) promises by name, and it is the one piece of this task that Plan 2c cannot start without. Write it first: if this step is interrupted, §11.10 is a summary somebody can reconstruct from the plan and §11.11 is not.

**§11.11 — what to write, and why it is not a note in the execution log.** Two decisions
were settled while executing this plan, both by reading the parent spec against itself
rather than by choosing. Neither belongs in a plan that is about to be marked done:
§11.5–§11.9 are the slice's amendment mechanism precisely because a decision recorded in
a finished plan is a decision nobody reads again. Write it in their shape — a `## 11.11`
heading, **Status:** line, the decision, then the reason stated as the failure it
prevents. It carries two things:

1. **The two-alias fix on the four identity routes.** `me`, `logout`, `logout-all` and
   `password` declare `["platform", "anyUser"]`. Give the failure, not the change: under
   plain `anyUser` the only account this plan creates cannot read its own identity, sign
   out, or change the password the CLI just set, because login always materialises
   `actingCompanyId: null` and §5.4's table excludes an *unscoped* `platform_admin`. Name
   the two repairs that were rejected and why — widening `anyUser` in `permits()` (it
   admits an unscoped scope to Plan 2c's tenant routes) and a fifth alias (`ROLE_ALIASES`
   is frozen at four and asserted twice). Record that §5.4 and §6.2 disagree and that the
   parent is amended at §6.2, not at §5.4.
2. **Nothing in Plan 2b produces `409 scope_required`, and that is Plan 2c's first
   problem.** This is the half that matters more, and it must be stated as a gap rather
   than implied by the first half. §6.3.3 promises **409 `scope_required`** when a tenant
   route is reached by an unscoped platform admin. Plan 2b registers no tenant route, so
   it builds no producer for that code, gives it no home in the pipeline, and no test
   asserts it — §6.3.5's step 10 note (departure (c)) defers the *per-resource* half to
   Plan 2c without noticing that the **scope-state** answer has no owner at all. The
   roughly twenty tenant routes Plan 2c registers at `anyUser` each need it, and the
   cheap wrong repair available at that moment — letting the unscoped admin through
   because the alias already admits them — is the security hole this slice just refused.
   Say where it should live: beside the role gate at step 7.5, reading `scope.kind`
   against whether the route binds a company. **Do not build it here.** Plan 2b has no
   route that could exercise it, and a producer with no consumer is untested code in the
   credential path.

- [ ] **Step 5: Run everything, then close the plan**

```bash
npm test
```

Expected: green across all four suites, with the counts recorded in the execution log
row. Then append that row: the date, what the session did, the last task finished, the
commits, and the next plan.

- [ ] **Step 6: Commit**

```bash
git add infra/README.md apps/core-api/README.md \
        apps/core-api/test/operations-docs.test.js apps/core-api/test/source-structure.test.js \
        apps/core-api/test/deploy-config.test.js apps/core-api/test/backup-restore.test.js \
        docs/superpowers/specs docs/superpowers/plans/2026-08-05-core-api-phase1-plan2b-authentication.md
git commit -m "docs(core-api): retire the Plan 2 markers, because Plan 2b made all of them false"
```

---
