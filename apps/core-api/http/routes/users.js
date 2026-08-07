"use strict";

// Spec §6.2's user block: the people inside one company, administered by whoever
// is one level above them.
//
// The two rules that shape every handler here live in lib/authorization.js, not in
// this file: the rank lattice (an actor may only touch a user STRICTLY below their
// own role) and shop containment (a manager administers the staff of the shops
// they are assigned to, and nobody else). They are pure, they are unit-tested by
// name, and a handler that re-implemented either would be the copy that drifts.

const { route } = require("../router");
const { readJsonBody } = require("../body");
const { sendJson } = require("../respond");
const { ApiError } = require("../../db/errors");
const { withTenantScope } = require("../../db");
const { mayActOnRole, permitsSelfPatch, permits } = require("../../lib/authorization");
const { hashPassword, generateInitialPassword } = require("../../lib/password");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LANGUAGE_PATTERN = /^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/;
// platform_admin is deliberately absent: users.company_id would have to be NULL,
// which users_platform_admin_has_no_company forbids for a tenant row. A platform
// admin is created by POST /api/platform/admins and nowhere else.
const ASSIGNABLE_ROLES = ["staff", "shop_manager", "company_admin"];
const SHOP_ASSIGNABLE_ROLES = ["staff", "shop_manager"];
const STATUSES = ["active", "suspended"];
// `all` is not a status a user can be IN. It is the spelling of "do not filter",
// and it exists because the shops and companies lists already take it -- a console
// that has to remember which of three lists wants the parameter omitted instead is
// a console that gets it wrong on one of them.
const LIST_STATUSES = ["active", "suspended", "all"];

function userDocument(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    phone: row.phone,
    role: row.role,
    status: row.status,
    language: row.language,
    shopIds: row.shopIds,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt === null ? null : row.lastLoginAt.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function userIdFrom(req) {
  if (!UUID_PATTERN.test(req.params.userId)) throw new ApiError(404, "not_found");
  return req.params.userId;
}

// §6.2: shopIds is required and non-empty for shop_manager and staff. "A
// zero-assignment tenant user reaches nothing AND is untouchable by any
// shop_manager" -- a person who exists, cannot work, and cannot be found by the
// only people who would notice.
function validateShopIds(value, role, errors, { required }) {
  if (value === undefined) {
    if (required && SHOP_ASSIGNABLE_ROLES.includes(role)) {
      errors.push({ field: "shopIds", code: "required" });
    }
    return undefined;
  }
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
    errors.push({ field: "shopIds", code: "invalid_uuid" });
    return undefined;
  }
  if (SHOP_ASSIGNABLE_ROLES.includes(role) && value.length === 0) {
    errors.push({ field: "shopIds", code: "too_short" });
    return undefined;
  }
  // A company_admin is company-wide; an assignment row for one would be a claim
  // about their reach that nothing reads.
  if (!SHOP_ASSIGNABLE_ROLES.includes(role) && value.length > 0) {
    errors.push({ field: "shopIds", code: "not_in_enum" });
    return undefined;
  }
  return value;
}

route(
  "GET",
  "/api/admin/users",
  { auth: "user", roles: ["manager"], sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const url = new URL(req.originalUrl, "http://placeholder");
    const role = url.searchParams.get("role");
    const status = url.searchParams.get("status");

    const errors = [];
    if (role !== null && !ASSIGNABLE_ROLES.includes(role)) errors.push({ field: "role", code: "not_in_enum" });
    if (status !== null && !LIST_STATUSES.includes(status)) errors.push({ field: "status", code: "not_in_enum" });
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    const rows = await withTenantScope(req.core.scope, () =>
      deps.tenantUsers.listUsers(req.core.scope, { role, status: status === "all" ? null : status })
    );
    sendJson(res, 200, { users: rows.map(userDocument) });
  }
);

