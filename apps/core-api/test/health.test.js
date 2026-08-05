const assert = require("node:assert/strict");
const test = require("node:test");
require("../http/routes/health");
const { createApp } = require("../http/router");

// Spec §8.1: the real Express app on app.listen(0) driven by global fetch — a departure from
// server.inject() at apps/customer-order/server.js:350, whose fake res stores headers in a plain
// object and so cannot represent two Set-Cookie values of the same name.
//
// THE EXTRACTION THIS COMMENT USED TO PROMISE HAS NOT HAPPENED, and the trigger it named
// has already fired. It said "Plan 2 extracts this helper into testing/http.js when the
// explicit cookie jar arrives". The jar arrived in Plan 2b — auth-routes.test.js drives
// __Host-core_session end to end and pipeline.test.js reads headers.getSetCookie() — and
// the helper stayed where it was. testing/ still holds compose.js, database.js and
// fixtures/ and nothing else.
//
// What changed is the count, which is the part that decides it: there are now FIVE copies
// of this function, not the two the original comment assumed — auth-routes, health,
// pipeline, router-registration and table-displays.
//
// Deliberately NOT extracted here. Five suites is five green files at the end of an
// execution run, and no plan has scoped this refactor; doing it as a drive-by would put
// the whole HTTP harness in a commit about something else. It belongs to whichever plan
// next touches these harnesses — Phase 3 for table-displays, Plan 2c for the tenant
// routes — and the sixth copy is the point at which writing it is cheaper than not.
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

function captureLog() {
  const lines = [];
  const log = (line) => lines.push(line);
  log.access = () => lines.map((line) => JSON.parse(line)).filter((record) => record.level === undefined);
  log.raw = () => lines;
  return log;
}

test("GET /health is 200 and never touches the database", async () => {
  let probeCalls = 0;
  const deps = {
    log: captureLog(),
    trustedProxyHops: 0,
    checkReadiness: async () => {
      probeCalls += 1;
      return { database: "ready", migrations: "current" };
    }
  };

  await withServer(deps, async (base) => {
    const response = await fetch(`${base}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, app: "core-api" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  assert.equal(probeCalls, 0, "liveness must not depend on the database — a DB blip cannot mark the container unhealthy");
});

test("HEAD /health is 200 with no body — this is what the container healthcheck issues", async () => {
  await withServer({ log: captureLog(), trustedProxyHops: 0, checkReadiness: async () => ({ database: "ready", migrations: "current" }) }, async (base) => {
    const response = await fetch(`${base}/health`, { method: "HEAD" });

    assert.equal(response.status, 200, "wget --spider issues HEAD; a 405 here makes the container permanently unhealthy");
    assert.equal(await response.text(), "");
  });
});

function readyDeps(checks, log) {
  return { log, trustedProxyHops: 0, checkReadiness: async () => checks };
}

test("GET /health/ready is 200 when the database answers and the ledger is current", async () => {
  await withServer(readyDeps({ database: "ready", migrations: "current" }, captureLog()), async (base) => {
    const response = await fetch(`${base}/health/ready`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, app: "core-api" });
  });
});

test("every not-ready combination is 503 with the ordinary opaque envelope", async () => {
  const cases = [
    { database: "unreachable", migrations: "current" },
    { database: "timeout", migrations: "current" },
    { database: "ready", migrations: "pending" },
    { database: "ready", migrations: "checksum_mismatch" }
  ];

  for (const checks of cases) {
    await withServer(readyDeps(checks, captureLog()), async (base) => {
      const response = await fetch(`${base}/health/ready`);
      const text = await response.text();

      assert.equal(response.status, 503, JSON.stringify(checks));
      assert.equal(response.headers.get("retry-after"), "5");
      const body = JSON.parse(text);
      assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId"]);
      assert.equal(body.error.code, "service_unavailable");
      assert.doesNotMatch(text, /unreachable|timeout|pending|checksum_mismatch/, JSON.stringify(checks));
    });
  }
});

test("the checks vocabulary reaches the request log against the same requestId", async () => {
  const log = captureLog();
  let requestId;

  await withServer(readyDeps({ database: "ready", migrations: "checksum_mismatch" }, log), async (base) => {
    requestId = (await (await fetch(`${base}/health/ready`)).json()).error.requestId;
  });

  const access = log.access();
  assert.equal(access.length, 1);
  assert.equal(access[0].requestId, requestId);
  assert.equal(access[0].route, "/health/ready");
  assert.equal(access[0].status, 503);
  assert.deepEqual(access[0].checks, { database: "ready", migrations: "checksum_mismatch" });
});

test("a probe that throws is 503 with database unreachable, not a 500", async () => {
  const log = captureLog();

  await withServer(
    {
      log,
      trustedProxyHops: 0,
      checkReadiness: async () => {
        throw new Error("connect ECONNREFUSED 172.19.0.2:5432");
      }
    },
    async (base) => {
      const response = await fetch(`${base}/health/ready`);
      const text = await response.text();

      assert.equal(response.status, 503);
      assert.equal(JSON.parse(text).error.code, "service_unavailable");
      assert.doesNotMatch(text, /ECONNREFUSED|172\.19/);
    }
  );

  assert.deepEqual(log.access()[0].checks, { database: "unreachable" });
});
