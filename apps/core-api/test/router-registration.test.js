const assert = require("node:assert/strict");
const test = require("node:test");
const { AUTH_MODES, route, listRoutes } = require("../http/router");
const { sendJson } = require("../http/respond");

// Scratch routes for this file only. They exist so the dispatch tests in later tasks have
// something to hit; route-auth.test.js deliberately registers nothing.
route("GET", "/__probe/ok", { auth: "public" }, (req, res) => sendJson(res, 200, { probe: "get" }));
// auth.logout, not shop.updated: validateRouteTable now asserts membership of the
// spec 5.9 vocabulary, and shop.* arrives with the shop routes in Plan 2c. This
// route registers into the LIVE table, so createApp() below validates it.
route("POST", "/__probe/ok", { auth: "public", body: null, audit: "auth.logout" }, (req, res) =>
  sendJson(res, 201, { probe: "post" })
);
route("GET", "/__probe/items/:itemId", { auth: "public", params: { itemId: "uuid" } }, (req, res) =>
  sendJson(res, 200, { itemId: req.params.itemId })
);
route("GET", "/__probe/boom", { auth: "public" }, () => {
  const error = new Error('relation "users" does not exist in SELECT * FROM users');
  error.constraint = "users_email_active_key";
  throw error;
});

test("the three auth modes are the whole vocabulary", () => {
  assert.deepEqual([...AUTH_MODES].sort(), ["public", "terminal", "user"]);
});

test("route() throws when auth is absent — there is no default anywhere", () => {
  assert.throws(
    () => route("GET", "/__probe/undeclared", {}, () => {}),
    /must declare auth as one of user\|terminal\|public/
  );
});

test("route() throws for an auth value outside the vocabulary", () => {
  for (const bad of ["admin", "USER", null, true, ""]) {
    assert.throws(
      () => route("GET", "/__probe/undeclared", { auth: bad }, () => {}),
      /must declare auth as one of user\|terminal\|public/,
      `auth: ${JSON.stringify(bad)}`
    );
  }
});

test("route() throws when options is missing entirely", () => {
  assert.throws(() => route("GET", "/__probe/undeclared", undefined, () => {}), /needs an options object declaring auth/);
});

test("route() rejects an unknown method, a relative path and a missing handler", () => {
  assert.throws(() => route("get", "/__probe/x", { auth: "public" }, () => {}), /method must be one of/);
  assert.throws(() => route("OPTIONS", "/__probe/x", { auth: "public" }, () => {}), /method must be one of/);
  assert.throws(() => route("GET", "__probe/x", { auth: "public" }, () => {}), /path must be a string starting with/);
  assert.throws(() => route("GET", "/__probe/x", { auth: "public" }, null), /needs a handler function/);
});

test("route() rejects a duplicate method+path", () => {
  assert.throws(() => route("GET", "/__probe/ok", { auth: "public" }, () => {}), /duplicate registration for GET \/__probe\/ok/);
});

test("listRoutes() returns the registered entries with frozen options", () => {
  const entry = listRoutes().find((candidate) => candidate.key === "GET /__probe/ok");

  assert.ok(entry, "GET /__probe/ok should be registered");
  assert.equal(entry.method, "GET");
  assert.equal(entry.path, "/__probe/ok");
  assert.equal(entry.options.auth, "public");
  assert.equal(Object.isFrozen(entry.options), true);
  assert.equal(typeof entry.handler, "function");
});

test("listRoutes() hands back a copy, so a caller cannot mutate the table", () => {
  const before = listRoutes().length;
  listRoutes().push({ key: "GET /injected" });
  assert.equal(listRoutes().length, before);
});

const { ROLE_ALIASES, validateRouteTable } = require("../http/router");

// validateRouteTable takes the entries as a parameter precisely so the rules can be exercised
// against synthetic tables without polluting the live registry that route-auth.test.js censuses.
function entry(method, path, options) {
  return { key: `${method} ${path}`, method, path, options };
}

test("the four role aliases of spec 5.4 are the whole vocabulary", () => {
  assert.deepEqual([...ROLE_ALIASES].sort(), ["anyUser", "companyAdmin", "manager", "platform"]);
});

test("validateRouteTable accepts the live table", () => {
  assert.equal(validateRouteTable().length, listRoutes().length);
});

test("rule 1: an auth mode outside the vocabulary is fatal at boot", () => {
  assert.throws(() => validateRouteTable([entry("GET", "/x", { auth: "sometimes" })]), /unknown auth mode/);
});

test("rule 4: a duplicate method+path is fatal at boot", () => {
  assert.throws(
    () => validateRouteTable([entry("GET", "/x", { auth: "public" }), entry("GET", "/x", { auth: "public" })]),
    /duplicate GET \/x/
  );
});

test("rule 4: a :param with no params entry is fatal", () => {
  assert.throws(
    () => validateRouteTable([entry("GET", "/shops/:shopId", { auth: "public" })]),
    /path parameter :shopId with no params entry/
  );
  assert.doesNotThrow(() => validateRouteTable([entry("GET", "/shops/:shopId", { auth: "public", params: { shopId: "uuid" } })]));
});

