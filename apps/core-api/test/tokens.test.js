"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { mintToken, hashToken, TOKEN_BYTES, TOKEN_LENGTH } = require("../lib/tokens");

test("a minted token is 22 Base64URL characters", () => {
  // Both constants, so neither is public surface that nothing holds to account.
  // 128 bits is the strength this credential is claimed to have; 22 is what
  // unpadded Base64URL makes of it.
  assert.equal(TOKEN_BYTES, 16);
  assert.equal(TOKEN_LENGTH, 22);
  for (let i = 0; i < 200; i += 1) {
    const token = mintToken();
    assert.equal(token.length, 22);
    // Base64URL only: no +, no /, no =. A token that reaches a URL fragment
    // must survive it without escaping.
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  }
});

test("minted tokens do not repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i += 1) seen.add(mintToken());
  assert.equal(seen.size, 1000);
});

test("hashToken returns a 32-byte Buffer, not hex text", () => {
  const digest = hashToken("abc");
  assert.ok(Buffer.isBuffer(digest), "hashToken must return a Buffer so pg binds bytea");
  assert.equal(digest.length, 32);
});

test("hashToken is the plain SHA-256 of the raw value", () => {
  // Pinned against a known vector, so a future "improvement" to a salted or
  // keyed digest cannot land silently and orphan every stored row.
  assert.equal(
    hashToken("abc").toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("hashToken is deterministic and input-sensitive", () => {
  assert.deepEqual(hashToken("same"), hashToken("same"));
  assert.notDeepEqual(hashToken("a"), hashToken("b"));
});

test("hashToken refuses a non-string, so a Buffer or null cannot hash to a constant", () => {
  for (const bad of [null, undefined, 42, Buffer.from("x"), {}]) {
    assert.throws(() => hashToken(bad), /hashToken requires a string/);
  }
});
