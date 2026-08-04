"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../http/router");
const { assertAuditEvent } = require("../lib/audit-vocabulary");
require("../http/routes/table-displays");

// POST /api/terminal/table-displays/:tableNumber -- the route spec 11.7 moved the SDK
// behind. No database: appendAuditEvent is injected, and its argument is then run through
// the REAL assertAuditEvent, which mirrors audit_events_actor_arc, _target_pair and
// _detail_no_credentials. That is what makes "the row this route would write is legal"
// checkable without a connection, and it is the check that would otherwise fire as a 23514
// in production.

const SERVICE_TOKEN = "0123456789abcdef0123456789abcdef";
const ORDERING_URL = "https://order.yeyintlwin.com/t/AAAAAAAAAAAAAAAAAAAAAA";

function noopLog() {}

function harness(overrides = {}) {
  const updates = [];
  const audits = [];
  const lines = [];

  const deps = {
    log: (line) => lines.push(JSON.parse(line)),
    tableDisplay: {
      configured: true,
      updateTableDisplay: async (update) => {
        updates.push(update);
        return { ok: true };
      }
    },
    tableDisplayServiceToken: SERVICE_TOKEN,
    appendAuditEvent: async (event) => {
      audits.push(event);
      return "1";
    },
    trustedProxyHops: 0,
    ...overrides
  };

  return { deps, updates, audits, lines };
}

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

