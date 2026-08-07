"use strict";

// Spec §6.2's shops block, reshaped by the admin-console design.
//
// The reshaping is the whole point of this file, and it is one sentence: the shop
// RECORD belongs to the platform owner, and the CEO owns the people in it. So
// POST and PATCH declare `platformScoped` -- a platform admin acting inside a
// company, and NOT that company's own admin -- while reading stays open to
// everybody who works there.
//
// §6.2 wrote POST and PATCH as `companyAdmin`. That alias admits both the operator
// and the CEO, which is precisely the distinction the console change turns on, so
// this is a DEPARTURE and it is deliberate. The console design's §2 has the
// argument: fitting out a branch is tables, e-paper screens and printed QR codes,
// and a CEO opening one had no way to do any of it.

const { route } = require("../router");
const { readJsonBody } = require("../body");
const { sendJson } = require("../respond");
const { ApiError } = require("../../db/errors");
const { withTenantScope } = require("../../db");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The DDL's expression, character for character (0003_admin_console.sql). Three
// copies of this rule exist -- the CHECK, this line and the console's validator --
// and they are only correct while they are identical.
const SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const LANGUAGE_PATTERN = /^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/;
const STATUSES = ["active", "suspended"];
const LIST_STATUSES = ["active", "suspended", "all"];
// §4A.2's cap, and the console offers the same number. A branch with more than
// this many tables is a data-entry accident, and creating them is not free.
const TABLES_MAX = 200;

function shopDocument(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    address: row.address,
    timeZone: row.timeZone,
    businessDayRolloverHour: row.businessDayRolloverHour,
    currency: row.currency,
    language: row.language,
    phone: row.phone,
    openingHours: row.openingHours,
    receiptFooter: row.receiptFooter,
    runByOwner: row.runByOwner,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    // Summed from the tables, the way a company's counts are summed from its shops.
    // The console prints it on every branch row and nothing anywhere stores it.
    tableCount: row.tableCount,
    // An id and a count, never a name: a platform admin acting inside a company
    // reads this document, and they do not see the people in it.
    managerUserId: row.managerUserId,
    staffCount: row.staffCount
  };
}

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

// One validator per field, each pushing into a shared array so every failure is
// reported at once (spec §6.3.5 step 11). Returning null on failure is safe: the
// caller throws before any null reaches a repository.
function text(body, field, errors, { required, max, pattern, trim = true }) {
  if (!has(body, field)) {
    if (required) errors.push({ field, code: "required" });
    return null;
  }
  const raw = body[field];
  if (typeof raw !== "string") {
    errors.push({ field, code: "type" });
    return null;
  }
  const value = trim ? raw.trim() : raw;
  if (value.length === 0) {
    errors.push({ field, code: "too_short" });
    return null;
  }
  if (max !== undefined && value.length > max) {
    errors.push({ field, code: "too_long" });
    return null;
  }
  if (pattern !== undefined && !pattern.test(value)) {
    errors.push({ field, code: "pattern" });
    return null;
  }
  return value;
}

function integer(body, field, errors, { required, min, max }) {
  if (!has(body, field)) {
    if (required) errors.push({ field, code: "required" });
    return null;
  }
  const value = body[field];
  if (!Number.isInteger(value)) {
    errors.push({ field, code: "type" });
    return null;
  }
  if (value < min || value > max) {
    errors.push({ field, code: "out_of_range" });
    return null;
  }
  return value;
}

function enumerated(body, field, errors, allowed) {
  if (!has(body, field)) return null;
  if (typeof body[field] !== "string" || !allowed.includes(body[field])) {
    errors.push({ field, code: "not_in_enum" });
    return null;
  }
  return body[field];
}

// A time zone is validated by asking the platform, not by a list this file would
// have to keep up to date. Intl throws RangeError on an unknown zone, which is the
// only reliable check available and the one the repository comment promises.
function timeZone(body, field, errors, { required }) {
  const value = text(body, field, errors, { required, max: 64 });
  if (value === null) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
  } catch (error) {
    errors.push({ field, code: "invalid_time_zone" });
    return null;
  }
  return value;
}

function shopIdFrom(req) {
  // 404, never 422: a malformed path segment cannot name a resource, and a typed
  // refusal would confirm that a real one exists at a real id (§6.3.3).
  if (!UUID_PATTERN.test(req.params.shopId)) throw new ApiError(404, "not_found");
  return req.params.shopId;
}

route(
  "GET",
  "/api/admin/shops",
  { auth: "user", roles: ["anyUser"], sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const url = new URL(req.originalUrl, "http://placeholder");
    const status = url.searchParams.get("status");

    if (status !== null && !LIST_STATUSES.includes(status)) {
      throw new ApiError(422, "validation_failed", [{ field: "status", code: "not_in_enum" }]);
    }

    const rows = await withTenantScope(req.core.scope, () =>
      deps.shops.listShops(req.core.scope, {
        status: status === null || status === "all" ? null : status
      })
    );
    sendJson(res, 200, { shops: rows.map(shopDocument) });
  }
);

