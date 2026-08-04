"use strict";

// Reading a JSON request body, deliberately NOT express.json().
//
// http/router.js is the only file allowed to touch express (rule C3), and a
// service-wide body parser is a decision the plan that lands the first
// cookie-authenticated route has to make: it has to agree with the CSRF and
// Content-Type rules of spec §6.3, with the 413/415 vocabulary below, and with
// nginx's `client_max_body_size 64k`. Registering one now would settle that by
// accident. This settles nothing: it reads ONE request, on demand, and answers
// with codes db/errors.js already declares.
//
// Every refusal is an ApiError, so the code -> status pairing is checked by the
// constructor rather than written twice.

const { ApiError } = require("../db/errors");

// The same ceiling infra/nginx/api.conf sets with `client_max_body_size 64k`.
// Stated in both places on purpose: nginx sheds it before it reaches this
// process on the box, and this is what holds when the caller is another
// container on the compose network and never passes through nginx at all --
// which is exactly how apps/customer-order reaches this service.
const MAX_BODY_BYTES = 64 * 1024;

// Exactly the form http/respond.js emits, and exactly the form
// apps/customer-order/server.js already requires of its own callers. A bare
// `application/json` and one with the utf-8 charset are the whole accepted set;
// anything else is 415 rather than a parse attempt.
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const header = req.headers["content-type"];
    if (!JSON_CONTENT_TYPE.test(String(header || ""))) {
      reject(new ApiError(415, "unsupported_media_type"));
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      if (error) reject(error);
      else resolve(value);
    };

    function onData(chunk) {
      size += chunk.length;
      // Counted in BYTES off the wire, not in characters after decoding: a
      // multi-byte body would otherwise clear a character limit while occupying
      // several times the memory the limit was chosen to bound.
      if (size > maxBytes) {
        // finish() removes the listeners, so nothing further is BUFFERED --
        // memory is bounded at maxBytes, which is what the limit is for.
        finish(new ApiError(413, "payload_too_large"));
        // ...and then the rest is DRAINED rather than destroyed. req.destroy()
        // is the obvious call and it is wrong: it tears the socket down before
        // the 413 has been written, so the caller sees a transport failure
        // instead of a status it can act on. apps/customer-order reads the
        // status out of the message to decide whether to retry, and "fetch
        // failed" reads as transient -- so destroying here would turn a
        // permanent refusal into an infinite retry.
        //
        // The residual is time, not memory: a hostile sender can keep this
        // request open while we discard its bytes. nginx sheds those at
        // client_max_body_size 64k before they arrive, and the one caller that
        // bypasses nginx is another container on the compose network.
        req.resume();
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      const text = Buffer.concat(chunks).toString("utf8");
      // An empty body is {} rather than a parse error: a route that takes no
      // fields should not oblige its caller to send two braces.
      if (text.trim() === "") {
        finish(null, {});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        // The parser's own message names an offset and a character and is never
        // shown to the client -- invalid_json carries a fixed message.
        finish(new ApiError(400, "invalid_json"));
        return;
      }
      // A top-level array, string or null is not a body. Rejecting it here means
      // every route can read `body.field` without first proving body is an
      // object, which is the check that gets forgotten.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        finish(new ApiError(400, "invalid_json"));
        return;
      }
      finish(null, parsed);
    }

    function onError() {
      // A transport failure mid-body. Never surfaced verbatim: the message is a
      // Node errno string and the client gets the fixed invalid_request wording.
      finish(new ApiError(400, "invalid_request"));
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

module.exports = { readJsonBody, MAX_BODY_BYTES, JSON_CONTENT_TYPE };