function post(base, tableNumber, body, headers = {}) {
  return fetch(`${base}/api/terminal/table-displays/${tableNumber}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      "Content-Type": "application/json",
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("an authenticated update reaches the SDK client and answers 200", async () => {
  const { deps, updates } = harness();

  await withServer(deps, async (base) => {
    const response = await post(base, 7, { status: "Table is in use", orderingUrl: ORDERING_URL });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      tableNumber: 7,
      status: "Table is in use"
    });
  });

  // The path segment became a NUMBER, which is what the SDK's 1..12 integer check needs;
  // the URL was passed through byte for byte, which is what the QR needs.
  assert.deepEqual(updates, [
    { tableNumber: 7, status: "Table is in use", orderingUrl: ORDERING_URL }
  ]);
});

test("the audit row it would write is one audit_events actually accepts", async () => {
  const { deps, audits } = harness();

  await withServer(deps, async (base) => {
    await post(base, 7, { status: "Welcome", orderingUrl: ORDERING_URL });
  });

  assert.equal(audits.length, 1);
  const event = audits[0];

  // 'system', not 'user' and not 'terminal': audit_events_actor_arc requires an id column
  // for both of those, and a CONFIGURED SERVICE TOKEN references neither row. Phase 3
  // pairs this caller as a terminal and this becomes 'terminal' with an actorTerminalId.
  assert.equal(event.actorKind, "system");
  assert.equal(event.actorUserId, undefined);
  assert.equal(event.actorTerminalId, undefined);
  assert.equal(event.action, "table_display.updated");
  assert.equal(event.outcome, "success");
  assert.equal(event.targetKind, "table_display");
  assert.equal(event.targetId, "7");

  // THE CREDENTIAL IS NOT IN THE ROW. `url` is not on
  // audit_events_detail_no_credentials' banned-key list, so nothing in the database would
  // stop this route from persisting a live table token for the 365-day retention window.
  assert.deepEqual(event.detail, { status: "Welcome" });
  assert.equal(JSON.stringify(event).includes("AAAAAAAAAAAAAAAAAAAAAA"), false);

  // The real vocabulary check, run over the real event. Everything above is a property of
  // this test's expectations; this is a property of the schema.
  assert.doesNotThrow(() => assertAuditEvent(event));
});

test("a hub failure is 503 and is audited as a failure, not swallowed", async () => {
  const { deps, audits } = harness({
    tableDisplay: {
      configured: true,
      updateTableDisplay: async () => {
        throw new Error("E-paper hub update failed with 502");
      }
    }
  });

  await withServer(deps, async (base) => {
    const response = await post(base, 7, { status: "Welcome", orderingUrl: ORDERING_URL });

    // 503 rather than 502: db/errors.js's code vocabulary is closed and has no 502, and
    // http/respond.js adds Retry-After: 5, which is the correct instruction for a hub that
    // is down. apps/customer-order's isTransientEpaperError reads the 503 and retries.
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");

    const body = await response.json();
    assert.equal(body.error.code, "service_unavailable");
    // The SDK's message names the hub and its status. Neither reaches the client.
    assert.doesNotMatch(JSON.stringify(body), /502|E-paper hub/);
  });

  assert.equal(audits.length, 1);
  assert.equal(audits[0].outcome, "failure");
  assert.doesNotThrow(() => assertAuditEvent(audits[0]));
});

test("a wrong, absent or malformed bearer is 401 and never reaches the SDK", async () => {
  const { deps, updates, audits } = harness();

  await withServer(deps, async (base) => {
    for (const headers of [
      { Authorization: "" },
      { Authorization: "Bearer " },
      // SAME LENGTH as the real token: a length-only comparison would accept this, and
      // crypto.timingSafeEqual over SHA-256 digests is what refuses it in constant time.
      { Authorization: `Bearer ${"f".repeat(SERVICE_TOKEN.length)}` },
      // Right value, wrong scheme.
      { Authorization: SERVICE_TOKEN },
      { Authorization: `Basic ${SERVICE_TOKEN}` },
      // One character short, which is the length timingSafeEqual would THROW on if the
      // tokens were compared raw instead of as fixed-width digests.
      { Authorization: `Bearer ${SERVICE_TOKEN.slice(0, -1)}` }
    ]) {
      const response = await post(base, 7, { status: "Welcome", orderingUrl: ORDERING_URL }, headers);
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.equal((await response.json()).error.code, "unauthenticated");
    }
  });

  assert.deepEqual(updates, [], "an unauthenticated request must not drive a panel");
  assert.deepEqual(audits, [], "the auth middleware owns the 401 event, not this route");
});

test("an unconfigured service token is 503, so a missing secret is not a wrong password", async () => {
  // The other half of "both credentials are optional" in config.js. An operator who has
  // not yet added TABLE_DISPLAY_SERVICE_TOKEN to ~/core-api.env must not be sent looking
  // for a mistyped one -- and the service still migrates, listens and passes the deploy's
  // readiness gate, which is why this is not a boot-time refusal.
  const { deps, updates } = harness({ tableDisplayServiceToken: undefined });

  await withServer(deps, async (base) => {
    const response = await post(base, 7, { status: "Welcome", orderingUrl: ORDERING_URL });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "service_unavailable");
  });

  assert.deepEqual(updates, []);
});

test("an unconfigured hub is 503 even though the caller authenticated", async () => {
  const { deps, audits } = harness({
    tableDisplay: {
      configured: false,
      updateTableDisplay: async () => {
        throw new Error("the e-paper hub is not configured");
      }
    }
  });

  await withServer(deps, async (base) => {
    const response = await post(base, 7, { status: "Welcome", orderingUrl: ORDERING_URL });
    assert.equal(response.status, 503);
  });

  // No attempt was made, so there is nothing to record. An audit row saying a display
  // update failed would be wrong: none was tried.
  assert.deepEqual(audits, []);
});

test("a table number outside 1..12 is 404 before the body is even read", async () => {
  const { deps, updates } = harness();

  await withServer(deps, async (base) => {
    for (const tableNumber of ["0", "13", "99", "007", "abc", "1.5", "-1"]) {
      const response = await post(base, tableNumber, { status: "Welcome", orderingUrl: ORDERING_URL });
      assert.equal(response.status, 404, tableNumber);
      assert.equal((await response.json()).error.code, "not_found", tableNumber);
    }
  });

  assert.deepEqual(updates, []);
});

test("the body is validated against the closed status set and the URL shape", async () => {
  const { deps, updates } = harness();

  await withServer(deps, async (base) => {
    const cases = [
      [{ status: "Reserved", orderingUrl: ORDERING_URL }, ["status"]],
      [{ orderingUrl: ORDERING_URL }, ["status"]],
      [{ status: "Welcome" }, ["orderingUrl"]],
      [{ status: "Welcome", orderingUrl: "" }, ["orderingUrl"]],
      [{ status: "Welcome", orderingUrl: "not-a-url" }, ["orderingUrl"]],
      // A non-http scheme still parses as a URL, which is why the protocol is checked
      // separately: javascript: and data: would both reach the QR renderer otherwise.
      [{ status: "Welcome", orderingUrl: "javascript:alert(1)" }, ["orderingUrl"]],
      [{ status: "Welcome", orderingUrl: 7 }, ["orderingUrl"]],
      [{ status: "nope", orderingUrl: "nope" }, ["status", "orderingUrl"]]
    ];

    for (const [body, fields] of cases) {
      const response = await post(base, 5, body);
      assert.equal(response.status, 422, JSON.stringify(body));
      const payload = await response.json();
      assert.equal(payload.error.code, "validation_failed");
      assert.deepEqual(
        payload.error.errors.map((entry) => entry.field),
        fields,
        JSON.stringify(body)
      );
    }
  });

  assert.deepEqual(updates, []);
});

test("the body reader answers 415, 413 and 400 from the declared vocabulary", async () => {
  const { deps } = harness();

  await withServer(deps, async (base) => {
    const wrongType = await post(base, 5, { status: "Welcome", orderingUrl: ORDERING_URL }, {
      "Content-Type": "text/plain"
    });
    assert.equal(wrongType.status, 415);
    assert.equal((await wrongType.json()).error.code, "unsupported_media_type");

    const malformed = await post(base, 5, "{not json");
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "invalid_json");

    // A top-level array is valid JSON and is not a body. Without this a route would read
    // `body.status` off an array and get undefined, which then fails as a validation
    // error and hides what actually went wrong.
    const array = await post(base, 5, "[]");
    assert.equal(array.status, 400);
    assert.equal((await array.json()).error.code, "invalid_json");

    // 64 KiB is the same ceiling infra/nginx/api.conf sets. It has to hold here as well,
    // because apps/customer-order reaches this route over the compose network and never
    // passes through nginx at all.
    const huge = await post(base, 5, JSON.stringify({ status: "Welcome", orderingUrl: `https://x.test/${"a".repeat(70000)}` }));
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).error.code, "payload_too_large");
  });
});

