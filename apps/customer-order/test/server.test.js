const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createOrderStore } = require("../order-store");
const { createTableVisitStore } = require("../table-visit-store");
const {
  createServer: createCustomerServer,
  initializeTableDisplays: initializeCustomerTableDisplays,
  start: startCustomer
} = require("../server");

const ORDER_ORIGIN = "https://order.yeyintlwin.com";
const CHECKOUT_API_KEY = "checkout-secret";
const START_CONFIGURATION = {
  shopId: "1",
  checkoutApiKey: CHECKOUT_API_KEY,
  businessTimeZone: "Asia/Tokyo",
  businessDayRolloverHour: 6
};

function createVisitStore(options = {}) {
  const visitStore = createTableVisitStore({
    shopId: "1",
    orderBaseUrl: ORDER_ORIGIN,
    ...options
  });
  visitStore.createInitialVisits();
  return visitStore;
}

function createServer(options = {}) {
  return createCustomerServer({ visitStore: createVisitStore(), ...options });
}

function initializeTableDisplays(options = {}) {
  return initializeCustomerTableDisplays({ visitStore: createVisitStore(), ...options });
}

function start(options = {}) {
  return startCustomer({ ...START_CONFIGURATION, ...options });
}

async function enrollPhone(server, visitStore, tableNumber) {
  const token = visitStore.getRawTokenForDisplay(tableNumber);
  const response = await server.inject("GET", `/t/${token}`);
  assert.equal(response.status, 302, "phone enrollment");
  return response.headers["Set-Cookie"].split(";")[0];
}

function customerHeaders(cookie, headers = {}) {
  return {
    cookie,
    origin: ORDER_ORIGIN,
    "content-type": "application/json",
    ...headers
  };
}

test("createServer requires an explicit visit store", () => {
  assert.throws(() => createCustomerServer(), /visitStore is required/);
});

test("enrolling a current table QR creates a secure opaque phone session", async () => {
  const visitStore = createVisitStore();
  const server = createCustomerServer({ visitStore });
  const token = visitStore.getRawTokenForDisplay(7);

  const response = await server.inject("GET", `/t/${token}`);

  assert.equal(response.status, 302);
  assert.equal(response.headers.Location, "/");
  assert.match(response.headers["Set-Cookie"], /^rsid=[A-Za-z0-9_-]{22}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.doesNotMatch(response.headers.Location, /table|shop|date/);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(token));
});

test("malformed, unknown, expired, and superseded QR tokens all redirect to the expired screen", async () => {
  let now = new Date("2026-07-22T20:59:59Z");
  const expiredStore = createVisitStore({ now: () => now });
  const expiredToken = expiredStore.getRawTokenForDisplay(7);
  now = new Date("2026-07-22T21:00:00Z");

  const supersededStore = createVisitStore();
  const supersededToken = supersededStore.getRawTokenForDisplay(7);
  supersededStore.beginRotation(7);

  const cases = [
    { server: createServer(), token: "malformed" },
    { server: createServer(), token: "A".repeat(22) },
    { server: createCustomerServer({ visitStore: expiredStore }), token: expiredToken },
    { server: createCustomerServer({ visitStore: supersededStore }), token: supersededToken }
  ];
  const responses = [];
  for (const entry of cases) responses.push(await entry.server.inject("GET", `/t/${entry.token}`));

  for (const response of responses) {
    assert.equal(response.status, 302);
    assert.equal(response.headers.Location, "/?e=expired");
    assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(response.headers["Set-Cookie"], undefined);
  }
  for (let index = 0; index < responses.length; index += 1) {
    assert.doesNotMatch(JSON.stringify(responses[index]), new RegExp(cases[index].token));
  }
});

