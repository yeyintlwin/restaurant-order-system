"use strict";

// THE ONLY FILE IN THE REPOSITORY THAT MAY REQUIRE @restaurant/epaper-hub-sdk.
//
// Spec §11.7: "core-api is the controlling API ... to update an e-paper display you go
// THROUGH core-api, which calls the SDK." That makes the SDK's permitted-caller set a
// one-element list, and rule C16 in test/source-structure.test.js asserts it by name --
// the same shape C1 uses for `pg` (only db/pool.js) and C3 for `express` (only
// http/router.js). C16 asserts it twice: once against this app's walker and once
// REPOSITORY-WIDE, because the app that used to call the SDK is apps/customer-order and
// an app-local rule would prove nothing about it.
//
// NOT under lib/. lib/ is Tier 1 pure and rule C9 bans node:http(s)/net there; the SDK
// reaches the hub over the network through globalThis.fetch, so its caller cannot live
// in a directory whose entire contract is "no network". epaper/ is its own area for that
// reason, and the walker in source-structure.test.js carries a sentinel for it.
//
// This file deliberately holds NO HTTP concerns: it neither reads a request nor chooses a
// status code. http/routes/table-displays.js owns that, and this owns "how a table becomes
// a rendered frame at the hub".

const { createEpaperHubSdk } = require("@restaurant/epaper-hub-sdk");

// The SDK hard-rejects any epaperId outside 1..12 (packages/epaper-hub-sdk/index.js:24),
// as does table-template.js's validateInput. Spec §11.7 "The coupling this does NOT fix":
// moving the caller changes nothing about that range, and widening it belongs to the same
// change that decides whether a screen is scoped to a shop or to an epaper_hub terminal.
const MIN_TABLE_NUMBER = 1;
const MAX_TABLE_NUMBER = 12;

// The two statuses this service renders. Closed on purpose: the hub draws whatever string
// it is handed, so an open set here is an open set on twelve physical panels.
const STATUSES = Object.freeze(["Welcome", "Table is in use"]);

// "TABLE 07" -- eight characters, and itself a legal 0001_init.sql dining_tables.label
// (`^[A-Z0-9][A-Z0-9 -]{0,7}$`). Formatted HERE rather than in the renderer so the panels
// this service drives render byte-identically to the frames apps/customer-order used to
// send, while the renderer stays free of any one caller's wording. Carried verbatim from
// the deleted apps/customer-order/epaper-client.js, because "byte-identical" is the whole
// claim and a reworded label would quietly break it.
function tableLabelFor(tableNumber) {
  return `TABLE ${String(tableNumber).padStart(2, "0")}`;
}

function assertTableNumber(tableNumber) {
  if (
    !Number.isInteger(tableNumber) ||
    tableNumber < MIN_TABLE_NUMBER ||
    tableNumber > MAX_TABLE_NUMBER
  ) {
    throw new Error(
      `tableNumber must be an integer from ${MIN_TABLE_NUMBER} to ${MAX_TABLE_NUMBER}`
    );
  }
}

/**
 * Both credentials are OPTIONAL, and an unconfigured client reports `configured: false`
 * rather than throwing at construction. That is deliberate and is a deploy-safety
 * property, not laziness: core-api is migrated and health-gated by
 * .github/workflows/deploy.yml, so a constructor that threw on a box whose ~/core-api.env
 * had not yet gained EPAPER_API_KEY would fail the readiness gate AFTER the migration had
 * applied -- the exact failure shape spec §9.5 spends a page avoiding. Unconfigured, the
 * route answers 503 and every other route is untouched.
 */
function createEpaperHubClient({ hubUrl, apiKey, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = String(hubUrl || "").replace(/\/$/, "");
  const token = String(apiKey || "");
  const sdk = baseUrl && token ? createEpaperHubSdk({ baseUrl, apiKey: token, fetchImpl }) : null;

  async function updateTableDisplay({ tableNumber, status, orderingUrl }) {
    if (sdk === null) throw new Error("the e-paper hub is not configured");
    assertTableNumber(tableNumber);
    if (!STATUSES.includes(status)) {
      throw new Error(`status must be one of ${STATUSES.join(" | ")}`);
    }

    return sdk.updateTableDisplay({
      epaperId: tableNumber,
      tableLabel: tableLabelFor(tableNumber),
      status,
      // The QR. Spec §11.7: this URL IS the visit credential, so it is never logged,
      // never echoed into a response and never written to audit_events.detail -- it only
      // ever travels from the request body into the rendered frame.
      url: orderingUrl
    });
  }

  return { configured: sdk !== null, updateTableDisplay };
}

module.exports = {
  createEpaperHubClient,
  tableLabelFor,
  MIN_TABLE_NUMBER,
  MAX_TABLE_NUMBER,
  STATUSES
};
