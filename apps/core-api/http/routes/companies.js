"use strict";

// The four routes of spec §6.2's platform-companies block. The first screen of the
// admin console, and the first routes in the service that are neither public nor
// tenant-scoped.
//
// WHAT IS NOT HERE: any SQL. Every statement lives in repositories/platform/*,
// which is the one directory allowed to reach the database without a company_id.
// Rule C2's needle bans a `.query(` in this file whatever the handle is called.
//
// roles: ["platform"] on all four, and that alias means an UNSCOPED platform admin
// and nobody else -- its member list is empty, so no tenant scope can satisfy it,
// including a platform admin who has selected a company. That is the intended
// reading: these routes are about the list of companies, and somebody standing
// inside one of them should step out first.

const { route } = require("../router");
const { readJsonBody } = require("../body");
const { sendJson } = require("../respond");
const { ApiError } = require("../../db/errors");
const { withPlatformScope } = require("../../db");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The SAME expression 0003_admin_console.sql enforces, and migrate.test.js asserts
// the DDL's spelling exactly for this reason: three copies of this rule exist -- the
// CHECK, this line, and the console's own validator -- and they are only correct
// while they are identical. One forbids four things at once: a leading digit, a
// trailing hyphen, two hyphens in a row, and anything outside [a-z0-9-].
const SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SLUG_MIN = 2;
const SLUG_MAX = 24;
const NAME_MAX = 120;
const STATUSES = ["active", "suspended"];
const LIST_STATUSES = ["active", "suspended", "all"];
const LIMIT_MAX = 100;

// Shaped here rather than in the repository, because the repository returns the row
// and the route owns the contract. Keeping them separate is what lets a column be
// added to companies without it appearing in a response nobody decided to widen.
function companyDocument(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    shopCount: row.shopCount,
    tableCount: row.tableCount,
    // null, not an omitted key: a company whose CEO has not been appointed yet is a
    // state the console draws ("No CEO yet", with the action to fix it), and a key
    // that vanishes is a state it would have to infer.
    // The id is here because the console acts on this person -- resetting their
    // password, replacing them -- and the alternative is a scope switch and a user
    // list read just to find out who they are.
    ceo:
      row.ceoId === null
        ? null
        : { id: row.ceoId, displayName: row.ceoName, email: row.ceoEmail }
  };
}

// Every failure collected, then thrown ONCE. Early-returning on the first bad field
// makes a caller fix one thing per round trip, and spec §6.3.5 step 11 says "all
// errors reported at once".
function validateName(value, errors, { required }) {
  if (value === undefined) {
    if (required) errors.push({ field: "name", code: "required" });
    return null;
  }
  if (typeof value !== "string") {
    errors.push({ field: "name", code: "type" });
    return null;
  }
  const name = value.trim();
  if (name.length === 0) errors.push({ field: "name", code: "too_short" });
  else if (name.length > NAME_MAX) errors.push({ field: "name", code: "too_long" });
  return name;
}

function validateSlug(value, errors, { required }) {
  if (value === undefined) {
    if (required) errors.push({ field: "slug", code: "required" });
    return null;
  }
  if (typeof value !== "string") {
    errors.push({ field: "slug", code: "type" });
    return null;
  }
  // Never trimmed. A slug with a space in it is wrong, not nearly right, and
  // silently repairing it would mean the address the caller was shown is not the
  // address that was stored.
  if (value.length < SLUG_MIN) errors.push({ field: "slug", code: "too_short" });
  else if (value.length > SLUG_MAX) errors.push({ field: "slug", code: "too_long" });
  else if (!SLUG_PATTERN.test(value)) errors.push({ field: "slug", code: "pattern" });
  return value;
}

function validateStatus(value, errors) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !STATUSES.includes(value)) {
    errors.push({ field: "status", code: "not_in_enum" });
    return null;
  }
  return value;
}

// A malformed path segment is 404, never 422. Spec §6.3.3: "unknown route, unknown
// resource and resource outside scope" are one answer, and a typed refusal here
// would confirm that a real resource type exists at a real id.
function companyIdFrom(req) {
  if (!UUID_PATTERN.test(req.params.companyId)) throw new ApiError(404, "not_found");
  return req.params.companyId;
}

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

