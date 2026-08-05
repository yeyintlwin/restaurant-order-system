"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createServer } = require("../server");

// One listener per test, on port 0 so nothing collides with a dev server.
async function withServer(options, run) {
  const server = createServer(options);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET / serves index.html as HTML", async () => {
  await withServer({ coreApiUrl: "http://127.0.0.1:1" }, async (base) => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.match(await response.text(), /<html/i);
  });
});

test("an unknown path is 404 and does not leak a filesystem path", async () => {
  await withServer({ coreApiUrl: "http://127.0.0.1:1" }, async (base) => {
    const response = await fetch(`${base}/nope.css`);
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.doesNotMatch(body, /admin-management|ENOENT|[A-Za-z]:\\|\/home\//);
  });
});

test("a traversal attempt cannot escape public/", async () => {
  // The one bug a hand-written static server ships. `..%2f` survives the URL
  // parser as a literal segment, so a server that only splits on "/" and never
  // resolves the result will happily read outside the root.
  await withServer({ coreApiUrl: "http://127.0.0.1:1" }, async (base) => {
    for (const attempt of ["/../package.json", "/..%2fpackage.json", "/%2e%2e/server.js"]) {
      const response = await fetch(`${base}${attempt}`);
      assert.ok(response.status === 404 || response.status === 400, `${attempt} → ${response.status}`);
      assert.doesNotMatch(await response.text(), /"name":|createServer/);
    }
  });
});

test("every response carries the security headers, including on the 404", async () => {
  await withServer({ coreApiUrl: "http://127.0.0.1:1" }, async (base) => {
    for (const path of ["/", "/nope.css"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer", path);
      assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    }
  });
});