route(
  "POST",
  "/api/admin/users",
  {
    auth: "user",
    roles: ["manager"],
    body: {
      email: "string",
      displayName: "string",
      phone: "string",
      role: "string",
      shopIds: "uuid[]?",
      language: "string?"
    },
    audit: "user.created",
    sample: {
      body: {
        email: "aye@example.test",
        displayName: "Aye Aye Mon",
        phone: "09 42 118 9021",
        role: "staff",
        shopIds: ["00000000-0000-4000-8000-000000000000"]
      }
    }
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

    // §4A.4: required on every person. "In a restaurant the phone is how you
    // actually reach someone; the email address is only how the system recognises
    // them." The column is nullable because rows predate the rule; the API is
    // where the rule starts.
    const phone = has(body, "phone") && typeof body.phone === "string" ? body.phone.trim() : null;
    if (phone === null || phone.length === 0) errors.push({ field: "phone", code: "required" });

    const role = has(body, "role") ? body.role : null;
    if (role === null) errors.push({ field: "role", code: "required" });
    else if (!ASSIGNABLE_ROLES.includes(role)) errors.push({ field: "role", code: "not_in_enum" });

    const language = has(body, "language") ? body.language : undefined;
    if (language !== undefined && language !== null && !LANGUAGE_PATTERN.test(String(language))) {
      errors.push({ field: "language", code: "pattern" });
    }
    const shopIds = validateShopIds(has(body, "shopIds") ? body.shopIds : undefined, role, errors, { required: true });
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    // The lattice, checked before anything is hashed or written. Strictly below,
    // so a company_admin cannot mint a second company_admin and a shop_manager
    // cannot mint anybody but staff.
    if (!mayActOnRole(req.core.scope.role, role)) throw new ApiError(403, "forbidden");

    // Read out loud, never mailed: this system has no mail server (§5.1).
    const initialPassword = generateInitialPassword();
    const passwordHash = await hashPassword(initialPassword);

    const user = await withTenantScope(req.core.scope, async () => {
      const created = await deps.tenantUsers.createUser(req.core.scope, {
        email, displayName, phone, role, language,
        shopIds: shopIds || [],
        passwordHash,
        createdByUserId: req.core.session.userId
      });
      await deps.tenantAudit.appendTenantAuditEvent(req.core.scope, {
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "user.created",
        outcome: "success",
        targetKind: "user",
        targetId: created.id,
        sourceIp: req.core.clientIp,
        detail: { email, role }
      });
      return created;
    });

    // The ONLY response that carries it. There is no route that reads a password
    // back, so a lost create response is repaired with a password reset -- which
    // is why that route exists.
    sendJson(res, 201, { ...userDocument(user), initialPassword }, {
      Location: `/api/admin/users/${user.id}`
    });
  }
);

route(
  "GET",
  "/api/admin/users/:userId",
  // anyUser, not manager. Everybody reads their OWN record -- it is what Account
  // settings draws -- and a member of staff, whose whole console is a dashboard and
  // their own account, could not read it at all. The containment for somebody
  // ELSE's record is unchanged and enforced below.
  { auth: "user", roles: ["anyUser"], params: { userId: "uuid" }, sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const userId = userIdFrom(req);
    // Widening the alias widened WHO may ask, not WHAT they may ask about. A staff
    // caller reading a colleague is 404, the same answer as a stranger: the
    // repository would have let them through GET_CONTAINED, which pins role=staff
    // and their own shop -- exactly their colleagues.
    if (userId !== req.core.session.userId && !permits(req.core.scope, ["manager"])) {
      throw new ApiError(404, "not_found");
    }
    const user = await withTenantScope(req.core.scope, () => deps.tenantUsers.getUser(req.core.scope, userId));
    if (user === null) throw new ApiError(404, "not_found");
    sendJson(res, 200, userDocument(user));
  }
);

