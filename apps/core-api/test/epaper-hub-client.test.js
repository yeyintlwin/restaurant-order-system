"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createEpaperHubClient,
  tableLabelFor,
  MIN_TABLE_NUMBER,
  MAX_TABLE_NUMBER,
  STATUSES
} = require("../epaper/hub-client");

// epaper/hub-client.js is the ONE file in the repository that requires
// @restaurant/epaper-hub-sdk (spec 11.7; rule C16 in source-structure.test.js asserts it
// as a one-element list, app-locally and repository-wide). This file grades what it does
// with it. The SDK is exercised for real -- not stubbed -- with `fetchImpl` injected, so
// the frame these assertions see is the frame the hub would receive.

const ORDERING_URL = "https://order.yeyintlwin.com/t/AAAAAAAAAAAAAAAAAAAAAA";

function recording(options = {}) {
  const requests = [];
  const client = createEpaperHubClient({
    hubUrl: "https://epaper-hub.example.test/",
    apiKey: "hub-key",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    ...options
  });
  return { client, requests };
}

test("the table label is byte-identical to the one customer-order used to send", () => {
  // THE POINT OF THIS TEST IS THAT NOTHING VISIBLE CHANGED. Twelve physical panels are
  // rendering these strings right now; the boundary moved, the frames did not. "TABLE 07"
  // is also a legal 0001_init.sql dining_tables.label (^[A-Z0-9][A-Z0-9 -]{0,7}$), which
  // is what will let Phase 3 resolve the label from a row without a re-render.
  assert.equal(tableLabelFor(1), "TABLE 01");
  assert.equal(tableLabelFor(7), "TABLE 07");
  assert.equal(tableLabelFor(12), "TABLE 12");
  for (let n = MIN_TABLE_NUMBER; n <= MAX_TABLE_NUMBER; n += 1) {
    assert.match(tableLabelFor(n), /^[A-Z0-9][A-Z0-9 -]{0,7}$/, `TABLE ${n}`);
  }
});

test("an update reaches the hub's epaper endpoint with the bearer and the rendered frame", async () => {
  const { client, requests } = recording();

  const result = await client.updateTableDisplay({
    tableNumber: 7,
    status: "Table is in use",
    orderingUrl: ORDERING_URL
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://epaper-hub.example.test/api/epapers/7");
  assert.equal(requests[0].init.headers.Authorization, "Bearer hub-key");
  assert.equal(requests[0].init.headers["Content-Type"], "application/json");

  // A real rendered frame, asserted by SHAPE rather than by a golden blob: a golden blob
  // here would be a second copy of the wire format, and it would rot the first time the
  // template changed for a reason that had nothing to do with this boundary.
  const frame = JSON.parse(requests[0].init.body);
  assert.equal(frame.format, "epd-2bit-v1");
  assert.equal(frame.width, 296);
  assert.equal(frame.height, 128);
  assert.equal(typeof frame.data, "string");

  // THE VISIT TOKEN NEVER APPEARS AS TEXT ON THE WIRE, only as drawn QR modules -- so
  // the hub's own access log and its screen store cannot end up holding it in a
  // greppable form. Matched on the WHOLE URL: `data` is a long run-length-friendly
  // encoding whose all-white regions really do contain 22 consecutive "A"s, so asserting
  // on the token alone fails against a perfectly correct frame.
  assert.equal(requests[0].init.body.includes(ORDERING_URL), false);
  assert.equal(requests[0].init.body.includes("order.yeyintlwin.com"), false);
});

test("the QR really is drawn from the exact URL it was given", async () => {
  // The property the whole visit-token design rests on, and the one a shape assertion
  // cannot see: change one character of the URL and the frame must change. Without this,
  // a renderer that ignored `url` entirely would pass every other test in this file, and
  // twelve panels would show a QR that enrols a phone into nothing.
  const { client, requests } = recording();
  const other = "https://order.yeyintlwin.com/t/BBBBBBBBBBBBBBBBBBBBBB";

  await client.updateTableDisplay({ tableNumber: 7, status: "Welcome", orderingUrl: ORDERING_URL });
  await client.updateTableDisplay({ tableNumber: 7, status: "Welcome", orderingUrl: ORDERING_URL });
  await client.updateTableDisplay({ tableNumber: 7, status: "Welcome", orderingUrl: other });

  assert.equal(requests[0].init.body, requests[1].init.body, "the same inputs must render identically");
  assert.notEqual(requests[1].init.body, requests[2].init.body, "a different URL must render differently");
});

test("both rendered statuses are accepted and nothing else is", async () => {
  const { client, requests } = recording();

  for (const status of STATUSES) {
    await client.updateTableDisplay({ tableNumber: 3, status, orderingUrl: ORDERING_URL });
  }
  assert.equal(requests.length, STATUSES.length);

  // The hub draws whatever string it is handed, so an open set here is an open set on
  // twelve physical panels.
  await assert.rejects(
    () => client.updateTableDisplay({ tableNumber: 3, status: "Reserved", orderingUrl: ORDERING_URL }),
    /status must be one of/
  );
});

test("the table number is rejected outside 1..12 before any request is made", async () => {
  const { client, requests } = recording();

  for (const tableNumber of [0, 13, -1, 1.5, "7", null, undefined, NaN]) {
    await assert.rejects(
      () => client.updateTableDisplay({ tableNumber, status: "Welcome", orderingUrl: ORDERING_URL }),
      /tableNumber must be an integer from 1 to 12/,
      String(tableNumber)
    );
  }
  assert.equal(requests.length, 0, "a rejected table number must not reach the hub");
});

test("a non-2xx from the hub is an error, so the caller cannot report a stale panel as updated", async () => {
  const client = createEpaperHubClient({
    hubUrl: "https://epaper-hub.example.test",
    apiKey: "hub-key",
    fetchImpl: async () => ({ ok: false, status: 502 })
  });

  await assert.rejects(
    () => client.updateTableDisplay({ tableNumber: 4, status: "Welcome", orderingUrl: ORDERING_URL }),
    /502/
  );
});

test("an unconfigured client reports it rather than throwing at construction", async () => {
  // The deploy-safety property, and it is why config.js leaves EPAPER_API_KEY optional:
  // this service migrates the database BEFORE it listens, so a constructor that threw on a
  // box whose ~/core-api.env had not been updated would fail the readiness gate after the
  // migration had already applied.
  for (const options of [
    { hubUrl: "", apiKey: "hub-key" },
    { hubUrl: "https://epaper-hub.example.test", apiKey: "" },
    {}
  ]) {
    const client = createEpaperHubClient({
      ...options,
      fetchImpl: async () => {
        throw new Error("fetch should not run");
      }
    });

    assert.equal(client.configured, false);
    await assert.rejects(
      () => client.updateTableDisplay({ tableNumber: 1, status: "Welcome", orderingUrl: ORDERING_URL }),
      /not configured/
    );
  }
});

test("a configured client says so, which is what the route reads to choose 503", () => {
  assert.equal(recording().client.configured, true);
});
