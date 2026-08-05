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
