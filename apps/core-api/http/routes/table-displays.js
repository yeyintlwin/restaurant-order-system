"use strict";

const crypto = require("node:crypto");
// lib/client-ip.js takes `isIP` as an ARGUMENT because rule C9 bans node:net under lib/,
// and its own header says http/ is what supplies it. This is that supply.
const { isIP } = require("node:net");

const { route } = require("../router");
const { readJsonBody } = require("../body");
const { sendJson } = require("../respond");
const { ApiError } = require("../../db/errors");
const { deriveClientIp } = require("../../lib/client-ip");
const { hashToken } = require("../../lib/tokens");
const { STATUSES } = require("../../epaper/hub-client");

// ---------------------------------------------------------------------------
// Spec §11.7: core-api owns the display. apps/customer-order used to hold the SDK and
// drive twelve panels itself; it now asks for a table to be updated and this route calls
// the SDK. epaper/hub-client.js is the one permitted caller and rule C16 pins that.
//
// WHAT THIS ROUTE IS NOT, YET, and §11.7 says so in as many words: the ordering URL still
// arrives IN THE REQUEST BODY. That URL is the visit token -- apps/customer-order's
// table-visit-store.js mints it, rotates it and expires it -- and §11.7's end state has
// core-api resolving the token itself so a front end is never handed one. Moving the visit
// store is Phase 3 and 382 lines; moving the SDK is this change. The two are separable in
// this direction only: the boundary moves first, the token follows. Spec §11.9 records
// that explicitly so nobody reads §11.7's "would defeat the point" and concludes this
// contradicts it.
//
// AUTHENTICATION IS A CONFIGURED SHARED SERVICE TOKEN, AND IT IS INTERIM (spec §11.9).
// The settled answer is terminal pairing: apps/customer-order becomes a paired terminal
// and presents a terminal_tokens bearer. That machinery is Phase 3's. Until then this
// matches what the repository already does between customer-order and the hub
// (EPAPER_API_KEY) and between the counter and checkout (CHECKOUT_API_KEY) -- a level the
// codebase already lives at, rather than a mechanism invented for one route.
//
// auth: "terminal" and the /api/terminal/ nesting are therefore not a claim that terminal
// authentication exists today; they are the mode this route WILL be served under, chosen
// now so Phase 3 swaps the credential check for the middleware without moving the path.
// The other two modes are both wrong: "user" is a human with a session, and "public" would
// have to join route-auth.test.js rule 2's deepEqual set, which is a promise that no
// credential is required at all.
// ---------------------------------------------------------------------------

const TABLE_NUMBER_PATTERN = /^(?:[1-9]|1[0-2])$/;
const BEARER_PREFIX = "Bearer ";

// A frozen, closed shape for the ONE key this route writes to the request log. The router
// warns that logExtra is "written only by handlers, and only with closed vocabularies" --
// an SDK error message would name the hub's URL and status, and this is the field that
// would carry it there if the vocabulary were open.
const OUTCOMES = Object.freeze({ updated: "updated", failed: "failed" });

// SHA-256 both sides first, then compare: crypto.timingSafeEqual THROWS on a length
// mismatch, so comparing raw tokens would leak the configured length through an exception
// rather than through timing. hashToken is lib/tokens.js's house primitive -- the same one
// user_sessions, terminal_tokens and user_email_tokens are compared through -- so this
// route does not introduce a second way to hash a credential.
function bearerMatches(header, expected) {
  const value = String(header || "");
  if (!value.startsWith(BEARER_PREFIX) || !expected) return false;
  return crypto.timingSafeEqual(hashToken(value.slice(BEARER_PREFIX.length)), hashToken(expected));
}

function validateBody(body) {
  const errors = [];

  if (!STATUSES.includes(body.status)) {
    errors.push({ field: "status", code: "not_in_enum" });
  }

  // The ordering URL is a CREDENTIAL. It is validated for shape and then passed straight
  // into the rendered frame: never logged, never echoed back in the response, never
  // written to audit_events.detail. `url` is not on
  // audit_events_detail_no_credentials' banned-key list, so nothing but this rule stops it
  // from being persisted in cleartext next to the table it unlocks.
  if (typeof body.orderingUrl !== "string" || body.orderingUrl === "") {
    errors.push({ field: "orderingUrl", code: "required" });
  } else {
    let parsed = null;
    try {
      parsed = new URL(body.orderingUrl);
    } catch {
      parsed = null;
    }
    if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      errors.push({ field: "orderingUrl", code: "pattern" });
    }
  }

  if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);
}

