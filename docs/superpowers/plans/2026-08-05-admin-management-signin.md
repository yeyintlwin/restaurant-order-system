# Admin Management Sign-in — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/admin-management` its first screen — sign in, see who you are,
change your password, sign out — served at `admin.yeyintlwin.com`, with `core-api`
unchanged.

**Architecture:** A front end and a proxy, nothing more. `server.js` serves
`public/` and forwards `/api/*` to core-api, so the browser only ever talks to one
origin and no CORS is needed. The client splits in two: `public/api.js` holds every
call to core-api and takes `fetch` as an argument so it can be unit-tested without a
browser; `public/app.js` does DOM wiring only.

**Tech Stack:** Node 20 (CommonJS for the server, ES modules for the browser),
`node:http`, `node:fs`, `node --test` + `node:assert/strict`. **No runtime
dependency and no build step** — `apps/customer-order` has zero dependencies and
this matches it.

**Spec:** [2026-08-05-admin-management-login-design.md](../specs/2026-08-05-admin-management-login-design.md).
Bare section references (§5.3, §6.2, §9.5) point at
[2026-07-29-core-api-phase1-design.md](../specs/2026-07-29-core-api-phase1-design.md).

---

## Execution log

**Status: 7 of 9 tasks done.** Task 8 is deliberately out of order and NOT done — the
`admin.yeyintlwin.com` certificate does not exist yet, and `ssl_certificate` is read at
parse time, so shipping its server block early makes `nginx -t` fail and the deploy roll
back. Task 9 is next; Task 8 goes in once the DNS record has propagated and certbot has
run.

Append one row per working session. A task counts as finished only when all of its
steps are ticked and its commit exists.

| Date | Session did | Tasks finished | Commits | Next |
| --- | --- | --- | --- | --- |
| 2026-08-05 | Task 1: manifest, stub `index.html`, static server. 4/4 pass. Found that `node --test <dir>` does not work in this checkout — see the note under Task 1 Step 4; use `npm --prefix apps/admin-management test`. | **1/9** | `feat(admin-management): serve public/, and resolve the path before trusting it` | Task 2 |
| 2026-08-05 | Task 2: the `/api` proxy. 10/10 pass. Step 2 predicted six red and measured five — "only /api is proxied" is green before the proxy exists, see the note under Step 2. Full suite still at baseline, no mirror moved. | **2/9** | `feat(admin-management): proxy /api, and touch neither Origin nor X-Forwarded-For` | Task 3 |
| 2026-08-05 | Task 3: `public/api.js`, `fetch` injected. 9/9 pass, 19/19 for the app. **The dual-export footer was KEPT as written** — `require()` did not throw, so the fallback was not taken; see the note under Step 4 for why, and for the Node floor it costs. | **3/9** | `feat(admin-management): the API client, with fetch injected so 401 is testable` | Task 4 |
| 2026-08-05 | Task 4: the page, the stylesheet, `app.js` and the CSP. 6/6 new, **25/25 for the app** — `server.test.js` stayed green with the fifth header. Step 2's red measured exactly as predicted (0/6, three assertion failures and three `ENOENT`). Step 4's directory-form command still fails the way Task 1 documented; used `npm --prefix apps/admin-management test`. | **4/9** | `feat(admin-management): one page, three states, and the server's own error text` | Task 5 |
| 2026-08-05 | Task 5: the README, the root `scripts.test` entry, the root README line. 2/2 new, 27/27 for the app. **Full suite green, five suites: 14 + 33 + 69 + 531 + 27.** core-api unchanged at 531 (530 pass, 1 pre-existing `# SKIP` — C6, platform repositories do not exist yet). The root README already listed `apps/admin-management`, so Step 3's "add it" was a rewrite of a stale line, not an insertion — see the note under Step 3. | **5/9** | `feat(admin-management): a README that describes the app, and a suite the root script runs` | Task 6 |
| 2026-08-05 | Task 6: the Dockerfile and the compose service. 2/2 new, 29/29 for the app. **This session appended no row of its own; the row is reconstructed here from commit `bcf8d8e`.** It left `deploy-config.test.js:249` red on purpose — the fifth service is not in the deploy's expected list until Task 9. | **6/9** | `feat(admin-management): an image with no secret and a loopback-only port` | Task 7 |
| 2026-08-05 | Task 7: `API_PUBLIC_ORIGIN` → `admin.yeyintlwin.com`. **"Six sites" measured as five in this commit, not three** — `config.test.js` holds three of them and `deploy-config.test.js:198` a fourth that the task's own `grep` cannot find, because the literal is backslash-escaped inside a regex. See the notes under Steps 2 and 3. Step 2's red landed on the compose-reader assertion, not on the frozen `PRODUCTION_ENV` fixture, which no compose edit can reach. Task 8 SKIPPED deliberately — no certificate yet. | **7/9** | `feat: API_PUBLIC_ORIGIN is the admin app, and the deploy probes say so too` | Task 9 |

Baseline at the head of this plan, measured: **14 / 33 / 69 / 531**, 0 failures,
1 skip (C6, guarded on `repositories/platform/`, which arms in Plan 2c).

---

## How to pick this up

**The checkboxes are the state.** Tick them as you go and commit the plan file with
the code.

**Tick them with exact-string edits, never `sed -i`.** The plan files in this
repository are CRLF; `sed -i` rewrites every line ending and turns five characters
into a whole-file diff. Check `git diff --stat` on the plan before staging.

**Every command runs from the repository root.**

**Only Task 6 and Task 9 need a database**, and only because they run the full
repository suite. The core-api suites throw without a URL, by design:

```bash
export CORE_API_TEST_DATABASE_URL='postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
```

### The two things this plan will not let you do

**1. Do not make `apps/core-api` serve HTML, and do not touch its source at all.**
The whole point of the proxy is that core-api stays an API. Spec §2.1 records why
parent decision 11 does not settle this and why two earlier "it cannot work" claims
were wrong. If you find yourself adding `sendHtml`, a second CSP table or an
`/admin` route, stop — you are re-deriving a rejected design.

**2. Do not add a dependency.** Not express, not a proxy library, not a bundler.
`apps/customer-order/package.json` describes itself as having zero runtime
dependencies and serves a considerably bigger UI than this one with `node:http`.

### Standing rule: a fifth app is a lockstep change

Adding an app under `apps/` touches five places that are not next to each other,
and one variable move touches six more. Both lists are in spec §5. **Before editing
any of them, grep for the literal across `apps/`, `infra/`, `.github/` and the root**
— and treat a site this plan does not mention as a finding to report, not a decision
to make.

---

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `apps/admin-management/package.json` | Manifest. Zero dependencies. | 1 |
| `apps/admin-management/server.js` | Serve `public/`; forward `/api/*` to core-api | 1, 2 |
| `apps/admin-management/public/api.js` | Every call to core-api. Takes `fetch`. No DOM. | 3 |
| `apps/admin-management/public/index.html` | The one document | 4 |
| `apps/admin-management/public/styles.css` | The centred card, house palette | 4 |
| `apps/admin-management/public/app.js` | DOM wiring only | 4 |
| `apps/admin-management/Dockerfile` | Image | 6 |
| `apps/admin-management/README.md` | Replaces the stale placeholder | 5 |
| `docker-compose.yml` | The service, and `API_PUBLIC_ORIGIN` | 6, 7 |
| `.github/workflows/deploy.yml` | ci/test/build/push, and the two probe origins | 7, 9 |
| `apps/core-api/test/config.test.js` | The frozen `PRODUCTION_ENV` fixture | 7 |
| `infra/nginx/admin.conf` | The `admin.yeyintlwin.com` server block | 8 |
| `infra/README.md` | The subdomain, its certificate, the topology | 8 |

Tests mirror these under `apps/admin-management/test/`.

---

## Part 1 — The app

### Task 1: The manifest and a server that serves `public/`

**Files:**

- Create: `apps/admin-management/package.json`
- Create: `apps/admin-management/server.js`
- Create: `apps/admin-management/public/index.html`
- Create: `apps/admin-management/test/server.test.js`

- [x] **Step 1: Write the failing test**

Create `apps/admin-management/test/server.test.js`:

```js
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
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/admin-management/test/server.test.js
```

Expected: FAIL — `Cannot find module '../server'`.

- [x] **Step 3: Write the manifest and the server**

Create `apps/admin-management/package.json`:

