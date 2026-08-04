const assert = require("node:assert/strict");
const test = require("node:test");
const { createTableDisplayClient } = require("../table-display-client");

// Replaces test/epaper-client.test.js, which was deleted with the module it graded.
// Spec 11.7: this app asks core-api to update a table; core-api calls the SDK. The
// assertions that used to be about a rendered frame are therefore about a REQUEST now --
// the same four properties, one layer out.

const ORDERING_URL = "https://order.yeyintlwin.com/t/AAAAAAAAAAAAAAAAAAAAAA";
const SERVICE_TOKEN = "service-token";

function recordingClient(respond, options = {}) {
  const requests = [];
  const client = createTableDisplayClient({
    coreApiUrl: "https://api.example.test/",
    serviceToken: SERVICE_TOKEN,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return respond(requests.length);
    },
    ...options
  });
  return { client, requests };
}

test("declares no runtime dependency, because the SDK moved to core-api", () => {
  const packageJson = require("../package.json");

  // The other half of apps/core-api/test/source-structure.test.js rule C16, asserted from
  // this side: C16 proves no file here REQUIRES the SDK, and this proves the manifest does
  // not still ship it. The two fail independently -- a stale manifest entry resolves, gets
  // installed into the image and is simply never used, which no require-graph rule sees.
  assert.equal(packageJson.dependencies, undefined);
});

test("sends the opaque URL to core-api as an in-use update", async () => {
  const { client, requests } = recordingClient(() => ({ ok: true, json: async () => ({ ok: true }) }));

  const result = await client.updateTableInUse(7, ORDERING_URL);

  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 1);
  // The table number in the PATH, the credential in the BODY. Never the reverse: this URL
  // is the visit token, and a query string or a path segment lands in an access log.
  assert.equal(requests[0].url, "https://api.example.test/api/terminal/table-displays/7");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${SERVICE_TOKEN}`);
  assert.equal(requests[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    status: "Table is in use",
    orderingUrl: ORDERING_URL
  });
});

test("sends the opaque URL to core-api as a Welcome update", async () => {
  const { client, requests } = recordingClient(() => ({ ok: true, json: async () => ({ ok: true }) }));

  await client.updateTableWelcome(7, ORDERING_URL);

  assert.equal(requests[0].url, "https://api.example.test/api/terminal/table-displays/7");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    status: "Welcome",
    orderingUrl: ORDERING_URL
  });
});

test("a trailing slash on CORE_API_URL does not produce a doubled path", async () => {
  // "https://api.example.test/" is what an operator pastes out of a browser bar, and
  // //api/terminal/... is a 404 that reads like a routing bug in core-api.
  const { requests } = recordingClient(() => ({ ok: true, json: async () => ({ ok: true }) }));
  const client = createTableDisplayClient({
    coreApiUrl: "https://api.example.test/",
    serviceToken: SERVICE_TOKEN,
    fetchImpl: async (url) => {
      requests.push({ url });
      return { ok: true, json: async () => ({ ok: true }) };
    }
  });

  await client.updateTableWelcome(1, ORDERING_URL);
  assert.equal(requests[0].url, "https://api.example.test/api/terminal/table-displays/1");
});

test("a refusal carries core-api's status, because that is what the retry ladder reads", async () => {
  // server.js's isTransientEpaperError parses the status out of this message: 5xx, 408 and
  // 429 are retried and a 401 or 422 never is. Losing the number from the message would
  // make every permanent refusal look transient and burn the startup attempt budget on a
  // credential that will never be accepted.
  for (const status of [401, 404, 413, 415, 422, 503]) {
    const { client } = recordingClient(() => ({ ok: false, status }));
    await assert.rejects(
      () => client.updateTableWelcome(3, ORDERING_URL),
      new RegExp(`Table display update failed with ${status}$`),
      `status ${status}`
    );
  }
});

test("a refusal never echoes core-api's response body", async () => {
  // core-api's error envelope carries a requestId and a code. Neither belongs in an error
  // string this app may surface toward a customer, and json() must not even be called.
  let jsonCalls = 0;
  const { client } = recordingClient(() => ({
    ok: false,
    status: 422,
    json: async () => {
      jsonCalls += 1;
      return { error: { code: "validation_failed", requestId: "leaked01" } };
    }
  }));

  await assert.rejects(() => client.updateTableWelcome(3, ORDERING_URL), (error) => {
    assert.doesNotMatch(error.message, /leaked01|validation_failed/);
    return true;
  });
  assert.equal(jsonCalls, 0);
});

test("skips the update when core-api's URL or the service token is missing", async () => {
  // The sentinel epaper-client.js returned when the hub was unconfigured, kept byte for
  // byte: server.js turns `skipped` into a 503 on the provisioning route and into an
  // EPAPER_CONFIGURATION error at startup, and both readings still have to hold.
  for (const options of [
    { coreApiUrl: "", serviceToken: SERVICE_TOKEN },
    { coreApiUrl: "https://api.example.test", serviceToken: "" },
    {}
  ]) {
    const client = createTableDisplayClient({
      ...options,
      fetchImpl: async () => {
        throw new Error("fetch should not run");
      }
    });

    assert.equal(client.configured, false);
    assert.deepEqual(await client.updateTableWelcome(1, ORDERING_URL), { skipped: true });
    assert.deepEqual(await client.updateTableInUse(1, ORDERING_URL), { skipped: true });
  }
});

test("every request carries an abort signal, so one hung call cannot stall a table", async () => {
  // Display updates are serialised per table in server.js: runTableDisplayUpdate chains
  // each one onto the previous promise. A core-api that accepts the connection and never
  // answers would therefore hold that table's queue open for as long as it liked, and
  // every subsequent order on it would wait behind a request nobody is going to answer.
  const { client, requests } = recordingClient(() => ({ ok: true, json: async () => ({ ok: true }) }), {
    timeoutMs: 1234
  });

  await client.updateTableWelcome(2, ORDERING_URL);

  assert.ok(requests[0].init.signal, "no AbortSignal was passed to fetch");
  assert.equal(typeof requests[0].init.signal.aborted, "boolean");
});
