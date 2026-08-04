const assert = require("node:assert/strict");
const test = require("node:test");
const { renderTableDisplay } = require("../../../packages/epaper-hub-sdk");
const { createEpaperClient } = require("../epaper-client");

test("declares the e-paper SDK as a customer server dependency", () => {
  const packageJson = require("../package.json");
  assert.equal(packageJson.dependencies["@restaurant/epaper-hub-sdk"], "file:../../packages/epaper-hub-sdk");
});

test("passes an exact opaque URL through an in-use e-paper update", async () => {
  const requests = [];
  const opaqueUrl = "https://order.yeyintlwin.com/t/AAAAAAAAAAAAAAAAAAAAAA";
  const client = createEpaperClient({
    hubUrl: "https://epaper-hub.example.test/",
    apiKey: "secret-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true }) };
    }
  });

  await client.updateTableInUse(7, opaqueUrl);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://epaper-hub.example.test/api/epapers/7");
  assert.equal(requests[0].options.headers.Authorization, "Bearer secret-key");
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(
    JSON.parse(requests[0].options.body),
    renderTableDisplay({
      tableLabel: "TABLE 07",
      status: "Table is in use",
      url: opaqueUrl
    })
  );
});

test("passes an exact opaque URL through a Welcome e-paper update", async () => {
  const requests = [];
  const opaqueUrl = "https://order.yeyintlwin.com/t/BBBBBBBBBBBBBBBBBBBBBB";
  const client = createEpaperClient({
    hubUrl: "https://epaper-hub.example.test/",
    apiKey: "secret-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true }) };
    }
  });

  await client.updateTableWelcome(7, opaqueUrl);

  assert.equal(requests[0].url, "https://epaper-hub.example.test/api/epapers/7");
  assert.deepEqual(
    JSON.parse(requests[0].options.body),
    renderTableDisplay({
      tableLabel: "TABLE 07",
      status: "Welcome",
      url: opaqueUrl
    })
  );
});

test("rejects missing or malformed opaque URLs through the SDK renderer", async () => {
  const client = createEpaperClient({
    hubUrl: "https://epaper-hub.example.test/",
    apiKey: "secret-key",
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) })
  });

  await assert.rejects(() => client.updateTableWelcome(7), /url must be an http or https URL/);
  await assert.rejects(() => client.updateTableInUse(7, "not-a-url"), /url must be an http or https URL/);
});

test("skips e-paper update when hub url or api key is missing", async () => {
  const client = createEpaperClient({
    hubUrl: "",
    apiKey: "",
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    }
  });

  const result = await client.updateTableInUse(1, "https://order.yeyintlwin.com/t/AAAAAAAAAAAAAAAAAAAAAA");

  assert.deepEqual(result, { skipped: true });
  assert.deepEqual(await client.updateTableWelcome(1, "https://order.yeyintlwin.com/t/AAAAAAAAAAAAAAAAAAAAAA"), { skipped: true });
  assert.deepEqual(await client.updateTableInUse(1, "https://order.yeyintlwin.com/t/AAAAAAAAAAAAAAAAAAAAAA"), { skipped: true });
});