```json
{
  "name": "admin-management",
  "version": "1.0.0",
  "private": true,
  "description": "Restaurant management front end. Serves its own static files and proxies /api to core-api so the browser sees one origin -- which is what lets the __Host- session cookie work without CORS. Zero runtime dependencies.",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "engines": {
    "node": ">=20"
  }
}
```

Create `apps/admin-management/public/index.html` as a stub for now — Task 4 writes
the real one:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Restaurant Admin</title>
  </head>
  <body></body>
</html>
```

Create `apps/admin-management/server.js`:

```js
"use strict";

// A front end and a proxy. It holds no credential, reads no database, and makes no
// decision about who may do what -- every such decision stays in core-api, where the
// tests for it live.
//
// Zero dependencies, matching apps/customer-order. node:http serves a bigger UI than
// this one there.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PUBLIC_ROOT = path.join(__dirname, "public");

// The same four headers core-api puts on every response (http/respond.js), minus the
// CSP, which Task 4 adds once there is a script to allow. Repeated here rather than
// imported because this app must not depend on core-api's source.
const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY"
});

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
});

function send(res, status, body, headers = {}) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.statusCode = status;
  res.end(body);
}

// RESOLVE, THEN CHECK. Splitting the path and rejecting ".." by string match is the
// version that ships a directory traversal: "..%2f" is a single decoded segment, and
// a symlink inside public/ defeats a purely textual check anyway. path.resolve plus a
// prefix test on the RESULT is what actually bounds it.
function resolveWithinPublic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_ROOT, relative);
  // path.sep so the check cannot be satisfied by a sibling directory whose name
  // starts with "public".
  if (resolved !== PUBLIC_ROOT && !resolved.startsWith(PUBLIC_ROOT + path.sep)) return null;
  return resolved;
}

function serveStatic(req, res) {
  const filePath = resolveWithinPublic(req.url.split("?")[0]);
  if (filePath === null) {
    send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch {
    // One message for missing, unreadable and directory. An errno string here would
    // put an absolute filesystem path in a public response.
    send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  send(res, 200, body, {
    "Content-Type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    // The API answers no-store; the shell may be cached briefly, but never by a
    // shared cache, because a future authenticated page would otherwise be storable.
    "Cache-Control": "no-cache, private"
  });
}

function createServer(options = {}) {
  const coreApiUrl = options.coreApiUrl || process.env.CORE_API_URL;
  if (!coreApiUrl) {
    throw new Error("admin-management requires CORE_API_URL (the address of core-api)");
  }

  return http.createServer((req, res) => {
    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res);
      return;
    }
    send(res, 405, "Method not allowed", {
      Allow: "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8"
    });
  });
}

async function start(options = {}) {
  const port = Number(process.env.PORT || 3400);
  const server = options.server || createServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  });
  console.log(`admin-management listening on http://127.0.0.1:${port}`);
  return server;
}

module.exports = { createServer, start, resolveWithinPublic, PUBLIC_ROOT };

if (require.main === module) {
  start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/admin-management/test/server.test.js
```

Expected: 4 tests, all pass.

> **The directory form of this command does not work in this checkout.** `node --test
> apps/admin-management/` runs the *directory* as an entry point instead of searching
> it, so `package.json`'s `main` executes `server.js`, `start()` throws for want of
> `CORE_API_URL`, and the run reports one failed "test" with zero of the real four.
> This is not new and not this app's doing: `node --test apps/customer-order/` fails
> the same way, on its own `SHOP_ID` guard. Use the per-file form above, or
> `npm --prefix apps/admin-management test`, which is the form the root `scripts.test`
> already uses for every other app and which Task 5 adds for this one. **Task 4 Step 4
> says `node --test apps/admin-management/` — use `npm --prefix apps/admin-management
> test` there instead.**

- [x] **Step 5: Commit**

```bash
git add apps/admin-management/package.json apps/admin-management/server.js \
        apps/admin-management/public/index.html apps/admin-management/test/server.test.js \
        docs/superpowers/plans/2026-08-05-admin-management-signin.md
git commit -m "feat(admin-management): serve public/, and resolve the path before trusting it"
```

---

### Task 2: The `/api` proxy — and the three headers it must not touch

**Files:**

- Modify: `apps/admin-management/server.js`
- Modify: `apps/admin-management/test/server.test.js`

**The mirrors.** None move for this task, but three shipped invariants depend on it
behaving:

```bash
grep -n "TRUSTED_PROXY_HOPS" docker-compose.yml apps/core-api/lib/client-ip.js
grep -n "apiPublicOrigin" apps/core-api/http/csrf.js
grep -n "BASE_ATTRIBUTES" apps/core-api/http/cookies.js
```

- [x] **Step 1: Write the failing tests**

Add to `apps/admin-management/test/server.test.js`:

```js
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
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
node --test apps/admin-management/test/server.test.js
```

Expected: the six new tests fail — `/api/...` currently answers 404 from the static
handler, or 405 for the POSTs.

> **Measured: FIVE of the six fail, not six.** The mechanism is exactly as predicted
> — nothing reaches the upstream, so `seen[0]` is `undefined` for the Origin and
> X-Forwarded-For tests, `getSetCookie()[0]` is `undefined`, the `POST /api/admin/users`
> gets 405 and the `GET /api/admin/auth/me` gets 404 instead of 502. The exception is
> **"only /api is proxied", which is green before the proxy exists**: it asserts
> `/health` is 404 and that the upstream saw nothing, and a server with no proxy at all
> satisfies both vacuously. It is a regression guard, not a red-first test — it can only
> ever fail once someone widens the prefix match. Keep it; just do not read it as
> evidence the proxy works.

- [x] **Step 3: Implement the proxy**

In `apps/admin-management/server.js`, add the proxy above `createServer`:

```js
// Forward VERBATIM, with exactly one exception: `host`, which must name the upstream
// or a virtual-hosted server would route by the wrong name. Everything else --
// Origin, X-Forwarded-For, Cookie, Content-Type -- goes through untouched, and each
// of those has a test saying why.
//
// NOTHING IS APPENDED TO X-Forwarded-For. This process is transparent; nginx stays
// the only hop, and TRUSTED_PROXY_HOPS stays 1 with its cross-file assertion intact.
function proxyToCoreApi(req, res, coreApiUrl) {
  const target = new URL(req.url, coreApiUrl);
  const headers = { ...req.headers, host: target.host };

  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers
    },
    (upstreamRes) => {
      // writeHead with the raw headers object preserves a repeated Set-Cookie as an
      // array. Copying them one at a time with setHeader is how the second cookie
      // gets lost.
      res.writeHead(upstreamRes.statusCode, {
        ...SECURITY_HEADERS,
        ...upstreamRes.headers
      });
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", () => {
    if (res.headersSent) {
      res.end();
      return;
    }
    // 502 with a fixed body. The errno names a host and a port, and this response is
    // public.
    send(res, 502, "Bad gateway", { "Content-Type": "text/plain; charset=utf-8" });
  });

  // Never log the body: the sign-in request carries a password. Piping it straight
  // through is also what keeps this a streaming proxy rather than a buffer.
  req.pipe(upstream);
}
```

and replace the request handler inside `createServer`:

```js
  return http.createServer((req, res) => {
    if (req.url === "/api" || req.url.startsWith("/api/")) {
      proxyToCoreApi(req, res, coreApiUrl);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res);
      return;
    }
    send(res, 405, "Method not allowed", {
      Allow: "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8"
    });
  });
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/admin-management/test/server.test.js
```

Expected: 10 tests, all pass.

> Measured: 10 tests, 10 pass, 0 fail. The full repository suite still measures the
> recorded baseline — 14 / 33 / 69 / 531, 0 failures, 1 skip — so no mirror moved.

- [x] **Step 5: Commit**

```bash
git add apps/admin-management/server.js apps/admin-management/test/server.test.js \
        docs/superpowers/plans/2026-08-05-admin-management-signin.md
git commit -m "feat(admin-management): proxy /api, and touch neither Origin nor X-Forwarded-For"
```

---

### Task 3: `public/api.js` — every call to core-api, with `fetch` injected

**Files:**

- Create: `apps/admin-management/public/api.js`
- Create: `apps/admin-management/test/api.test.js`

**Why this file exists separately.** The house frontend test is
`customer-order/test/public-ui.test.js`: one function, `readFileSync`, and thirty
`assert.match` calls against raw source. It asserts that strings appear in files.
For a page whose interesting behaviour is *what happens on a 401*, that is a
spell-checker. Taking `fetch` as an argument is what makes every status in spec §4
a real test.

- [x] **Step 1: Write the failing test**

Create `apps/admin-management/test/api.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createApi } = require("../public/api.js");