test("two phones enrolled from one QR share one table slip and ignore injected table numbers", async () => {
  const visitStore = createVisitStore();
  const server = createCustomerServer({
    visitStore,
    epaperClient: { updateTableInUse: async () => ({ ok: true }) }
  });
  const firstCookie = await enrollPhone(server, visitStore, 7);
  const secondCookie = await enrollPhone(server, visitStore, 7);

  const order = await server.inject("POST", "/api/orders", {
    table_number: 12,
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(firstCookie));
  const session = await server.inject("GET", "/api/session?table_number=12", undefined, { cookie: secondCookie });
  const staffCall = await server.inject("POST", "/api/staff-calls", {
    table_number: 12,
    reason: "Water"
  }, customerHeaders(secondCookie));

  assert.notEqual(firstCookie, secondCookie);
  assert.equal(order.status, 201);
  assert.equal(session.status, 200);
  assert.equal(order.body.session.tableNumber, 7);
  assert.equal(session.body.session.tableNumber, 7);
  assert.equal(staffCall.body.call.tableNumber, 7);
  assert.equal(session.body.session.slipNumber, order.body.session.slipNumber);
  assert.deepEqual(session.body.session.orders, order.body.session.orders);
});

test("all protected customer APIs reject missing and forged phone sessions", async () => {
  const server = createServer();
  const requests = [
    ["GET", "/api/session", undefined],
    ["POST", "/api/orders", { items: [{ id: "crispy-gyoza", quantity: 1 }] }],
    ["POST", "/api/staff-calls", { reason: "Water" }]
  ];

  for (const cookie of [undefined, `rsid=${"A".repeat(22)}`]) {
    for (const [method, path, body] of requests) {
      const headers = method === "GET" ? { cookie } : customerHeaders(cookie);
      const response = await server.inject(method, path, body, headers);
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  }
});

test("rotating a visit revokes its enrolled cookie across all protected customer APIs", async () => {
  const visitStore = createVisitStore();
  const server = createCustomerServer({ visitStore });
  const cookie = await enrollPhone(server, visitStore, 7);
  visitStore.beginRotation(7);
  const requests = [
    ["GET", "/api/session", undefined],
    ["POST", "/api/orders", { items: [{ id: "crispy-gyoza", quantity: 1 }] }],
    ["POST", "/api/staff-calls", { reason: "Water" }]
  ];

  for (const [method, path, body] of requests) {
    const headers = method === "GET" ? { cookie } : customerHeaders(cookie);
    const response = await server.inject(method, path, body, headers);
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("customer mutations reauthorize after body parsing before mutating", async () => {
  for (const path of ["/api/orders", "/api/staff-calls"]) {
    let resolutions = 0;
    let orderMutations = 0;
    let staffMutations = 0;
    const visitStore = {
      enroll: () => null,
      getOrderingUrl: () => "https://order.yeyintlwin.com/t/current-visit-token",
      markInUse: () => null,
      resolvePhoneSession: () => (++resolutions === 1 ? { tableNumber: 7 } : null)
    };
    const store = {
      placeOrder: () => { orderMutations += 1; },
      callStaff: () => { staffMutations += 1; }
    };
    const server = createCustomerServer({ visitStore, store });
    const body = path === "/api/orders"
      ? { items: [{ id: "crispy-gyoza", quantity: 1 }] }
      : { reason: "Water" };

    const response = await server.inject("POST", path, body, customerHeaders("rsid=controlled-session"));

    assert.equal(response.status, 401, path);
    assert.equal(resolutions, 2, path);
    assert.equal(orderMutations, 0, path);
    assert.equal(staffMutations, 0, path);
  }
});

test("customer mutations require the configured origin before changing an order", async () => {
  const visitStore = createVisitStore();
  const server = createCustomerServer({ visitStore });
  const cookie = await enrollPhone(server, visitStore, 7);
  const body = { items: [{ id: "crispy-gyoza", quantity: 1 }] };

  for (const origin of [undefined, "https://attacker.example"]) {
    for (const path of ["/api/orders", "/api/staff-calls"]) {
      const response = await server.inject("POST", path, body, customerHeaders(cookie, { origin }));
      assert.equal(response.status, 403, path);
    }
  }
  const session = await server.inject("GET", "/api/session", undefined, { cookie });
  assert.equal(session.body.session.orders.length, 0);
});

test("customer mutations accept JSON with an optional charset and reject other content types", async () => {
  const visitStore = createVisitStore();
  const server = createCustomerServer({
    visitStore,
    epaperClient: { updateTableInUse: async () => ({ ok: true }) }
  });
  const cookie = await enrollPhone(server, visitStore, 7);

  for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
    for (const path of ["/api/orders", "/api/staff-calls"]) {
      const response = await server.inject("POST", path, {}, customerHeaders(cookie, { "content-type": contentType }));
      assert.equal(response.status, 415, path);
    }
  }
  const accepted = await server.inject("POST", "/api/orders", {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(cookie, { "content-type": "application/json; charset=utf-8" }));
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.session.orders.length, 1);
});

function displayClient(updateTableWelcome) {
  return {
    updateTableWelcome,
    updateTableInUse: async () => ({ ok: true })
  };
}

test("startup renders twelve unique opaque Welcome URLs before listening", async () => {
  const updates = [];
  let listened = false;
  const pending = [];
  const epaperClient = {
    updateTableWelcome(tableNumber, orderingUrl) {
      updates.push({ tableNumber, orderingUrl });
      return new Promise((resolve) => pending.push(resolve));
    }
  };

  const starting = start({
    epaperClient,
    port: 0,
    listen: () => { listened = true; }
  });
  await new Promise(setImmediate);

  assert.deepEqual(updates.map(({ tableNumber }) => tableNumber), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(new Set(updates.map(({ orderingUrl }) => orderingUrl)).size, 12);
  assert.ok(updates.every(({ orderingUrl }) => /^https:\/\/order\.yeyintlwin\.com\/t\/[A-Za-z0-9_-]{22}$/.test(orderingUrl)));
  assert.equal(listened, false);
  pending.forEach((resolve) => resolve({ ok: true }));
  await starting;
  assert.equal(listened, true);
});

test("rollover targets the next 06:00 Asia/Tokyo, invalidates sessions before display await, reschedules, and unreferences timers", async () => {
  let now = new Date("2026-07-22T20:59:59.000Z");
  const scheduled = [];
  const scheduler = (callback, delay) => {
    const timer = {
      unrefCalls: 0,
      unref() { timer.unrefCalls += 1; }
    };
    scheduled.push({ callback, delay, timer });
    return timer;
  };
  let releaseDisplays;
  const displaysHeld = new Promise((resolve) => { releaseDisplays = resolve; });
  let rolloverStarted = false;
  const rolloverUpdates = [];
  const visitStore = createVisitStore({ now: () => now });
  const store = createOrderStore({ now: () => now });
  const server = await start({
    now: () => now,
    scheduler,
    visitStore,
    store,
    listen: async () => {},
    epaperClient: {
      updateTableInUse: async () => ({ ok: true }),
      async updateTableWelcome(tableNumber, orderingUrl) {
        if (!rolloverStarted) return { ok: true };
        rolloverUpdates.push({ tableNumber, orderingUrl });
        await displaysHeld;
        return { ok: true };
      }
    }
  });
  const oldToken = visitStore.getRawTokenForDisplay(7);
  const firstCookie = await enrollPhone(server, visitStore, 7);
  const secondCookie = await enrollPhone(server, visitStore, 7);
  await server.inject("POST", "/api/orders", {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(firstCookie));

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);
  assert.equal(scheduled[0].timer.unrefCalls, 1);

  now = new Date("2026-07-22T21:00:00.000Z");
  rolloverStarted = true;
  const reconciling = scheduled[0].callback();
  await new Promise(setImmediate);

  const expiredScan = await server.inject("GET", `/t/${oldToken}`);
  assert.equal(expiredScan.status, 302);
  assert.equal(expiredScan.headers.Location, "/?e=expired");
  assert.equal((await server.inject("GET", "/api/session", undefined, { cookie: firstCookie })).status, 401);
  assert.equal((await server.inject("GET", "/api/session", undefined, { cookie: secondCookie })).status, 401);
  assert.equal(store.getSession(7).slipNumber, null);
  assert.equal(rolloverUpdates.length, 12);
  assert.ok(Array.from({ length: 12 }, (_, index) => index + 1).every(
    (tableNumber) => visitStore.getCurrentVisit(tableNumber).status === "pending_display"
  ));

  releaseDisplays();
  await reconciling;

  assert.deepEqual(rolloverUpdates.map(({ tableNumber }) => tableNumber).sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(new Set(rolloverUpdates.map(({ orderingUrl }) => orderingUrl)).size, 12);
  for (const { tableNumber, orderingUrl } of rolloverUpdates) {
    const visit = visitStore.getCurrentVisit(tableNumber);
    assert.equal(visit.generation, 2);
    assert.equal(visit.status, "welcome");
    assert.equal(orderingUrl, visit.orderingUrl);
  }
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delay, 24 * 60 * 60 * 1000);
  assert.equal(scheduled[1].timer.unrefCalls, 1);
});

test("rollover isolates display failures and retries the same pending URL and generation", async () => {
  let now = new Date("2026-07-22T20:59:59.000Z");
  let rolloverStarted = false;
  let tableSevenAttempts = 0;
  const rolloverUpdates = [];
  const visitStore = createVisitStore({ now: () => now });
  const store = createOrderStore({ now: () => now });
  const server = await start({
    now: () => now,
    scheduler: () => ({ unref() {} }),
    visitStore,
    store,
    listen: async () => {},
    epaperClient: {
      updateTableInUse: async () => ({ ok: true }),
      async updateTableWelcome(tableNumber, orderingUrl) {
        if (!rolloverStarted) return { ok: true };
        rolloverUpdates.push({ tableNumber, orderingUrl });
        if (tableNumber === 7 && ++tableSevenAttempts === 1) throw new Error("table 7 offline");
        return { ok: true };
      }
    }
  });
  const oldToken = visitStore.getRawTokenForDisplay(7);
  const cookie = await enrollPhone(server, visitStore, 7);
  await server.inject("POST", "/api/orders", {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(cookie));

  now = new Date("2026-07-22T21:00:00.000Z");
  rolloverStarted = true;
  await server.reconcileExpiredVisits();

  const pending = visitStore.getCurrentVisit(7);
  const expiredScan = await server.inject("GET", `/t/${oldToken}`);
  assert.equal(expiredScan.status, 302);
  assert.equal(expiredScan.headers.Location, "/?e=expired");
  assert.equal((await server.inject("GET", "/api/session", undefined, { cookie })).status, 401);
  assert.equal(store.getSession(7).slipNumber, null);
  assert.equal(pending.status, "pending_display");
  assert.equal(pending.generation, 2);
  for (const tableNumber of Array.from({ length: 12 }, (_, index) => index + 1).filter((value) => value !== 7)) {
    assert.equal(visitStore.getCurrentVisit(tableNumber).status, "welcome");
    assert.equal(visitStore.getCurrentVisit(tableNumber).generation, 2);
  }

  await server.reconcileExpiredVisits();

  const completed = visitStore.getCurrentVisit(7);
  const tableSevenUrls = rolloverUpdates
    .filter(({ tableNumber }) => tableNumber === 7)
    .map(({ orderingUrl }) => orderingUrl);
  assert.deepEqual(tableSevenUrls, [pending.orderingUrl, pending.orderingUrl]);
  assert.equal(completed.status, "welcome");
  assert.equal(completed.generation, pending.generation);
  assert.equal(completed.orderingUrl, pending.orderingUrl);
  assert.equal(rolloverUpdates.length, 13);
});

test("rollover replaces a checkout replacement that expired while its display update was failed", async () => {
  let now = new Date("2026-07-22T20:59:00.000Z");
  const tableSevenUrls = [];
  let failCheckoutDisplay = true;
  const visitStore = createVisitStore({ now: () => now });
  const server = createCustomerServer({
    checkoutApiKey: CHECKOUT_API_KEY,
    now: () => now,
    visitStore,
    epaperClient: displayClient(async (tableNumber, orderingUrl) => {
      if (tableNumber === 7) tableSevenUrls.push(orderingUrl);
      if (tableNumber === 7 && failCheckoutDisplay) throw new Error("display offline");
      return { ok: true };
    })
  });

  const checkout = await server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );
  const expiredPending = visitStore.getCurrentVisit(7);

  assert.equal(checkout.status, 502);
  assert.equal(expiredPending.status, "pending_display");
  assert.equal(expiredPending.generation, 2);

  now = new Date("2026-07-22T21:00:00.000Z");
  failCheckoutDisplay = false;
  await server.reconcileExpiredVisits();

  const replacement = visitStore.getCurrentVisit(7);
  assert.equal(replacement.status, "welcome");
  assert.equal(replacement.generation, expiredPending.generation + 1);
  assert.notEqual(replacement.orderingUrl, expiredPending.orderingUrl);
  assert.deepEqual(tableSevenUrls, [expiredPending.orderingUrl, replacement.orderingUrl]);
});

test("rollover and a racing checkout share one blocked table rotation", async () => {
  let now = new Date("2026-07-22T20:59:59.000Z");
  let releaseDisplay;
  const displayHeld = new Promise((resolve) => { releaseDisplay = resolve; });
  let displayStarted;
  const displayBegun = new Promise((resolve) => { displayStarted = resolve; });
  const tableSevenUrls = [];
  const visitStore = createVisitStore({ now: () => now });
  const before = visitStore.getCurrentVisit(7);
  const server = createCustomerServer({
    checkoutApiKey: CHECKOUT_API_KEY,
    now: () => now,
    visitStore,
    epaperClient: displayClient(async (tableNumber, orderingUrl) => {
      if (tableNumber === 7) {
        tableSevenUrls.push(orderingUrl);
        displayStarted();
        await displayHeld;
      }
      return { ok: true };
    })
  });

  now = new Date("2026-07-22T21:00:00.000Z");
  const rollover = server.reconcileExpiredVisits();
  await displayBegun;
  const pending = visitStore.getCurrentVisit(7);
  const pendingToken = visitStore.getRawTokenForDisplay(7);
  const checkout = server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );
  await new Promise(setImmediate);

  assert.deepEqual(tableSevenUrls, [pending.orderingUrl]);
  assert.equal(pending.generation, before.generation + 1);

  releaseDisplay();
  const [, checkoutResponse] = await Promise.all([rollover, checkout]);
  const completed = visitStore.getCurrentVisit(7);

  assert.equal(checkoutResponse.status, 200);
  assert.deepEqual(checkoutResponse.body, { ok: true, tableNumber: 7, status: "Welcome" });
  assert.deepEqual(tableSevenUrls, [pending.orderingUrl]);
  assert.equal(completed.generation, pending.generation);
  assert.equal(completed.orderingUrl, pending.orderingUrl);
  assert.equal(visitStore.getRawTokenForDisplay(7), pendingToken);
  assert.equal(completed.status, "welcome");
});

test("rollover scheduler contains unexpected reconciliation rejection and reschedules", async () => {
  let now = new Date("2026-07-22T20:59:59.000Z");
  const scheduled = [];
  const reported = [];
  const visitStore = createVisitStore({ now: () => now });
  await start({
    now: () => now,
    visitStore,
    scheduler(callback, delay) {
      scheduled.push({ callback, delay });
      return { unref() {} };
    },
    reportRolloverError: (message) => { reported.push(message); },
    listen: async () => {},
    epaperClient: { updateTableWelcome: async () => ({ ok: true }) }
  });
  visitStore.expiredTableNumbers = () => {
    throw new Error("Bearer raw-secret must never be reported");
  };
  now = new Date("2026-07-22T21:00:00.000Z");

  const [result] = await Promise.allSettled([scheduled[0].callback()]);

  assert.equal(result.status, "fulfilled");
  assert.deepEqual(reported, ["Business-day rollover reconciliation failed"]);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delay, 24 * 60 * 60 * 1000);
});

test("startup retries a transient 503 display failure", async () => {
  const attempts = new Map();
  const urls = [];
  let sleeps = 0;
  await initializeTableDisplays({
    epaperClient: {
      async updateTableWelcome(tableNumber, orderingUrl) {
        const count = (attempts.get(tableNumber) || 0) + 1;
        attempts.set(tableNumber, count);
        if (tableNumber === 7) urls.push(orderingUrl);
        if (tableNumber === 7 && count === 1) throw new Error("E-paper hub update failed with 503");
        return { ok: true };
      }
    },
    attempts: 2,
    sleep: async () => { sleeps += 1; }
  });

  assert.equal(attempts.get(7), 2);
  assert.equal([...attempts.values()].reduce((sum, count) => sum + count, 0), 13);
  assert.equal(sleeps, 1);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], urls[1]);
});

test("startup does not retry a permanent 401 display failure", async () => {
  const attempts = new Map();
  let sleeps = 0;

  await assert.rejects(() => initializeTableDisplays({
    epaperClient: {
      async updateTableWelcome(tableNumber) {
        attempts.set(tableNumber, (attempts.get(tableNumber) || 0) + 1);
        if (tableNumber === 7) throw new Error("E-paper hub update failed with 401");
        return { ok: true };
      }
    },
    attempts: 3,
    sleep: async () => { sleeps += 1; }
  }), /Failed to initialize e-paper table 7/);

  assert.equal(attempts.get(7), 1);
  assert.equal(sleeps, 0);
});

test("startup does not retry a validation display failure", async () => {
  let attempts = 0;

  await assert.rejects(() => initializeTableDisplays({
    epaperClient: {
      async updateTableWelcome(tableNumber) {
        if (tableNumber === 7) {
          attempts += 1;
          throw new Error("url must be an http or https URL");
        }
        return { ok: true };
      }
    },
    attempts: 3,
    sleep: async () => {}
  }), /Failed to initialize e-paper table 7/);

  assert.equal(attempts, 1);
});

test("startup failure prevents the HTTP listener", async () => {
  let listened = false;
  await assert.rejects(() => start({
    epaperClient: { updateTableWelcome: async () => { throw new Error("offline"); } },
    attempts: 2,
    sleep: async () => {},
    listen: () => { listened = true; }
  }), /Failed to initialize e-paper table/);
  assert.equal(listened, false);
});

test("startup rejects an unconfigured e-paper client", async () => {
  let updates = 0;
  await assert.rejects(() => initializeTableDisplays({
    epaperClient: { updateTableWelcome: async () => { updates += 1; return { skipped: true }; } },
    attempts: 3,
    sleep: async () => {}
  }), /Failed to initialize e-paper table/);
  assert.equal(updates, 12);
});

test("startup rejects invalid attempt counts before display updates", async () => {
  for (const attempts of [0, -1, 1.5, "3", NaN]) {
    let updates = 0;
    await assert.rejects(() => initializeTableDisplays({
      epaperClient: { updateTableWelcome: async () => { updates += 1; } },
      attempts
    }), /attempts must be a positive integer/);
    assert.equal(updates, 0);
  }
});

test("default startup rejects missing production configuration before updates or listening", async () => {
  const originalEnvironment = { ...process.env };
  const originalFetch = globalThis.fetch;
  // Spec 11.7: the display path now runs through core-api, so the two variables this
  // app must have are WHERE core-api is and the shared service token it presents there.
  // EPAPER_HUB_URL and EPAPER_API_KEY are core-api's now and are deliberately absent --
  // the loop below would be vacuous if a variable it deletes were one nothing reads.
  const configuredEnvironment = {
    CORE_API_URL: "https://api.example.test",
    TABLE_DISPLAY_SERVICE_TOKEN: "service-token",
    ORDER_BASE_URL: "https://order.yeyintlwin.com",
    SHOP_ID: "1",
    CHECKOUT_API_KEY,
    BUSINESS_TIME_ZONE: "Asia/Tokyo",
    BUSINESS_DAY_ROLLOVER_HOUR: "6"
  };
  try {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("unexpected table display request");
    };
    // POSITIVE CONTROL, and it is load-bearing: without it this test passes even when
    // the loop deletes variables nothing reads, because an environment missing ALL of
    // them throws the same message. The full configuration must get PAST the check and
    // reach the network -- and it does so with no epaperClient injected, since injecting
    // one skips createConfiguredEpaperClient(true) and the check with it.
    Object.assign(process.env, configuredEnvironment);
    await assert.rejects(() => startCustomer({
      server: {},
      listen: () => {},
      attempts: 1,
      sleep: async () => {}
    }), /Failed to initialize e-paper table/);
    assert.ok(fetchCalls > 0, "the fully configured startup never reached core-api");
    fetchCalls = 0;

    for (const { missing } of [
      { missing: ["CORE_API_URL"] },
      { missing: ["TABLE_DISPLAY_SERVICE_TOKEN"] },
      { missing: ["ORDER_BASE_URL"] }
    ]) {
      Object.assign(process.env, configuredEnvironment);
      for (const variable of missing) delete process.env[variable];
      let listened = false;
      await assert.rejects(() => startCustomer({
        server: {},
        listen: () => { listened = true; },
        attempts: 1,
        sleep: async () => {}
      }), /E-paper startup configuration is incomplete/);
      assert.equal(listened, false);
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, originalEnvironment);
  }
});

