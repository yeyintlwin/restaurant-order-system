"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  hashPassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  SCRYPT_PARAMS
} = require("../lib/password");

test("the parameters are the ones the spec fixed", () => {
  assert.deepEqual(SCRYPT_PARAMS, { N: 32768, r: 8, p: 1, dkLen: 32 });
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  assert.equal(PASSWORD_MAX_LENGTH, 256);
});

test("a hash is a self-describing PHC-style string the column CHECK accepts", async () => {
  const stored = await hashPassword("correct horse battery staple");

  // users.password_hash CHECK: LIKE 'scrypt$%' AND length BETWEEN 40 AND 512.
  assert.ok(stored.startsWith("scrypt$"));
  assert.ok(stored.length >= 40 && stored.length <= 512, `length was ${stored.length}`);

  const [scheme, params, salt, key] = stored.split("$");
  assert.equal(scheme, "scrypt");
  assert.equal(params, "N=32768,r=8,p=1");
  // 16-byte salt and 32-byte key, both Base64URL.
  assert.match(salt, /^[A-Za-z0-9_-]{22}$/);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
});

test("the salt is random, so two hashes of one password differ", async () => {
  const a = await hashPassword("correct horse battery staple");
  const b = await hashPassword("correct horse battery staple");
  assert.notEqual(a, b);
});

test("the policy is enforced at both ends", async () => {
  await assert.rejects(() => hashPassword("short"), /too_short/);
  await assert.rejects(() => hashPassword("a".repeat(257)), /too_long/);
  // Exactly at the bounds is accepted.
  assert.ok(await hashPassword("a".repeat(12)));
  assert.ok(await hashPassword("a".repeat(256)));
});

test("a non-string is refused rather than coerced", async () => {
  for (const bad of [null, undefined, 12345678901234, {}]) {
    await assert.rejects(() => hashPassword(bad), /hashPassword requires a string/);
  }
});

test("the input is NFKC-normalised, so two spellings of one password agree", async () => {
  // U+FF41 FULLWIDTH LATIN SMALL LETTER A normalises to "a" under NFKC. Without
  // normalisation a password typed on a Japanese IME would hash differently
  // from the same password typed on an ASCII keyboard.
  const wide = "ａ".repeat(12);
  const stored = await hashPassword(wide);
  const [, , salt] = stored.split("$");
  const again = await hashPassword("a".repeat(12), Buffer.from(salt, "base64url"));
  assert.equal(stored, again);
});

test("maxmem is raised, or scrypt throws at exactly these parameters", async () => {
  // 128 * N * r is exactly 33,554,432 bytes and Node's default maxmem is
  // exactly 32 MiB. This test is the regression guard for the one-line trap.
  assert.equal(128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r, 33554432);
  await assert.doesNotReject(() => hashPassword("a".repeat(12)));
});
