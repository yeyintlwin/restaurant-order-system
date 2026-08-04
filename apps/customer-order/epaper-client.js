const { createEpaperHubSdk } = require("@restaurant/epaper-hub-sdk");

function createEpaperClient({ hubUrl, apiKey, fetchImpl = fetch } = {}) {
  const normalizedHubUrl = String(hubUrl || "").replace(/\/$/, "");
  const token = String(apiKey || "");
  const sdk = normalizedHubUrl && token
    ? createEpaperHubSdk({ baseUrl: normalizedHubUrl, apiKey: token, fetchImpl })
    : null;

  async function updateTableStatus(tableNumber, status, orderingUrl) {
    if (!sdk) return { skipped: true };

    // This app addresses tables by integer (1..12, see order-store.js), but the SDK now
    // takes the dining table's label. Format it here rather than in the renderer: "TABLE 07"
    // is 8 characters and is itself a legal 0001_init.sql label, so this app's panels render
    // byte-identically to Phase 1 while the renderer stays free of any one caller's wording.
    return sdk.updateTableDisplay({
      epaperId: tableNumber,
      tableLabel: `TABLE ${String(tableNumber).padStart(2, "0")}`,
      status,
      url: orderingUrl
    });
  }

  return {
    updateTableWelcome: (tableNumber, orderingUrl) => updateTableStatus(tableNumber, "Welcome", orderingUrl),
    updateTableInUse: (tableNumber, orderingUrl) => updateTableStatus(tableNumber, "Table is in use", orderingUrl)
  };
}

module.exports = { createEpaperClient };
