const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { AUTH_MODES, listRoutes, validateRouteTable } = require("../http/router");

const appRoot = path.join(__dirname, "..");
const routesDirectory = path.join(appRoot, "http", "routes");

// Load every route module so the census covers the production table. This file registers
// NOTHING of its own — rule 2 asserts set equality, and a scratch route would break it.
const routeModules = fs.readdirSync(routesDirectory).filter((name) => name.endsWith(".js"));
for (const name of routeModules) require(path.join(routesDirectory, name));

const entries = listRoutes();
const keys = entries.map((entry) => entry.key);

test("the route table exists and passes boot validation", () => {
  assert.ok(routeModules.length > 0, "http/routes must contain at least one module");
  assert.ok(entries.length > 0, "no routes were registered");
  assert.doesNotThrow(() => validateRouteTable());
});

test("rule 1: every entry declares one of the three auth modes", () => {
  for (const entry of entries) {
    assert.ok(AUTH_MODES.includes(entry.options.auth), `${entry.key} declares auth ${JSON.stringify(entry.options.auth)}`);
  }
});

test("rule 2: the public set is exactly the Plan 1 set", () => {
  const publicKeys = new Set(entries.filter((entry) => entry.options.auth === "public").map((entry) => entry.key));

  // Set EQUALITY, not containment: adding a fourth fails and so does removing one.
  // Three of the eight that identity spec 6.2 enumerates. The next five are Plan 2d's
  // recovery routes; POST /api/terminal/pair makes nine and arrives with the terminal
  // plan. Widen this literal in the same commit as the route, never ahead of it.
  assert.deepEqual(
    publicKeys,
    new Set(["GET /health", "GET /health/ready", "POST /api/admin/auth/login"])
  );
});

test("the origin-gated set is derived and pinned, so a new public POST cannot skip the gate", () => {
  const { requiresOriginCheck } = require("../http/csrf");
  const gated = new Set(entries.filter(requiresOriginCheck).map((entry) => entry.key));

  // Identity spec 6.3's amended rule, asserted as a CENSUS rather than declared as a
  // route option: 8.5 is exactly ten rules and adding an `origin:` option would be a
  // design change rather than a repair. Plan 2d adds forgot-password, reset-password
  // and verify-email; the auth routes below arrive across Tasks 12-15.
  assert.deepEqual(gated, new Set([
    "POST /api/admin/auth/login",
    "POST /api/admin/auth/logout",
    "POST /api/admin/auth/logout-all"
  ]));
});

test("rule 3: neither settled must-change-password exemption is declared before its route exists", () => {
  const exempt = new Set(entries.filter((entry) => entry.options.exemptFromPasswordChange === true).map((entry) => entry.key));

  // Spec §8.5 rule 3's target set. Intersected with what is actually registered, so this is
  // empty in Plan 1 and arms itself the moment either route lands: registering the password or
  // logout route WITHOUT the exemption flag then fails here, which is the regression that
  // locks a user out of the only two routes that can clear must_change_password.
  const SETTLED_EXEMPT = ["POST /api/admin/auth/password", "POST /api/admin/auth/logout"];
  assert.deepEqual(exempt, new Set(SETTLED_EXEMPT.filter((key) => keys.includes(key))));
});

test("rule 4: no duplicate method+path", () => {
  assert.deepEqual([...new Set(keys)].sort(), [...keys].sort());
});

test("rule 4: every path parameter has a params entry", () => {
  for (const entry of entries) {
    for (const segment of entry.path.split("/")) {
      if (!segment.startsWith(":")) continue;
      const name = segment.slice(1);
      assert.ok(entry.options.params && name in entry.options.params, `${entry.key} declares no params entry for :${name}`);
    }
  }
});

test("rule 4: every non-GET route declares body and audit", () => {
  for (const entry of entries.filter((candidate) => candidate.method !== "GET")) {
    assert.ok("body" in entry.options, `${entry.key} must declare body`);
    assert.match(entry.options.audit || "", /^[a-z_]+\.[a-z_]+$/, `${entry.key} must declare an audit action`);
  }
});

test("rule 5: terminal routes are nested and user routes declare roles", () => {
  for (const entry of entries) {
    if (entry.options.auth === "terminal") {
      assert.ok(entry.path.startsWith("/api/terminal/"), `${entry.key} is auth:'terminal' but is not nested`);
    }
    if (entry.options.auth === "user") {
      assert.ok(Array.isArray(entry.options.roles) && entry.options.roles.length > 0, `${entry.key} declares no roles`);
    }
  }
});

test("rule 8: no principal-keyed rate limit sits on a public route", () => {
  for (const entry of entries) {
    if (!entry.options.limit) continue;
    if (!["user", "terminal"].includes(entry.options.limit.key)) continue;
    assert.notEqual(entry.options.auth, "public", `${entry.key} keys a bucket on a principal it has not resolved`);
  }
});

test("rule 10: every entry declares a sample", () => {
  for (const entry of entries) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(entry.options, "sample"),
      `${entry.key} must declare a sample — the tenant-isolation route probe is driven off it`
    );
  }
});

test("server.js requires every route module, so this census covers what production serves", () => {
  const source = fs.readFileSync(path.join(appRoot, "server.js"), "utf8");

  for (const name of routeModules) {
    const specifier = `./http/routes/${name.replace(/\.js$/, "")}`;
    assert.ok(source.includes(`require("${specifier}")`), `server.js must require("${specifier}")`);
  }
});

test("no route answers to its own path with a trailing slash", () => {
  // A cross-file invariant, and the only place the two halves of it meet.
  //
  // nginx grades this service with `location = <path>` -- an EXACT match. Express
  // and the 404/405 tail used to tolerate a trailing slash, so "/health/" missed
  // `location = /health` (and its `allow 127.0.0.1; deny all;`), fell through to
  // the catch-all `location /`, was proxied with no ACL consulted, and was then
  // matched and served by the handler. "/health/ready/" walked past its
  // `return 404;` the same way.
  //
  // The cost is not the health routes. It is that every credential route inherits
  // it: "POST /api/admin/auth/login/" would be graded by zone=core_api burst=40
  // rather than zone=core_login burst=5, defeating the network half of the shed
  // that keeps a flood off the 2-slot scrypt semaphore -- and the deploy's own
  // probe curls the unslashed URI, so nothing would have noticed.
  for (const entry of entries) {
    assert.equal(
      entry.pattern.test(`${entry.path}/`),
      false,
      `${entry.key} also answers to ${entry.path}/, which nginx's "location = ${entry.path}" does not cover`
    );
  }
});
