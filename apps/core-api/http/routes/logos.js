"use strict";

// A mark for a company, and a different one for the branches that need it.
//
// WHY A BRANCH GETS ITS OWN. A chain does not always trade under one name. The name
// that works at home can be unusable in another country -- wrong reading, wrong
// connotation, already taken -- so the Bangkok branch of a Yangon chain may need a
// different mark on its receipts and its table screens. The company's is the rule;
// the branch's is the exception, and an exception that cannot be expressed means the
// branch quietly prints the wrong thing.
//
// The company's is REQUIRED and the branch's is OPTIONAL, and "which one does this
// branch use" is resolved when the row is read: its own if it has one, the company's
// otherwise. Never stored -- a stored copy is right until somebody changes the
// company's.
//
// BOTH ARE THE PLATFORM OWNER'S, which is why both live here rather than beside the
// shop routes. They fit the branches out, and the mark on the table screen is part of
// that. `roles: ["platform"]` throughout: these are reached from the Companies screen,
// where the platform owner is above every company and inside none.
//
// THE UPLOAD IS A RAW BODY, not multipart. A logo is one file with no fields beside
// it, so `PUT` with the bytes and an image Content-Type says everything multipart
// would -- and it needs no parser, which means no dependency and no second place for
// a filename to arrive from. The type is decided by SNIFFING the bytes anyway; the
// header is a claim by the caller and is not believed.

