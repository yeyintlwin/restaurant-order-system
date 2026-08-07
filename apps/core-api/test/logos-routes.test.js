"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { after, before, describe, test } = require("node:test");

const { createApp } = require("../http/router");
const { createRateLimiter } = require("../lib/rate-limit");
const { createSemaphore } = require("../lib/semaphore");
const { createScope } = require("../db/scope");
const { openRuntimePool, closeAllPools } = require("../db");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const { SESSION_COOKIE_NAME } = require("../http/cookies");
const { createLogoStore, isKey } = require("../storage/logo-store");

require("../http/routes/auth");
require("../http/routes/logos");

const ORIGIN = "https://api.yeyintlwin.com";
const COOKIE = `${SESSION_COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAA`;
const HASH = `scrypt$N=32768,r=8,p=1$${"c".repeat(22)}$${"k".repeat(43)}`;
const ADMIN = "aaaaaaaa-0003-4000-8000-0000000000e1";
const SESSION_ID = "aaaaaaaa-0008-4000-8000-0000000000e1";
const CO_A = "aaaaaaaa-0001-4000-8000-0000000000e1";
const CO_B = "aaaaaaaa-0001-4000-8000-0000000000e2";
const SHOP_A = "aaaaaaaa-0002-4000-8000-0000000000e1";

const PLATFORM_SCOPE = createScope({ kind: "platform", userId: ADMIN, sessionId: SESSION_ID });

