# Core API Phase 1 — Plan 2b: Authentication, Sessions and the Request Pipeline

> ## ⚠️ THIS PLAN IS INCOMPLETE — DO NOT EXECUTE IT YET
>
> Writing stopped mid-document when the authoring session was cut off by an API
> error. **Tasks 1–9 are written and appear complete; Part 4 ("The pipeline") has
> its heading and nothing under it.** Nothing has been implemented and nothing here
> has been reviewed.
>
> **What is missing**, from the brief this was written against:
>
> - Part 4 — the §6.3.5 pipeline: `http/authenticate.js`, and wiring `lib/semaphore.js`
>   into the scrypt path.
> - The six routes: `POST /api/admin/auth/{login,logout,logout-all,password}`,
>   `GET /api/admin/auth/me`, `POST /api/admin/scope`.
> - **The deploy tripwire.** Registering `POST /api/admin/auth/login` trips
>   `deploy-config.test.js`, because the deploy's block-4 probe expects a 404 there.
>   `deploy.yml`, that test and the route must move in ONE commit or the deploy
>   aborts *after* the migration has applied. This is the single most dangerous task
>   in the plan and it is not written.
> - `scripts/create-platform-admin.js` (§5.6).
> - The §5.7 limiter roster and the `limit.name` boot check — §5.7 claims `route()`
>   already rejects unknown limiter names and **it does not**.
> - The audit-vocabulary membership check (see spec §11.6 for why it was written,
>   reverted, and is waiting).
> - The `TRUSTED_PROXY_HOPS` cross-file assertion — spec §11.5 marks it **required**.
> - The whole-plan self-review: spec coverage, type consistency across tasks.
>
> **To finish it:** read Tasks 1–9 first so you do not duplicate them, then continue
> from Part 4. The spec sections are named in each bullet above.


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
(`isIP`, supplied to `lib/client-ip.js` from `http/`), `node:readline` (the
bootstrap CLI's echo-off prompt), PostgreSQL 16, `node --test` +
`node:assert/strict`. **No new npm dependency, and no new configuration variable** —
see "Why 2b adds no config" below.

**Spec:** [2026-08-04-core-api-identity-slice-design.md](../specs/2026-08-04-core-api-identity-slice-design.md),
whose §11.5–§11.9 are the amendments this plan carries out. Bare section
references (§5.1, §6.3.5, §8.5) point at the **parent**,
[2026-07-29-core-api-phase1-design.md](../specs/2026-07-29-core-api-phase1-design.md).

---

## Execution log

**Status: 0 of 17 tasks done. NOT STARTED.**

Append one row per working session. A task counts as finished only when all of its
steps are ticked and its commit exists.

| Date | Session did | Tasks finished | Commits | Next |
| --- | --- | --- | --- | --- |
| | | **0/17** | | Task 1 |

Baseline at the head of this plan, measured: **14 / 33 / 69 / 392**, 0 failures,
1 skip (C6, guarded on `repositories/platform/`, which arms in Plan 2c).

---

## How to pick this up

**The checkboxes are the state.** Tick them as you go and commit the plan file
with the code. There is no other progress tracker.

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

Tasks 1–6 and 10 need no database. Tasks 7, 8, 9 and 11–17 do.

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
`TRUSTED_PROXY_HOPS`, `API_PUBLIC_ORIGIN`. Plan 1 defaulted them for exactly this
plan.

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
| `apps/core-api/http/router.js` | Roster boot check; vocabulary boot check; the §6.3.5 pipeline | 2, 3, 11 |
| `apps/core-api/lib/audit-vocabulary.js` | The nine actions 2b's routes and CLI emit | 3 |
| `apps/core-api/test/nginx-config.test.js` | §11.5's `TRUSTED_PROXY_HOPS` ↔ proxy-depth assertion | 4 |
| `apps/core-api/http/cookies.js` | Collect every value for a name; build the `__Host-` cookie | 5 |
| `apps/core-api/http/csrf.js` | The amended §5.3 rule, gated on the channel | 6 |
| `apps/core-api/repositories/auth/users.js` | Login lookup, atomic backoff, password write | 7 |
| `apps/core-api/repositories/auth/sessions.js` | create / resolve / renew / delete / acting company | 8 |
| `apps/core-api/repositories/auth/scope-materialize.js` | `shopIds` and `administeredShopIds` | 9 |
| `apps/core-api/http/authenticate.js` | Cookie resolution, strict channel binding, read-only | 10 |
| `apps/core-api/http/routes/auth.js` | The six routes | 12–15 |
| `apps/core-api/scripts/create-platform-admin.js` | §5.6/§9.10 bootstrap CLI | 16 |

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

- [ ] **Step 1: Write the failing test**

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

test("every roster entry declares a key, a window, a Retry-After policy and a bucket", () => {
  for (const [name, entry] of Object.entries(LIMITERS)) {
    assert.ok(["ip", "user", "terminal"].includes(entry.key), `${name} keys on ${entry.key}`);
    assert.ok(Number.isInteger(entry.windowMs) && entry.windowMs > 0, `${name} window`);
    assert.equal(typeof entry.retryAfter, "boolean", `${name} retryAfter`);
    assert.ok(["request", "failure"].includes(entry.consume), `${name} consume`);
    assert.ok(Object.prototype.hasOwnProperty.call(LIMITERS, entry.bucket), `${name} bucket`);
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

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/rate-limit.test.js
```

Expected: FAIL — `Cannot find module '../lib/rate-limit'`.

- [ ] **Step 3: Write the module**

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
function limiter(key, windowMs, retryAfter, consume, bucket) {
  return Object.freeze({ key, windowMs, retryAfter, consume, bucket });
}

const LIMITERS = Object.freeze({
  // Retry-After is deliberately absent on both credential-independent buckets:
  // the header would confirm to an attacker that their probes are landing, and
  // login and pair are the two 429s spec 6.2 marks as carrying no Retry-After.
  "login-global": limiter("ip", MINUTE, false, "request", "login-global"),
  "pair-global": limiter("ip", MINUTE, false, "request", "pair-global"),
  "create-user": limiter("user", TEN_MINUTES, true, "request", "create-user"),
  "password-reset": limiter("user", TEN_MINUTES, true, "request", "create-user"),
  "pairing-code-mint": limiter("user", TEN_MINUTES, true, "request", "pairing-code-mint"),
  "password-change-abuse": limiter("user", HOUR, true, "failure", "password-change-abuse"),
  "token-rotate": limiter("terminal", HOUR, true, "request", "token-rotate")
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

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/rate-limit.test.js apps/core-api/test/source-structure.test.js
```

Expected: both pass. `source-structure.test.js` is run because C9 (impure require)
and C14 (weak randomness) now have one more `lib/` file to scan and must stay
green, and because the walker floor is a **minimum** — 26 scanned files clears the
floor of 25, so nothing breaks here. The floor is raised to its new exact value in
Task 17.

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/router-registration.test.js
```

Expected: FAIL — three of the four new cases report
`Missing expected exception`; `validateRouteTable` currently returns the entries
unchanged for all of them.

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/router-registration.test.js apps/core-api/test/route-auth.test.js apps/core-api/test/rate-limit.test.js
```

Expected: all pass. `route-auth.test.js` is unaffected — no registered route
declares a `limit` yet.

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/audit-vocabulary.test.js apps/core-api/test/router-registration.test.js
```

Expected: FAIL — the nine actions are undeclared, and the two membership cases
report `Missing expected exception`.

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run the tests to verify they pass**

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

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Write the failing test**

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
  const apiConf = readText(repoRoot, "infra", "nginx", "api.conf");
  const snippet = readText(repoRoot, "infra", "nginx", "core-api-proxy.conf");

  // (1) Exactly one hop is APPENDED. $proxy_add_x_forwarded_for is the incoming
  //     header with $remote_addr appended on the right, so one occurrence of it
  //     in the one snippet every proxying location includes means the chain grows
  //     by exactly one entry between the client and core-api.
  const appends = (snippet.match(/\$proxy_add_x_forwarded_for/g) || []).length;
  assert.equal(appends, 1, "core-api-proxy.conf must append X-Forwarded-For exactly once");

  // (2) There is no SECOND proxy layer. api.conf never proxy_passes directly (a
  //     bare proxy_pass would set no X-Forwarded-For at all and pass the client's
  //     own header straight through), and the snippet's single proxy_pass names
  //     the upstream group rather than another nginx.
  assert.doesNotMatch(apiConf, /proxy_pass/, "api.conf must proxy only through the snippet");
  assert.equal((snippet.match(/^[ \t]*proxy_pass\s/gm) || []).length, 1);
  assert.match(snippet, /^proxy_pass http:\/\/core_api;$/m);

  // (3) Nothing rewrites $remote_addr before the chain is built. With
  //     real_ip_header set, a forged header gets appended to ITSELF and a
  //     one-from-the-right read returns the attacker's value -- so the deployed
  //     depth would no longer be derivable from the two facts above.
  for (const [label, text] of [["api.conf", apiConf], ["core-api-proxy.conf", snippet]]) {
    assert.doesNotMatch(text, /\breal_ip_header\b/, `${label} carries real_ip_header`);
    assert.doesNotMatch(text, /\bset_real_ip_from\b/, `${label} carries set_real_ip_from`);
  }

  // The deployed depth, DERIVED from the three facts rather than restated.
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

> `readText` and `repoRoot` already exist at the top of `nginx-config.test.js`.
> Confirm with `grep -n "function readText\|const repoRoot" apps/core-api/test/nginx-config.test.js`
> before pasting; if the helper is named differently, use the file's own.

- [ ] **Step 2: Run test to verify it fails**

Temporarily change `docker-compose.yml`'s `TRUSTED_PROXY_HOPS: 1` to `2`, then:

```bash
node --test apps/core-api/test/nginx-config.test.js
```

Expected: FAIL — `docker-compose.yml sets TRUSTED_PROXY_HOPS=2 but infra/nginx
deploys 1 proxy hop(s)`. **Revert the compose edit immediately** — it is a
production file and `config.test.js` reads it too.

- [ ] **Step 3: Implement**

Nothing to implement. The assertion passes against the tree as it stands; Step 2 is
the proof it is not vacuous. This is the one task in this plan whose deliverable is
the test.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
git diff --stat docker-compose.yml
node --test apps/core-api/test/nginx-config.test.js apps/core-api/test/config.test.js
```

Expected: `git diff --stat` prints nothing (the Step 2 edit is reverted), and both
suites pass.

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/cookies.test.js
```

Expected: FAIL — `Cannot find module '../http/cookies'`.

- [ ] **Step 3: Write the module**

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

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/cookies.test.js apps/core-api/test/source-structure.test.js
```

Expected: both pass.

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/csrf.test.js
```

Expected: FAIL — `Cannot find module '../http/csrf'`.

- [ ] **Step 3: Write the module**

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

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/csrf.test.js apps/core-api/test/body.test.js apps/core-api/test/source-structure.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Write the failing test**

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

test("the bootstrap insert is monotonic and returns null on the second run", { skip }, async () => {
  const hash = await hashPassword("bootstrap-password-1");
  const first = await users.insertPlatformAdmin({
    email: "boot@example.test",
    displayName: "Boot",
    passwordHash: hash
  });
  assert.ok(first && first.id);

  // Same address: users_email_key is UNCONDITIONAL (email is identity), so this is
  // a 23505 and the repository turns it into null rather than letting a raw
  // driver error reach a CLI that would print a constraint name.
  const second = await users.insertPlatformAdmin({
    email: "boot@example.test",
    displayName: "Boot",
    passwordHash: hash
  });
  assert.equal(second, null);
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

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/auth-users.test.js
```

Expected: FAIL — `Cannot find module '../repositories/auth/users'`.

- [ ] **Step 3: Write the module**

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

// ON CONFLICT DO NOTHING, so a second run of scripts/create-platform-admin.js is a
// null rather than a 23505 the CLI would have to translate. users_email_key is
// UNCONDITIONAL (spec: email is identity, and freeing a suspended user's address
// would let a second row shadow the first in the login lookup), so this is the
// only conflict reachable.
//
// NAMED insertPlatformAdmin, not createPlatformAdmin, and the difference is
// load-bearing: source-structure.test.js rule C6 budgets repositories/platform/ at
// exactly ten exported functions and `createPlatformAdmin` is one of them, arriving
// in Plan 2c with POST /api/platform/admins. Two functions with one name in two
// exempt zones is the kind of collision that gets "fixed" by widening C6.
const INSERT_PLATFORM_ADMIN = `
  INSERT INTO users (company_id, role, email, display_name, password_hash, must_change_password)
  VALUES (NULL, 'platform_admin', lower(btrim($1)), $2, $3, false)
  ON CONFLICT DO NOTHING
  RETURNING id, email, display_name AS "displayName"
`;

async function insertPlatformAdmin({ email, displayName, passwordHash }) {
  return withUnscopedConnection(async (connection) => {
    const { rows } = await connection.query(INSERT_PLATFORM_ADMIN, [email, displayName, passwordHash]);
    return rows.length === 0 ? null : rows[0];
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
  insertPlatformAdmin,
  countActivePlatformAdmins
};
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/auth-users.test.js apps/core-api/test/source-structure.test.js
```

Expected: both pass. **`source-structure.test.js` is not optional here** — it is
the only thing that catches a callback named `client`, and C4's allowlist already
names this file so nothing else would.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/repositories/auth/users.js apps/core-api/test/auth-users.test.js
git commit -m "feat(core-api): the login lookup, and a backoff whose cast cannot overflow"
```

---

### Task 8: `repositories/auth/sessions.js`

**Files:**

- Create: `apps/core-api/repositories/auth/sessions.js`
- Create: `apps/core-api/test/auth-sessions.test.js`

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/auth-sessions.test.js
```

Expected: FAIL — `Cannot find module '../repositories/auth/sessions'`.

- [ ] **Step 3: Write the module**

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

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/auth-sessions.test.js apps/core-api/test/source-structure.test.js
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/repositories/auth/sessions.js apps/core-api/test/auth-sessions.test.js
git commit -m "feat(core-api): sessions - read-only resolution, and a renewal SQL clamps itself"
```

---

### Task 9: `repositories/auth/scope-materialize.js`

**Files:**

- Create: `apps/core-api/repositories/auth/scope-materialize.js`
- Create: `apps/core-api/test/scope-materialize.test.js`

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/scope-materialize.test.js
```

Expected: FAIL — `Cannot find module '../repositories/auth/scope-materialize'`.

- [ ] **Step 3: Write the module**

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

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/scope-materialize.test.js apps/core-api/test/scope.test.js apps/core-api/test/source-structure.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/repositories/auth/scope-materialize.js apps/core-api/test/scope-materialize.test.js
git commit -m "feat(core-api): materialise the scope, with [] and never null for zero shops"
```

---

## Part 4 — The pipeline

<!-- PART-BREAK -->


