const assert = require("node:assert/strict");
const test = require("node:test");
const { createEpaperHubSdk, renderTableDisplay } = require("..");

test("posts a compact table template to the selected e-paper", async () => {
  const requests = [];
  const sdk = createEpaperHubSdk({
    baseUrl: "https://epaper-hub.example.test/",
    apiKey: "secret-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, id: 3 }) };
    }
  });

  const result = await sdk.updateTableDisplay({
    epaperId: 3,
    tableLabel: "A1",
    status: "Welcome",
    url: "https://order.example.test/t/SECONDtokenSECONDtok22"
  });

  assert.deepEqual(result, { ok: true, id: 3 });
  assert.equal(requests[0].url, "https://epaper-hub.example.test/api/epapers/3");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer secret-key");
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");

  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.format, "epd-2bit-v1");
  assert.equal(body.width, 296);
  assert.equal(body.height, 128);
  assert.equal(Buffer.from(body.data, "base64").length, 9472);
});

test("exposes table rendering without sending a request", () => {
  const sdk = createEpaperHubSdk({
    baseUrl: "https://epaper-hub.example.test",
    apiKey: "secret-key",
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    }
  });

  const input = {
    tableLabel: "TERRACE2",
    status: "Welcome",
    url: "https://order.example.test/t/THIRDtokenTHIRDtoken33"
  };
  assert.deepEqual(sdk.renderTableDisplay(input), renderTableDisplay(input));
});

test("validates SDK credentials and e-paper IDs", async () => {
  assert.throws(
    () => createEpaperHubSdk({ baseUrl: "https://epaper-hub.example.test", apiKey: "" }),
    /apiKey is required/
  );
  assert.throws(
    () => createEpaperHubSdk({ baseUrl: "", apiKey: "secret-key" }),
    /baseUrl must be an http or https URL/
  );
  assert.throws(
    () => createEpaperHubSdk({ baseUrl: "https://epaper-hub.example.test?tenant=1", apiKey: "secret-key" }),
    /baseUrl must not contain a query or fragment/
  );

  const sdk = createEpaperHubSdk({ baseUrl: "https://epaper-hub.example.test", apiKey: "secret-key" });
  await assert.rejects(
    () => sdk.updateTableDisplay({ epaperId: 13, tableLabel: "B12", status: "Welcome", url: "https://order.example.test" }),
    /epaperId must be an integer from 1 to 12/
  );
});

test("reports e-paper hub HTTP errors", async () => {
  const sdk = createEpaperHubSdk({
    baseUrl: "https://epaper-hub.example.test",
    apiKey: "secret-key",
    fetchImpl: async () => ({ ok: false, status: 401 })
  });

  await assert.rejects(
    () => sdk.updateTableDisplay({ epaperId: 1, tableLabel: "B12", status: "Welcome", url: "https://order.example.test" }),
    /E-paper hub update failed with 401/
  );
});