test("startup rejects invalid business configuration before visits, displays, or listening", async () => {
  const invalidConfigurations = [
    [{ shopId: 1 }, /SHOP_ID/],
    [{ shopId: "2" }, /SHOP_ID/],
    [{ checkoutApiKey: "" }, /CHECKOUT_API_KEY/],
    [{ businessTimeZone: "UTC" }, /BUSINESS_TIME_ZONE/],
    [{ businessDayRolloverHour: 5 }, /BUSINESS_DAY_ROLLOVER_HOUR/],
    [{ businessDayRolloverHour: 6.5 }, /BUSINESS_DAY_ROLLOVER_HOUR/]
  ];

  for (const [invalid, pattern] of invalidConfigurations) {
    let visits = 0;
    let displays = 0;
    let listens = 0;
    await assert.rejects(() => startCustomer({
      ...START_CONFIGURATION,
      ...invalid,
      visitStore: { createInitialVisits: () => { visits += 1; } },
      epaperClient: { updateTableWelcome: async () => { displays += 1; } },
      server: {},
      listen: async () => { listens += 1; }
    }), pattern);
    assert.equal(visits, 0);
    assert.equal(displays, 0);
    assert.equal(listens, 0);
  }
});

test("startup reads the exact business configuration from the environment", async () => {
  const originalEnvironment = { ...process.env };
  try {
    Object.assign(process.env, {
      SHOP_ID: "1",
      CHECKOUT_API_KEY,
      BUSINESS_TIME_ZONE: "Asia/Tokyo",
      BUSINESS_DAY_ROLLOVER_HOUR: "6"
    });
    let displays = 0;
    let listened = false;

    await startCustomer({
      epaperClient: { updateTableWelcome: async () => { displays += 1; return { ok: true }; } },
      scheduler: () => ({ unref() {} }),
      listen: async () => { listened = true; }
    });

    assert.equal(displays, 12);
    assert.equal(listened, true);
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, originalEnvironment);
  }
});