route(
  "PATCH",
  "/api/admin/users/:userId",
  {
    auth: "user",
    // anyUser for the same reason as the GET, and it needs no extra guard: for
    // anybody else's row mayActOnRole("staff", ...) is false, and for their own the
    // body is already limited to SELF_PATCHABLE_FIELDS.
    roles: ["anyUser"],
    params: { userId: "uuid" },
    body: {
      displayName: "string?",
      phone: "string?",
      role: "string?",
      status: "string?",
      language: "string|null?",
      shopIds: "uuid[]?"
    },
    audit: "user.updated",
    sample: { params: { userId: "00000000-0000-4000-8000-000000000000" }, body: { status: "suspended" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const userId = userIdFrom(req);
    const body = await readJsonBody(req);
    const errors = [];

    const fields = ["displayName", "phone", "role", "status", "language", "shopIds"].filter((key) => has(body, key));
    if (fields.length === 0) throw new ApiError(400, "invalid_request");

    // Your name, your number and your language are yours; nothing else about your
    // own account is. §6.2 said displayName ALONE, and §7A.3 widened it: the
    // console language is a per-person setting, so a manager filing a request to
    // change what language they read is not a rule, it is an obstacle. What stays
    // out has not moved -- a route that let you change your own role would make
    // the lattice decorative, and your email is how the person above you reaches
    // you. lib/authorization.js holds the list.
    //
    // isSelf also EXEMPTS the row from the lattice below, and it has to: nobody is
    // strictly below themselves, so a CEO renaming themselves would otherwise be
    // refused by the rule that stops them minting a peer. Two different questions
    // that happen to compare the same two roles.
    const isSelf = userId === req.core.session.userId;
    if (isSelf && !permitsSelfPatch(fields)) {
      throw new ApiError(403, "self_modification_forbidden");
    }

    if (has(body, "displayName") && (typeof body.displayName !== "string" || body.displayName.trim().length === 0)) {
      errors.push({ field: "displayName", code: "too_short" });
    }
    if (has(body, "phone") && (typeof body.phone !== "string" || body.phone.trim().length === 0)) {
      errors.push({ field: "phone", code: "too_short" });
    }
    if (has(body, "role") && !ASSIGNABLE_ROLES.includes(body.role)) {
      errors.push({ field: "role", code: "not_in_enum" });
    }
    if (has(body, "status") && !STATUSES.includes(body.status)) {
      errors.push({ field: "status", code: "not_in_enum" });
    }
    if (has(body, "language") && body.language !== null && !LANGUAGE_PATTERN.test(String(body.language))) {
      errors.push({ field: "language", code: "pattern" });
    }
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    // A body carrying role or shopIds additionally requires companyAdmin. This is
    // BODY-dependent, so it cannot be a route declaration -- §6.2 says so, and it
    // is why the route is `manager` and this line exists.
    const wantsReassignment = has(body, "role") || has(body, "shopIds");
    if (wantsReassignment && req.core.scope.administeredShopIds === undefined) {
      throw new ApiError(403, "forbidden");
    }

    const user = await withTenantScope(req.core.scope, async () => {
      const before = await deps.tenantUsers.getUser(req.core.scope, userId);
      if (before === null) return null;

      // Strictly below BEFORE and AFTER. Checked twice on purpose: without the
      // second half, editing a staff row you were allowed to touch is how somebody
      // becomes your peer.
      if (!isSelf && !mayActOnRole(req.core.scope.role, before.role)) {
        throw new ApiError(403, "forbidden");
      }
      // ...and AFTER. Without this half, editing a staff row you were allowed to
      // touch is how somebody becomes your peer. It is also why a company_admin
      // cannot promote anybody to company_admin: a company's FIRST one is created
      // by a scoped platform admin, whose rank 3 clears rank 2 (§6.2).
      if (has(body, "role") && !mayActOnRole(req.core.scope.role, body.role)) {
        throw new ApiError(403, "forbidden");
      }

      const nextRole = has(body, "role") ? body.role : before.role;
      const nextShopIds = has(body, "shopIds") ? body.shopIds : undefined;
      const shopErrors = [];
      validateShopIds(nextShopIds, nextRole, shopErrors, { required: has(body, "role") });
      if (shopErrors.length > 0) throw new ApiError(422, "validation_failed", shopErrors);

      const changes = {
        displayName: has(body, "displayName") ? body.displayName.trim() : null,
        phone: has(body, "phone") ? body.phone.trim() : null,
        role: has(body, "role") ? body.role : null,
        status: has(body, "status") ? body.status : null,
        shopIds: nextShopIds
      };
      // Promotion to company_admin drops every assignment: they are company-wide,
      // and a leftover row would be a claim about their reach that nothing reads.
      if (changes.role === "company_admin") changes.shopIds = [];
      if (has(body, "language")) changes.language = body.language;

      const updated = await deps.tenantUsers.updateUser(req.core.scope, userId, changes);
      await deps.tenantAudit.appendTenantAuditEvent(req.core.scope, {
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "user.updated",
        outcome: "success",
        targetKind: "user",
        targetId: userId,
        sourceIp: req.core.clientIp,
        detail: { role: updated.role, status: updated.status }
      });
      return updated;
    });

    if (user === null) throw new ApiError(404, "not_found");
    sendJson(res, 200, userDocument(user));
  }
);

route(
  "POST",
  "/api/admin/users/:userId/password-reset",
  {
    auth: "user",
    roles: ["manager"],
    params: { userId: "uuid" },
    body: null,
    audit: "user.password_reset",
    sample: { params: { userId: "00000000-0000-4000-8000-000000000000" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const userId = userIdFrom(req);
    if (userId === req.core.session.userId) throw new ApiError(403, "self_modification_forbidden");

    const initialPassword = generateInitialPassword();
    const passwordHash = await hashPassword(initialPassword);

    const user = await withTenantScope(req.core.scope, async () => {
      const before = await deps.tenantUsers.getUser(req.core.scope, userId);
      if (before === null) return null;
      if (!mayActOnRole(req.core.scope.role, before.role)) throw new ApiError(403, "forbidden");

      const updated = await deps.tenantUsers.resetUserPassword(req.core.scope, userId, passwordHash);
      await deps.tenantAudit.appendTenantAuditEvent(req.core.scope, {
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "user.password_reset",
        outcome: "success",
        targetKind: "user",
        targetId: userId,
        sourceIp: req.core.clientIp
      });
      return updated;
    });

    if (user === null) throw new ApiError(404, "not_found");
    // The repair for a lost create response AND for a locked-out cashier: the
    // reset clears failed_login_count and locked_until too, because the remedy
    // that helps somebody locked out is a working password.
    sendJson(res, 200, { ...userDocument(user), initialPassword });
  }
);
