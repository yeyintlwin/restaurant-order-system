"use strict";

// The logo files on disk. No database, no HTTP -- this file knows a directory and a
// set of bytes, and nothing about who those bytes belong to.
//
// It is NOT under lib/, and C9 is why: lib/ is Tier 1, pure, and may not require
// node:fs. This is the same shape of boundary epaper/ draws around the one file
// allowed to reach the hub -- an area named for the thing outside the process that it
// is the only file permitted to touch.
//
// THE NAME IS THE CONTENT. A key is the SHA-256 of the file plus its extension, which
// buys three things at once:
//
//   * the same image uploaded for two branches is one file;
//   * "is this file still needed" is a question about the two logo_key columns and
//     nothing else -- no reference count on disk to drift out of step;
//   * writing can never overwrite a file some other record is pointing at, because
//     identical names mean identical bytes.
//
// WHAT IS NOT ACCEPTED, and why. SVG is an executable document: it carries <script>
// and external references, and it would be served from the same origin as the console.
// A logo is a picture, so the three formats that can only ever be a picture are the
// three that are allowed. The type is decided by SNIFFING THE BYTES rather than by
// reading Content-Type -- a header is a claim by the caller, and this is the one
// place where believing it puts a chosen file on our disk under a chosen name.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// The key shape, identical to the CHECK on the logo_key domain in 0004. Two copies,
// and they are only correct while they are the same: this one refuses a bad key
// before it reaches a filesystem path, and the constraint refuses one that got past
// a bug here.
const KEY_PATTERN = /^[0-9a-f]{64}\.(png|jpg|webp)$/;

// Magic bytes, longest first so a prefix cannot shadow a longer signature.
const SIGNATURES = [
  { extension: "png", contentType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { extension: "jpg", contentType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] }
];

// 2 MB. A logo is drawn at 40 pixels in the rail and a few hundred on a receipt; a
// file bigger than this is a photograph somebody dropped in by mistake, and the
// honest answer is to say so rather than to store it.
const MAX_BYTES = 2 * 1024 * 1024;

class LogoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// WebP is the awkward one: "RIFF" then four bytes of length then "WEBP", so the
// signature is split. Checked separately rather than bent into the table above.
function sniff(buffer) {
  for (const signature of SIGNATURES) {
    if (buffer.length < signature.bytes.length) continue;
    if (signature.bytes.every((byte, index) => buffer[index] === byte)) return signature;
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
}

const CONTENT_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp"
});

function contentTypeFor(key) {
  return CONTENT_TYPES[key.slice(65)] || "application/octet-stream";
}

function isKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

// Resolve, THEN check -- the same order db/health.js and the admin proxy use, and for
// the same reason. Rejecting ".." by string match is the version that ships a
// traversal: "..%2f" is one decoded segment and a symlink defeats a textual check
// anyway. Belt and braces on top of KEY_PATTERN, because this is the line that turns
// a string into a path.
function resolveWithin(root, key) {
  if (!isKey(key)) throw new LogoError("not_an_image", `not a logo key: ${JSON.stringify(key)}`);
  const resolved = path.resolve(root, key);
  const base = path.resolve(root) + path.sep;
  if (!resolved.startsWith(base)) throw new LogoError("not_an_image", "key escapes the logo directory");
  return resolved;
}

function createLogoStore({ root }) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("createLogoStore: a root directory is required");
  }

  async function ensureRoot() {
    await fs.mkdir(root, { recursive: true });
  }

  // Returns the key. Writing the same bytes twice is a no-op that returns the same
  // name, which is what makes "two branches, one mark" cost one file.
  async function save(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new LogoError("not_an_image", "empty upload");
    }
    if (buffer.length > MAX_BYTES) {
      throw new LogoError("too_large", `logo is larger than ${MAX_BYTES} bytes`);
    }
    const signature = sniff(buffer);
    if (signature === null) {
      throw new LogoError("not_an_image", "not a PNG, JPEG or WebP");
    }

    const key = `${crypto.createHash("sha256").update(buffer).digest("hex")}.${signature.extension}`;
    await ensureRoot();
    // wx: fail if it exists. An existing file has the same SHA-256, so it already
    // holds these exact bytes and rewriting it would be pure risk -- a torn write
    // over a file three records are pointing at.
    try {
      await fs.writeFile(resolveWithin(root, key), buffer, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return key;
  }

  async function read(key) {
    try {
      return await fs.readFile(resolveWithin(root, key));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  // ENOENT is success. The caller's question is "make sure this is gone", and a file
  // that was never written -- or that two concurrent deletes both reached -- answers
  // it. Anything else is a real filesystem problem and is not swallowed.
  async function remove(key) {
    try {
      await fs.unlink(resolveWithin(root, key));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  return { save, read, remove, root };
}

module.exports = {
  createLogoStore,
  LogoError,
  isKey,
  sniff,
  contentTypeFor,
  KEY_PATTERN,
  MAX_BYTES
};
