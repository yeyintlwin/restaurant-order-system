"use strict";

// PURE (Tier 1). node:crypto only.
//
// A deliberate DEPARTURE from the repository's single-round SHA-256 credential
// convention, and the departure is the point. SHA-256 is correct for the 128-bit
// random tokens in lib/tokens.js -- a fast hash over a 2^128 preimage space is
// not brute-forceable -- and catastrophically wrong for a ~30-bit human
// password. scrypt is memory-hard, ships in node:crypto, and runs on the libuv
// threadpool rather than the event loop.
const crypto = require("node:crypto");

const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, dkLen: 32 });

// 128 * N * r is exactly 33,554,432 bytes and Node's default scrypt maxmem is
// exactly 32 MiB, so the call throws at these parameters unless maxmem is
// raised. This is the single most likely way to ship a service that hashes
// nothing.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const SALT_BYTES = 16;
const PASSWORD_MIN_LENGTH = 12;
// The maximum exists to bound scrypt work reachable from an unauthenticated
// route, not because long passwords are bad.
const PASSWORD_MAX_LENGTH = 256;

class PasswordPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "PasswordPolicyError";
    this.code = code;
  }
}

function normalise(password) {
  if (typeof password !== "string") {
    throw new Error(
      `hashPassword requires a string, got ${password === null ? "null" : typeof password}`
    );
  }
  // NFKC before measuring AND before hashing, so the length policy and the
  // digest agree about what the password is.
  const normalised = password.normalize("NFKC");
  if (normalised.length < PASSWORD_MIN_LENGTH) throw new PasswordPolicyError("too_short");
  if (normalised.length > PASSWORD_MAX_LENGTH) throw new PasswordPolicyError("too_long");
  return normalised;
}

function derive(password, salt) {
  const { N, r, p, dkLen } = SCRYPT_PARAMS;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, dkLen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (error, key) =>
      error ? reject(error) : resolve(key)
    );
  });
}

// `salt` is a parameter so the test can prove normalisation without reaching
// into the module. Production callers pass nothing and get a random salt.
async function hashPassword(password, salt = crypto.randomBytes(SALT_BYTES)) {
  const normalised = normalise(password);
  const key = await derive(normalised, salt);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$N=${N},r=${r},p=${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

module.exports = {
  hashPassword,
  PasswordPolicyError,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  SCRYPT_PARAMS,
  SCRYPT_MAXMEM,
  SALT_BYTES
};