test("startup accepts an injected e-paper client without production configuration", async () => {
  const originalEnvironment = { ...process.env };
  try {
    delete process.env.CORE_API_URL;
    delete process.env.TABLE_DISPLAY_SERVICE_TOKEN;
    delete process.env.ORDER_BASE_URL;
    let updates = 0;
    let listened = false;

    await start({
      epaperClient: {
        updateTableWelcome: async () => { updates += 1; return { ok: true }; }
      },
      server: {},
      listen: () => { listened = true; }
    });

    assert.equal(updates, 12);
    assert.equal(listened, true);
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, originalEnvironment);
  }
});

test("default startup listener resolves only after listening", async () => {
  const server = new EventEmitter();
  let ready;
  server.listen = (_port, callback) => {
    ready = callback;
    return server;
  };
  let settled = false;
  const starting = start({
    epaperClient: { updateTableWelcome: async () => ({ ok: true }) },
    server,
    port: 0
  }).then(() => { settled = true; });

  await new Promise(setImmediate);
  assert.equal(settled, false);
  ready();
  await starting;
  assert.equal(settled, true);
});

test("default startup listener rejects asynchronous errors", async () => {
  const server = new EventEmitter();
  const failure = new Error("address unavailable");
  server.on("error", () => {});
  server.listen = () => {
    process.nextTick(() => server.emit("error", failure));
    return server;
  };

  await assert.rejects(() => start({
    epaperClient: { updateTableWelcome: async () => ({ ok: true }) },
    server,
    port: 0
  }), /address unavailable/);
});

