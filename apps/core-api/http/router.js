"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { sendError } = require("./respond");
const { LIMITERS } = require("../lib/rate-limit");
const { AUDIT_ACTIONS } = require("../lib/audit-vocabulary");
const { permits } = require("../lib/authorization");
const { buildClearingCookie } = require("./cookies");
const { requiresOriginCheck, assertOriginAndContentType } = require("./csrf");
const { sessionTokensPresented, clientAddressOf, authenticateUser } = require("./authenticate");

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
  // NO optional trailing slash. nginx grades this service with `location = <path>`,
  // which is an EXACT match, so "/health/" never matches `location = /health` and
  // falls to the catch-all `location /` -- which carries the proxy include and no
  // ACL. Tolerating the slash here therefore walked straight past `deny all` on
  // /health, past `return 404` on /health/ready, and would have graded
  // "POST /api/admin/auth/login/" under zone=core_api burst=40 instead of
  // zone=core_login burst=5 -- the network half of the shed that keeps a flood off
  // the 2-slot scrypt semaphore. Each file was locally correct; only the pair was
  // wrong. route-auth.test.js pins it.
  return new RegExp(`^${source}$`);
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
//   rule 2  (the public set is three of the eight identity spec §6.2 enumerates — eight once
//           Plan 2d adds forgot-password, reset-password, verify-email and the two GET landing
//           pages, nine when the terminal plan adds POST /api/terminal/pair) and rule 3 (the
//           exempt set) — a census at
//           boot makes the service un-bootable at every intermediate commit; both live in
//           route-auth.test.js, which asserts set EQUALITY and so fails on an addition too.
//           Rule 4's audit-vocabulary membership (§5.9) and the §5.7 limiter roster check
//           are both HERE, above, as of Plan 2b: they read lib/audit-vocabulary.js's
//           AUDIT_ACTIONS and lib/rate-limit.js's LIMITERS, which are the one place each
//           list is written.
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
      // Spec 8.5 rule 4's second half, and spec 11.6 explains why it waited: the
      // shape check alone lets a route declare user.frobnicated, which reaches
      // audit_events -- whose CHECK is ALSO only a shape regex -- and is written.
      // It could not land in Plan 2a because the vocabulary then held five actions
      // and roughly twenty-five routes were still unwritten. It lands here because
      // this is the plan whose routes complete the auth.* half of the table.
      if (!Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, options.audit)) {
        throw new Error(
          `route table: ${where} declares audit action ${JSON.stringify(
            options.audit
          )}, which is not in the spec 5.9 vocabulary (apps/core-api/lib/audit-vocabulary.js)`
        );
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

    if (options.limit !== undefined) {
      if (options.limit === null || typeof options.limit !== "object") {
        throw new Error(`route table: ${where} declares a limit that must be an object { key, name }`);
      }
      // Spec 5.7's own claim, made true. Until Plan 2b there was no roster
      // constant and no membership check anywhere in the service, so
      // limit: { key: "ip", name: "invented" } registered and the process
      // listened -- a route believing it was throttled by a bucket that did not
      // exist. The list is printed because the failure is a typo nine times in
      // ten and the reader needs the spelling.
      if (!Object.prototype.hasOwnProperty.call(LIMITERS, options.limit.name)) {
        throw new Error(
          `route table: ${where} declares limit.name ${JSON.stringify(
            options.limit.name
          )}, which is not in the spec 5.7 roster (${Object.keys(LIMITERS).sort().join(", ")})`
        );
      }
      // The roster owns the bucket key, and a route that disagrees with it is
      // asking for a bucket nobody sized. Rule 8 below catches only the
      // principal-on-public case; this catches user-vs-terminal too.
      const declared = LIMITERS[options.limit.name];
      if (declared.key !== options.limit.key) {
        throw new Error(
          `route table: ${where} declares limit.key ${JSON.stringify(options.limit.key)} but the roster keys "${
            options.limit.name
          }" on "${declared.key}"`
        );
      }
      // Rule 8, unchanged and deliberately kept as its own statement: spec 6.3.5
      // splits step 4a from 5b because five of the seven limiters key on a
      // principal that does not exist until credential resolution. route-auth.test.js
      // mirrors this assertion, so the two can disagree only by someone editing both.
      if (PRINCIPAL_LIMIT_KEYS.includes(options.limit.key) && options.auth === "public") {
        throw new Error(
          `route table: ${where} keys a rate-limit bucket on "${options.limit.key}" but is auth:'public' — that principal does not exist yet`
        );
      }
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

// Spec 6.3.5, steps 3 through 7, in order, and THE ORDERING IS THE SECURITY
// PROPERTY. It runs INSIDE the dispatch wrapper -- after route lookup -- because
// as an app.use() ahead of the routes it would answer 403 origin_not_allowed for
// an unknown path instead of 404 not_found, destroying the
// [credential-independent] property step 2 is marked with. And a pure
// http/csrf.js called from here is the only compliant shape anyway:
// source-structure.test.js rule C3 forbids app.use( outside this file.
//
// Returns true when the handler should run. Every refusal RESPONDS HERE and
// returns false, rather than throwing: two of them (429, 401) have to set a
// header, ApiError cannot carry one, and one style for all five beats a mix a
// reader has to hold in their head.
async function runPipeline(entry, req, res, deps) {
  // Step 3 -- the declared auth mode. Nothing to do at runtime: route() and
  // validateRouteTable() have already refused a table with a missing or unknown
  // mode, which is why 6.3.5 marks this step "never a runtime 500".

  // Step 4a -- CREDENTIAL-INDEPENDENT buckets, before any scrypt is queued.
  const address = clientAddressOf(req, deps.trustedProxyHops);
  req.core.clientIp = address.ip;
  req.core.clientBucketKey = address.bucketKey;
  if (!consumeLimit(entry, req, res, deps, "ip", address.bucketKey)) return false;

  if (entry.options.auth === "user") {
    // Step 5 -- credential resolution and channel binding, READ-ONLY.
    const authenticate = deps.authenticate || authenticateUser;
    let resolved;
    try {
      resolved = await authenticate(req, deps);
    } catch (error) {
      if (!(error && error.status === 401)) throw error;
      // A clearing Set-Cookie ONLY when one was presented (6.3.4). Sending it
      // unconditionally would let any unauthenticated request instruct a browser
      // to drop a cookie it never sent.
      const headers = sessionTokensPresented(req).length > 0 ? { "Set-Cookie": buildClearingCookie() } : {};
      sendError(res, error, req.core.requestId, headers);
      return false;
    }

    req.core.session = resolved.session;
    req.core.scope = resolved.scope;
    req.core.actorKind = "user";
    req.core.actorId = resolved.session.userId;

    // Step 5b -- PRINCIPAL-KEYED buckets. They could not run at 4a: the principal
    // does not exist until now, and keying them on the presented credential string
    // would put every probe in a fresh empty bucket AND make the map an
    // unauthenticated memory-growth vector.
    if (!consumeLimit(entry, req, res, deps, "user", resolved.session.userId)) return false;

    // Step 6 -- the must_change_password gate, in the RESOLVER and not the UI.
    // Spec 8.5 rule 3 fixes the exempt set at exactly two routes, and
    // route-auth.test.js asserts it by set equality.
    if (resolved.session.mustChangePassword && entry.options.exemptFromPasswordChange !== true) {
      sendError(res, { status: 403, code: "password_change_required" }, req.core.requestId);
      return false;
    }
  }

  // Step 7 -- Origin and Content-Type, AFTER the password gate. Reversed, an
  // attacker with no session learns whether their Origin is allowed before being
  // asked for a credential.
  if (requiresOriginCheck(entry)) {
    try {
      assertOriginAndContentType({
        origin: req.headers.origin,
        contentType: req.headers["content-type"],
        apiPublicOrigin: deps.apiPublicOrigin
      });
    } catch (error) {
      sendError(res, error, req.core.requestId);
      return false;
    }
  }

  // Step 10, FIRST HALF. Spec 6.3.5 writes step 10 as "AUTHORIZATION: route roles ->
  // 403; then each path resource resolved in path order". Those are two halves with
  // different inputs, and only the second one has an ordering constraint.
  //
  // This half depends on the resolved credential and on NOTHING the caller can vary,
  // so it runs as soon as the credential exists rather than after steps 8 and 9. The
  // second half needs step 9's path parameters -- it is what makes "exists but not
  // yours" and "does not exist" the same zero-row result -- and it arrives with the
  // first route that HAS a path parameter, in Plan 2c.
  //
  // It is here, once, rather than a line in every handler, for the same reason route()
  // exists at all: one place where authorization can be forgotten.
  if (entry.options.auth === "user" && !permits(req.core.scope, entry.options.roles)) {
    sendError(res, { status: 403, code: "forbidden" }, req.core.requestId);
    return false;
  }

  return true;
}

// One helper for both 4a and 5b: `stage` is the key kind this call is responsible
// for, so a principal-keyed limiter is invisible at 4a and an ip-keyed one is not
// consumed twice.
function consumeLimit(entry, req, res, deps, stage, bucketKey) {
  const declared = entry.options.limit ? LIMITERS[entry.options.limit.name] : null;
  if (declared === null || declared.key !== stage) return true;
  // "failure" limiters are the handler's to consume -- password-change-abuse
  // counts consecutive failures, and a per-request decrement would lock a user out
  // of their own password-change route for succeeding at it.
  if (declared.consume !== "request") return true;

  const ceiling = deps[declared.ceilingKey];
  const verdict = deps.rateLimiter.consume(entry.options.limit.name, bucketKey, ceiling);
  if (verdict.allowed) return true;

  const headers = verdict.retryAfterSeconds === null ? {} : { "Retry-After": String(verdict.retryAfterSeconds) };
  sendError(res, { status: 429, code: "rate_limited" }, req.core.requestId, headers);
  return false;
}

// Step 14 -- sliding renewal, at most once per 60 seconds, and ONLY on a request
// that reached the handler and succeeded. The throttle itself lives in the SQL so
// two concurrent requests cannot both decide they are the one allowed to renew.
//
// `log` is createApp's NORMALISED local, threaded in by the caller, not deps.log.
// server.js passes `log: options.log`, which is undefined on a normal boot, so
// deps.log(...) here is a TypeError in production on the one path that only fires
// when the database is already in trouble.
async function renewIfSucceeded(entry, req, res, deps, log) {
  if (entry.options.auth !== "user" || req.core.session === undefined) return;
  if (res.statusCode >= 400) return;
  try {
    await deps.sessions.renewSession({
      sessionId: req.core.session.sessionId,
      idleSeconds: deps.sessionIdleSeconds,
      lastSeenIp: req.core.clientIp
    });
  } catch (error) {
    // The response is already written. A failure here costs one minute of idle
    // window, and turning a successful request into a 500 because of it would be
    // strictly worse.
    //
    // NOT req.core.logExtra. Step 14 runs after the handler resolved, and the
    // access line is assembled inside res.on("finish"), which has already fired
    // and already spread logExtra -- a write there is discarded unread, and the
    // renewal failure would be invisible everywhere. So this is a second line for
    // the same request, in the shape of the error tail's, and `level` is what keeps
    // the access log one line per request.
    log(
      JSON.stringify({
        level: "error",
        requestId: req.core.requestId,
        route: req.core.routePattern,
        status: res.statusCode,
        message: `renewSession: ${String((error && error.message) || error)}`
      })
    );
  }
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
  // The dispatch half of the same fix. pathToRegExp() governs the 404/405 tail;
  // this governs Express's own matching, which defaults to tolerating a trailing
  // slash. Both ends have to agree with nginx's `location =`, or the tail and the
  // handler disagree about what is a route.
  app.set("strict routing", true);
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
      // async, because steps 5 and 14 both await. The whole body is one promise
      // chain so a rejection anywhere reaches next() and the error tail, which is
      // the only thing that may build a response from an exception.
      (async () => {
        if (!(await runPipeline(entry, req, res, deps))) return;
        await entry.handler(req, res);
        // `log`, not `deps.log`: this loop already sits inside createApp, one scope
        // below the `const log = typeof deps.log === "function" ? ... ` normalisation,
        // and that default is the only reason a normal boot logs at all.
        await renewIfSucceeded(entry, req, res, deps, log);
      })().catch(next);
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