test("the access log names the route pattern and the system actor, never the token", async () => {
  const { deps, lines } = harness();

  await withServer(deps, async (base) => {
    await post(base, 7, { status: "Welcome", orderingUrl: ORDERING_URL });
  });

  const access = lines.filter((record) => record.level === undefined);
  assert.equal(access.length, 1);
  assert.equal(access[0].route, "/api/terminal/table-displays/:tableNumber");
  assert.equal(access[0].status, 200);
  assert.equal(access[0].actorKind, "system");
  assert.equal(access[0].tableDisplay, "updated");

  // Neither credential in the request may appear in the log line: not the bearer, and not
  // the visit token. The router logs the PATTERN rather than the URL, which is what keeps
  // the table number out too.
  for (const record of lines) {
    assert.doesNotMatch(JSON.stringify(record), new RegExp(SERVICE_TOKEN));
    assert.doesNotMatch(JSON.stringify(record), /AAAAAAAAAAAAAAAAAAAAAA/);
  }
});

test("a failed audit write is a 500, because an unrecorded panel change is not a success", async () => {
  const { deps, updates } = harness({
    appendAuditEvent: async () => {
      throw new Error("relation \"audit_events\" does not exist");
    }
  });

  await withServer({ ...deps, log: noopLog }, async (base) => {
    const response = await post(base, 7, { status: "Welcome", orderingUrl: ORDERING_URL });

    assert.equal(response.status, 500);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, "internal_error");
    assert.doesNotMatch(text, /audit_events|does not exist/);
  });

  // The panel WAS updated. The caller retries, the update is idempotent, and it re-renders
  // the identical frame -- which is the cheap half of this trade. Reporting success with
  // no audit row is the expensive half, and that is the one being refused.
  assert.equal(updates.length, 1);
});

test("GET and DELETE on this path are 405 with Allow, not 404", async () => {
  const { deps } = harness();

  await withServer(deps, async (base) => {
    for (const method of ["GET", "DELETE", "PATCH"]) {
      const response = await fetch(`${base}/api/terminal/table-displays/7`, { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("allow"), "POST", method);
    }
  });
});

test("the path does not answer with a trailing slash, which nginx's location = never covers", async () => {
  // route-auth.test.js asserts this over the whole table; asserted here over the wire too,
  // because this is the first non-GET route and the 405/404 tail is what decides it.
  const { deps } = harness();

  await withServer(deps, async (base) => {
    const response = await post(base, "7/", { status: "Welcome", orderingUrl: ORDERING_URL });
    assert.equal(response.status, 404);
  });
});
