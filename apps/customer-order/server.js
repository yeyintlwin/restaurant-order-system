const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createEpaperClient } = require("./epaper-client");
const { createOrderStore, MAX_TABLE_NUMBER } = require("./order-store");
const { createTableVisitStore } = require("./table-visit-store");

const PUBLIC_ROOT = path.join(__dirname, "public");
const DEFAULT_ORDER_BASE_URL = "https://order.yeyintlwin.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function createConfiguredEpaperClient(requireStartupConfiguration = false) {
  const hubUrl = process.env.EPAPER_HUB_URL;
  const apiKey = process.env.EPAPER_API_KEY || process.env.API_KEY;
  const orderBaseUrl = process.env.ORDER_BASE_URL;
  if (requireStartupConfiguration && (!hubUrl || !apiKey || !orderBaseUrl)) {
    throw new Error("E-paper startup configuration is incomplete");
  }
  return createEpaperClient({
    hubUrl,
    apiKey,
    orderBaseUrl
  });
}

function loadDotEnv(file = path.join(__dirname, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function startupConfiguration(options) {
  const shopId = options.shopId ?? process.env.SHOP_ID;
  const checkoutApiKey = options.checkoutApiKey ?? process.env.CHECKOUT_API_KEY;
  const businessTimeZone = options.businessTimeZone ?? process.env.BUSINESS_TIME_ZONE;
  const rolloverValue = options.businessDayRolloverHour ?? process.env.BUSINESS_DAY_ROLLOVER_HOUR;
  const businessDayRolloverHour = rolloverValue === "6" ? 6 : rolloverValue;

  if (shopId !== "1") throw new Error('SHOP_ID must be exactly "1"');
  if (typeof checkoutApiKey !== "string" || checkoutApiKey.length === 0) {
    throw new Error("CHECKOUT_API_KEY must be nonempty");
  }
  if (businessTimeZone !== "Asia/Tokyo") {
    throw new Error('BUSINESS_TIME_ZONE must be exactly "Asia/Tokyo"');
  }
  if (!Number.isInteger(businessDayRolloverHour) || businessDayRolloverHour !== 6) {
    throw new Error("BUSINESS_DAY_ROLLOVER_HOUR must be integer 6");
  }
  return { shopId, checkoutApiKey };
}

function millisecondsUntilNextRollover(now) {
  const instant = new Date(now).getTime();
  const tokyo = new Date(instant + JST_OFFSET_MS);
  let rollover = Date.UTC(
    tokyo.getUTCFullYear(),
    tokyo.getUTCMonth(),
    tokyo.getUTCDate(),
    6
  ) - JST_OFFSET_MS;
  if (rollover <= instant) rollover += DAY_MS;
  return rollover - instant;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function bearerMatches(header, expected) {
  const prefix = "Bearer ";
  if (!String(header || "").startsWith(prefix) || !expected) return false;
  const supplied = crypto.createHash("sha256").update(String(header).slice(prefix.length)).digest();
  const configured = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(supplied, configured);
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function authorizedVisit(req, visitStore) {
  return visitStore.resolvePhoneSession(cookieValue(req.headers.cookie, "rsid"));
}

function acceptsJson(req) {
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers["content-type"] || ""));
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

function sendStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_ROOT, requested));

  if (!filePath.startsWith(PUBLIC_ROOT)) return sendJson(res, 404, { error: "Not found" });
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: "Not found" });
  }

  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function createServer(options = {}) {
  const store = options.store || createOrderStore({ now: options.now });
  const visitStore = options.visitStore;
  if (!visitStore || ["getOrderingUrl", "enroll", "resolvePhoneSession", "markInUse"].some((method) => typeof visitStore[method] !== "function")) {
    throw new Error("visitStore is required and must provide getOrderingUrl");
  }
  const orderOrigin = new URL(options.orderBaseUrl || process.env.ORDER_BASE_URL || DEFAULT_ORDER_BASE_URL).origin;
  const pendingEpaperTables = new Set();
  const tableDisplayUpdates = new Map();
  const rotationOperations = new Map();
  const failedRolloverTables = new Set();
  const checkoutApiKey = options.checkoutApiKey ?? process.env.CHECKOUT_API_KEY;
  const tableDisplayApiKey = options.tableDisplayApiKey ?? process.env.TABLE_DISPLAY_API_KEY;
  const epaperClient = options.epaperClient || createConfiguredEpaperClient();

  function runTableDisplayUpdate(tableNumber, update) {
    const previous = tableDisplayUpdates.get(tableNumber) || Promise.resolve();
    const next = previous.catch(() => undefined).then(update);
    tableDisplayUpdates.set(tableNumber, next);
    return next.finally(() => {
      if (tableDisplayUpdates.get(tableNumber) === next) tableDisplayUpdates.delete(tableNumber);
    });
  }

  function runTableRotation(tableNumber, rotation) {
    const inFlight = rotationOperations.get(tableNumber);
    if (inFlight) return inFlight;
    const operation = runTableDisplayUpdate(tableNumber, rotation);
    const shared = operation.finally(() => {
      if (rotationOperations.get(tableNumber) === shared) rotationOperations.delete(tableNumber);
    });
    rotationOperations.set(tableNumber, shared);
    return shared;
  }

  async function rotateTableDisplay(tableNumber) {
    const replacement = visitStore.beginRotation(tableNumber);
    store.closeSession(tableNumber);
    await epaperClient.updateTableWelcome(tableNumber, replacement.orderingUrl);
    return visitStore.completeRotation(tableNumber);
  }

  async function reconcileExpiredVisits() {
    const tableNumbers = [...new Set([
      ...visitStore.expiredTableNumbers(),
      ...failedRolloverTables
    ])];
    await Promise.all(tableNumbers.map(async (tableNumber) => {
      try {
        await runTableRotation(tableNumber, async () => {
          const current = visitStore.getCurrentVisit(tableNumber);
          if (failedRolloverTables.has(tableNumber)) {
            if (current?.status !== "pending_display") return;
          } else if (!visitStore.expiredTableNumbers().includes(tableNumber)) {
            return;
          }
          await rotateTableDisplay(tableNumber);
        });
        failedRolloverTables.delete(tableNumber);
      } catch {
        failedRolloverTables.add(tableNumber);
      }
    }));
  }

  async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, app: "customer-order" });
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        return sendJson(res, 200, { maxTableNumber: MAX_TABLE_NUMBER, currency: "JPY" });
      }

      if (req.method === "GET" && url.pathname === "/api/menu") {
        return sendJson(res, 200, store.getMenu());
      }

      const enrollmentRoute = url.pathname.match(/^\/t\/([^/]+)$/);
      if (req.method === "GET" && enrollmentRoute) {
        const enrollment = visitStore.enroll(enrollmentRoute[1]);
        if (!enrollment) {
          res.writeHead(302, {
            Location: "/?e=expired",
            "Cache-Control": "no-store"
          });
          return res.end();
        }
        const expiresAt = Date.parse(enrollment.visit.expiresAt);
        const maxAge = Number.isFinite(expiresAt)
          ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
          : 0;
        res.writeHead(302, {
          Location: "/",
          "Set-Cookie": `rsid=${enrollment.sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
          "Cache-Control": "no-store"
        });
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/api/session") {
        const visit = authorizedVisit(req, visitStore);
        if (!visit) return sendJson(res, 401, { error: "Scan the current table QR to continue" });
        return sendJson(res, 200, { session: store.getSession(visit.tableNumber) });
      }

      const welcomeRoute = url.pathname.match(/^\/api\/table-displays\/([^/]+)\/welcome$/);
      if (req.method === "POST" && welcomeRoute) {
        if (!tableDisplayApiKey) {
          return sendJson(res, 503, { error: "Table display provisioning is not configured" });
        }
        if (!bearerMatches(req.headers.authorization, tableDisplayApiKey)) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }

        if (!/^(?:[1-9]|1[0-2])$/.test(welcomeRoute[1])) {
          return sendJson(res, 400, { error: `table number must be between 1 and ${MAX_TABLE_NUMBER}` });
        }
        const tableNumber = Number(welcomeRoute[1]);
        const response = await runTableDisplayUpdate(tableNumber, async () => {
          if (store.getSession(tableNumber).status === "Table is in use") {
            return { status: 409, body: { error: "Table is in use" } };
          }
          try {
            const result = await epaperClient.updateTableWelcome(tableNumber, visitStore.getOrderingUrl(tableNumber));
            if (result?.skipped) {
              return { status: 503, body: { error: "E-paper hub is not configured" } };
            }
            return { status: 200, body: { ok: true, tableNumber, status: "Welcome" } };
          } catch {
            return { status: 502, body: { error: "E-paper display update failed" } };
          }
        });
        return sendJson(res, response.status, response.body);
      }

      const checkoutRoute = url.pathname.match(/^\/api\/tables\/([^/]+)\/checkout$/);
      if (req.method === "POST" && checkoutRoute) {
        if (!bearerMatches(req.headers.authorization, checkoutApiKey)) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }
        if (!/^(?:[1-9]|1[0-2])$/.test(checkoutRoute[1])) {
          return sendJson(res, 400, { error: `table number must be between 1 and ${MAX_TABLE_NUMBER}` });
        }
        const tableNumber = Number(checkoutRoute[1]);
        const response = await runTableRotation(tableNumber, () => rotateTableDisplay(tableNumber)).then(
          () => ({ status: 200, body: { ok: true, tableNumber, status: "Welcome" } }),
          () => ({ status: 502, body: { error: "E-paper display update failed" } })
        );
        return sendJson(res, response.status, response.body);
      }

      if (req.method === "POST" && url.pathname === "/api/orders") {
        const visit = authorizedVisit(req, visitStore);
        if (!visit) return sendJson(res, 401, { error: "Scan the current table QR to continue" });
        if (req.headers.origin !== orderOrigin) return sendJson(res, 403, { error: "Forbidden" });
        if (!acceptsJson(req)) return sendJson(res, 415, { error: "Content-Type must be application/json" });
        const body = await readBody(req);
        const tableNumber = visit.tableNumber;
        const response = await runTableDisplayUpdate(tableNumber, async () => {
          const currentVisit = authorizedVisit(req, visitStore);
          if (!currentVisit || currentVisit.tableNumber !== tableNumber) {
            return { status: 401, body: { error: "Scan the current table QR to continue" } };
          }
          const result = store.placeOrder({ tableNumber, items: body.items });
          visitStore.markInUse(tableNumber);
          let epaperUpdate = { ok: true };
          if (result.isFirstOrderForSession || pendingEpaperTables.has(tableNumber)) {
            try {
              epaperUpdate = await epaperClient.updateTableInUse(tableNumber, visitStore.getOrderingUrl(tableNumber));
              pendingEpaperTables.delete(tableNumber);
            } catch {
              pendingEpaperTables.add(tableNumber);
              epaperUpdate = { ok: false, pending: true, error: "E-paper display update failed" };
            }
          }
          return { status: 201, body: { ...result, epaperUpdate } };
        });
        return sendJson(res, response.status, response.body);
      }

      if (req.method === "POST" && url.pathname === "/api/staff-calls") {
        let visit = authorizedVisit(req, visitStore);
        if (!visit) return sendJson(res, 401, { error: "Scan the current table QR to continue" });
        if (req.headers.origin !== orderOrigin) return sendJson(res, 403, { error: "Forbidden" });
        if (!acceptsJson(req)) return sendJson(res, 415, { error: "Content-Type must be application/json" });
        const body = await readBody(req);
        visit = authorizedVisit(req, visitStore);
        if (!visit) return sendJson(res, 401, { error: "Scan the current table QR to continue" });
        return sendJson(res, 201, { call: store.callStaff(visit.tableNumber, body.reason) });
      }

      if (req.method === "GET") return sendStatic(req, res);
      return sendJson(res, 405, { error: "Method not allowed" });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  const server = http.createServer(handler);
  server.inject = async (method, url, body, headers = {}) => {
    const chunks = [];
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const req = {
      method,
      url,
      headers,
      on(event, listener) {
        if (event === "data" && bodyText) process.nextTick(() => listener(Buffer.from(bodyText)));
        if (event === "end") process.nextTick(listener);
        return req;
      },
      destroy() {}
    };
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status, headers) {
        res.statusCode = status;
        Object.assign(res.headers, headers);
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        res.finished();
      },
      getHeaders() {
        return res.headers;
      },
      finished() {}
    };

    await new Promise((resolve) => {
      res.finished = resolve;
      handler(req, res);
    });
    const text = Buffer.concat(chunks).toString();
    return {
      status: res.statusCode,
      headers: res.getHeaders(),
      body: text ? JSON.parse(text) : null
    };
  };
  server.reconcileExpiredVisits = reconcileExpiredVisits;

  return server;
}

async function initializeTableDisplays(options = {}) {
  const epaperClient = options.epaperClient;
  const visitStore = options.visitStore;
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const retryDelayMs = options.retryDelayMs ?? 1000;

  await Promise.all(Array.from({ length: MAX_TABLE_NUMBER }, async (_, index) => {
    const tableNumber = index + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await epaperClient.updateTableWelcome(tableNumber, visitStore.getOrderingUrl(tableNumber));
        if (result?.skipped) {
          const error = new Error("E-paper hub is not configured");
          error.code = "EPAPER_CONFIGURATION";
          throw error;
        }
        return;
      } catch (error) {
        if (attempt === attempts || !isTransientEpaperError(error)) {
          throw new Error(`Failed to initialize e-paper table ${tableNumber}`, { cause: error });
        }
        await sleep(retryDelayMs);
      }
    }
  }));
}

function isTransientEpaperError(error) {
  const message = String(error?.message || "");
  if (
    error?.code === "EPAPER_CONFIGURATION" ||
    error?.code === "ERR_INVALID_URL" ||
    // tableLabel is the SDK's rejection; tableNumber is still thrown by table-visit-store.js
    // for this app's own 1..12 range, and both are permanent -- retrying either just burns
    // the startup attempt budget three times over.
    /^(?:baseUrl|apiKey|epaperId|tableNumber|tableLabel|status|url)\b.*\b(?:must|is required)\b|^url is too long for the e-paper QR area$|^Invalid URL$/.test(message)
  ) return false;
  const status = /(?:^|\D)([1-5]\d{2})(?:\D|$)/.exec(message);
  if (!status) return true;
  const value = Number(status[1]);
  return value === 408 || value === 429 || value >= 500;
}

function listenServer(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

async function start(options = {}) {
  const configuration = startupConfiguration(options);
  const epaperClient = options.epaperClient || createConfiguredEpaperClient(true);
  const visitStore = options.visitStore || createTableVisitStore({
    shopId: configuration.shopId,
    orderBaseUrl: options.orderBaseUrl || process.env.ORDER_BASE_URL || DEFAULT_ORDER_BASE_URL,
    now: options.now
  });
  visitStore.createInitialVisits();
  const server = options.server || createServer({
    ...options,
    checkoutApiKey: configuration.checkoutApiKey,
    epaperClient,
    visitStore
  });
  const port = options.port ?? Number(process.env.PORT || 3100);
  const listen = options.listen || listenServer;

  await initializeTableDisplays({ ...options, epaperClient, visitStore });
  await listen(server, port);
  const scheduler = options.scheduler || setTimeout;
  const now = options.now || (() => new Date());
  const reportRolloverError = options.reportRolloverError || console.error;
  const scheduleNextRollover = () => {
    const timer = scheduler(async () => {
      try {
        await server.reconcileExpiredVisits();
      } catch {
        try {
          reportRolloverError("Business-day rollover reconciliation failed");
        } catch {}
      } finally {
        scheduleNextRollover();
      }
    }, millisecondsUntilNextRollover(now()));
    if (typeof timer?.unref === "function") timer.unref();
  };
  scheduleNextRollover();
  return server;
}

if (require.main === module) {
  loadDotEnv();
  start().then(() => {
    const port = Number(process.env.PORT || 3100);
    console.log(`Customer order app listening on http://localhost:${port}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createServer, initializeTableDisplays, loadDotEnv, start };
