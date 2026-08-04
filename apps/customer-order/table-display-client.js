// Replaces epaper-client.js, which held the e-paper hub SDK and drove twelve
// panels from this app directly.
//
// Spec 11.7: "core-api is the controlling API. apps/customer-order is a front end; its
// backend is core-api. To update an e-paper display you go THROUGH core-api, which calls
// the SDK." So this app no longer speaks to the e-paper hub at all, no longer holds the
// hub's API key, and no longer depends on the SDK -- apps/core-api/test/
// source-structure.test.js rule C16 asserts repository-wide that it does not.
//
// THE SHAPE OF THIS MODULE IS DELIBERATELY THE SHAPE OF THE ONE IT REPLACES.
// updateTableWelcome/updateTableInUse, the (tableNumber, orderingUrl) argument order and
// the `{ skipped: true }` sentinel are all contracts server.js already reads -- it
// serialises display updates per table, retries a failed in-use update on the next order,
// and turns `skipped` into a 503. Keeping them means this change moves a boundary and
// nothing else; every one of those behaviours is still covered by the same tests.
//
// WHAT STILL LIVES HERE, AND WHY THAT IS NOT AN OVERSIGHT: the ordering URL. It is minted
// by table-visit-store.js, it IS the visit credential, and it travels in the request body
// to core-api, which renders it into the QR. Spec 11.7 says an end state that passes the
// URL to core-api "would keep minting the credential in the front end and defeat the
// point" -- and it is right. This is not the end state. Phase 3 moves table-visit-store.js
// and order-store.js into core-api (382 lines and a new migration), and only then does the
// token stop being minted here. The SDK boundary moves first because it can; spec 11.9
// records the ordering.

const DEFAULT_TIMEOUT_MS = 5000;

function createTableDisplayClient({
  coreApiUrl,
  serviceToken,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const baseUrl = String(coreApiUrl || "").replace(/\/$/, "");
  const token = String(serviceToken || "");
  const configured = Boolean(baseUrl && token);

  async function updateTableStatus(tableNumber, status, orderingUrl) {
    // The same sentinel epaper-client.js returned when the hub was unconfigured.
    // server.js's startup path turns it into an EPAPER_CONFIGURATION error, which
    // isTransientEpaperError classifies as permanent so it does not burn three attempts.
    if (!configured) return { skipped: true };

    // AbortSignal.timeout, not a bare fetch: this call sits inside a per-table update
    // queue, and a core-api that accepts the connection and never answers would hold that
    // table's queue open indefinitely -- no order on that table could report its display
    // outcome, because runTableDisplayUpdate chains on the previous promise.
    const response = await fetchImpl(`${baseUrl}/api/terminal/table-displays/${tableNumber}`, {
      method: "POST",
      headers: {
        // The interim shared service token (spec 11.9). core-api compares it with
        // crypto.timingSafeEqual over SHA-256 digests. Phase 3 replaces it with the
        // terminal_tokens bearer this app is issued when it is paired -- same header,
        // same route, a credential with a lifecycle.
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ status, orderingUrl }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      // The STATUS, in the message, because that is what server.js's
      // isTransientEpaperError reads to decide whether to retry: 408/429/5xx are worth
      // another attempt and a 401 or a 422 never will be. Never the response BODY --
      // core-api's error envelope carries a requestId, and echoing it into this app's
      // own error strings would put it in front of a customer.
      throw new Error(`Table display update failed with ${response.status}`);
    }
    return typeof response.json === "function" ? response.json() : { ok: true };
  }

  return {
    configured,
    updateTableWelcome: (tableNumber, orderingUrl) =>
      updateTableStatus(tableNumber, "Welcome", orderingUrl),
    updateTableInUse: (tableNumber, orderingUrl) =>
      updateTableStatus(tableNumber, "Table is in use", orderingUrl)
  };
}

module.exports = { createTableDisplayClient };