test("placing first order updates e-paper once with the current opaque URL", async () => {
  const epaperUpdates = [];
  const visitStore = createVisitStore();
  const server = createCustomerServer({
    now: () => new Date("2026-07-19T10:00:00Z"),
    visitStore,
    epaperClient: {
      updateTableInUse: async (tableNumber, orderingUrl) => {
        epaperUpdates.push({ tableNumber, orderingUrl });
        return { ok: true };
      }
    }
  });
  const cookie = await enrollPhone(server, visitStore, 4);

  const first = await server.inject("POST", "/api/orders", {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(cookie));
  const second = await server.inject("POST", "/api/orders", {
    items: [{ id: "green-tea-ice-cream", quantity: 1 }]
  }, customerHeaders(cookie));

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.session.slipNumber, second.body.session.slipNumber);
  assert.deepEqual(epaperUpdates, [{ tableNumber: 4, orderingUrl: visitStore.getOrderingUrl(4) }]);
});

test("keeps a stored order successful and retries a failed e-paper update", async () => {
  let attempts = 0;
  const visitStore = createVisitStore();
  const server = createCustomerServer({
    visitStore,
    epaperClient: {
      updateTableInUse: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("hub unavailable");
        return { ok: true };
      }
    }
  });
  const body = {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  };
  const cookie = await enrollPhone(server, visitStore, 4);

  const first = await server.inject("POST", "/api/orders", body, customerHeaders(cookie));
  const second = await server.inject("POST", "/api/orders", body, customerHeaders(cookie));

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(attempts, 2);
});

