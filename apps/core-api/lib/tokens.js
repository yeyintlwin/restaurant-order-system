"use strict";

// PURE (Tier 1): no database, no filesystem, no network, no ambient clock.
// node:crypto is permitted -- C9's IMPURE_REQUIRE bans node:fs, node:http(s),
// node:net, pg and ../db/*, and a CSPRNG is none of those.
//
// The house credential shape, used by user_sessions, terminal_tokens and
// user_email_tokens alike: 16 random bytes rendered as 22 Base64URL characters,
// with only the SHA-256 ever stored.
//
// SHA-256 is correct HERE and catastrophically wrong for passwords. The
// distinction is the preimage space: a fast hash over 2^128 random bits is not
// brute-forceable, while the same hash over a ~30-bit human password is. See
// lib/password.js.
const crypto = require("node:crypto");

const TOKEN_BYTES = 16;
// Derived, not a second literal: unpadded Base64URL emits one character per 6
// bits. Two independent constants can drift; this pair cannot.
const TOKEN_LENGTH = Math.ceil((TOKEN_BYTES * 8) / 6);

function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

// Returns a Buffer, never hex text. The column is bytea(32), so binding a raw
// credential by mistake raises "invalid input syntax for type bytea" instead of
// silently matching zero rows -- a loud failure rather than a quiet one.
function hashToken(raw) {
  if (typeof raw !== "string") {
    throw new Error(`hashToken requires a string, got ${raw === null ? "null" : typeof raw}`);
  }
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

module.exports = { mintToken, hashToken, TOKEN_BYTES, TOKEN_LENGTH };
