"use strict";

// Spec §6.2's platform-admins block. POST here is "the sole route in the system
// that creates a peer, and an explicit named exception to 'nobody creates at or
// above their own role'".
//
// The exception is justified rather than convenient: scripts/create-platform-admin.js
// is monotonic -- it refuses once a platform.admin_created row exists -- so a
// platform with one administrator would otherwise have no second recovery path,
// and §9.1 of the console design records the day that cost somebody raw SQL on
// the box with no audit trail and no guard rails.
//
// All five are roles:["platform"], the UNSCOPED platform admin. A platform admin
// who has selected a company is administering that company, not the platform.

const { route } = require("../router");
const { readJsonBody } = require("../body");
const { sendJson } = require("../respond");
const { ApiError } = require("../../db/errors");
const { withPlatformScope } = require("../../db");
const { hashPassword, generateInitialPassword } = require("../../lib/password");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const STATUSES = ["active", "suspended"];

function adminDocument(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    phone: row.phone,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt === null ? null : row.lastLoginAt.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function adminIdFrom(req) {
  if (!UUID_PATTERN.test(req.params.userId)) throw new ApiError(404, "not_found");
  return req.params.userId;
}

route(
  "GET",
  "/api/platform/admins",
  { auth: "user", roles: ["platform"], sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const url = new URL(req.originalUrl, "http://placeholder");
    const status = url.searchParams.get("status");
    const email = url.searchParams.get("email");

    if (status !== null && !STATUSES.includes(status)) {
      throw new ApiError(422, "validation_failed", [{ field: "status", code: "not_in_enum" }]);
    }

    const rows = await withPlatformScope(req.core.scope, () =>
      deps.platformAdmins.listPlatformAdmins(req.core.scope, { status, email })
    );
    sendJson(res, 200, { admins: rows.map(adminDocument) });
  }
);

route(
  "POST",
  "/api/platform/admins",
  {
    auth: "user",
    roles: ["platform"],
    body: { email: "string", displayName: "string", phone: "string?" },
    audit: "platform.admin_created",
    sample: { body: { email: "second@example.test", displayName: "Second Admin" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const body = await readJsonBody(req);
    const errors = [];

    const email = has(body, "email") && typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
    if (email === null) errors.push({ field: "email", code: "required" });
    else if (!EMAIL_PATTERN.test(email)) errors.push({ field: "email", code: "pattern" });

    const displayName = has(body, "displayName") && typeof body.displayName === "string"
      ? body.displayName.trim() : null;
    if (displayName === null) errors.push({ field: "displayName", code: "required" });
    else if (displayName.length === 0) errors.push({ field: "displayName", code: "too_short" });
    else if (displayName.length > 80) errors.push({ field: "displayName", code: "too_long" });

    const phone = has(body, "phone") ? body.phone : null;
    if (phone !== null && (typeof phone !== "string" || phone.trim().length === 0)) {
      errors.push({ field: "phone", code: "too_short" });
    }
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    const initialPassword = generateInitialPassword();
    const passwordHash = await hashPassword(initialPassword);

    const admin = await withPlatformScope(req.core.scope, async () => {
      const created = await deps.platformAdmins.createPlatformAdmin(req.core.scope, {
        email,
        displayName,
        phone: phone === null ? null : phone.trim(),
        passwordHash,
        createdByUserId: req.core.session.userId
      });
      await deps.platformAudit.appendPlatformAuditEvent(req.core.scope, {
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "platform.admin_created",
        outcome: "success",
        targetKind: "user",
        targetId: created.id,
        sourceIp: req.core.clientIp,
        detail: { email }
      });
      return created;
    });

    sendJson(res, 201, { ...adminDocument(admin), initialPassword }, {
      Location: `/api/platform/admins/${admin.id}`
    });
  }
);

route(
  "GET",
  "/api/platform/admins/:userId",
  { auth: "user", roles: ["platform"], params: { userId: "uuid" }, sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const userId = adminIdFrom(req);
    const admin = await withPlatformScope(req.core.scope, () =>
      deps.platformAdmins.getPlatformAdmin(req.core.scope, userId)
    );
    // Exists so every 201 Location is followable, and so §6.2's documented
    // lost-response repair (409 -> GET ?email= -> password-reset) is executable.
    if (admin === null) throw new ApiError(404, "not_found");
    sendJson(res, 200, adminDocument(admin));
  }
);

route(
  "PATCH",
  "/api/platform/admins/:userId",
  {
    auth: "user",
    roles: ["platform"],
    params: { userId: "uuid" },
    body: { displayName: "string?", phone: "string?", status: "string?" },
    audit: "platform.admin_updated",
    sample: { params: { userId: "00000000-0000-4000-8000-000000000000" }, body: { status: "suspended" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const userId = adminIdFrom(req);
    const body = await readJsonBody(req);
    const errors = [];

    const fields = ["displayName", "phone", "status"].filter((key) => has(body, key));
    if (fields.length === 0) throw new ApiError(400, "invalid_request");

    // §4C: the platform owner is the one person who may edit their own name,
    // because there is nobody above them to ask. Suspending yourself is a
    // different matter -- it is the lockout §9.1 has no answer for.
    if (userId === req.core.session.userId && has(body, "status")) {
      throw new ApiError(403, "self_modification_forbidden");
    }

    if (has(body, "displayName") && (typeof body.displayName !== "string" || body.displayName.trim().length === 0)) {
      errors.push({ field: "displayName", code: "too_short" });
    }
    if (has(body, "phone") && (typeof body.phone !== "string" || body.phone.trim().length === 0)) {
      errors.push({ field: "phone", code: "too_short" });
    }
    if (has(body, "status") && !STATUSES.includes(body.status)) {
      errors.push({ field: "status", code: "not_in_enum" });
    }
    // role is not patchable here or anywhere (§6.2). Named rather than ignored, so
    // a caller who tries learns why instead of watching it silently do nothing.
    if (has(body, "role")) errors.push({ field: "role", code: "immutable" });
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    const result = await withPlatformScope(req.core.scope, async () => {
      const updated = await deps.platformAdmins.updatePlatformAdmin(req.core.scope, userId, {
        displayName: has(body, "displayName") ? body.displayName.trim() : null,
        phone: has(body, "phone") ? body.phone.trim() : null,
        status: has(body, "status") ? body.status : null
      });
      if (updated === null || updated === "last_platform_admin") return updated;
      await deps.platformAudit.appendPlatformAuditEvent(req.core.scope, {
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "platform.admin_updated",
        outcome: "success",
        targetKind: "user",
        targetId: userId,
        sourceIp: req.core.clientIp,
        detail: { status: updated.status }
      });
      return updated;
    });

    // The refusal that keeps the platform reachable. §9.1: a platform admin has
    // nobody above them, so suspending the last active one is a door locked from
    // the inside with the key still in it.
    if (result === "last_platform_admin") throw new ApiError(409, "last_platform_admin");
    if (result === null) throw new ApiError(404, "not_found");
    sendJson(res, 200, adminDocument(result));
  }
);

route(
  "POST",
  "/api/platform/admins/:userId/password-reset",
  {
    auth: "user",
    roles: ["platform"],
    params: { userId: "uuid" },
    body: null,
    audit: "platform.admin_password_reset",
    sample: { params: { userId: "00000000-0000-4000-8000-000000000000" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const userId = adminIdFrom(req);
    // Your own password is changed through the account route, which asks for the
    // current one. This route hands a NEW password to somebody else, and using it
    // on yourself would be a way to skip that question.
    if (userId === req.core.session.userId) throw new ApiError(403, "self_modification_forbidden");

    const initialPassword = generateInitialPassword();
    const passwordHash = await hashPassword(initialPassword);

    const admin = await withPlatformScope(req.core.scope, async () => {
      const updated = await deps.platformAdmins.resetPlatformAdminPassword(req.core.scope, userId, passwordHash);
      if (updated === null) return null;
      await deps.platformAudit.appendPlatformAuditEvent(req.core.scope, {
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "platform.admin_password_reset",
        outcome: "success",
        targetKind: "user",
        targetId: userId,
        sourceIp: req.core.clientIp
      });
      return updated;
    });

    if (admin === null) throw new ApiError(404, "not_found");
    // Mints a password AND clears failed_login_count/locked_until. §6.2: "there is
    // no separate unlock route: the remedy that helps a locked-out operator is a
    // working password."
    sendJson(res, 200, { ...adminDocument(admin), initialPassword });
  }
);
