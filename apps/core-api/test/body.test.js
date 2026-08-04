"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { readJsonBody, MAX_BODY_BYTES } = require("../http/body");

// http/body.js exists instead of express.json(), and the reason is a scoping decision
// rather than a preference: http/router.js is the only file allowed to touch express
// (rule C3), so registering a parser there would settle the service-wide question -- the
// CSRF and Content-Type rules of spec §6.3, the 413/415 codes, the interaction with
// nginx's client_max_body_size -- as a side effect of the first route that needed a body.
// This reads one request on demand and settles nothing.
//
// Driven off a fake IncomingMessage rather than a live server: every refusal here is a
// property of the reader, and a socket in the middle only adds ways for a test to be
// green for the wrong reason. The route's end of it is graded over real HTTP in
// test/table-displays.test.js.

function request(body, contentType = "application/json") {
  const stream = new EventEmitter();
  stream.headers = contentType === null ? {} : { "content-type": contentType };
  stream.resume = () => {
    stream.resumed = true;
  };
  stream.emitBody = (chunks) => {
    for (const chunk of chunks) stream.emit("data", Buffer.from(chunk));
    stream.emit("end");
  };
  process.nextTick(() => {
    if (body === undefined) stream.emit("end");
    else stream.emitBody(Array.isArray(body) ? body : [body]);
  });
  return stream;
}

test("a well-formed JSON object is parsed", async () => {
  assert.deepEqual(await readJsonBody(request('{"status":"Welcome"}')), { status: "Welcome" });
});

test("a body split across chunks is reassembled before parsing", async () => {
  // The failure this catches is a reader that parses each chunk: a body that arrives in
  // two TCP segments is not two JSON documents, and the split point depends on the
  // network rather than on anything a test would normally vary.
  assert.deepEqual(await readJsonBody(request(['{"status":"Wel', 'come"}'])), { status: "Welcome" });
});

test("an empty body is an empty object, not a parse error", async () => {
  // A route that takes no fields should not oblige its caller to send two braces.
  assert.deepEqual(await readJsonBody(request(undefined)), {});
  assert.deepEqual(await readJsonBody(request("   ")), {});
});

test("only application/json is accepted, and the refusal is 415", async () => {
  assert.deepEqual(await readJsonBody(request("{}", "application/json; charset=utf-8")), {});
  assert.deepEqual(await readJsonBody(request("{}", "APPLICATION/JSON")), {});

  for (const type of [null, "", "text/plain", "application/x-www-form-urlencoded", "application/json5", "multipart/form-data"]) {
    await assert.rejects(() => readJsonBody(request("{}", type)), (error) => {
      assert.equal(error.status, 415);
      assert.equal(error.code, "unsupported_media_type");
      return true;
    }, String(type));
  }
});

test("malformed JSON is 400 invalid_json and never carries the parser's own message", async () => {
  for (const text of ["{not json", "{", '{"a":}', "undefined"]) {
    await assert.rejects(() => readJsonBody(request(text)), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_json");
      // JSON.parse names an offset and a character. That is an internal, and the whole
      // point of db/errors.js's closed vocabulary is that it cannot reach a client.
      assert.doesNotMatch(error.message, /position|token|Unexpected/i);
      return true;
    }, text);
  }
});

test("a top-level array, string, number or null is not a body", async () => {
  // All four are valid JSON. Rejecting them here is what lets every route read
  // `body.field` without first proving body is an object -- which is the check that gets
  // forgotten, and which fails as a confusing validation error rather than as this.
  for (const text of ["[]", '["a"]', '"a string"', "42", "null", "true"]) {
    await assert.rejects(() => readJsonBody(request(text)), (error) => {
      assert.equal(error.code, "invalid_json");
      return true;
    }, text);
  }
});

test("the size cap is 64 KiB, counted in bytes off the wire", async () => {
  // The same ceiling infra/nginx/api.conf sets with client_max_body_size 64k. Stated in
  // both places on purpose: nginx sheds it before it reaches this process on the box, and
  // this is what holds for a caller on the compose network that never passes through
  // nginx at all -- which is exactly how apps/customer-order reaches this service.
  assert.equal(MAX_BODY_BYTES, 64 * 1024);

  const stream = request(`{"a":"${"x".repeat(MAX_BODY_BYTES)}"}`);
  await assert.rejects(() => readJsonBody(stream), (error) => {
    assert.equal(error.status, 413);
    assert.equal(error.code, "payload_too_large");
    return true;
  });
  // DRAINED, not destroyed. req.destroy() is the obvious call and it tears the socket
  // down before the 413 has been written, so the caller sees a transport failure instead
  // of a status -- and apps/customer-order reads the status to decide whether to retry,
  // so a destroyed socket turns a permanent refusal into an infinite retry.
  assert.equal(stream.resumed, true, "the remainder of an oversized body must be drained");
});

test("bytes, not characters: a multi-byte body cannot clear the cap by decoding smaller", async () => {
  // "가" is three bytes of UTF-8 and one character. A reader that measured the decoded
  // string would let a body three times the limit through, which is the memory bound the
  // limit exists to hold.
  const stream = request(`{"a":"${"가".repeat(MAX_BODY_BYTES / 2)}"}`);
  await assert.rejects(() => readJsonBody(stream), (error) => {
    assert.equal(error.code, "payload_too_large");
    return true;
  });
});

test("a transport failure mid-body is 400, not a leaked errno", async () => {
  const stream = new EventEmitter();
  stream.headers = { "content-type": "application/json" };
  stream.resume = () => {};
  process.nextTick(() => stream.emit("error", new Error("ECONNRESET read ETIMEDOUT")));

  await assert.rejects(() => readJsonBody(stream), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_request");
    assert.doesNotMatch(error.message, /ECONNRESET|ETIMEDOUT/);
    return true;
  });
});

test("the promise settles exactly once, whatever the stream does afterwards", async () => {
  // A stream that errors after end, or ends twice, must not reject an already-resolved
  // promise -- that is an unhandled rejection in a process whose only failure channel is
  // the request it belongs to.
  const stream = request('{"a":1}');
  const parsed = await readJsonBody(stream);
  assert.deepEqual(parsed, { a: 1 });

  // The mechanism, asserted directly: settling removes all three listeners, so a late
  // event has nothing left to reach. Without this the reader would still hold the
  // request after resolving, and on a keep-alive connection Node reuses the object.
  for (const event of ["data", "end", "error"]) {
    assert.equal(stream.listenerCount(event), 0, `${event} listener survived`);
  }

  // ...and emitting them anyway settles nothing a second time. The error listener is the
  // TEST's, because a bare EventEmitter throws on an unhandled "error" -- which is
  // EventEmitter's behaviour, not the reader's, and is what this test is not about.
  stream.on("error", () => {});
  stream.emit("error", new Error("late"));
  stream.emit("end");
  await new Promise((resolve) => setImmediate(resolve));
});