test("rule 4: a non-GET route must declare body and an audit action", () => {
  assert.throws(
    () => validateRouteTable([entry("POST", "/x", { auth: "public", audit: "auth.logout" })]),
    /must declare body \(null when it takes none\)/
  );
  assert.throws(() => validateRouteTable([entry("POST", "/x", { auth: "public", body: null })]), /must declare an audit action/);
  assert.throws(
    () => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: "shopCreated" })]),
    /must declare an audit action/
  );
  assert.doesNotThrow(() => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: "auth.logout" })]));
});

test("rule 5: an auth:'terminal' route outside /api/terminal/ is fatal", () => {
  assert.throws(() => validateRouteTable([entry("GET", "/api/admin/me", { auth: "terminal" })]), /is not under \/api\/terminal\//);
  assert.doesNotThrow(() => validateRouteTable([entry("GET", "/api/terminal/me", { auth: "terminal" })]));
});

test("rule 5: an auth:'user' route needs a non-empty roles list from the four aliases", () => {
  assert.throws(() => validateRouteTable([entry("GET", "/api/admin/shops", { auth: "user" })]), /must declare a non-empty roles array/);
  assert.throws(() => validateRouteTable([entry("GET", "/api/admin/shops", { auth: "user", roles: [] })]), /must declare a non-empty roles array/);
  assert.throws(
    () => validateRouteTable([entry("GET", "/api/admin/shops", { auth: "user", roles: ["shop_manager"] })]),
    /unknown role alias "shop_manager"/
  );
  assert.doesNotThrow(() => validateRouteTable([entry("GET", "/api/admin/shops", { auth: "user", roles: ["anyUser"] })]));
});

test("rule 8: a principal-keyed rate limit on a public route is fatal", () => {
  assert.throws(
    () =>
      validateRouteTable([
        entry("POST", "/api/terminal/pair", {
          auth: "public",
          body: null,
          audit: "auth.logout",
          limit: { key: "user", name: "create-user" }
        })
      ]),
    /keys a rate-limit bucket on "user" but is auth:'public'/
  );
  assert.doesNotThrow(() =>
    validateRouteTable([
      entry("POST", "/api/terminal/pair", {
        auth: "public",
        body: null,
        audit: "auth.logout",
        limit: { key: "ip", name: "pair-global" }
      })
    ])
  );
});

const { LIMITERS } = require("../lib/rate-limit");

test("validateRouteTable rejects a limit naming a limiter outside the 5.7 roster", () => {
  // Spec 5.7 claimed route() already did this. It did not: limit: { key: "ip",
  // name: "invented" } registered cleanly and the process listened. A limiter name
  // nobody declared is a bucket nobody sized, so the ceiling the route thinks it
  // has does not exist.
  assert.throws(
    () =>
      validateRouteTable([
        entry("POST", "/x", {
          auth: "public",
          body: null,
          audit: "auth.login",
          limit: { key: "ip", name: "invented" }
        })
      ]),
    /limit\.name "invented".*roster/s
  );
});

test("validateRouteTable rejects a limit whose key disagrees with the roster", () => {
  // The half that is easy to miss: "login-global" IS in the roster, so a name-only
  // check passes, while the route has quietly asked for a per-user bucket on a
  // public route. Rule 8 catches THAT particular pair; this catches the general
  // case, including terminal-vs-user on an authenticated route where rule 8 is
  // silent.
  assert.throws(
    () =>
      validateRouteTable([
        entry("POST", "/x", {
          auth: "user",
          roles: ["anyUser"],
          body: null,
          audit: "auth.login",
          limit: { key: "terminal", name: "create-user" }
        })
      ]),
    /keys "create-user" on "user"/
  );
});

test("validateRouteTable accepts every name in the roster", () => {
  // The anti-vacuity half. A regex typo that made the membership test always throw
  // would pass both cases above and make the whole roster unusable at boot.
  for (const [name, declared] of Object.entries(LIMITERS)) {
    const options = {
      auth: declared.key === "ip" ? "public" : "user",
      body: null,
      audit: "auth.login",
      limit: { key: declared.key, name }
    };
    if (options.auth === "user") options.roles = ["anyUser"];
    assert.doesNotThrow(() => validateRouteTable([entry("POST", "/x", options)]), name);
  }
});

test("validateRouteTable rejects a limit that is not an object", () => {
  for (const bad of ["login-global", 5, true]) {
    assert.throws(
      () => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: "auth.login", limit: bad })]),
      /must be an object/,
      JSON.stringify(bad)
    );
  }
});

const { AUDIT_ACTIONS } = require("../lib/audit-vocabulary");

test("validateRouteTable rejects an audit action outside the 5.9 vocabulary", () => {
  // The shape check has always been here: user.frobnicated is a legal noun.verb,
  // and audit_events' CHECK is ALSO only a shape regex, so the row would be
  // written. The closed vocabulary is what audit_events_detail_no_credentials is
  // protecting, and it is worthless if any handler can name an action nobody chose.
  assert.throws(
    () => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: "user.frobnicated" })]),
    /not in the .*vocabulary/
  );
});