route(
  "POST",
  "/api/admin/shops",
  {
    auth: "user",
    // The departure. See the header: `companyAdmin` would admit the CEO, and
    // opening a branch is not theirs any more.
    roles: ["platformScoped"],
    body: {
      name: "string",
      slug: "string",
      address: "string?",
      timeZone: "string",
      businessDayRolloverHour: "integer",
      currency: "string",
      language: "string",
      tableCount: "integer"
    },
    audit: "shop.created",
    sample: {
      body: {
        name: "Bogyoke",
        slug: "bogyoke",
        timeZone: "Asia/Yangon",
        businessDayRolloverHour: 6,
        currency: "MMK",
        language: "my",
        tableCount: 12
      }
    }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const body = await readJsonBody(req);
    const errors = [];

    const name = text(body, "name", errors, { required: true, max: 120 });
    // Never trimmed: a slug with a space in it is wrong, not nearly right, and
    // repairing it means the address the caller was shown is not the one stored.
    const slug = text(body, "slug", errors, { required: true, max: 24, pattern: SLUG_PATTERN, trim: false });
    if (slug !== null && slug.length < 2) errors.push({ field: "slug", code: "too_short" });
    const address = has(body, "address") ? text(body, "address", errors, { required: false, max: 200 }) : null;
    const zone = timeZone(body, "timeZone", errors, { required: true });
    const rollover = integer(body, "businessDayRolloverHour", errors, { required: true, min: 0, max: 23 });
    const currency = text(body, "currency", errors, { required: true, max: 3, pattern: CURRENCY_PATTERN });
    const language = text(body, "language", errors, { required: true, max: 35, pattern: LANGUAGE_PATTERN });
    // §4A.2: the number CREATES the tables, so zero is legal and means "none yet".
    const tableCount = integer(body, "tableCount", errors, { required: true, min: 0, max: TABLES_MAX });

    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    // The shop, its tables and the audit row in ONE transaction. A branch whose
    // table count created no tables would be a lie told by the number somebody
    // typed, and an audit row for a rolled-back shop would be worse.
    const shop = await withTenantScope(req.core.scope, async () => {
      const created = await deps.shops.createShop(req.core.scope, {
        name,
        slug,
        address,
        timeZone: zone,
        businessDayRolloverHour: rollover,
        currency,
        language,
        tableCount,
        createdByUserId: req.core.session.userId
      });
      await deps.tenantAudit.appendTenantAuditEvent(req.core.scope, {
        shopId: created.id,
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "shop.created",
        outcome: "success",
        targetKind: "shop",
        targetId: created.id,
        sourceIp: req.core.clientIp,
        detail: { name: created.name, slug: created.slug, timeZone: created.timeZone, tableCount }
      });
      return created;
    });

    sendJson(res, 201, shopDocument(shop), { Location: `/api/admin/shops/${shop.id}` });
  }
);

route(
  "GET",
  "/api/admin/shops/:shopId",
  { auth: "user", roles: ["anyUser"], params: { shopId: "uuid" }, sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const shopId = shopIdFrom(req);
    const shop = await withTenantScope(req.core.scope, () => deps.shops.getShop(req.core.scope, shopId));
    // "Exists but not yours" and "does not exist" are one answer, produced by the
    // same zero rows -- the scope's shop ids are in the predicate, so there is no
    // second read that could tell them apart even if somebody wanted to.
    if (shop === null) throw new ApiError(404, "not_found");
    sendJson(res, 200, shopDocument(shop));
  }
);