// A stub in the shape fetch actually returns: a status, a json() and the request
// recorded so the assertions can be about what went over the wire.
function stubFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => next.body ?? {}
    };
  };
  return { fetch, calls };
}

const ME = {
  user: { id: "u1", email: "a@example.test", displayName: "A", role: "platform_admin", companyId: null, mustChangePassword: false },
  scope: { kind: "platform", companyId: null, shopIds: [] },
  session: { expiresAt: "2026-08-05T08:00:00.000Z", absoluteExpiresAt: "2026-08-12T00:00:00.000Z" }
};

test("me() returns signedIn with the document on 200", async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: ME });
  const result = await createApi(fetch).me();

  assert.equal(result.state, "signedIn");
  assert.equal(result.me.user.email, "a@example.test");
  assert.equal(calls[0].url, "/api/admin/auth/me");
  // Same origin, so the cookie rides along without any CORS mode.
  assert.equal(calls[0].init.credentials, "same-origin");
});

test("me() returns signedOut on 401 and mustChangePassword on that 403", async () => {
  const out = await createApi(stubFetch({ status: 401, body: { error: { code: "unauthenticated" } } }).fetch).me();
  assert.equal(out.state, "signedOut");

  const forced = await createApi(
    stubFetch({ status: 403, body: { error: { code: "password_change_required" } } }).fetch
  ).me();
  assert.equal(forced.state, "mustChangePassword");
});

test("login() sends JSON and reports signedIn on 200", async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: ME });
  const result = await createApi(fetch).login("a@example.test", "correct-horse-battery");

  assert.equal(result.state, "signedIn");
  assert.equal(calls[0].init.method, "POST");
  // 5.3 requires this exact header on the login route, or core-api answers 415.
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    email: "a@example.test",
    password: "correct-horse-battery"
  });
});

test("login() reports mustChangePassword when the 200 says so", async () => {
  // Spec 4.2: sign-in succeeded and the cookie is set; the account simply cannot do
  // anything else yet. Landing on the ordinary signed-in state and letting them
  // discover the 403 by clicking is the version to avoid.
  const forced = { ...ME, user: { ...ME.user, mustChangePassword: true } };
  const result = await createApi(stubFetch({ status: 200, body: forced }).fetch).login("a@example.test", "x");
  assert.equal(result.state, "mustChangePassword");
});

test("login() surfaces the server's own message and never invents one", async () => {
  // 5.8(b): "wrong password" and "unknown email" must stay indistinguishable. A
  // client that writes its own text is how they drift apart.
  const body = { error: { code: "invalid_credentials", message: "Those sign-in details were not accepted." } };
  const result = await createApi(stubFetch({ status: 401, body }).fetch).login("a@example.test", "wrong");

  assert.equal(result.state, "failed");
  assert.equal(result.message, "Those sign-in details were not accepted.");
  assert.equal(result.code, "invalid_credentials");
});

test("login() returns field errors from a 422 without rewording them", async () => {
  const body = { error: { code: "validation_failed", message: "The request could not be processed.", errors: [{ field: "email", code: "required" }] } };
  const result = await createApi(stubFetch({ status: 422, body }).fetch).login("", "x");

  assert.equal(result.state, "failed");
  assert.deepEqual(result.fieldErrors, [{ field: "email", code: "required" }]);
});

test("changePassword() reports the two failures the UI must tell apart", async () => {
  const wrongCurrent = await createApi(
    stubFetch({ status: 403, body: { error: { code: "current_password_invalid", message: "The current password is incorrect." } } }).fetch
  ).changePassword("wrong", "a-brand-new-passphrase");
  assert.equal(wrongCurrent.state, "failed");
  assert.equal(wrongCurrent.code, "current_password_invalid");

  const tooShort = await createApi(
    stubFetch({ status: 422, body: { error: { code: "validation_failed", message: "The request could not be processed.", errors: [{ field: "newPassword", code: "too_short" }] } } }).fetch
  ).changePassword("right", "short");
  assert.deepEqual(tooShort.fieldErrors, [{ field: "newPassword", code: "too_short" }]);
});

test("a transport failure is a distinct state, not a sign-in failure", async () => {
  // The proxy answers 502 when core-api is down. Reporting that as "those sign-in
  // details were not accepted" sends the operator to reset a password that is fine.
  const result = await createApi(stubFetch(new TypeError("fetch failed")).fetch).login("a@example.test", "x");
  assert.equal(result.state, "unreachable");
});

test("the password appears in the body and nowhere else", async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: ME });
  await createApi(fetch).login("a@example.test", "correct-horse-battery");

  assert.doesNotMatch(calls[0].url, /correct-horse-battery/);
  assert.doesNotMatch(JSON.stringify(calls[0].init.headers), /correct-horse-battery/);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/admin-management/test/api.test.js
```

Expected: FAIL — `Cannot find module '../public/api.js'`.

> **Measured, exactly as predicted:** `# Error: Cannot find module '../public/api.js'`,
> 0 pass / 1 fail.

- [x] **Step 3: Write the module**

Create `apps/admin-management/public/api.js`:

```js
"use strict";

// Every call to core-api, and no DOM. `fetch` is an ARGUMENT rather than a global so
// each branch below is a real test rather than a string match against this file.
//
// It is loaded by the browser as an ES module and by node --test as CommonJS; the
// two-line footer at the bottom is what makes both work without a build step.

// The paths are relative because the proxy puts the API on this same origin. An
// absolute URL here would be a second place that has to agree with nginx.
const ROUTES = Object.freeze({
  me: "/api/admin/auth/me",
  login: "/api/admin/auth/login",
  password: "/api/admin/auth/password",
  logout: "/api/admin/auth/logout",
  logoutAll: "/api/admin/auth/logout-all"
});

function createApi(fetchImpl) {
  // Same-origin, so the __Host- cookie rides along and no CORS mode is involved.
  // Spelling it out rather than relying on the default records that this is a
  // decision: "include" would be the beginning of a cross-origin design.
  const base = { credentials: "same-origin" };

  async function call(path, init = {}) {
    let response;
    try {
      response = await fetchImpl(path, { ...base, ...init });
    } catch {
      // A TypeError from fetch means the request never got an answer -- the proxy is
      // down, or the network is. Never report that as a credential problem.
      return { state: "unreachable" };
    }

    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    return { response, body };
  }

  // ONE place that turns an error body into what the UI shows. The message is the
  // server's, verbatim: 5.8(b) keeps "wrong password" and "unknown email"
  // indistinguishable, and a client that writes its own text is how they drift apart.
  function failure(body) {
    const error = body.error || {};
    return {
      state: "failed",
      code: error.code || "internal_error",
      message: error.message || "Something went wrong.",
      fieldErrors: Array.isArray(error.errors) ? error.errors : []
    };
  }

  function signedIn(me) {
    // 4.2: a 200 that carries mustChangePassword is a different state, not a warning
    // to show on the ordinary one.
    return me.user && me.user.mustChangePassword
      ? { state: "mustChangePassword", me }
      : { state: "signedIn", me };
  }

  return {
    async me() {
      const result = await call(ROUTES.me);
      if (result.state === "unreachable") return result;
      const { response, body } = result;
      if (response.status === 200) return signedIn(body);
      if (response.status === 401) return { state: "signedOut" };
      if (response.status === 403 && body.error && body.error.code === "password_change_required") {
        return { state: "mustChangePassword", me: null };
      }
      return failure(body);
    },

    async login(email, password) {
      const result = await call(ROUTES.login, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (result.state === "unreachable") return result;
      const { response, body } = result;
      return response.status === 200 ? signedIn(body) : failure(body);
    },

    async changePassword(currentPassword, newPassword) {
      const result = await call(ROUTES.password, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      if (result.state === "unreachable") return result;
      const { response, body } = result;
      // A success mints a fresh session and kills every other one.
      return response.status === 200 ? { state: "signedIn", me: body } : failure(body);
    },

    async logout(everywhere = false) {
      const result = await call(everywhere ? ROUTES.logoutAll : ROUTES.logout, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      if (result.state === "unreachable") return result;
      const { response, body } = result;
      if (response.status !== 200) return failure(body);
      return { state: "signedOut", revokedSessionCount: body.revokedSessionCount };
    }
  };
}

// Loaded as an ES module in the browser and required by node --test. Two lines
// instead of a bundler.
if (typeof module !== "undefined" && module.exports) module.exports = { createApi, ROUTES };
export { createApi, ROUTES };
```

