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

const http = require("node:http");

// A stand-in for core-api that records exactly what reached it and answers with a
// cookie, so the assertions below are about bytes rather than intent.
async function withUpstream(handler, run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(req, res);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await new Promise((resolve) => upstream.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${upstream.address().port}`, seen);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test("the proxy forwards Origin UNCHANGED", async () => {
  // core-api's 5.3 check is the CSRF control: it compares Origin to
  // API_PUBLIC_ORIGIN exactly. A proxy that rewrites this header disables that check
  // for everything passing through, including a forged cross-site request.
  await withUpstream((req, res) => res.end("{}"), async (upstreamUrl, seen) => {
    await withServer({ coreApiUrl: upstreamUrl }, async (base) => {
      await fetch(`${base}/api/admin/auth/me`, { headers: { Origin: "https://admin.yeyintlwin.com" } });
    });
    assert.equal(seen[0].headers.origin, "https://admin.yeyintlwin.com");
  });
});

test("the proxy does NOT append to X-Forwarded-For", async () => {
  // THE SUBTLE ONE. core-api counts TRUSTED_PROXY_HOPS entries from the RIGHT, and
  // that value is pinned at 1 against the depth infra/nginx deploys. If this app
  // appended its own hop, the depth would be 2 through /api and 1 everywhere else,
  // and no single hop count could be right for both -- so the pick lands one place
  // to the left, on an entry the client controls.
  await withUpstream((req, res) => res.end("{}"), async (upstreamUrl, seen) => {
    await withServer({ coreApiUrl: upstreamUrl }, async (base) => {
      await fetch(`${base}/api/admin/auth/me`, { headers: { "X-Forwarded-For": "203.0.113.7, 10.0.0.1" } });
    });
    assert.equal(seen[0].headers["x-forwarded-for"], "203.0.113.7, 10.0.0.1");
  });
});

test("the proxy returns Set-Cookie with every attribute intact", async () => {
  // __Host- is only worth anything if Path=/, Secure, HttpOnly and SameSite survive
  // the hop. A proxy that reserialises cookies is where they quietly stop doing so.
  const cookie = "__Host-core_session=AAAAAAAAAAAAAAAAAAAAAA; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800";
  await withUpstream(
    (req, res) => {
      res.setHeader("Set-Cookie", cookie);
      res.end("{}");
    },
    async (upstreamUrl) => {
      await withServer({ coreApiUrl: upstreamUrl }, async (base) => {
        const response = await fetch(`${base}/api/admin/auth/login`, { method: "POST", body: "{}" });
        assert.equal(response.headers.getSetCookie()[0], cookie);
      });
    }
  );
});

test("the proxy forwards the method, the path, the query and the body", async () => {
  await withUpstream((req, res) => { res.statusCode = 201; res.end("{}"); }, async (upstreamUrl, seen) => {
    await withServer({ coreApiUrl: upstreamUrl }, async (base) => {
      const response = await fetch(`${base}/api/admin/users?limit=5`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"email":"a@b.test"}'
      });
      assert.equal(response.status, 201);
    });
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/api/admin/users?limit=5");
    assert.equal(seen[0].body, '{"email":"a@b.test"}');
  });
});

test("only /api is proxied", async () => {
  // /health and /health/ready are not this app's to expose.
  await withUpstream((req, res) => res.end("{}"), async (upstreamUrl, seen) => {
    await withServer({ coreApiUrl: upstreamUrl }, async (base) => {
      assert.equal((await fetch(`${base}/health`)).status, 404);
    });
    assert.deepEqual(seen, []);
  });
});

test("core-api being down is 502, and says nothing about why", async () => {
  await withServer({ coreApiUrl: "http://127.0.0.1:1" }, async (base) => {
    const response = await fetch(`${base}/api/admin/auth/me`);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /ECONNREFUSED|127\.0\.0\.1|:1\b/);
  });
});
