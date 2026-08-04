"use strict";

// PURE (Tier 1). `isIP` is an ARGUMENT rather than a require, because rule C9
// bans node:net under lib/ and the validation still has to be the real one --
// a hand-written IPv6 matcher is exactly the kind of thing that is subtly wrong
// for years. http/ supplies require("node:net").isIP.

// One shared bucket for every request whose address could not be derived. This
// is the STRICTEST option and it is deliberate: an attacker who strips the
// header lands in the same bucket as every other such request, so removing the
// header cannot be used to escape a throttle.
const UNTRUSTED_BUCKET_KEY = "unknown";

const UNTRUSTED = Object.freeze({ ip: null, bucketKey: UNTRUSTED_BUCKET_KEY, trusted: false });

// Counted from the RIGHT: entries to the left of the trusted hops are whatever
// the client sent, and the rightmost `trustedProxyHops` entries are what our own
// proxies appended.
function deriveClientIp({ header, trustedProxyHops, isIP }) {
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0) {
    throw new Error(
      `deriveClientIp: trustedProxyHops must be a non-negative integer, got ${JSON.stringify(
        trustedProxyHops
      )}`
    );
  }
  if (typeof isIP !== "function") {
    throw new Error("deriveClientIp: isIP must be a function (lib/ may not require node:net)");
  }

  // No proxy is trusted, so no entry may be believed.
  if (trustedProxyHops === 0) return UNTRUSTED;

  // A repeated header arrives as an array. Stringifying it would join with a
  // comma and invent an entry boundary no proxy wrote.
  if (typeof header !== "string") return UNTRUSTED;

  const entries = header.split(",").map((entry) => entry.trim());
  if (entries.length < trustedProxyHops) return UNTRUSTED;

  const candidate = entries[entries.length - trustedProxyHops];
  if (candidate === undefined || isIP(candidate) === 0) return UNTRUSTED;

  return { ip: candidate, bucketKey: candidate, trusted: true };
}

module.exports = { deriveClientIp, UNTRUSTED_BUCKET_KEY };
