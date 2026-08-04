"use strict";

const assert = require("node:assert/strict");
const { isIP } = require("node:net");
const { test } = require("node:test");

const { deriveClientIp, UNTRUSTED_BUCKET_KEY } = require("../lib/client-ip");

const derive = (header, hops) => deriveClientIp({ header, trustedProxyHops: hops, isIP });

test("one trusted hop takes the rightmost entry", () => {
  assert.deepEqual(derive("203.0.113.9", 1), {
    ip: "203.0.113.9",
    bucketKey: "203.0.113.9",
    trusted: true
  });
  // The attacker prepends; the rightmost entry is the one Nginx wrote.
  assert.deepEqual(derive("1.1.1.1, 203.0.113.9", 1), {
    ip: "203.0.113.9",
    bucketKey: "203.0.113.9",
    trusted: true
  });
});

test("two trusted hops take the second from the right", () => {
  assert.deepEqual(derive("9.9.9.9, 203.0.113.9, 10.0.0.1", 2), {
    ip: "203.0.113.9",
    bucketKey: "203.0.113.9",
    trusted: true
  });
});

test("forging cannot move the selected entry", () => {
  // Whatever the client prepends, one hop always selects what the proxy appended.
  for (const forged of ["", "8.8.8.8", "8.8.8.8, 9.9.9.9", "not-an-ip", ", ,"]) {
    const header = forged === "" ? "203.0.113.9" : `${forged}, 203.0.113.9`;
    assert.equal(derive(header, 1).ip, "203.0.113.9");
  }
});

test("an absent header is untrusted, and fails CLOSED for the bucket", () => {
  for (const header of [undefined, null, "", "   "]) {
    assert.deepEqual(derive(header, 1), {
      // NULL in the audit row: fail-soft, because a wrong address is worse
      // than a missing one.
      ip: null,
      // One shared bucket: fail-CLOSED, so an attacker cannot escape the
      // throttle by stripping the header.
      bucketKey: UNTRUSTED_BUCKET_KEY,
      trusted: false
    });
  }
});

test("fewer entries than the hop count is untrusted", () => {
  assert.deepEqual(derive("203.0.113.9", 2), {
    ip: null,
    bucketKey: UNTRUSTED_BUCKET_KEY,
    trusted: false
  });
});

test("a selected entry that is not an IP is untrusted", () => {
  // The failure this prevents: writing the raw comma-separated header into an
  // inet column raises "invalid input syntax for type inet" INSIDE the login
  // transaction, failing login outright for anyone behind two proxies.
  for (const bad of ["banana", "203.0.113.9:443", "203.0.113.999", "<script>"]) {
    assert.deepEqual(derive(`1.1.1.1, ${bad}`, 1), {
      ip: null,
      bucketKey: UNTRUSTED_BUCKET_KEY,
      trusted: false
    });
  }
});

test("IPv6 is accepted, and surrounding whitespace is tolerated", () => {
  assert.deepEqual(derive("  2001:db8::1  ", 1), {
    ip: "2001:db8::1",
    bucketKey: "2001:db8::1",
    trusted: true
  });
});

test("zero hops is untrusted for every input", () => {
  // TRUSTED_PROXY_HOPS=0 means "no proxy is trusted", so no entry may be
  // believed. config.js allows 0 as the development default.
  assert.equal(derive("203.0.113.9", 0).trusted, false);
  assert.equal(derive("203.0.113.9", 0).bucketKey, UNTRUSTED_BUCKET_KEY);
});

test("an array-valued header is refused rather than stringified", () => {
  // Node exposes a repeated header as an array. String(["a","b"]) is "a,b",
  // which would silently invent an entry that no proxy wrote.
  assert.deepEqual(derive(["1.1.1.1", "203.0.113.9"], 1), {
    ip: null,
    bucketKey: UNTRUSTED_BUCKET_KEY,
    trusted: false
  });
});

test("the hop count is validated", () => {
  for (const bad of [-1, 1.5, "1", null, undefined]) {
    assert.throws(
      () => deriveClientIp({ header: "203.0.113.9", trustedProxyHops: bad, isIP }),
      /trustedProxyHops must be a non-negative integer/
    );
  }
});

test("isIP must be supplied, because lib/ may not require node:net", () => {
  assert.throws(
    () => deriveClientIp({ header: "203.0.113.9", trustedProxyHops: 1 }),
    /isIP must be a function/
  );
});
