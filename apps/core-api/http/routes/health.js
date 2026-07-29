"use strict";

const { route } = require("../router");
const { sendJson, sendError } = require("../respond");

// `sample` is spec §8.5 rule 10: the params and minimal body the tenant-isolation route probe
// replays against every route. Health takes neither, so it is empty — but it must be declared,
// because a missing sample means a route the probe silently skips.

// Spec §6.2: liveness. Touches no database, so a database blip cannot mark the container
// unhealthy mid-incident. This is what the Docker healthcheck calls.
route("GET", "/health", { auth: "public", sample: {} }, (req, res) => {
  sendJson(res, 200, { ok: true, app: "core-api" });
});

// Spec §6.2: readiness — SELECT 1 with a 2s statement timeout plus schema_migrations against the
// on-disk file list. This is what the deploy gate calls, and Nginx 404s it publicly.
//
// Spec §6.3.6: readiness is INSIDE the leak rule. The 503 body is the ordinary opaque envelope;
// the closed-vocabulary checks (ready|unreachable|timeout, current|pending|checksum_mismatch) go
// to the request log against the same requestId and never to the client.
route("GET", "/health/ready", { auth: "public", sample: {} }, async (req, res) => {
  let checks;
  try {
    checks = await req.core.deps.checkReadiness();
  } catch {
    // db/health.js's checkReadiness contract is "never throws"; if it does anyway, the database
    // is what is unreachable. `migrations` is omitted rather than guessed — the vocabulary
    // stays closed, and a contract violation degrades to 503 rather than to a 500.
    checks = { database: "unreachable" };
  }
  req.core.logExtra.checks = checks;

  if (checks.database === "ready" && checks.migrations === "current") {
    sendJson(res, 200, { ok: true, app: "core-api" });
    return;
  }
  sendError(res, { status: 503, code: "service_unavailable" }, req.core.requestId);
});