test("validateRouteTable still rejects a malformed audit action before checking membership", () => {
  // Ordering matters for the message: "Frobnicated" fails the SHAPE, and reporting
  // it as "not in the vocabulary" would send the reader to the wrong file.
  assert.throws(
    () => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: "Frobnicated" })]),
    /must declare an audit action of the form/
  );
});

test("validateRouteTable accepts every action in the vocabulary", () => {
  for (const action of Object.keys(AUDIT_ACTIONS)) {
    assert.doesNotThrow(
      () => validateRouteTable([entry("POST", "/x", { auth: "public", body: null, audit: action })]),
      action
    );
  }
});

const { createApp } = require("../http/router");

// Plan 2 extracts this into testing/http.js when the explicit cookie jar arrives (spec §8.1);
// twelve duplicated lines is cheaper than a helper nothing else uses yet.
async function withServer(deps, run) {
  const app = createApp(deps);
  const server = app.listen(0, "127.0.0.1");
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

function captureLog() {
  const lines = [];
  const log = (line) => lines.push(line);
  log.access = () => lines.map((line) => JSON.parse(line)).filter((record) => record.level === undefined);
  log.raw = () => lines;
  return log;
}

test("GET dispatches through the table and carries the base headers", async () => {
  await withServer({ log: captureLog(), trustedProxyHops: 0 }, async (base) => {
    const response = await fetch(`${base}/__probe/ok`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { probe: "get" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
});

test("HEAD resolves through the same table as GET, with the body stripped", async () => {
  await withServer({ log: captureLog(), trustedProxyHops: 0 }, async (base) => {
    const response = await fetch(`${base}/__probe/ok`, { method: "HEAD" });

    assert.equal(response.status, 200, "the wget --spider healthcheck issues HEAD");
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength('{"probe":"get"}')));
  });
});

test("a path parameter reaches the handler", async () => {
  await withServer({ log: captureLog(), trustedProxyHops: 0 }, async (base) => {
    const response = await fetch(`${base}/__probe/items/abc123`);
    assert.deepEqual(await response.json(), { itemId: "abc123" });
  });
});

test("an unregistered method on a known path is 405 with Allow, and HEAD counts as GET", async () => {
  await withServer({ log: captureLog(), trustedProxyHops: 0 }, async (base) => {
    for (const method of ["DELETE", "PATCH", "OPTIONS"]) {
      const response = await fetch(`${base}/__probe/ok`, { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("allow"), "GET, HEAD, POST", method);
      if (method !== "OPTIONS") continue;
      const body = await response.json();
      assert.equal(body.error.code, "method_not_allowed");
    }
  });
});

test("an unknown path is 404 not_found with an 8-character requestId", async () => {
  await withServer({ log: captureLog(), trustedProxyHops: 0 }, async (base) => {
    const response = await fetch(`${base}/__probe/nowhere`);

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("allow"), null);
    const body = await response.json();
    assert.equal(body.error.code, "not_found");
    assert.match(body.error.requestId, /^[A-Za-z0-9_-]{8}$/);
  });
});

test("a throwing handler becomes an opaque 500 that leaks no driver text", async () => {
  await withServer({ log: captureLog(), trustedProxyHops: 0 }, async (base) => {
    const response = await fetch(`${base}/__probe/boom`);

    assert.equal(response.status, 500);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, "internal_error");
    assert.doesNotMatch(text, /SELECT|users_email_active_key|does not exist|at Object\./);
  });
});

test("the request log records the route pattern, never the raw path or query string", async () => {
  const log = captureLog();
  await withServer({ log, trustedProxyHops: 0 }, async (base) => {
    await fetch(`${base}/__probe/items/abc123?token=leaked-secret`);
  });

  const access = log.access();
  assert.equal(access.length, 1, "exactly one access line per request");
  assert.equal(access[0].route, "/__probe/items/:itemId");
  assert.equal(access[0].method, "GET");
  assert.equal(access[0].status, 200);
  assert.equal(access[0].actorKind, "anonymous");
  assert.equal(access[0].actorId, null);
  assert.equal(typeof access[0].durationMs, "number");
  assert.match(access[0].requestId, /^[A-Za-z0-9_-]{8}$/);
  for (const line of log.raw()) {
    assert.doesNotMatch(line, /leaked-secret|abc123/, "neither the query string nor the raw segment may be logged");
  }
});

test("the logged requestId is the one the client was given", async () => {
  const log = captureLog();
  let seen;
  await withServer({ log, trustedProxyHops: 0 }, async (base) => {
    seen = (await (await fetch(`${base}/__probe/nowhere`)).json()).error.requestId;
  });

  assert.equal(log.access()[0].requestId, seen);
  assert.equal(log.access()[0].route, null, "an unmatched request has no pattern to log");
});