// A REAL PNG, built rather than pasted: one pixel, valid header, valid CRCs. The
// store sniffs magic bytes, so a fixture that only looks like a PNG in a comment
// would pass the test and fail on the box.
function png(red) {
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(typed) : 0, 0);
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  // The pixel's colour is the ONLY difference between two fixtures, which is what
  // makes "the same picture twice is one file" testable against "two pictures".
  const raw = zlib.deflateSync(Buffer.from([0x00, red, 0x00, 0x00]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", raw),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const RED = png(0xff);
const BLUE = png(0x11);

function harness(store) {
  return {
    log: (line) => { try { const e = JSON.parse(line); if (e.level === "error") console.error("  core-api:", e.message); } catch {} },
    apiPublicOrigin: ORIGIN,
    trustedProxyHops: 1,
    sessionIdleSeconds: 28800,
    sessionAbsoluteSeconds: 604800,
    loginRatePerMinute: 30,
    loginTimeBudgetMs: 250,
    passwordAbuseThreshold: 5,
    adminMintRatePer10min: 20,
    pairingMintRatePer10min: 30,
    pairRatePerMinute: 20,
    rotateRatePerHour: 5,
    rateLimiter: createRateLimiter({ now: () => 1_700_000_000_000 }),
    scryptSemaphore: createSemaphore({ slots: 2 }),
    sessions: {
      resolveSession: async () => ({
        sessionId: SESSION_ID, userId: ADMIN, role: "platform_admin", companyId: null,
        actingCompanyId: null, email: "op@example.test", displayName: "Operator",
        mustChangePassword: false, status: "active", companyStatus: null
      }),
      renewSession: async () => null
    },
    scopes: { materialiseScope: async () => PLATFORM_SCOPE },
    appendAuditEvent: async () => "1",
    logos: require("../repositories/platform/logos"),
    platformAudit: require("../repositories/platform/audit"),
    logoStore: store
  };
}

async function withServer(deps, run) {
  const app = createApp(deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const upload = (base, urlPath, body) =>
  fetch(`${base}${urlPath}`, {
    method: "PUT",
    headers: { Origin: ORIGIN, "Content-Type": "image/png", "X-Forwarded-For": "203.0.113.7", Cookie: COOKIE },
    body
  });

const clear = (base, urlPath) =>
  fetch(`${base}${urlPath}`, {
    method: "DELETE",
    headers: { Origin: ORIGIN, "X-Forwarded-For": "203.0.113.7", Cookie: COOKIE }
  });

const fetchLogo = (base, key) =>
  fetch(`${base}/api/logos/${key}`, { headers: { "X-Forwarded-For": "203.0.113.7" } });

describe("logos", { skip: skipDatabaseTests() }, () => {
  let db;
  let root;
  let store;

  before(async () => {
    db = await cloneTemplate(__filename);
    openRuntimePool({ connectionString: db.connectionString, max: 4 });
    root = await fs.mkdtemp(path.join(os.tmpdir(), "core-api-logos-"));
    store = createLogoStore({ root });
  });
  after(async () => {
    await closeAllPools();
    await db.drop();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function reset() {
    await db.resetFixtures();
    await db.unscoped(
      `INSERT INTO users (id, company_id, role, email, display_name, password_hash)
       VALUES ($1, NULL, 'platform_admin', 'op@example.test', 'Operator', $2)`,
      [ADMIN, HASH]
    );
    await db.unscoped(
      `INSERT INTO companies (id, name, slug) VALUES ($1, 'Golden Duck', 'golden-duck'), ($2, 'Shwe Cafe', 'shwe-cafe')`,
      [CO_A, CO_B]
    );
    await db.unscoped(
      `INSERT INTO shops (id, company_id, name, slug, time_zone, business_day_rollover_hour, currency, language)
       VALUES ($1, $2, 'Insein', 'insein', 'Asia/Yangon', 6, 'MMK', 'my')`,
      [SHOP_A, CO_A]
    );
    for (const name of await fs.readdir(root)) await fs.rm(path.join(root, name));
  }

  const onDisk = async () => (await fs.readdir(root)).sort();

  test("the key is the content, so the same picture twice is one file", async () => {
    await reset();
    await withServer(harness(store), async (base) => {
      const first = await upload(base, `/api/platform/companies/${CO_A}/logo`, RED);
      assert.equal(first.status, 200);
      const key = (await first.json()).logoKey;
      assert.ok(isKey(key), key);

      // The SAME bytes for a DIFFERENT company. One file, two rows pointing at it --
      // which is the whole reason the cleanup below has to ask about both tables.
      const second = await upload(base, `/api/platform/companies/${CO_B}/logo`, RED);
      assert.equal((await second.json()).logoKey, key);
      assert.deepEqual(await onDisk(), [key]);
    });
  });

  test("REPLACING A LOGO DELETES THE OLD FILE, and only when nothing else wants it", async () => {
    await reset();
    await withServer(harness(store), async (base) => {
      const red = (await (await upload(base, `/api/platform/companies/${CO_A}/logo`, RED)).json()).logoKey;
      // The second company takes the SAME picture, so the file now has two holders.
      await upload(base, `/api/platform/companies/${CO_B}/logo`, RED);
      assert.deepEqual(await onDisk(), [red]);

      // A changes to a different picture. The old file is still B's, so it stays --
      // this is the case a per-tenant check would get wrong, and it would get it
      // wrong by deleting a mark another company is still showing.
      const blue = (await (await upload(base, `/api/platform/companies/${CO_A}/logo`, BLUE)).json()).logoKey;
      assert.notEqual(blue, red);
      assert.deepEqual(await onDisk(), [blue, red].sort());
      assert.equal((await fetchLogo(base, red)).status, 200);

      // Now B changes too. Nothing points at the red one any more, so it goes.
      await upload(base, `/api/platform/companies/${CO_B}/logo`, BLUE);
      assert.deepEqual(await onDisk(), [blue]);
      assert.equal((await fetchLogo(base, red)).status, 404);
    });
  });

  test("a branch wears the company's mark until it is given its own", async () => {
    await reset();
    const shops = require("../repositories/shops");
    const { withTenantScope } = require("../db");
    const tenant = createScope({
      kind: "tenant", userId: ADMIN, sessionId: SESSION_ID, companyId: CO_A,
      role: "platform_admin", shopIds: [SHOP_A], administeredShopIds: [SHOP_A]
    });

    await withServer(harness(store), async (base) => {
      const companyKey = (await (await upload(base, `/api/platform/companies/${CO_A}/logo`, RED)).json()).logoKey;

      // No mark of its own, and it still has one to draw. That is the fallback, and
      // it is computed by the statement that reads the row -- a stored copy would be
      // right until somebody changed the company's.
      let shop = await withTenantScope(tenant, () => shops.getShop(tenant, SHOP_A));
      assert.equal(shop.logoKey, null);
      assert.equal(shop.effectiveLogoKey, companyKey);

      // The exception: this branch trades under a different mark, because the name
      // that works at home does not work in the country it is in.
      const shopKey = (await (await upload(base, `/api/platform/shops/${SHOP_A}/logo`, BLUE)).json()).logoKey;
      shop = await withTenantScope(tenant, () => shops.getShop(tenant, SHOP_A));
      assert.equal(shop.logoKey, shopKey);
      assert.equal(shop.effectiveLogoKey, shopKey);

      // Taking the exception away puts the branch back under the company's mark, and
      // the file it was using goes with it.
      assert.equal((await clear(base, `/api/platform/shops/${SHOP_A}/logo`)).status, 200);
      shop = await withTenantScope(tenant, () => shops.getShop(tenant, SHOP_A));
      assert.equal(shop.logoKey, null);
      assert.equal(shop.effectiveLogoKey, companyKey);
      assert.deepEqual(await onDisk(), [companyKey]);

      // Changing the COMPANY's mark moves the branch with it, with nothing to update
      // on the branch at all.
      const next = (await (await upload(base, `/api/platform/companies/${CO_A}/logo`, BLUE)).json()).logoKey;
      shop = await withTenantScope(tenant, () => shops.getShop(tenant, SHOP_A));
      assert.equal(shop.effectiveLogoKey, next);
    });
  });

  test("the bytes decide what it is, not the header", async () => {
    await reset();
    await withServer(harness(store), async (base) => {
      // Content-Type says image/png on every one of these, because the header is a
      // claim by the caller and this is the one route where believing it puts a
      // chosen file on our disk under a chosen name.
      for (const body of [
        Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"),
        Buffer.from("GIF89a" + "x".repeat(40)),
        Buffer.from("%PDF-1.4\n%..."),
        Buffer.alloc(0)
      ]) {
        const refused = await upload(base, `/api/platform/companies/${CO_A}/logo`, body);
        assert.equal(refused.status, 422, body.slice(0, 8).toString("ascii"));
      }
      // ...and nothing was written for any of them.
      assert.deepEqual(await onDisk(), []);
    });
  });

  test("a key cannot walk out of the directory it is read from", async () => {
    await reset();
    await fs.writeFile(path.join(root, "..", "secret.txt"), "not a logo");
    await withServer(harness(store), async (base) => {
      for (const attempt of [
        "../secret.txt",
        "..%2Fsecret.txt",
        "%2e%2e%2fsecret.txt",
        "0".repeat(64) + ".exe",
        "0".repeat(63) + ".png"
      ]) {
        // 404 for every shape, the same answer a well-formed key that is simply not
        // there gets: §6.3.3, and here it also means the naming scheme cannot be
        // probed by watching which refusal comes back.
        assert.equal((await fetchLogo(base, attempt)).status, 404, attempt);
      }
    });
    await fs.rm(path.join(root, "..", "secret.txt"), { force: true });
  });

  test("a logo is public, cached forever, and served as what it is", async () => {
    await reset();
    await withServer(harness(store), async (base) => {
      const key = (await (await upload(base, `/api/platform/companies/${CO_A}/logo`, RED)).json()).logoKey;

      // No cookie: a table screen and a customer's menu carry no session, and the
      // same file is drawn on both.
      const response = await fetch(`${base}/api/logos/${key}`, { headers: { "X-Forwarded-For": "203.0.113.7" } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      // The name IS the content, so a key can never point at different bytes. This is
      // the one response in the service that is safe to cache forever.
      assert.match(response.headers.get("cache-control"), /immutable/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), RED);
    });
  });

  test("a company that does not exist is 404 and leaves nothing behind", async () => {
    await reset();
    await withServer(harness(store), async (base) => {
      const missing = "aaaaaaaa-0001-4000-8000-00000000ffff";
      assert.equal((await upload(base, `/api/platform/companies/${missing}/logo`, RED)).status, 404);
      // The bytes were written before the row was found to be absent -- and then
      // taken away again, because nothing references them.
      assert.deepEqual(await onDisk(), []);
    });
  });
});