route(
  "PATCH",
  "/api/admin/shops/:shopId/day-to-day",
  {
    auth: "user",
    // The manager alias, so a shop_manager reaches it -- containment then limits
    // them to the shops they are actually assigned to, because getShop below is
    // driven by their scope.
    roles: ["manager"],
    params: { shopId: "uuid" },
    body: { phone: "string?", openingHours: "string?", receiptFooter: "string?" },
    audit: "shop.day_to_day_updated",
    sample: { params: { shopId: "00000000-0000-4000-8000-000000000000" }, body: { phone: "09 77 123 4567" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const shopId = shopIdFrom(req);

    // The platform owner opens the branch and does not run it. They set the
    // country facts; the phone on the receipt belongs to whoever answers it.
    if (req.core.scope.role === "platform_admin") throw new ApiError(403, "forbidden");

    const body = await readJsonBody(req);
    const errors = [];
    const fields = ["phone", "openingHours", "receiptFooter"].filter((key) => has(body, key));
    if (fields.length === 0) throw new ApiError(400, "invalid_request");

    // null is a VALUE here, and it means "there is no such thing" -- a shop with no
    // second phone number, a receipt with no footer. Refusing an empty box as
    // too_short left no way to undo a wrong one, and because the console recomputes
    // the patch from all three fields on every blur, the refused one was re-sent
    // with the next edit and blocked the other two.
    for (const [field, max] of [["phone", 40], ["openingHours", 120], ["receiptFooter", 200]]) {
      if (!has(body, field)) continue;
      if (body[field] === null) continue;
      if (typeof body[field] !== "string") {
        errors.push({ field, code: "type" });
      } else if (body[field].trim().length === 0) {
        // An empty STRING is not the way to erase one -- null is. Two spellings of
        // "make this go away" is how a client ends up storing "" in one place and
        // NULL in another, and every reader has to know both.
        errors.push({ field, code: "empty" });
      } else if (body[field].trim().length > max) {
        errors.push({ field, code: "too_long" });
      }
    }
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    const result = await withTenantScope(req.core.scope, async () => {
      const shop = await deps.shops.getShop(req.core.scope, shopId);
      if (shop === null) return { shop: null };

      // §3.1B: these three are the CEO's ONLY while no manager owns them, and they
      // "disappear the moment a manager is named, because that is the moment those
      // fields stop being the CEO's". Enforced here and not only in the console: a
      // screen that hides a control is a courtesy, and a route that refuses the
      // write is the rule.
      if (req.core.scope.administeredShopIds !== undefined) {
        const manager = await deps.shops.getShopManager(req.core.scope, shopId);
        if (manager !== null) return { shop: null, refusal: "has_a_manager" };
      }

      // PRESENT-FLAG plus value, because null now has to mean two different things
      // depending on whether the key was there: absent is "leave it", present-null
      // is "erase it". One nullable argument cannot carry both.
      const trimmed = (key) => (body[key] === null ? null : String(body[key]).trim());
      const updated = await deps.shops.updateShopDayToDay(req.core.scope, shopId, {
        setPhone: has(body, "phone"),
        phone: has(body, "phone") ? trimmed("phone") : null,
        setOpeningHours: has(body, "openingHours"),
        openingHours: has(body, "openingHours") ? trimmed("openingHours") : null,
        setReceiptFooter: has(body, "receiptFooter"),
        receiptFooter: has(body, "receiptFooter") ? trimmed("receiptFooter") : null
      });
      await deps.tenantAudit.appendTenantAuditEvent(req.core.scope, {
        shopId,
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "shop.day_to_day_updated",
        outcome: "success",
        targetKind: "shop",
        targetId: shopId,
        sourceIp: req.core.clientIp,
        detail: { fields: fields.join(",") }
      });
      return { shop: updated };
    });

    if (result.refusal === "has_a_manager") throw new ApiError(403, "forbidden");
    if (result.shop === null) throw new ApiError(404, "not_found");
    sendJson(res, 200, shopDocument(result.shop));
  }
);

route(
  "PUT",
  "/api/admin/shops/:shopId/manager",
  {
    auth: "user",
    // companyAdmin is the narrowest existing alias that contains the CEO. It also
    // contains a platform admin acting inside the company, and the handler refuses
    // that below -- see there for why this is a handler check and not a sixth alias.
    roles: ["companyAdmin"],
    params: { shopId: "uuid" },
    body: { managerUserId: "uuid|null", runByOwner: "boolean?", outgoing: "string?" },
    audit: "shop.manager_changed",
    sample: {
      params: { shopId: "00000000-0000-4000-8000-000000000000" },
      body: { managerUserId: null, runByOwner: true }
    }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const shopId = shopIdFrom(req);

    // The platform owner may open a branch and may not staff it. §6 of the console
    // design is built on their never seeing a person inside a company, and a route
    // that takes a user id would be the one place that leaked -- "is this id one of
    // yours?" answered by the difference between 404 and 200.
    //
    // A handler check rather than a sixth role alias: this is the only route in the
    // service that wants "company_admin and not the operator", and the codebase
    // already answers a one-route role question this way (POST /api/admin/scope
    // tests session.role in its handler for the mirror-image reason).
    if (req.core.scope.role === "platform_admin") throw new ApiError(403, "forbidden");

    const body = await readJsonBody(req);
    const errors = [];

    // REQUIRED and explicitly NULLABLE. {} and {"managerUserId": null} are two
    // different requests: one is a mistake, the other empties the slot.
    if (!has(body, "managerUserId")) {
      errors.push({ field: "managerUserId", code: "required" });
    } else if (body.managerUserId !== null && !UUID_PATTERN.test(String(body.managerUserId))) {
      errors.push({ field: "managerUserId", code: "invalid_uuid" });
    }
    if (has(body, "runByOwner") && typeof body.runByOwner !== "boolean") {
      errors.push({ field: "runByOwner", code: "type" });
    }
    if (has(body, "outgoing") && !["staff", "suspend"].includes(body.outgoing)) {
      errors.push({ field: "outgoing", code: "not_in_enum" });
    }
    // The invariant 0003 could not write as a CHECK, refused here rather than
    // silently resolved: a shop is owner-run or it has a manager, never both.
    if (body.managerUserId != null && body.runByOwner === true) {
      errors.push({ field: "runByOwner", code: "immutable" });
    }
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    const result = await withTenantScope(req.core.scope, async () => {
      const shop = await deps.shops.getShop(req.core.scope, shopId);
      if (shop === null) return { shop: null };

      if (body.managerUserId !== null) {
        // Read before write, so "no such person" and "somebody else's person" are
        // one 404 rather than a foreign-key violation arriving as a 500.
        const member = await deps.shops.findCompanyMember(req.core.scope, body.managerUserId);
        if (member === null) return { shop: null };
        if (member.status !== "active") return { shop: null, refusal: "suspended_candidate" };
      }

      const outgoing = await deps.shops.getShopManager(req.core.scope, shopId);
      const updated = await deps.shops.setShopManager(req.core.scope, shopId, {
        managerUserId: body.managerUserId,
        runByOwner: body.runByOwner === true,
        outgoing: body.outgoing === "suspend" ? "suspend" : "staff"
      });
      await deps.tenantAudit.appendTenantAuditEvent(req.core.scope, {
        shopId,
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "shop.manager_changed",
        outcome: "success",
        targetKind: "shop",
        targetId: shopId,
        sourceIp: req.core.clientIp,
        detail: {
          managerUserId: body.managerUserId,
          runByOwner: updated.runByOwner,
          replacedUserId: outgoing === null ? null : outgoing.id
        }
      });
      return { shop: updated };
    });

    if (result.refusal === "suspended_candidate") {
      // A suspended person cannot sign in, so appointing them would leave the shop
      // being run by an account that cannot reach it -- the same failure §3.2's
      // suspension rule exists to prevent, arrived at from the other direction.
      throw new ApiError(409, "role_not_shop_assignable");
    }
    if (result.shop === null) throw new ApiError(404, "not_found");
    sendJson(res, 200, shopDocument(result.shop));
  }
);

route(
  "PATCH",
  "/api/admin/shops/:shopId",
  {
    auth: "user",
    roles: ["platformScoped"],
    params: { shopId: "uuid" },
    body: {
      name: "string?",
      slug: "string?",
      address: "string?",
      timeZone: "string?",
      businessDayRolloverHour: "integer?",
      currency: "string?",
      language: "string?",
      status: "string?"
    },
    audit: "shop.updated",
    sample: { params: { shopId: "00000000-0000-4000-8000-000000000000" }, body: { name: "Bogyoke" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const shopId = shopIdFrom(req);
    const body = await readJsonBody(req);
    const errors = [];

    const changes = {
      name: has(body, "name") ? text(body, "name", errors, { required: false, max: 120 }) : null,
      slug: has(body, "slug")
        ? text(body, "slug", errors, { required: false, max: 24, pattern: SLUG_PATTERN, trim: false })
        : null,
      address: has(body, "address") ? text(body, "address", errors, { required: false, max: 200 }) : null,
      timeZone: has(body, "timeZone") ? timeZone(body, "timeZone", errors, { required: false }) : null,
      businessDayRolloverHour: has(body, "businessDayRolloverHour")
        ? integer(body, "businessDayRolloverHour", errors, { required: false, min: 0, max: 23 })
        : null,
      currency: has(body, "currency")
        ? text(body, "currency", errors, { required: false, max: 3, pattern: CURRENCY_PATTERN })
        : null,
      language: has(body, "language")
        ? text(body, "language", errors, { required: false, max: 35, pattern: LANGUAGE_PATTERN })
        : null,
      status: enumerated(body, "status", errors, STATUSES)
    };
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);
    if (Object.values(changes).every((value) => value === null)) {
      throw new ApiError(400, "invalid_request");
    }

    const shop = await withTenantScope(req.core.scope, async () => {
      const updated = await deps.shops.updateShop(req.core.scope, shopId, changes);
      if (updated === null) return null;
      await deps.tenantAudit.appendTenantAuditEvent(req.core.scope, {
        shopId: updated.id,
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "shop.updated",
        outcome: "success",
        targetKind: "shop",
        targetId: updated.id,
        sourceIp: req.core.clientIp,
        detail: { name: updated.name, slug: updated.slug, status: updated.status }
      });
      return updated;
    });

    if (shop === null) throw new ApiError(404, "not_found");
    sendJson(res, 200, shopDocument(shop));
  }
);