route(
  "GET",
  "/api/platform/companies",
  { auth: "user", roles: ["platform"], sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const url = new URL(req.originalUrl, "http://placeholder");
    const status = url.searchParams.get("status");
    const limitRaw = url.searchParams.get("limit");

    const errors = [];
    if (status !== null && !LIST_STATUSES.includes(status)) {
      errors.push({ field: "status", code: "not_in_enum" });
    }
    let limit = 50;
    if (limitRaw !== null) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
        errors.push({ field: "limit", code: "out_of_range" });
      }
    }
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    const rows = await withPlatformScope(req.core.scope, () =>
      // "all" is the default AND an explicit value, so it maps to null -- the
      // repository reads null as "no status predicate" rather than carrying a
      // third magic string into the SQL.
      deps.companies.listCompanies(req.core.scope, {
        status: status === null || status === "all" ? null : status,
        limit
      })
    );
    sendJson(res, 200, { companies: rows.map(companyDocument) });
  }
);

route(
  "POST",
  "/api/platform/companies",
  {
    auth: "user",
    roles: ["platform"],
    body: { name: "string", slug: "string" },
    audit: "company.created",
    sample: { body: { name: "Sakura Kitchen", slug: "sakura" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const body = await readJsonBody(req);

    const errors = [];
    const name = validateName(has(body, "name") ? body.name : undefined, errors, { required: true });
    const slug = validateSlug(has(body, "slug") ? body.slug : undefined, errors, { required: true });
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    // ONE transaction for the row and the row that says who made it. Written
    // separately, a rolled-back INSERT would leave an audit entry naming a company
    // that does not exist -- and the trail would be wrong in the direction nobody
    // audits the auditor for.
    const company = await withPlatformScope(req.core.scope, async () => {
      const created = await deps.companies.createCompany(req.core.scope, {
        name,
        slug,
        createdByUserId: req.core.session.userId
      });
      await deps.platformAudit.appendPlatformAuditEvent(req.core.scope, {
        companyId: created.id,
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "company.created",
        outcome: "success",
        targetKind: "company",
        targetId: created.id,
        sourceIp: req.core.clientIp,
        detail: { name: created.name, slug: created.slug }
      });
      return created;
    });

    // Spec §8.5 rule 7: a route that emits a Location has a GET at that path. The
    // GET below is that route, and this is the first Location in the service.
    sendJson(res, 201, companyDocument(company), {
      Location: `/api/platform/companies/${company.id}`
    });
  }
);

route(
  "GET",
  "/api/platform/companies/:companyId",
  { auth: "user", roles: ["platform"], params: { companyId: "uuid" }, sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const companyId = companyIdFrom(req);
    const company = await withPlatformScope(req.core.scope, () =>
      deps.companies.getCompany(req.core.scope, companyId)
    );
    if (company === null) throw new ApiError(404, "not_found");
    sendJson(res, 200, companyDocument(company));
  }
);

route(
  "PATCH",
  "/api/platform/companies/:companyId",
  {
    auth: "user",
    roles: ["platform"],
    params: { companyId: "uuid" },
    body: { name: "string?", slug: "string?", status: "string?" },
    audit: "company.updated",
    sample: { params: { companyId: "00000000-0000-4000-8000-000000000000" }, body: { status: "suspended" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const companyId = companyIdFrom(req);
    const body = await readJsonBody(req);

    const errors = [];
    // ABSENT means "do not change"; PRESENT means change it, even to something
    // invalid. hasOwnProperty is the only test that tells those apart, and {} and
    // {"name": null} are two different requests.
    const name = validateName(has(body, "name") ? body.name : undefined, errors, { required: false });
    const slug = validateSlug(has(body, "slug") ? body.slug : undefined, errors, { required: false });
    const status = has(body, "status") ? validateStatus(body.status, errors) : null;
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);
    if (!has(body, "name") && !has(body, "slug") && !has(body, "status")) {
      throw new ApiError(400, "invalid_request");
    }

    const company = await withPlatformScope(req.core.scope, async () => {
      const updated = await deps.companies.updateCompany(req.core.scope, companyId, { name, slug, status });
      // The 404 is raised INSIDE the transaction so nothing is audited for a
      // company that was never touched. company.updated declares outcome success
      // only, and a failure row here would be refused by the vocabulary anyway --
      // turning a 404 into a 500.
      if (updated === null) return null;
      await deps.platformAudit.appendPlatformAuditEvent(req.core.scope, {
        companyId: updated.id,
        actorKind: "user",
        actorUserId: req.core.session.userId,
        action: "company.updated",
        outcome: "success",
        targetKind: "company",
        targetId: updated.id,
        sourceIp: req.core.clientIp,
        detail: { name: updated.name, slug: updated.slug, status: updated.status }
      });
      return updated;
    });

    if (company === null) throw new ApiError(404, "not_found");
    sendJson(res, 200, companyDocument(company));
  }
);
