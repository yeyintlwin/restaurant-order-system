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
