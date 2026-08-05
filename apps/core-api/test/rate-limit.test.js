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