> **If `export` at the end breaks `require()`** — it will, because a file cannot be
> both — drop the `export` line and have `index.html` load `api.js` with a plain
> `<script>` tag that assigns `window.adminApi = { createApi }`. Do **not** reach for
> a bundler; the plan forbids it and one global is cheaper. Decide this at Step 4 by
> running the test, and record which shape you took in the plan's execution log.

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/admin-management/test/api.test.js
```

Expected: 9 tests, all pass. If `require()` throws on the `export` line, take the
fallback in the note above and re-run.

> **DECIDED: the dual-export footer stayed. The fallback was NOT taken.** Measured
> 9/9 on the first run with both the `module.exports` line and the `export` line
> present, and 19/19 for the app (`npm --prefix apps/admin-management test`, which
> is server.test.js's 10 plus these 9).
>
> **But not for the reason the note assumed, and this is worth knowing.** The file
> is not being loaded as CommonJS-with-an-extra-line. `require()` of it returns an
> **ES module namespace object** — `Object.prototype.toString` gives `[object
> Module]`, keys come back alphabetised as `ROUTES, createApi`. Node parsed it as
> CJS, hit the `export`, and re-parsed it as ESM (module syntax detection), then
> `require(esm)` handed back the namespace. So `typeof module` is `undefined`
> inside it and **the `module.exports` line never executes** — it is dead code that
> is kept because the plan says type the block verbatim, and because it costs
> nothing (the `typeof` guard short-circuits instead of throwing a ReferenceError).
>
> The note's "a file cannot be both" is right; the file is ESM, and `require(esm)`
> is what makes it look like both.
>
> **The price is a Node floor that `engines` does not state.** `require(esm)` is
> unflagged only from **v20.19 / v22.12**. Measured, on this exact file:
>
> | Runtime | Result |
> | --- | --- |
> | local v22.20.2 | 9/9 pass |
> | `node:20-alpine` (today v20.20.2) | 9/9 pass |
> | `node:20.18-alpine` | **`SyntaxError: Unexpected token 'export'`**, 0 pass / 1 fail |
>
> `apps/admin-management/package.json` says `"node": ">=20"` and every sibling
> Dockerfile says `FROM node:20-alpine`, which today resolves to 20.20.2 and is
> fine. CI (`.github/workflows/deploy.yml`, `node-version: 20`) resolves to latest
> 20.x and is fine. Anything on 20.0–20.18 is not. **Task 6, when it writes this
> app's Dockerfile: do not pin a minor below 20.19**, and consider tightening
> `engines` to `>=20.19`.
>
> **For Task 4:** `import { createApi } from "./api.js"` in `app.js` is the correct
> shape and needs no change — the file really is an ES module, so a
> `<script type="module">` in `index.html` loads it natively. The `window.adminApi`
> global fallback is not needed and should not be introduced.

- [x] **Step 5: Commit**

```bash
git add apps/admin-management/public/api.js apps/admin-management/test/api.test.js \
        docs/superpowers/plans/2026-08-05-admin-management-signin.md
git commit -m "feat(admin-management): the API client, with fetch injected so 401 is testable"
```

---

### Task 4: The page — one document, three states

**Files:**

- Modify: `apps/admin-management/public/index.html`
- Create: `apps/admin-management/public/styles.css`
- Create: `apps/admin-management/public/app.js`
- Create: `apps/admin-management/test/public-ui.test.js`
- Modify: `apps/admin-management/server.js`

- [x] **Step 1: Write the failing test**

Create `apps/admin-management/test/public-ui.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicRoot = path.join(__dirname, "..", "public");
const read = (name) => fs.readFileSync(path.join(publicRoot, name), "utf8");

test("the document carries the three states and the fields each one needs", () => {
  const html = read("index.html");

  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /id="signedOut"/);
  assert.match(html, /id="signedIn"/);
  assert.match(html, /id="mustChange"/);

  assert.match(html, /id="email"[\s\S]{0,200}type="email"/);
  assert.match(html, /id="password"[\s\S]{0,200}type="password"/);
  assert.match(html, /id="currentPassword"[\s\S]{0,200}type="password"/);
  assert.match(html, /id="newPassword"[\s\S]{0,200}type="password"/);
  assert.match(html, /id="signOut"/);
  assert.match(html, /id="signOutAll"/);
});

test("the password fields are not autofilled into the wrong form", () => {
  const html = read("index.html");
  assert.match(html, /id="password"[\s\S]{0,240}autocomplete="current-password"/);
  assert.match(html, /id="newPassword"[\s\S]{0,240}autocomplete="new-password"/);
});

test("the minimum length is stated before the request, not after", () => {
  // 5.1 sets it at 12. A form that only learns this from a 422 makes the user guess.
  assert.match(read("index.html"), /12/);
});

