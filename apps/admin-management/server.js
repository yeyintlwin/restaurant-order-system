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

// The same four headers core-api puts on every response (http/respond.js). Repeated
// here rather than imported because this app must not depend on core-api's source.
const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  // No inline script, no external anything. 'self' covers /app.js and /api.js;
  // connect-src 'self' covers the proxied /api calls. If a later screen needs an
  // inline script, add a hash -- never 'unsafe-inline'.
  //
  // blob: is on img-src for ONE thing: showing somebody the logo they just picked,
  // before it has been uploaded and therefore before it has a URL. A blob: URL can
  // only be minted by this page's own script from bytes it already holds, so it
  // reaches nothing 'self' does not -- which is why it is here and not on any other
  // directive.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
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

function createServer(options = {}) {
  const coreApiUrl = options.coreApiUrl || process.env.CORE_API_URL;
  if (!coreApiUrl) {
    throw new Error("admin-management requires CORE_API_URL (the address of core-api)");
  }

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