const { route } = require("../router");
const { sendJson } = require("../respond");
const { ApiError } = require("../../db/errors");
const { withPlatformScope } = require("../../db");
const { LogoError, isKey, contentTypeFor, MAX_BYTES } = require("../../storage/logo-store");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read the body into memory with the cap enforced AS IT ARRIVES rather than after.
// Waiting until the end to measure means a caller can spend our memory first and be
// refused second, which is the wrong order for the one route that accepts megabytes.
function readImageBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        // 413, and the connection is destroyed rather than drained: there is no
        // reason to keep receiving a body that is already too big.
        reject(new ApiError(413, "payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ONE place that turns a storage refusal into an HTTP answer, so "not a PNG" reads
// the same whichever route the bytes came in through.
function asApiError(error) {
  if (!(error instanceof LogoError)) return error;
  if (error.code === "too_large") return new ApiError(413, "payload_too_large");
  return new ApiError(422, "validation_failed", [{ field: "logo", code: "type" }]);
}

// THE CLEANUP, and the order is the whole of it.
//
// The new key is committed FIRST, then the old one is asked about. Doing it the other
// way -- delete, then write -- has a window where the record points at a file that is
// gone. This way the worst case is a file nobody references, which the next upload of
// the same image simply reuses.
//
// "Nobody references it" spans every company and every shop, because the key is the
// hash of the bytes: two companies that uploaded the same picture share one file, and
// a check scoped to one of them would delete the other's mark.
async function forgetIfUnused(scope, deps, oldKey, newKey) {
  if (!oldKey || oldKey === newKey) return;
  const stillUsed = await withPlatformScope(scope, () => deps.logos.isReferenced(scope, oldKey));
  if (stillUsed) return;
  await deps.logoStore.remove(oldKey);
}

function idFrom(value) {
  if (!UUID_PATTERN.test(value)) throw new ApiError(404, "not_found");
  return value;
}

// ---------------------------------------------------------------------------
// PUT /api/platform/companies/:companyId/logo
// ---------------------------------------------------------------------------

route(
  "PUT",
  "/api/platform/companies/:companyId/logo",
  {
    auth: "user",
    roles: ["platform"],
    params: { companyId: "uuid" },
    // No JSON body to declare: the body IS the image. `null` is the honest answer to
    // "what shape of JSON does this take", and it takes none -- and `accepts` is how
    // the Origin gate is told that, so it asks for image/png rather than for JSON.
    body: null,
    accepts: "image",
    audit: "company.updated",
    sample: { params: { companyId: "00000000-0000-4000-8000-000000000000" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const scope = req.core.scope;
    const companyId = idFrom(req.params.companyId);

    const bytes = await readImageBody(req);
    let key;
    try {
      key = await deps.logoStore.save(bytes);
    } catch (error) {
      throw asApiError(error);
    }

    const previous = await withPlatformScope(scope, async () => {
      const before = await deps.logos.getCompanyLogo(scope, companyId);
      if (before === null) return null;
      await deps.logos.setCompanyLogo(scope, companyId, key);
      await deps.platformAudit.appendPlatformAuditEvent(scope, {
        companyId,
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "company.updated",
        outcome: "success",
        targetKind: "company",
        targetId: companyId,
        sourceIp: req.core.clientIp,
        detail: { logo: "set" }
      });
      return before;
    });

    // A 404 AFTER the file was written, and that is not a leak: the bytes were the
    // caller's own, the name is their hash, and nothing references it -- so the next
    // sweep or the next upload of the same picture is the only trace.
    if (previous === null) {
      await forgetIfUnused(scope, deps, key, null);
      throw new ApiError(404, "not_found");
    }

    await forgetIfUnused(scope, deps, previous.logoKey, key);
    sendJson(res, 200, { logoKey: key });
  }
);

// ---------------------------------------------------------------------------
// PUT /api/platform/shops/:shopId/logo   -- and DELETE, because this one is optional
// ---------------------------------------------------------------------------

route(
  "PUT",
  "/api/platform/shops/:shopId/logo",
  {
    auth: "user",
    roles: ["platform"],
    params: { shopId: "uuid" },
    body: null,
    accepts: "image",
    audit: "shop.updated",
    sample: { params: { shopId: "00000000-0000-4000-8000-000000000000" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const scope = req.core.scope;
    const shopId = idFrom(req.params.shopId);

    const bytes = await readImageBody(req);
    let key;
    try {
      key = await deps.logoStore.save(bytes);
    } catch (error) {
      throw asApiError(error);
    }

    const previous = await withPlatformScope(scope, async () => {
      const before = await deps.logos.getShopLogo(scope, shopId);
      if (before === null) return null;
      await deps.logos.setShopLogo(scope, shopId, key);
      await deps.platformAudit.appendPlatformAuditEvent(scope, {
        companyId: before.companyId,
        shopId,
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "shop.updated",
        outcome: "success",
        targetKind: "shop",
        targetId: shopId,
        sourceIp: req.core.clientIp,
        detail: { logo: "set" }
      });
      return before;
    });

    if (previous === null) {
      await forgetIfUnused(scope, deps, key, null);
      throw new ApiError(404, "not_found");
    }

    await forgetIfUnused(scope, deps, previous.logoKey, key);
    sendJson(res, 200, { logoKey: key });
  }
);

// A branch's logo is the exception, so taking it away is a real action: the branch
// goes back to wearing the company's. There is deliberately no matching route for a
// company, because a company without a mark is the state §4E calls incomplete.
route(
  "DELETE",
  "/api/platform/shops/:shopId/logo",
  {
    auth: "user",
    roles: ["platform"],
    params: { shopId: "uuid" },
    body: null,
    audit: "shop.updated",
    sample: { params: { shopId: "00000000-0000-4000-8000-000000000000" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const scope = req.core.scope;
    const shopId = idFrom(req.params.shopId);

    const previous = await withPlatformScope(scope, async () => {
      const before = await deps.logos.getShopLogo(scope, shopId);
      if (before === null) return null;
      await deps.logos.setShopLogo(scope, shopId, null);
      await deps.platformAudit.appendPlatformAuditEvent(scope, {
        companyId: before.companyId,
        shopId,
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "shop.updated",
        outcome: "success",
        targetKind: "shop",
        targetId: shopId,
        sourceIp: req.core.clientIp,
        detail: { logo: "cleared" }
      });
      return before;
    });

    if (previous === null) throw new ApiError(404, "not_found");
    await forgetIfUnused(scope, deps, previous.logoKey, null);
    sendJson(res, 200, { logoKey: null });
  }
);

// ---------------------------------------------------------------------------
// GET /api/logos/:key
// ---------------------------------------------------------------------------

// PUBLIC, and it has to be. The same file is drawn on a table screen and at the top
// of a customer's menu, neither of which carries a session -- and a logo is a mark a
// business puts on its own front door. The key is the hash of the bytes, so it names
// nothing and enumerates nothing: you cannot ask for a logo you have not already been
// told the name of.
route(
  "GET",
  "/api/logos/:key",
  { auth: "public", params: { key: "string" }, sample: { params: { key: "0".repeat(64) + ".png" } } },
  async (req, res) => {
    const deps = req.core.deps;
    const key = req.params.key;
    // 404 rather than 400 for a malformed key, the same answer as a key that is well
    // formed and absent -- §6.3.3's rule, and here it also means the shape of the
    // name cannot be probed.
    if (!isKey(key)) throw new ApiError(404, "not_found");

    const bytes = await deps.logoStore.read(key);
    if (bytes === null) throw new ApiError(404, "not_found");

    // IMMUTABLE, because the name IS the content. A key can never point at different
    // bytes, so this is the one response in the service that is safe to cache
    // forever -- and it is the one that would otherwise be re-fetched on every table
    // screen refresh.
    res.setHeader("Content-Type", contentTypeFor(key));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Length", String(bytes.length));
    res.statusCode = 200;
    res.end(bytes);
  }
);