test("app.js wires the DOM and holds no fetch of its own", () => {
  const js = read("app.js");
  assert.match(js, /createApi/);
  // Every call goes through api.js, which is the file with the tests.
  assert.doesNotMatch(js.replace(/createApi\(\s*fetch\s*\)/g, ""), /\bfetch\s*\(/);
});

test("nothing in the client logs a password or puts one in a URL", () => {
  for (const name of ["app.js", "api.js"]) {
    const js = read(name);
    assert.doesNotMatch(js, /console\.(log|info|warn|error)[^\n]*(password|Password)/);
    assert.doesNotMatch(js, /[?&](password|currentPassword|newPassword)=/);
  }
});

test("the stylesheet uses the house palette rather than inventing one", () => {
  const css = read("styles.css");
  assert.match(css, /#2e7d5b/i);
  assert.match(css, /#f4f5f7/i);
  assert.match(css, /Inter/);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/admin-management/test/public-ui.test.js
```

Expected: FAIL — `index.html` is the Task 1 stub and `styles.css` and `app.js` do
not exist.

> **Measured, exactly as predicted:** 0 pass / 6 fail. The split is worth recording
> because it is two different failures: tests 1–3 read the Task 1 stub and fail on
> `assert.match` (no viewport, no `id="signedOut"`, no `12`), while tests 4–6 never
> get to an assertion — `ENOENT ... public\app.js` and `ENOENT ... public\styles.css`
> are thrown by `readFileSync` inside the helper.

- [x] **Step 3: Write the page**

Replace `apps/admin-management/public/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#f4f5f7" />
    <title>Restaurant Admin</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="card" id="card">
      <div class="brand" aria-hidden="true">R</div>

      <!-- Shown until we know. Replaced by whichever state applies. -->
      <section id="loading" class="state">
        <p class="muted">Checking your session…</p>
      </section>

      <section id="signedOut" class="state" hidden>
        <h1>Restaurant Admin</h1>
        <p class="muted">Sign in to continue</p>
        <form id="signInForm" novalidate>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username" required />
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
          <p class="error" id="signInError" role="alert" hidden></p>
          <button type="submit" id="signInButton">Sign in</button>
        </form>
      </section>

      <section id="signedIn" class="state" hidden>
        <p class="label">Signed in as</p>
        <p class="identity" id="identityEmail"></p>
        <p class="muted" id="identityRole"></p>
        <hr />
        <p class="label">Change password</p>
        <form id="changeForm" novalidate>
          <label for="currentPassword">Current password</label>
          <input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required />
          <label for="newPassword">New password <span class="hint">at least 12 characters</span></label>
          <input id="newPassword" name="newPassword" type="password" autocomplete="new-password" required />
          <p class="error" id="changeError" role="alert" hidden></p>
          <p class="ok" id="changeOk" role="status" hidden></p>
          <button type="submit" id="changeButton">Update password</button>
        </form>
        <div class="row">
          <button type="button" id="signOut" class="secondary">Sign out</button>
          <button type="button" id="signOutAll" class="secondary">Sign out everywhere</button>
        </div>
      </section>

      <section id="mustChange" class="state" hidden>
        <h1>Change your password</h1>
        <p class="muted">Your account needs a new password before you can do anything else.</p>
        <form id="forcedForm" novalidate>
          <label for="forcedCurrent">Current password</label>
          <input id="forcedCurrent" name="forcedCurrent" type="password" autocomplete="current-password" required />
          <label for="forcedNew">New password <span class="hint">at least 12 characters</span></label>
          <input id="forcedNew" name="forcedNew" type="password" autocomplete="new-password" required />
          <p class="error" id="forcedError" role="alert" hidden></p>
          <button type="submit" id="forcedButton">Update password</button>
        </form>
      </section>
    </main>

    <script type="module" src="/app.js"></script>
  </body>
</html>
```

Create `apps/admin-management/public/styles.css`:

```css
/* The palette is apps/customer-order/public/styles.css's, so the two apps read as
   one product. Copied rather than imported: they are separate services and a shared
   stylesheet would be a build step. */
:root {
  color-scheme: light;
  --bg: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #f7f8fa;
  --ink: #16181d;
  --muted: #6b7280;
  --line: #ececf0;
  --accent: #2e7d5b;
  --accent-press: #256849;
  --danger: #b3261e;
  --radius: 16px;
  --radius-sm: 12px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
  color: var(--ink);
}

.card {
  width: 100%;
  max-width: 380px;
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px rgb(16 24 40 / 8%);
  padding: 28px 24px;
}

.brand {
  width: 40px; height: 40px;
  margin: 0 auto 16px;
  border-radius: 12px;
  background: #e6f3ee;
  color: var(--accent);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700;
}

h1 { font-size: 20px; margin: 0 0 4px; text-align: center; }
.muted { color: var(--muted); font-size: 13px; margin: 0 0 18px; text-align: center; }
.label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
.identity { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
.hint { color: var(--muted); font-weight: 400; text-transform: none; letter-spacing: 0; }
hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }

label { display: block; font-size: 12px; font-weight: 600; margin: 0 0 6px; }
input {
  width: 100%;
  height: 44px;
  padding: 0 12px;
  margin: 0 0 14px;
  font: inherit;
  color: inherit;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }

button {
  width: 100%;
  height: 44px;
  font: inherit;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
button:hover { background: var(--accent-press); }
button[disabled] { opacity: .6; cursor: default; }

.secondary { background: var(--surface); color: var(--muted); border: 1px solid var(--line); }
.secondary:hover { background: var(--surface-2); }
.row { display: flex; gap: 8px; margin-top: 12px; }

.error { color: var(--danger); font-size: 13px; margin: 0 0 12px; }
.ok { color: var(--accent); font-size: 13px; margin: 0 0 12px; }
[hidden] { display: none !important; }
```

Create `apps/admin-management/public/app.js`:

```js
// DOM wiring only. Every call to core-api goes through api.js, which is the file
// with the tests -- this one must not grow a fetch of its own.
import { createApi } from "/api.js";

const api = createApi(fetch);
const $ = (id) => document.getElementById(id);

const STATES = ["loading", "signedOut", "signedIn", "mustChange"];

function show(state) {
  for (const name of STATES) $(name).hidden = name !== state;
}

function setError(element, text) {
  element.textContent = text;
  element.hidden = !text;
}

// The server's wording, always. 5.8(b) keeps "wrong password" and "unknown email"
// indistinguishable, and a client that writes its own text is how they drift apart.
// Field codes get a short gloss because "too_short" is not a sentence.
const FIELD_TEXT = Object.freeze({
  required: "is required",
  too_short: "must be at least 12 characters",
  too_long: "is too long",
  invalid_uuid: "is not valid"
});

function describe(result) {
  if (result.state === "unreachable") {
    return "Could not reach the server. Check your connection and try again.";
  }
  if (result.fieldErrors && result.fieldErrors.length > 0) {
    return result.fieldErrors
      .map((entry) => `${entry.field} ${FIELD_TEXT[entry.code] || "is not accepted"}`)
      .join("; ");
  }
  return result.message;
}

function renderSignedIn(me) {
  $("identityEmail").textContent = me.user.email;
  const company = me.scope.companyId ? `company ${me.scope.companyId}` : "no company selected";
  $("identityRole").textContent = `${me.user.role} · ${company}`;
  show("signedIn");
}

function apply(result) {
  if (result.state === "signedIn") {
    renderSignedIn(result.me);
    return;
  }
  if (result.state === "mustChangePassword") {
    show("mustChange");
    return;
  }
  show("signedOut");
}

async function submitting(button, run) {
  button.disabled = true;
  try {
    await run();
  } finally {
    button.disabled = false;
  }
}

$("signInForm").addEventListener("submit", (event) => {
  event.preventDefault();
  return submitting($("signInButton"), async () => {
    setError($("signInError"), "");
    const result = await api.login($("email").value.trim(), $("password").value);
    if (result.state === "failed" || result.state === "unreachable") {
      // KEEP THE EMAIL, CLEAR THE PASSWORD. A page that clears itself on a wrong
      // password makes a typo cost the whole entry.
      $("password").value = "";
      setError($("signInError"), describe(result));
      return;
    }
    apply(result);
  });
});

function changeHandler(currentId, newId, errorId, buttonId, okId) {
  return (event) => {
    event.preventDefault();
    return submitting($(buttonId), async () => {
      setError($(errorId), "");
      if (okId) setError($(okId), "");
      const result = await api.changePassword($(currentId).value, $(newId).value);
      if (result.state !== "signedIn") {
        setError($(errorId), describe(result));
        return;
      }
      $(currentId).value = "";
      $(newId).value = "";
      // Spec 4.3: a success mints a fresh session and kills every other one. Saying
      // so here is why "you have been signed out on your phone" is not a surprise.
      if (okId) setError($(okId), "Password updated. Every other session was signed out.");
      renderSignedIn(result.me);
    });
  };
}

$("changeForm").addEventListener("submit", changeHandler("currentPassword", "newPassword", "changeError", "changeButton", "changeOk"));
$("forcedForm").addEventListener("submit", changeHandler("forcedCurrent", "forcedNew", "forcedError", "forcedButton", null));

for (const [id, everywhere] of [["signOut", false], ["signOutAll", true]]) {
  $(id).addEventListener("click", () =>
    submitting($(id), async () => {
      await api.logout(everywhere);
      $("email").value = "";
      $("password").value = "";
      show("signedOut");
    })
  );
}

apply(await api.me());
```

In `apps/admin-management/server.js`, add the CSP to `SECURITY_HEADERS`. The page
loads two same-origin modules and nothing else, so the policy can be strict without
a hash:

```js
const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  // No inline script, no external anything. 'self' covers /app.js and /api.js;
  // connect-src 'self' covers the proxied /api calls. If a later screen needs an
  // inline script, add a hash -- never 'unsafe-inline'.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
});
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/admin-management/
```

Expected: all three suites pass. **`server.test.js` must still be green** — the CSP
addition changes every response's headers and its assertions run over them.

> **Ran `npm --prefix apps/admin-management test` instead, as the Task 1 Step 4 note
> instructs.** The directory form still fails the documented way on this checkout
> (node v22.20.0): it runs `package.json`'s `main`, `start()` throws for want of
> `CORE_API_URL`, and the run reports one failed "test". Confirmed pre-existing by
> running the same command against `git show HEAD:apps/admin-management/server.js` —
> identical failure, so it is not the CSP edit's doing.
>
> **25/25 pass**: api.test.js's 9, public-ui.test.js's 6, server.test.js's 10.
> **`server.test.js` is green with the CSP present** — in particular "every response
> carries the security headers, including on the 404", which sets no expectation
> about the header *count*, so adding a fifth header does not disturb it.
>
> Also smoke-tested the delivery, since the CSP is only useful if the browser can
> still load the page: served on port 3487 and curled it. `/` is 200 `text/html`,
> `/app.js` and `/api.js` are 200 `application/javascript`, `/styles.css` is 200
> `text/css`, and the CSP rides on all of them. Nothing the page loads is outside
> `'self'`: `Inter` is a bare family name with no `@font-face`, so `font-src` never
> comes into play, and the forms are all `preventDefault`-ed JS submits, so
> `form-action 'none'` blocks nothing that is meant to happen.
>
> **The import specifier is `/api.js`, as this task's code block writes it** — not
> the `./api.js` Task 3's closing note mentioned in passing. Both are ES-module
> imports resolving to the same URL from `/app.js`; the block is the load-bearing
> text and was typed verbatim. The `window.adminApi` global fallback was NOT
> introduced, per Task 3 Step 4.

- [x] **Step 5: Commit**

```bash
git add apps/admin-management/public apps/admin-management/server.js \
        apps/admin-management/test/public-ui.test.js \
        docs/superpowers/plans/2026-08-05-admin-management-signin.md
git commit -m "feat(admin-management): one page, three states, and the server's own error text"
```

---

### Task 5: The README, and the root test script that runs this suite

**Files:**

- Modify: `apps/admin-management/README.md`
- Modify: `package.json` (repository root)
- Modify: `README.md` (repository root)

**The mirrors.** This is the task the standing rule is about:

```bash
grep -n "scripts" package.json
grep -rn "npm --prefix apps/customer-order test" . --include=*.json --include=*.js --include=*.yml | grep -v node_modules
grep -n "apps/" README.md
```

`source-structure.test.js`'s **C11** asserts the root `scripts.test` still contains
the three original suites and core-api's. It uses `includes`, so adding a fifth does
not break it — but nothing runs the new suite until it is added, and C11 exists
precisely because *a suite the root script does not invoke is a suite the deploy gate
never sees*.

- [x] **Step 1: Write the failing test**

Add to `apps/admin-management/test/public-ui.test.js`:

```js
test("the repository test script runs this app's suite", () => {
  // Without this line the suite exists and nothing runs it -- not locally, not in
  // the deploy gate. Same reasoning as source-structure.test.js's C11.
  const rootPackage = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
  assert.match(rootPackage.scripts.test, /npm --prefix apps\/admin-management test/);
});

test("this app's README describes what it is, not what it was going to be", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /proxy|proxies/i);
  assert.match(readme, /admin\.yeyintlwin\.com/);
  // The placeholder promised menu editing and sales reports. Those are Plan 2c and
  // later; a README that still promises them sends the next reader looking for code
  // that does not exist.
  assert.doesNotMatch(readme, /daily sales report/i);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/admin-management/test/public-ui.test.js
```

Expected: both new tests fail — the root script has no `admin-management` entry and
the README is still the placeholder.

> **Measured, and exactly as predicted.** The single-file form of `node --test` works
> (it is the directory form that Task 1 documented as broken here). 8 tests, 6 pass,
> 2 fail — `not ok 7` and `not ok 8`, the two just added. Test 7 failed on
> `scripts.test` having no `admin-management` entry; test 8 failed its first
> assertion, `/proxy|proxies/i`, against the placeholder README printed verbatim in
> the diff.

- [x] **Step 3: Write them**

Replace `apps/admin-management/README.md`:

```markdown
# Admin Management

The restaurant management front end. Plain HTML, CSS and ES modules — no framework,
no build step, no runtime dependency.

Served at **`https://admin.yeyintlwin.com`**.

## What it does

It serves `public/` and forwards `/api/*` to `core-api`. That is the whole server.

The proxy is not a convenience. `core-api`'s session cookie is `__Host-` prefixed
and host-only, and a cookie-authenticated cross-origin `fetch` would need
`Access-Control-Allow-Credentials`, which the parent spec forbids on `/api/admin/*`.
Putting both behind one origin removes the problem instead of configuring around it.

**Three headers it must never touch**, each with a test in `test/server.test.js`:

| Header | Why |
| --- | --- |
| `Origin` | core-api compares it to `API_PUBLIC_ORIGIN`. That is the CSRF control. |
| `X-Forwarded-For` | core-api counts hops from the right. Appending here makes `TRUSTED_PROXY_HOPS` wrong for `/api` and right for everything else. |
| `Set-Cookie` | `__Host-` is only worth anything if `Path=/; Secure; HttpOnly; SameSite=Lax` survives the hop. |

## Screens

One page today: sign in, see who you are, change your password, sign out. Company,
shop and user management arrive with Plan 2c, which builds the routes.

## Running it

```sh
CORE_API_URL=http://127.0.0.1:3200 PORT=3400 npm start
```

`CORE_API_URL` is required and the process refuses to start without it.

## Tests

```sh
npm test
```

`api.js` takes `fetch` as an argument, so every status core-api can return is a real
test rather than a string match against the source.
```

In the repository root `package.json`, extend `scripts.test`:

```json
"test": "npm --prefix packages/epaper-hub-sdk test && npm --prefix apps/epaper-hub test && npm --prefix apps/customer-order test && npm --prefix apps/core-api test && npm --prefix apps/admin-management test"
```

In the repository root `README.md`, add `apps/admin-management` beside the other apps
in whatever list `monorepo-structure.test.js` reads — find it with
`grep -n "apps/" README.md` and match the surrounding style.

> **The root README already had the entry.** `grep -n "apps/" README.md` found
> `apps/admin-management` already sitting in the Apps list at line 11 — the six app
> folders were all listed when the monorepo was scaffolded, which is also why
> `monorepo-structure.test.js` asserts a `README.md` exists under each of the six.
> So Step 3's "add it" had nothing to add. What it did have was a line describing the
> app as "menu management, pricing, daily sales, and transaction history" — the same
> promise the placeholder app README made, and the same one this task's own test
> forbids there. Leaving it would put the retired promise in the more-read of the two
> files. The line was rewritten instead: what the app is (the proxy, the origin, sign
> in and password today) with menu and sales named as later work. Nothing was
> inserted or removed, so the list is still six entries and
> `monorepo-structure.test.js`'s two root-README assertions — `/Restaurant Management
> System/` and `/apps\/epaper-hub/` — never looked at the line that changed.
>
> The root README's "Management Requirements" section (line 118) still names menu
> management, price changes, daily sales reports and transaction history. That one was
> left alone: it is a statement of what the interface must eventually support, not a
> claim about what exists, and Plan 2c is what discharges it.

- [x] **Step 4: Run the tests to verify they pass**

```bash
export CORE_API_TEST_DATABASE_URL='postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
npm test
```

Expected: five suites now, all green. The core-api count is unchanged at 531; the
new suite adds its own.

> **Five suites, all green: 14 + 33 + 69 + 531 + 27.** core-api is unchanged at 531
> as predicted — 530 pass and one `# SKIP`, which is C6 (`repositories/platform/ does
> not exist yet`) and predates this plan. The new fifth entry runs last in the chain,
> so a red admin-management suite now fails `npm test` and the deploy gate with it.
> `source-structure.test.js` C11 stayed green, as the plan said it would: it asserts
> with `includes`, so a fifth `&&` clause is invisible to it. No other mirror moved —
> `ci-contract.test.js` reads the workflow, not the root script, and the workflow is
> Task 9's.

- [x] **Step 5: Commit**

```bash
git add apps/admin-management/README.md package.json README.md \
        apps/admin-management/test/public-ui.test.js \
        docs/superpowers/plans/2026-08-05-admin-management-signin.md
git commit -m "feat(admin-management): a README that describes the app, and a suite the root script runs"
```

---

## Part 2 — Ship it

### Task 6: Dockerfile and the compose service

**Files:**

- Create: `apps/admin-management/Dockerfile`
- Modify: `docker-compose.yml`

- [x] **Step 1: Write the failing test**

Add to `apps/admin-management/test/public-ui.test.js`:

```js
test("the compose service names this app and points it at core-api", () => {
  const compose = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docker-compose.yml"), "utf8");
  assert.match(compose, /^ {2}admin-management:/m);
  assert.match(compose, /ADMIN_MANAGEMENT_IMAGE/);
  // It reaches core-api by service name over the default bridge, not through nginx.
  assert.match(compose, /CORE_API_URL: http:\/\/core-api:3200/);
});

test("the image carries no secret and publishes only to loopback", () => {
  const compose = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docker-compose.yml"), "utf8");
  const block = compose.slice(compose.indexOf("\n  admin-management:"));
  // Bound at the next line indented ZERO or exactly two spaces -- the next top-level
  // key or the next service. `indexOf("\n  ", 3)` stops at the first NESTED key
  // instead: "\n    image:" is a newline followed by two spaces too. That left a
  // "service block" of nothing but the header line, which no assertion below could
  // ever match and which made the `doesNotMatch` pass without reading anything.
  const next = block.slice(3).search(/\n(?: {2})?\S/);
  const service = next === -1 ? block : block.slice(0, next + 3);
  // This app holds no credential at all -- that is the point of it being a proxy.
  assert.doesNotMatch(service, /env_file|PASSWORD|TOKEN|SECRET|API_KEY/);
  assert.match(service, /127\.0\.0\.1:3400:3400/);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
node --test apps/admin-management/test/public-ui.test.js
```

Expected: both fail — there is no `admin-management` service.

- [x] **Step 3: Write them**

Create `apps/admin-management/Dockerfile`:

```dockerfile
# Zero dependencies, so there is no install step and no lockfile to copy.
FROM node:20-alpine

WORKDIR /app

# The build context is the repository root, matching customer-order and core-api, so
# the path below is repo-relative.
COPY apps/admin-management ./apps/admin-management

USER node
EXPOSE 3400
CMD ["node", "apps/admin-management/server.js"]
```

In `docker-compose.yml`, add the service after `customer-order`:

```yaml
  admin-management:
    image: ${ADMIN_MANAGEMENT_IMAGE:-admin-management}
    container_name: admin-management
    restart: unless-stopped
    ports:
      - "127.0.0.1:3400:3400"
    # Deliberately NO env-file key and no credential of any kind. This app serves
    # files and forwards requests; everything that needs a secret is behind it.
    # Hyphenated on purpose: public-ui.test.js greps this block for the underscored
    # key and cannot tell a declaration from a mention of one in prose.
    environment:
      PORT: 3400
      # By service name over the `default` bridge. It does NOT go out through nginx
      # and back in: that would put a second TLS handshake and a second proxy hop on
      # every API call, and the hop would change what core-api counts.
      CORE_API_URL: http://core-api:3200
    depends_on:
      core-api:
        condition: service_healthy
    oom_score_adj: 500
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/admin-management/test/public-ui.test.js
docker compose config --quiet && echo "compose file parses"
```

Expected: tests pass and compose validates.

**Task 6 left `apps/core-api/test/deploy-config.test.js:249` RED, and Task 9 as
written does not repair it.** That test pins the service list with a `deepEqual`,
requires an interpolated `env_file` from *every* service, and requires the deploy to
export every interpolated image variable. This task's service breaks all three: it is
a fifth service, it deliberately has no env-file, and nothing sets
`ADMIN_MANAGEMENT_IMAGE` until Task 9(d). Task 9 must therefore ALSO edit that test —
add `admin-management` to the expected list and make the env-file requirement skip the
one service that is documented as holding no credential — not merely append its own new
test. Until then `npm test` is 530/531 with one failure.

- [x] **Step 5: Commit**

```bash
git add apps/admin-management/Dockerfile docker-compose.yml \
        apps/admin-management/test/public-ui.test.js \
        docs/superpowers/plans/2026-08-05-admin-management-signin.md
git commit -m "feat(admin-management): an image with no secret and a loopback-only port"
```

---

### Task 7: `API_PUBLIC_ORIGIN` moves — SIX SITES, ONE COMMIT

**This is the dangerous task.** Read spec §5 before starting.

`docker-compose.yml` sets `API_PUBLIC_ORIGIN: https://api.yeyintlwin.com`, and
`deploy.yml` blocks 4 and 5 both send `-H 'Origin: https://api.yeyintlwin.com'`.
Change the variable alone and both probes get **403 `origin_not_allowed`** where they
expect 401 — and the deploy fails **after the migration has applied**, which is the
failure shape §9.5 exists to design away.

**Files:**

- Modify: `docker-compose.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `apps/core-api/test/config.test.js`
- Modify: `apps/core-api/test/deploy-config.test.js` — **added during execution.** It pins
  the compose line a second time, in escaped-regex form; see the note under Step 3.

**Nothing under `apps/core-api/` *source* changes.** The variable's value moves; no
check, route or header is touched.

**The mirrors:**

```bash
grep -rn "api.yeyintlwin.com" docker-compose.yml .github/workflows/deploy.yml apps/core-api/test/config.test.js
```

- [x] **Step 1: Run the suite first, so you know what green looked like**

```bash
export CORE_API_TEST_DATABASE_URL='postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
node --test apps/core-api/test/config.test.js apps/core-api/test/deploy-config.test.js
```

Expected: green. Record the counts; you are about to break and restore them.

> **Measured: 45 tests, 44 pass, 1 fail — and the fail is NOT green.** `config.test.js`
> is 29/29. `deploy-config.test.js` is 15/16, still carrying the failure Task 6 left at
> `deploy-config.test.js:249` and Task 9 repairs (see the note under Task 6 Step 4).
> That is the number to restore, not zero.

- [x] **Step 2: Change the variable alone, and watch it go red**

In `docker-compose.yml`:

```yaml
      # The origin BROWSERS use for cookie-authenticated requests, which is the admin
      # app -- it serves the UI and proxies /api, so core-api only ever sees requests
      # whose Origin is this. api.yeyintlwin.com keeps answering for terminal and
      # service callers, which authenticate by bearer and are exempt from the Origin
      # check entirely (spec 5.3).
      API_PUBLIC_ORIGIN: https://admin.yeyintlwin.com
```

```bash
node --test apps/core-api/test/config.test.js
```

Expected: **FAIL** on the frozen `PRODUCTION_ENV` fixture. That failure is the
mechanism working — it is the only automated thing standing between this edit and a
broken deploy.

> **The mechanism fired, but NOT where this step says.** Measured 28/29, one failure:
> `"the compose reader reads the real file and cannot pass by returning nothing"` at
> `config.test.js:507`, which asserts `COMPOSE_CORE_API.API_PUBLIC_ORIGIN` against the
> real file. `PRODUCTION_ENV` is a hand-written frozen literal — no edit to
> `docker-compose.yml` can move it, so it cannot be the guard. **The guard is the
> compose reader.** Worth knowing, because the reader is what a future edit must not
> be allowed to delete: `PRODUCTION_ENV` would keep passing over a compose file that
> says anything at all.

- [x] **Step 3: Move the other two sites in the same commit**

In `apps/core-api/test/config.test.js`, the `PRODUCTION_ENV` fixture:

```js
  API_PUBLIC_ORIGIN: "https://admin.yeyintlwin.com",
```

In `.github/workflows/deploy.yml`, **both** login probes — block 4's forgeability
probe and block 5's `limit_req` burst. Find them with
`grep -n "Origin: https://api.yeyintlwin.com" .github/workflows/deploy.yml`; there
are exactly two:

```sh
            -H 'Origin: https://admin.yeyintlwin.com' -H 'Content-Type: application/json' \
```

Add a line to block 4's comment recording why the origin is not the host being
called:

```sh
          # The Origin is the ADMIN app, not this host. core-api compares Origin to
          # API_PUBLIC_ORIGIN, and that is admin.yeyintlwin.com since the admin UI
          # became the only cookie-authenticated caller. Sending this host's name here
          # would be a 403 and the probe would prove nothing about login.
```

> **"The other two sites" is FIVE, and this step's own `grep` cannot find two of them.**
> Measured, all moved in this commit:
>
> 1. `config.test.js:22` — the `PRODUCTION_ENV` fixture, the one this step names.
> 2. `config.test.js:211` — `assert.equal(startupConfiguration(PRODUCTION_ENV).apiPublicOrigin, ...)`.
>    Moving the fixture without this one just relocates the red.
> 3. `config.test.js:507` — the compose-reader assertion, which is what Step 2 actually broke.
> 4. `deploy-config.test.js:198` — `assert.match(text, /^      API_PUBLIC_ORIGIN: https:\/\/api\.yeyintlwin\.com$/m)`,
>    a **sixth pin on the compose line**, in a file this task does not list under **Files**.
>    It survived the mirrors `grep` because the literal is written with backslash-escaped
>    dots: `grep "api.yeyintlwin.com"` matches `.` as any character, but nothing in it
>    matches a backslash. **Any future grep for a mirror of a hostname must also try the
>    escaped form** — `grep -rn 'api\\\.yeyintlwin\\\.com'`.
> 5. `deploy.yml` — both `Origin:` headers, exactly two as stated.
>
> The three `api.yeyintlwin.com` literals left in `config.test.js:204-218` are correct as
> they stand: they are `DEV_ENV` overrides exercising trailing-slash normalisation and the
> six rejection shapes, and any hostname serves. The `api.yeyintlwin.com` in
> `deploy-config.test.js:358/647/653/712` and all of `nginx-config.test.js` are the HOST,
> which is not moving — only the browser Origin moved.

- [x] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/config.test.js apps/core-api/test/deploy-config.test.js
npm test
```

Expected: back to green, with the counts from Step 1.

> **Measured: back to Step 1 exactly — 45 tests, 44 pass, 1 fail, and the one fail is
> Task 6's `deploy-config.test.js:249`, unchanged.** `docker compose config --quiet`
> still parses. Full suite: 14 / 33 / 69 / 531 (529 pass, 1 fail, 1 skip) and
> admin-management 29/29 run separately — the root `npm test` chain stops at the red
> core-api suite and never reaches the fifth, which is the gating behaviour Task 5's
> note predicted.

- [x] **Step 5: Commit**

```bash
git add docker-compose.yml .github/workflows/deploy.yml apps/core-api/test/config.test.js \
        apps/core-api/test/deploy-config.test.js \
        docs/superpowers/plans/2026-08-05-admin-management-signin.md
git commit -m "feat: API_PUBLIC_ORIGIN is the admin app, and the deploy probes say so too"
```

---

### Task 8: The nginx server block, and the certificate that must exist first

**Files:**

- Create: `infra/nginx/admin.conf`
- Modify: `infra/README.md`
- Modify: `apps/core-api/test/nginx-config.test.js`

> **MANUAL PREREQUISITE, and the deploy fails without it.** `ssl_certificate` is read
> at parse time, so a server block naming a certificate that is not on disk makes
> `nginx -t` fail — and the deploy runs `nginx -t` as a gate and rolls back. Before
> this task's commit reaches `main`:
>
> ```sh
> # DNS: an A record for admin.yeyintlwin.com → the Lightsail address
> sudo certbot certonly --nginx -d admin.yeyintlwin.com
> ```

- [ ] **Step 1: Write the failing test**

Add to `apps/core-api/test/nginx-config.test.js`:

```js
test("the admin block serves the UI and proxies /api without adding a hop", () => {
  const admin = stripComments(readText(repoRoot, "infra", "nginx", "admin.conf"));

  assert.match(admin, /server_name admin\.yeyintlwin\.com;/);
  assert.match(admin, /ssl_certificate\s+\/etc\/letsencrypt\/live\/admin\.yeyintlwin\.com\/fullchain\.pem;/);

  // It proxies to the admin app, which does the /api forwarding itself. A second
  // nginx location proxying /api straight to core-api would be a THIRD path to the
  // same API with different headers.
  assert.match(admin, /proxy_pass\s+http:\/\/127\.0\.0\.1:3400;/);

  // The hop count is the whole reason this is asserted. nginx appends the client
  // here exactly once, the admin app appends nothing, so core-api still sees one hop
  // and TRUSTED_PROXY_HOPS stays 1.
  const appends = (admin.match(/\$proxy_add_x_forwarded_for/g) || []).length;
  assert.equal(appends, 1, "admin.conf must append X-Forwarded-For exactly once");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/nginx-config.test.js
```

Expected: FAIL — `admin.conf` does not exist.

- [ ] **Step 3: Write the block**

Create `infra/nginx/admin.conf`, modelled on `infra/nginx/api.conf`:

```nginx
# admin.yeyintlwin.com -- the management front end.
#
# ONE ORIGIN IS THE POINT. The browser loads the page and calls /api from the same
# name, so core-api's __Host- session cookie works and no CORS is involved. The
# /api forwarding is done by the admin app itself, NOT by a second location here:
# two paths to the same API with different headers is how one of them quietly stops
# sending Origin.

server {
    listen 80;
    listen [::]:80;
    server_name admin.yeyintlwin.com;

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name admin.yeyintlwin.com;

    ssl_certificate     /etc/letsencrypt/live/admin.yeyintlwin.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.yeyintlwin.com/privkey.pem;

    # The sign-in body is small; the cap keeps a hostile body off the app entirely.
    client_max_body_size 64k;

    location / {
        proxy_pass http://127.0.0.1:3400;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        # EXACTLY ONE append, here. The admin app forwards this header untouched, so
        # core-api counts one hop and TRUSTED_PROXY_HOPS stays 1.
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Origin is NOT set here. core-api compares it to API_PUBLIC_ORIGIN, so it
        # must arrive exactly as the browser sent it.
    }
}
```

In `infra/README.md`, add the subdomain to the topology section and record the
certificate as a cutover step.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test apps/core-api/test/nginx-config.test.js apps/core-api/test/operations-docs.test.js
```

Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add infra/nginx/admin.conf infra/README.md apps/core-api/test/nginx-config.test.js \
        docs/superpowers/plans/2026-08-05-admin-management-signin.md
git commit -m "feat(infra): admin.yeyintlwin.com, with exactly one X-Forwarded-For append"
```

---

### Task 9: The deploy — build, test, upload, and the nginx include count

**Files:**

- Modify: `.github/workflows/deploy.yml`
- Modify: `apps/core-api/test/deploy-config.test.js`

- [ ] **Step 1: Write the failing test**

Add to `apps/core-api/test/deploy-config.test.js`, beside the existing per-app
assertions:

```js
test("the deploy builds, tests and ships admin-management", () => {
  const workflow = workflowText();

  // It has no dependencies, so there is no `npm ci` -- but the suite must run, or a
  // broken front end reaches the box with a green build.
  assert.match(workflow, /npm --prefix apps\/admin-management test/);
  assert.match(workflow, /docker build -f apps\/admin-management\/Dockerfile -t admin-management:/);
  assert.match(workflow, /ADMIN_MANAGEMENT_IMAGE=admin-management:/);

  // And the new nginx file has to be installed, or the server block never exists on
  // the box and admin.yeyintlwin.com 404s from the default server.
  assert.match(workflow, /admin\.conf/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test apps/core-api/test/deploy-config.test.js
```

Expected: FAIL on all four assertions.

- [ ] **Step 3: Edit the workflow**

Four regions, each beside its existing siblings. Find them with
`grep -n "customer-order" .github/workflows/deploy.yml`.

**(a)** The test job — after the `customer-order` test step:

```yaml
      # No `npm ci`: this app declares zero dependencies, like customer-order.
      - run: npm --prefix apps/admin-management test
```

**(b)** The build step:

```bash
          docker build -f apps/admin-management/Dockerfile -t admin-management:${{ github.sha }} .
```

**(c)** Wherever the other three images are saved and copied to the box, add
`admin-management` in the same shape. Read the surrounding lines rather than
guessing — the tarball name, the `docker load` and the `scp` must agree.

**(d)** The image export beside the other three:

```bash
          export ADMIN_MANAGEMENT_IMAGE=admin-management:${{ github.sha }}
```

**(e)** The nginx install step. `nginx-config.test.js` pins the include count, so
find it and read what it expects before editing:

```bash
grep -n "includeCount\|conf.d" apps/core-api/test/nginx-config.test.js .github/workflows/deploy.yml
```

Install `admin.conf` alongside `api.conf` and `core-api-proxy.conf`, and update the
count assertion in the same commit.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
export CORE_API_TEST_DATABASE_URL='postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
npm test
```

Expected: five suites, all green.

- [ ] **Step 5: Commit and watch the deploy**

```bash
git add .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js \
        docs/superpowers/plans/2026-08-05-admin-management-signin.md
git commit -m "feat(deploy): build, test and ship admin-management, and install its nginx block"
```

**Then watch it.** This push changes the deploy's own probes (Task 7) and adds a
server block (Task 8). If `nginx -t` fails, the certificate prerequisite was skipped.

```bash
gh run watch
```

- [ ] **Step 6: MANUAL — sign in through a browser**

Open `https://admin.yeyintlwin.com`, sign in, and confirm:

- the page shows your email and `platform_admin · no company selected`
- a wrong password leaves the email in the field and clears the password
- **Sign out everywhere** returns to the form
- DevTools → Application → Cookies shows `__Host-core_session` with `Secure`,
  `HttpOnly`, `SameSite=Lax`, `Path=/`

Tick this only after a human has actually done it.

---

## Self-review

**Spec coverage.** §1.1's three items map to Tasks 1–4 (page), 1–2 (proxy), 8 (the
subdomain). §2's seven decisions: 1 and 2 are the architecture of Tasks 1–2; 3 is
Task 7; 4 is the manifest in Task 1 and the Dockerfile in Task 6; 5 is Task 3; 6 is
Task 3's `failure()` and Task 4's `describe()`; 7 is Task 4's single document. §3.1's
four proxy rules each have a test in Task 2 — except "must not log request bodies",
which is enforced by there being no logging in the proxy at all and asserted
indirectly by Task 4's password scan. §4's three states are Task 4. §5's two lockstep
lists are Tasks 5, 6, 7 and 9. §6's four justifying tests are in Tasks 2 and 3. §7 is
Task 4's stylesheet. §8's residuals need no code.

**One spec item deliberately has no task:** §8's note that a lapsed certificate makes
the admin UI unreachable while the API stays up. It is an operational observation,
recorded in `infra/README.md` by Task 8 rather than implemented.