route(
  "POST",
  "/api/terminal/table-displays/:tableNumber",
  {
    auth: "terminal",
    params: { tableNumber: "integer" },
    body: { status: "enum", orderingUrl: "url" },
    audit: "table_display.updated",
    // Spec §8.5 rule 10: the params and MINIMAL body the tenant-isolation route probe
    // replays against every route. The URL here is a fixture, not a live visit token.
    sample: {
      params: { tableNumber: "1" },
      body: {
        status: "Welcome",
        orderingUrl: "https://order.example.test/t/AAAAAAAAAAAAAAAAAAAAAA"
      }
    }
  },
  async (req, res) => {
    const { tableDisplay, tableDisplayServiceToken, appendAuditEvent, trustedProxyHops } =
      req.core.deps;

    // Unconfigured is 503, not 401: the operator has not yet put the token in
    // ~/core-api.env, and answering "authentication is required" would send them looking
    // for a wrong credential. Every path below this line has authenticated.
    if (!tableDisplayServiceToken) {
      throw new ApiError(503, "service_unavailable");
    }
    if (!bearerMatches(req.headers.authorization, tableDisplayServiceToken)) {
      throw new ApiError(401, "unauthenticated");
    }

    // 'system', NOT 'user' and not 'terminal'. audit_events_actor_arc requires
    // actor_user_id NOT NULL for 'user' and actor_terminal_id NOT NULL for 'terminal',
    // and a configured service token references neither row -- there is no terminals row
    // for apps/customer-order until Phase 3 pairs it. 'system' is the arc's both-NULL
    // branch, and it is the honest one: the caller authenticated, so it is not
    // 'anonymous' either.
    req.core.actorKind = "system";

    // The pattern matched, so :tableNumber is a segment; whether it names one of twelve
    // panels is this check. not_found rather than validation_failed, for the same reason
    // db/errors.js gives it one code: "unknown route, unknown resource and resource
    // outside scope" are one answer.
    if (!TABLE_NUMBER_PATTERN.test(req.params.tableNumber)) {
      throw new ApiError(404, "not_found");
    }
    const tableNumber = Number(req.params.tableNumber);

    const body = await readJsonBody(req);
    validateBody(body);

    if (!tableDisplay.configured) {
      throw new ApiError(503, "service_unavailable");
    }

    const sourceIp = deriveClientIp({
      header: req.headers["x-forwarded-for"],
      trustedProxyHops,
      isIP
    }).ip;

    let failed = false;
    try {
      await tableDisplay.updateTableDisplay({ tableNumber, status: body.status, orderingUrl: body.orderingUrl });
    } catch {
      failed = true;
    }

    // Written AFTER the attempt and on BOTH outcomes, and deliberately not caught: a
    // failure to record what happened to a physical panel is a 500, not a silent success.
    // The caller retries, the update is idempotent, and it re-renders the same frame.
    //
    // Only the authenticated attempt is audited here. A 401 on this route is the auth
    // middleware's event to write, and that middleware is Plan 2b's.
    await appendAuditEvent({
      actorKind: "system",
      // With both actor id columns NULL this is the only attribution the row carries.
      // Phase 3 replaces it with the paired terminal's name and actorKind 'terminal'.
      actorLabel: "table-display-service",
      action: "table_display.updated",
      outcome: failed ? "failure" : "success",
      targetKind: "table_display",
      // text, capped at 64, no FK: dining_tables rows arrive with the admin CRUD, and
      // §11.7's own note says the epaperId -> table mapping is not this change's to fix.
      targetId: String(tableNumber),
      sourceIp,
      detail: { status: body.status }
    });

    if (failed) {
      req.core.logExtra.tableDisplay = OUTCOMES.failed;
      // 503, because 502 is not in db/errors.js's closed vocabulary and inventing one
      // would put a status in the response that nothing else in the service can produce.
      // http/respond.js adds Retry-After: 5, which is the right instruction: the hub
      // being unreachable is transient, and apps/customer-order's own retry ladder reads
      // the status out of the message to decide exactly that.
      throw new ApiError(503, "service_unavailable");
    }

    req.core.logExtra.tableDisplay = OUTCOMES.updated;
    sendJson(res, 200, { ok: true, tableNumber, status: body.status });
  }
);

// Exported for test/table-displays.test.js only. The route itself is reached through the
// registry, never through this object.
module.exports = { bearerMatches };
