"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { sendError } = require("./respond");

// Spec §3.2 rule 2: this is the ONLY file in the service that may require("express"), and
// source-structure.test.js rule C3 asserts that by name. One registration function means one
// place where authentication can be forgotten. Express 4 — Express 5 changes path-pattern
// syntax and the OPTIONS/HEAD fallbacks the tail below depends on.

const AUTH_MODES = Object.freeze(["user", "terminal", "public"]);
const METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// Spec §5.4. A scoped platform_admin materialises role 'platform_admin' (rank 3), so the rank
// lattice does the work and no fifth alias is needed.
const ROLE_ALIASES = Object.freeze(["platform", "companyAdmin", "manager", "anyUser"]);
// Spec §6.3.5: buckets keyed on a principal cannot exist before credential resolution.
const PRINCIPAL_LIMIT_KEYS = Object.freeze(["user", "terminal"]);
const AUDIT_ACTION_SHAPE = /^[a-z_]+\.[a-z_]+$/;

const routes = [];

// Compiled here rather than borrowed from Express's internals because the 404/405 tail needs
// to answer "which methods are registered for this path" for a path that matched no route.
function pathToRegExp(pattern) {
  const source = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}/?$`);
}

function route(method, path, options, handler) {
  if (!METHODS.includes(method)) {
    throw new Error(`route(): method must be one of ${METHODS.join(", ")}, got ${JSON.stringify(method)}`);
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(`route(): path must be a string starting with "/", got ${JSON.stringify(path)}`);
  }
  if (options === null || typeof options !== "object") {
    throw new Error(`route(): ${method} ${path} needs an options object declaring auth`);
  }
  if (!AUTH_MODES.includes(options.auth)) {
    throw new Error(
      `route(): ${method} ${path} must declare auth as one of ${AUTH_MODES.join("|")}, got ${JSON.stringify(options.auth)}`
    );
  }
  if (typeof handler !== "function") {
    throw new Error(`route(): ${method} ${path} needs a handler function`);
  }

  const key = `${method} ${path}`;
  if (routes.some((entry) => entry.key === key)) {
    throw new Error(`route(): duplicate registration for ${key}`);
  }

  const entry = Object.freeze({
    key,
    method,
    path,
    options: Object.freeze({ ...options }),
    handler,
    pattern: pathToRegExp(path)
  });
  routes.push(entry);
  return entry;
}

function listRoutes() {
  return routes.slice();
}

// Spec §8.5 rules 1, 4, 5 and 8 — the ones that are invariants of any table and hold with only
// health registered. Deliberately NOT here:
//   rule 2  (the public set equals the settled four) and rule 3 (the exempt set) — a census at
//           boot makes the service un-bootable at every intermediate commit; both live in
//           route-auth.test.js, which asserts set EQUALITY and so fails on an addition too.
//   rule 4's audit-vocabulary membership (§5.9) and the §5.7 limiter roster — Plan 2, with the
//           first non-GET route. The noun.verb shape is checked now so Plan 2 cannot invent
//           free-form strings and then have to reconcile them against the CHECK regex.
//   rule 6  (terminal-administration nesting) and rule 7 (a Location emitter has a GET) — Plan 2.
//   rule 9  is dispatch behaviour, in createApp(). Rule 10 is a test assertion.
// Takes `entries` as a parameter so the rules can be unit-tested on synthetic tables.
function validateRouteTable(entries = routes) {
  const seen = new Set();

  for (const item of entries) {
    const { method, path, options } = item;
    const where = `${method} ${path}`;

    if (!AUTH_MODES.includes(options.auth)) {
      throw new Error(`route table: ${where} declares an unknown auth mode ${JSON.stringify(options.auth)}`);
    }
    if (seen.has(item.key)) throw new Error(`route table: duplicate ${where}`);
    seen.add(item.key);

    for (const segment of path.split("/")) {
      if (!segment.startsWith(":")) continue;
      const name = segment.slice(1);
      if (!options.params || !Object.prototype.hasOwnProperty.call(options.params, name)) {
        throw new Error(`route table: ${where} has path parameter :${name} with no params entry`);
      }
    }

    if (method !== "GET") {
      if (!Object.prototype.hasOwnProperty.call(options, "body")) {
        throw new Error(`route table: ${where} must declare body (null when it takes none)`);
      }
      if (typeof options.audit !== "string" || !AUDIT_ACTION_SHAPE.test(options.audit)) {
        throw new Error(`route table: ${where} must declare an audit action of the form "noun.verb"`);
      }
    }

    if (options.auth === "terminal" && !path.startsWith("/api/terminal/")) {
      throw new Error(`route table: ${where} is auth:'terminal' but is not under /api/terminal/`);
    }

    if (options.auth === "user") {
      if (!Array.isArray(options.roles) || options.roles.length === 0) {
        throw new Error(`route table: ${where} is auth:'user' and must declare a non-empty roles array`);
      }
      for (const role of options.roles) {
        if (!ROLE_ALIASES.includes(role)) {
          throw new Error(`route table: ${where} declares unknown role alias ${JSON.stringify(role)}`);
        }
      }
    }

    if (options.limit && PRINCIPAL_LIMIT_KEYS.includes(options.limit.key) && options.auth === "public") {
      throw new Error(
        `route table: ${where} keys a rate-limit bucket on "${options.limit.key}" but is auth:'public' — that principal does not exist yet`
      );
    }
  }

  return entries;
}

function allowedMethods(pathname) {
  const allowed = new Set();
  for (const entry of routes) {
    if (!entry.pattern.test(pathname)) continue;
    allowed.add(entry.method);
    // Spec §8.5 rule 9: HEAD resolves through the GET entry, so it belongs in Allow.
    if (entry.method === "GET") allowed.add("HEAD");
  }
  return [...allowed].sort();
}

function createApp(deps = {}) {
  validateRouteTable();

  const log = typeof deps.log === "function" ? deps.log : (line) => process.stdout.write(`${line}\n`);
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  // "simple" is node:querystring, not qs — nothing in this service reads req.query, and the
  // extended parser is prototype-pollution surface for no benefit.
  app.set("query parser", "simple");
  // Deliberately NOT app.set("trust proxy"): the client IP is derived explicitly from
  // TRUSTED_PROXY_HOPS in lib/client-ip.js (Plan 2). Two derivation paths is one too many.

  // Pipeline step 1 (spec §6.3.5): requestId first. The security headers and Cache-Control are
  // applied by http/respond.js on the way out, which covers every response including the tails.
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    req.core = {
      requestId: crypto.randomBytes(6).toString("base64url"),
      routePattern: null,
      actorKind: "anonymous",
      actorId: null,
      logExtra: {},
      deps
    };
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // One structured line per request. The route PATTERN, never req.originalUrl — that is the
      // explicit rejection of morgan("combined") at apps/epaper-hub/server.js:32, which writes
      // the full URL including the ?api_key= that line 89 accepts. Never a body, never headers.
      // logExtra is written only by handlers, and only with closed vocabularies.
      log(
        JSON.stringify({
          method: req.method,
          route: req.core.routePattern,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          requestId: req.core.requestId,
          actorKind: req.core.actorKind,
          actorId: req.core.actorId,
          ...req.core.logExtra
        })
      );
    });
    next();
  });

  for (const entry of routes) {
    app[entry.method.toLowerCase()](entry.path, (req, res, next) => {
      req.core.routePattern = entry.path;
      try {
        const result = entry.handler(req, res);
        if (result && typeof result.then === "function") result.then(undefined, next);
      } catch (error) {
        next(error);
      }
    });
  }

  // The 404/405 tail. It MUST be registered after every route: Express 4's built-in OPTIONS
  // responder only fires once the whole stack declines, so a tail registered last pre-empts it
  // and OPTIONS gets 405 + Allow rather than a silent 200.
  app.use((req, res) => {
    const allowed = allowedMethods(req.path);
    if (allowed.length === 0) {
      sendError(res, { status: 404, code: "not_found" }, req.core.requestId);
      return;
    }
    sendError(res, { status: 405, code: "method_not_allowed" }, req.core.requestId, { Allow: allowed.join(", ") });
  });

  // Four parameters is what marks this as Express's error handler; `next` is unused on purpose.
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = Number.isInteger(error && error.status) ? error.status : 500;
    if (status >= 500) {
      // The message goes to the LOG, never to the response — that asymmetry is the whole point
      // of the requestId. This is a second line for the same request, tagged with a level so the
      // access log stays one-line-per-request.
      log(
        JSON.stringify({
          level: "error",
          requestId: req.core.requestId,
          route: req.core.routePattern,
          status,
          message: String((error && error.message) || error)
        })
      );
    }
    sendError(res, error, req.core.requestId);
  });

  return app;
}

module.exports = { AUTH_MODES, METHODS, ROLE_ALIASES, route, listRoutes, validateRouteTable, createApp };
