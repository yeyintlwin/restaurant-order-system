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

const STORED_PATTERN = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

// Never throws. A malformed row, a wrong password and an unknown scheme are all
// `false`, because the caller is an unauthenticated route whose failure modes
// must be indistinguishable -- a 500 where a 401 belongs is an oracle.
//
// The length policy is deliberately NOT applied here. It guards what is
// written; applying it on the read path would lock out every existing account
// the day the minimum is raised.
async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;

  const match = STORED_PATTERN.exec(stored);
  if (match === null) return false;

  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  const salt = Buffer.from(match[4], "base64url");
  const expected = Buffer.from(match[5], "base64url");

  // A row claiming absurd parameters must not be allowed to allocate them.
  // 128 * N * r must stay inside SCRYPT_MAXMEM, and N must be a power of two
  // greater than one or scrypt rejects it with a less legible error.
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return false;
  if (128 * N * r > SCRYPT_MAXMEM) return false;
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = await new Promise((resolve, reject) => {
      crypto.scrypt(
        password.normalize("NFKC"),
        salt,
        expected.length,
        { N, r, p, maxmem: SCRYPT_MAXMEM },
        (error, key) => (error ? reject(error) : resolve(key))
      );
    });
  } catch {
    return false;
  }

  // Both buffers are the same length by construction above, which is what
  // timingSafeEqual requires -- it throws on a length mismatch rather than
  // returning false.
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = {
  hashPassword,
  verifyPassword,
  PasswordPolicyError,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  SCRYPT_PARAMS,
  SCRYPT_MAXMEM,
  SALT_BYTES
};