test("does not expose e-paper client failure details in an order response", async () => {
  const visitStore = createVisitStore();
  const orderingUrl = visitStore.getOrderingUrl(7);
  const bearerValue = "Bearer future-client-secret";
  const server = createCustomerServer({
    visitStore,
    epaperClient: {
      updateTableInUse: async () => {
        throw new Error(`Failed to update ${orderingUrl} with ${bearerValue}`);
      }
    }
  });
  const cookie = await enrollPhone(server, visitStore, 7);

  const response = await server.inject("POST", "/api/orders", {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(cookie));

  assert.equal(response.status, 201);
  assert.deepEqual(response.body.epaperUpdate, {
    ok: false,
    pending: true,
    error: "E-paper display update failed"
  });
  const responseText = JSON.stringify(response.body);
  assert.equal(responseText.includes(orderingUrl), false);
  assert.equal(responseText.includes(bearerValue), false);
});

test("frontend config endpoint does not expose e-paper or display secrets", async () => {
  const server = createServer({
    checkoutApiKey: CHECKOUT_API_KEY,
    tableDisplayApiKey: "display-secret",
    epaperClient: { updateTableInUse: async () => ({ ok: true }) }
  });

  const response = await server.inject("GET", "/api/config");

  assert.equal(response.status, 200);
  assert.equal(response.body.epaperApiKey, undefined);
  assert.equal(response.body.tableDisplayApiKey, undefined);
  assert.equal(response.body.checkoutApiKey, undefined);
  assert.equal(response.body.apiKey, undefined);
  assert.equal(response.body.maxTableNumber, 12);
});

test("checkout rejects missing and same-length incorrect bearer authorization", async () => {
  let updates = 0;
  const server = createServer({
    checkoutApiKey: CHECKOUT_API_KEY,
    epaperClient: displayClient(async () => {
      updates += 1;
      return { ok: true };
    })
  });
  const incorrectKey = "checkout-secreT";
  assert.equal(incorrectKey.length, CHECKOUT_API_KEY.length);

  const missing = await server.inject("POST", "/api/tables/7/checkout");
  const incorrect = await server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${incorrectKey}` }
  );

  assert.equal(missing.status, 401);
  assert.equal(incorrect.status, 401);
  assert.equal(updates, 0);
});

test("checkout returns 401 for missing and wrong authorization when its key is not configured", async () => {
  let updates = 0;
  const server = createServer({
    checkoutApiKey: "",
    epaperClient: displayClient(async () => {
      updates += 1;
      return { ok: true };
    })
  });

  const missing = await server.inject("POST", "/api/tables/7/checkout");
  const wrong = await server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, missing.body);
  assert.equal(updates, 0);
});

test("checkout rejects noncanonical table number segments", async () => {
  let updates = 0;
  const server = createServer({
    checkoutApiKey: CHECKOUT_API_KEY,
    epaperClient: displayClient(async () => {
      updates += 1;
      return { ok: true };
    })
  });

  for (const tableNumber of ["-1", "1.5", "not-a-number", "1e0", "0x1", "01", "0", "13"]) {
    const response = await server.inject(
      "POST",
      `/api/tables/${tableNumber}/checkout`,
      undefined,
      { authorization: `Bearer ${CHECKOUT_API_KEY}` }
    );
    assert.equal(response.status, 400);
  }
  assert.equal(updates, 0);
});

test("checkout rotates the QR, revokes all phones, closes the order, and renders Welcome", async () => {
  const welcomeUpdates = [];
  const visitStore = createVisitStore();
  const store = createOrderStore({ now: () => new Date("2026-07-22T03:00:00Z") });
  const server = createCustomerServer({
    checkoutApiKey: CHECKOUT_API_KEY,
    visitStore,
    store,
    epaperClient: {
      updateTableInUse: async () => ({ ok: true }),
      updateTableWelcome: async (tableNumber, orderingUrl) => {
        welcomeUpdates.push({ tableNumber, orderingUrl });
        return { ok: true };
      }
    }
  });
  const oldToken = visitStore.getRawTokenForDisplay(7);
  const before = visitStore.getCurrentVisit(7);
  const firstCookie = await enrollPhone(server, visitStore, 7);
  const secondCookie = await enrollPhone(server, visitStore, 7);
  const order = await server.inject("POST", "/api/orders", {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(firstCookie));

  const response = await server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );

  const replacement = visitStore.getCurrentVisit(7);
  const newToken = visitStore.getRawTokenForDisplay(7);
  const oldQr = await server.inject("GET", `/t/${oldToken}`);
  const firstPhone = await server.inject("GET", "/api/session", undefined, { cookie: firstCookie });
  const secondPhone = await server.inject("GET", "/api/session", undefined, { cookie: secondCookie });
  const newCookie = await enrollPhone(server, visitStore, 7);
  const freshSession = await server.inject("GET", "/api/session", undefined, { cookie: newCookie });

  assert.equal(order.status, 201);
  assert.deepEqual(response.body, { ok: true, tableNumber: 7, status: "Welcome" });
  assert.equal(response.status, 200);
  assert.equal(replacement.generation, before.generation + 1);
  assert.equal(replacement.status, "welcome");
  assert.notEqual(newToken, oldToken);
  assert.deepEqual(welcomeUpdates, [{ tableNumber: 7, orderingUrl: replacement.orderingUrl }]);
  assert.equal(oldQr.status, 302);
  assert.equal(oldQr.headers.Location, "/?e=expired");
  assert.equal(firstPhone.status, 401);
  assert.equal(secondPhone.status, 401);
  assert.equal(freshSession.body.session.slipNumber, null);
  assert.deepEqual(freshSession.body.session.orders, []);
  const responseText = JSON.stringify(response.body);
  assert.equal(responseText.includes(replacement.orderingUrl), false);
  assert.equal(responseText.includes(newToken), false);
  assert.equal(responseText.includes(CHECKOUT_API_KEY), false);
});

test("simultaneous checkout requests share one in-flight rotation and safe response", async () => {
  let releaseDisplay;
  const displayHeld = new Promise((resolve) => {
    releaseDisplay = resolve;
  });
  let displayStarted;
  const displayBegun = new Promise((resolve) => {
    displayStarted = resolve;
  });
  const welcomeUrls = [];
  const visitStore = createVisitStore();
  const before = visitStore.getCurrentVisit(7);
  const oldToken = visitStore.getRawTokenForDisplay(7);
  const server = createCustomerServer({
    checkoutApiKey: CHECKOUT_API_KEY,
    visitStore,
    epaperClient: displayClient(async (_tableNumber, orderingUrl) => {
      welcomeUrls.push(orderingUrl);
      displayStarted();
      await displayHeld;
      return { ok: true };
    })
  });

  const first = server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );
  await displayBegun;
  const pending = visitStore.getCurrentVisit(7);
  const pendingToken = visitStore.getRawTokenForDisplay(7);
  const second = server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );
  const third = server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );
  await new Promise(setImmediate);

  assert.equal(welcomeUrls.length, 1);
  assert.equal(pending.generation, before.generation + 1);
  assert.notEqual(pendingToken, oldToken);
  releaseDisplay();

  const responses = await Promise.all([first, second, third]);
  const completed = visitStore.getCurrentVisit(7);
  const expectedBody = { ok: true, tableNumber: 7, status: "Welcome" };

  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, expectedBody);
    assert.equal(JSON.stringify(response.body).includes(pending.orderingUrl), false);
    assert.equal(JSON.stringify(response.body).includes(pendingToken), false);
  }
  assert.deepEqual(welcomeUrls, [pending.orderingUrl]);
  assert.equal(completed.generation, pending.generation);
  assert.equal(completed.orderingUrl, pending.orderingUrl);
  assert.equal(visitStore.getRawTokenForDisplay(7), pendingToken);
  assert.equal(completed.status, "welcome");
});

test("checkout failure keeps revocation and closed orders while retrying one pending replacement", async () => {
  let rejectDisplay;
  const displayHeld = new Promise((_resolve, reject) => {
    rejectDisplay = reject;
  });
  let displayStarted;
  const displayBegun = new Promise((resolve) => {
    displayStarted = resolve;
  });
  const welcomeUrls = [];
  const visitStore = createVisitStore();
  const store = createOrderStore({ now: () => new Date("2026-07-22T03:00:00Z") });
  const server = createCustomerServer({
    checkoutApiKey: CHECKOUT_API_KEY,
    visitStore,
    store,
    epaperClient: {
      updateTableInUse: async () => ({ ok: true }),
      updateTableWelcome: async (_tableNumber, orderingUrl) => {
        welcomeUrls.push(orderingUrl);
        if (welcomeUrls.length === 1) {
          displayStarted();
          return displayHeld;
        }
        return { ok: true };
      }
    }
  });
  const oldToken = visitStore.getRawTokenForDisplay(7);
  const before = visitStore.getCurrentVisit(7);
  const firstCookie = await enrollPhone(server, visitStore, 7);
  const secondCookie = await enrollPhone(server, visitStore, 7);
  await server.inject("POST", "/api/orders", {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(firstCookie));

  const firstRequest = server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );
  await displayBegun;
  const sharedRequest = server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );
  await new Promise(setImmediate);
  rejectDisplay(new Error(`Failed to render with Bearer ${CHECKOUT_API_KEY}`));
  const [first, shared] = await Promise.all([firstRequest, sharedRequest]);
  const pending = visitStore.getCurrentVisit(7);
  const pendingToken = visitStore.getRawTokenForDisplay(7);
  const oldQr = await server.inject("GET", `/t/${oldToken}`);
  const firstPhone = await server.inject("GET", "/api/session", undefined, { cookie: firstCookie });
  const secondPhone = await server.inject("GET", "/api/session", undefined, { cookie: secondCookie });

  assert.equal(first.status, 502);
  assert.deepEqual(first.body, { error: "E-paper display update failed" });
  assert.equal(shared.status, 502);
  assert.deepEqual(shared.body, first.body);
  assert.deepEqual(welcomeUrls, [pending.orderingUrl]);
  assert.equal(pending.status, "pending_display");
  assert.equal(pending.generation, before.generation + 1);
  assert.equal(oldQr.status, 302);
  assert.equal(oldQr.headers.Location, "/?e=expired");
  assert.equal(firstPhone.status, 401);
  assert.equal(secondPhone.status, 401);
  assert.equal(store.getSession(7).slipNumber, null);
  assert.equal(JSON.stringify(first.body).includes(pending.orderingUrl), false);
  assert.equal(JSON.stringify(first.body).includes(pendingToken), false);
  assert.equal(JSON.stringify(first.body).includes(CHECKOUT_API_KEY), false);

  const retry = await server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );
  const completed = visitStore.getCurrentVisit(7);

  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, { ok: true, tableNumber: 7, status: "Welcome" });
  assert.deepEqual(welcomeUrls, [pending.orderingUrl, pending.orderingUrl]);
  assert.equal(completed.generation, pending.generation);
  assert.equal(completed.orderingUrl, pending.orderingUrl);
  assert.equal(completed.status, "welcome");
});

test("checkout and an already-authenticated order follow the same table queue", async () => {
  let releaseProvisioning;
  const provisioningHeld = new Promise((resolve) => {
    releaseProvisioning = resolve;
  });
  let provisioningStarted;
  const provisioningBegun = new Promise((resolve) => {
    provisioningStarted = resolve;
  });
  let welcomeCalls = 0;
  const displayUpdates = [];
  const visitStore = createVisitStore();
  const store = createOrderStore({ now: () => new Date("2026-07-22T03:00:00Z") });
  const server = createCustomerServer({
    checkoutApiKey: CHECKOUT_API_KEY,
    tableDisplayApiKey: "display-secret",
    visitStore,
    store,
    epaperClient: {
      updateTableWelcome: async () => {
        welcomeCalls += 1;
        if (welcomeCalls === 1) {
          provisioningStarted();
          await provisioningHeld;
          displayUpdates.push("provisioning Welcome");
        } else {
          displayUpdates.push("checkout Welcome");
        }
        return { ok: true };
      },
      updateTableInUse: async () => {
        displayUpdates.push("Table is in use");
        return { ok: true };
      }
    }
  });
  const cookie = await enrollPhone(server, visitStore, 7);
  const provisioning = server.inject(
    "POST",
    "/api/table-displays/7/welcome",
    undefined,
    { authorization: "Bearer display-secret" }
  );
  await provisioningBegun;

  const checkout = server.inject(
    "POST",
    "/api/tables/7/checkout",
    undefined,
    { authorization: `Bearer ${CHECKOUT_API_KEY}` }
  );
  const order = server.inject("POST", "/api/orders", {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(cookie));
  await new Promise(setImmediate);
  releaseProvisioning();

  const [provisioningResponse, checkoutResponse, orderResponse] = await Promise.all([
    provisioning,
    checkout,
    order
  ]);

  assert.equal(provisioningResponse.status, 200);
  assert.equal(checkoutResponse.status, 200);
  assert.equal(orderResponse.status, 401);
  assert.deepEqual(displayUpdates, ["provisioning Welcome", "checkout Welcome"]);
  assert.equal(visitStore.getCurrentVisit(7).status, "welcome");
  assert.equal(store.getSession(7).slipNumber, null);
});

test("this app no longer reads, or can reach, the e-paper hub", () => {
  // Replaces "server can reuse epaper hub API_KEY when EPAPER_API_KEY is not set".
  // Spec 11.7 moved the e-paper hub SDK to apps/core-api and made it that package's one
  // permitted caller, so the hub's URL and the hub's key are core-api's configuration now
  // and this process has no business holding either.
  //
  // Asserted as an ABSENCE over the source, which is the only shape that can see this:
  // every behavioural test here injects an epaperClient, so a leftover
  // `process.env.EPAPER_API_KEY` would sit in server.js unread and unnoticed, and the
  // hub's key would keep being shipped to a container with no reason to have it.
  const source = require("node:fs").readFileSync(require.resolve("../server"), "utf8");

  for (const name of ["EPAPER_HUB_URL", "EPAPER_API_KEY"]) {
    assert.doesNotMatch(source, new RegExp(`process\\.env\\.${name}\\b`), name);
  }
  // API_KEY was the hub's fallback name. Word-bounded so TABLE_DISPLAY_API_KEY -- this
  // app's own INBOUND provisioning bearer, which is unrelated and stays -- is not caught.
  assert.doesNotMatch(source, /process\.env\.API_KEY\b/);

  // ...and the two it reads instead.
  assert.match(source, /process\.env\.CORE_API_URL\b/);
  assert.match(source, /process\.env\.TABLE_DISPLAY_SERVICE_TOKEN\b/);
});

test("provisioning compares SHA-256 token digests with timingSafeEqual", () => {
  const source = require("node:fs").readFileSync(require.resolve("../server"), "utf8");

  assert.match(source, /const supplied = crypto\.createHash\("sha256"\)\.update\(.+\)\.digest\(\)/);
  assert.match(source, /const configured = crypto\.createHash\("sha256"\)\.update\(.+\)\.digest\(\)/);
  assert.match(source, /crypto\.timingSafeEqual\(supplied, configured\)/);
});

test("authorized provisioning preserves the current Welcome visit URL and generation", async () => {
  const updates = [];
  const visitStore = createVisitStore();
  const before = visitStore.getCurrentVisit(7);
  const server = createCustomerServer({
    tableDisplayApiKey: "display-secret",
    visitStore,
    epaperClient: displayClient(async (tableNumber, orderingUrl) => {
      updates.push({ tableNumber, orderingUrl });
      return { ok: true };
    })
  });

  const response = await server.inject(
    "POST",
    "/api/table-displays/7/welcome",
    undefined,
    { authorization: "Bearer display-secret" }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, tableNumber: 7, status: "Welcome" });
  assert.deepEqual(updates, [{ tableNumber: 7, orderingUrl: before.orderingUrl }]);
  assert.deepEqual(visitStore.getCurrentVisit(7), before);
});

test("provisioning rejects missing or incorrect authorization", async () => {
  let updates = 0;
  const server = createServer({
    tableDisplayApiKey: "display-secret",
    epaperClient: displayClient(async () => {
      updates += 1;
      return { ok: true };
    })
  });

  const missing = await server.inject("POST", "/api/table-displays/7/welcome");
  const incorrect = await server.inject(
    "POST",
    "/api/table-displays/7/welcome",
    undefined,
    { authorization: "Bearer wrong-secret" }
  );

  assert.equal(missing.status, 401);
  assert.equal(incorrect.status, 401);
  assert.equal(updates, 0);
});

test("provisioning rejects an incorrect bearer token with the configured token length", async () => {
  let updates = 0;
  const server = createServer({
    tableDisplayApiKey: "display-secret",
    epaperClient: displayClient(async () => {
      updates += 1;
      return { ok: true };
    })
  });

  const response = await server.inject(
    "POST",
    "/api/table-displays/7/welcome",
    undefined,
    { authorization: "Bearer display-secrEt" }
  );

  assert.equal(response.status, 401);
  assert.equal(updates, 0);
});

test("provisioning rejects noncanonical table number segments", async () => {
  let updates = 0;
  const server = createServer({
    tableDisplayApiKey: "display-secret",
    epaperClient: displayClient(async () => {
      updates += 1;
      return { ok: true };
    })
  });

  for (const tableNumber of ["-1", "1.5", "not-a-number", "1e0", "0x1", "01", "0", "13"]) {
    const response = await server.inject(
      "POST",
      `/api/table-displays/${tableNumber}/welcome`,
      undefined,
      { authorization: "Bearer display-secret" }
    );

    assert.equal(response.status, 400);
  }
  assert.equal(updates, 0);
});

test("provisioning rejects active tables without updating the display or session", async () => {
  let welcomeUpdates = 0;
  const visitStore = createVisitStore();
  const server = createCustomerServer({
    visitStore,
    tableDisplayApiKey: "display-secret",
    epaperClient: {
      updateTableInUse: async () => ({ ok: true }),
      updateTableWelcome: async () => {
        welcomeUpdates += 1;
        return { ok: true };
      }
    }
  });
  const cookie = await enrollPhone(server, visitStore, 7);

  const order = await server.inject("POST", "/api/orders", {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(cookie));
  const before = await server.inject("GET", "/api/session", undefined, { cookie });
  const response = await server.inject(
    "POST",
    "/api/table-displays/7/welcome",
    undefined,
    { authorization: "Bearer display-secret" }
  );
  const after = await server.inject("GET", "/api/session", undefined, { cookie });

  assert.equal(order.status, 201);
  assert.equal(before.body.session.status, "Table is in use");
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { error: "Table is in use" });
  assert.equal(welcomeUpdates, 0);
  assert.deepEqual(after.body.session, before.body.session);
});

test("a concurrent first order leaves the table display in use after Welcome provisioning", async () => {
  let releaseWelcome;
  const welcomeStarted = new Promise((resolve) => {
    releaseWelcome = resolve;
  });
  let beginWelcome;
  const welcomeBegun = new Promise((resolve) => {
    beginWelcome = resolve;
  });
  const displayUpdates = [];
  const visitStore = createVisitStore();
  const server = createCustomerServer({
    visitStore,
    tableDisplayApiKey: "display-secret",
    epaperClient: {
      updateTableWelcome: async () => {
        beginWelcome();
        await welcomeStarted;
        displayUpdates.push("Welcome");
        return { ok: true };
      },
      updateTableInUse: async () => {
        displayUpdates.push("Table is in use");
        return { ok: true };
      }
    }
  });
  const cookie = await enrollPhone(server, visitStore, 7);

  const welcome = server.inject(
    "POST",
    "/api/table-displays/7/welcome",
    undefined,
    { authorization: "Bearer display-secret" }
  );
  await welcomeBegun;
  const order = server.inject("POST", "/api/orders", {
    items: [{ id: "crispy-gyoza", quantity: 1 }]
  }, customerHeaders(cookie));
  await new Promise(setImmediate);
  releaseWelcome();

  const [welcomeResponse, orderResponse] = await Promise.all([welcome, order]);
  const sessionResponse = await server.inject("GET", "/api/session", undefined, { cookie });

  assert.equal(welcomeResponse.status, 200);
  assert.equal(orderResponse.status, 201);
  assert.equal(sessionResponse.body.session.status, "Table is in use");
  assert.deepEqual(displayUpdates, ["Welcome", "Table is in use"]);
});

test("provisioning reports missing server display configuration", async () => {
  const missingKeyServer = createServer({
    tableDisplayApiKey: "",
    epaperClient: displayClient(async () => ({ ok: true }))
  });
  const missingHubServer = createServer({
    tableDisplayApiKey: "display-secret",
    epaperClient: displayClient(async () => ({ skipped: true }))
  });

  const missingKey = await missingKeyServer.inject("POST", "/api/table-displays/7/welcome");
  const missingHub = await missingHubServer.inject(
    "POST",
    "/api/table-displays/7/welcome",
    undefined,
    { authorization: "Bearer display-secret" }
  );

  assert.equal(missingKey.status, 503);
  assert.equal(missingHub.status, 503);
});

test("provisioning maps SDK failures to 502 without changing the session", async () => {
  const visitStore = createVisitStore();
  const server = createCustomerServer({
    visitStore,
    tableDisplayApiKey: "display-secret",
    epaperClient: displayClient(async () => {
      throw new Error("Bearer secret must not leak");
    })
  });
  const cookie = await enrollPhone(server, visitStore, 7);

  const before = await server.inject("GET", "/api/session", undefined, { cookie });
  const response = await server.inject(
    "POST",
    "/api/table-displays/7/welcome",
    undefined,
    { authorization: "Bearer display-secret" }
  );
  const after = await server.inject("GET", "/api/session", undefined, { cookie });

  assert.equal(before.body.session.status, "Welcome");
  assert.equal(before.body.session.orders.length, 0);
  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { error: "E-paper display update failed" });
  assert.deepEqual(after.body.session, before.body.session);
});
