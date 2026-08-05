"use strict";

// The six routes of spec 6.2's authentication block, in one file because they share
// the me-document -- which 6.2 defines once and four of them return.
//
// WHAT IS NOT HERE: any SQL. Every statement lives in repositories/auth/*, which are
// the files rule C4's nine-entry allowlist sanctions to call withUnscopedConnection.
// Rule C2's second needle bans a `.query(` in this file whatever the handle is called.

const { route } = require("../router");
const { readJsonBody } = require("../body");
const { sendJson } = require("../respond");
const { ApiError } = require("../../db/errors");
const { verifyPassword } = require("../../lib/password");
const { mintToken, hashToken } = require("../../lib/tokens");
const { buildSessionCookie } = require("../cookies");

// ---------------------------------------------------------------------------
// The me-document (spec 6.2), built by NAMING every field rather than by spreading
// a row. The login lookup selects password_hash, so a spread would put a scrypt PHC
// string in a 200 body -- and the 6.3.6 leak scanner reads error bodies only.
// ---------------------------------------------------------------------------

// pg hands timestamptz back as a Date; a stub in a test may hand back a string.
// Both become the same ISO-8601 text, so the response shape cannot depend on which.
function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function meDocument({ user, scope, session }) {
  const document = {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      // null for an unscoped platform admin, and 6.2 says so: scope.kind is what
      // the Phase-2 UI branches on to show the company selector.
      companyId: user.companyId ?? null,
      mustChangePassword: user.mustChangePassword
    },
    scope: {
      kind: scope.kind,
      companyId: scope.companyId ?? null,
      // ALWAYS an array, never null. Spec 6.2: this is what exercises the 3.3(c)
      // materialised-scope rule end to end, so a regression is visible from outside
      // the process. A platform scope carries no shopIds at all, and [] is the
      // honest rendering of "reaches no shop", not a stand-in for "reaches all".
      shopIds: [...(scope.shopIds ?? [])]
    },
    session: {
      expiresAt: iso(session.expiresAt),
      absoluteExpiresAt: iso(session.absoluteExpiresAt)
    }
  };
  // Present ONLY for company_admin and scoped platform_admin -- db/scope.js throws
  // if any other role is handed one, so its absence here is the same fact.
  if (scope.administeredShopIds !== undefined) {
    document.scope.administeredShopIds = [...scope.administeredShopIds];
  }
  return document;
}

// ---------------------------------------------------------------------------
// The login time budget (spec 5.1)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// MEASURED FROM SLOT ACQUISITION, not from request arrival -- spec 5.1 in as many
// words. Queue wait sits outside the budget, which is exactly why
// LOGIN_RATE_PER_MINUTE sheds BEFORE the queue rather than lengthening it: if queue
// time counted, a burst would stretch every login past the budget and the
// byte-identical-outcome property would leak through timing.
//
// Paid on the SUCCESS path too. Padding only failures makes success the fast answer,
// which is the same oracle wearing the other hat.
async function payTimeBudget(startedAt, budgetMs) {
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (elapsedMs < budgetMs) await sleep(budgetMs - elapsedMs);
}

// ---------------------------------------------------------------------------
// POST /api/admin/auth/login
// ---------------------------------------------------------------------------

// Returns { ok, bumpUserId }. Written as one function so the five uniform failure
// causes of 6.2 are visibly ONE list rather than five early returns scattered
// through a handler, and so the "which failures bump the counter" question has a
// single place to be answered.
//
// A LOCKED ACCOUNT DOES NOT BUMP, and that is the same argument spec 5.8(a) makes
// about the password route: bumping while locked lets one request every fourteen
// minutes hold the fifteen-minute cap forever, so a lockout designed to expire
// becomes permanent and the victim reads their own uniform 401 as a typo.
// A suspended user and a suspended company have no login to throttle at all.
async function evaluateLogin(user, password, now) {
  if (user === null) return { ok: false, bumpUserId: null };
  if (user.status !== "active") return { ok: false, bumpUserId: null };
  if (user.companyId !== null && user.companyStatus !== "active") return { ok: false, bumpUserId: null };
  if (user.lockedUntil !== null && new Date(user.lockedUntil).getTime() > now) {
    return { ok: false, bumpUserId: null };
  }
  // Reached only for an eligible account, so this is the ONLY path that spends
  // scrypt. Every other cause is a comparison, and the budget pad is what keeps
  // that difference off the wire.
  if (!(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, bumpUserId: user.id };
  }
  return { ok: true, bumpUserId: null };
}

route(
  "POST",
  "/api/admin/auth/login",
  {
    auth: "public",
    body: { email: "string", password: "string" },
    // ONE declared action, because `audit` is one string. The handler also writes
    // auth.login_failed, which is in the vocabulary and is what the deploy gate
    // reads. Nothing asserts that a route emits ONLY its declared action -- the
    // declaration is a boot-time membership check, not a runtime contract.
    audit: "auth.login",
    // Credential-independent, consumed by the pipeline at step 4a before any scrypt
    // is queued. NO Retry-After: spec 5.7 says the header would confirm the bucket.
    limit: { key: "ip", name: "login-global" },
    sample: { body: { email: "sample@example.test", password: "not-a-real-password" } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const body = await readJsonBody(req);

    // Shape, not semantics. A missing field says nothing about any account, so 422
    // here is not the oracle a 422-versus-401 split would be further down.
    const errors = [];
    if (typeof body.email !== "string" || body.email.trim() === "") {
      errors.push({ field: "email", code: "required" });
    } else if (body.email.trim().length > 254) {
      // 254 is the users.email CHECK -- `length(email) BETWEEN 3 AND 254` in
      // migrations/0001_init.sql -- and the same bound the bootstrap CLI applies
      // before it opens a pool. Unbounded here, the folded address is written into
      // audit_events.detail on EVERY failure including one that matches no row, and
      // that table has no length CHECK on detail and nothing sweeping it until
      // Plan 2d: an unauthenticated caller would choose the row size.
      //
      // Still shape, not semantics. It runs before findByEmailForLogin, so it says
      // nothing about whether any address exists, and no legal address reaches it --
      // an address the database would accept cannot be longer than the bound.
      errors.push({ field: "email", code: "too_long" });
    }
    if (typeof body.password !== "string" || body.password === "") {
      errors.push({ field: "password", code: "required" });
    }
    // THERE IS DELIBERATELY NO COMPANION `too_long` ON password, and this is the
    // note that exists so nobody adds one. lib/password.js says it in as many words:
    // "The length policy is deliberately NOT applied here. It guards what is
    // written; applying it on the read path would lock out every existing account
    // the day the minimum is raised." A check here would also measure the raw
    // string while normalise() measures after NFKC, so it would reject a password
    // that hashPassword accepted and contracted. And it saves nothing: scrypt's cost
    // is fixed by the N, r and p in the stored hash, not by how long the candidate
    // is -- and unlike the email, the password reaches no durable row on this path.
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    // Folded the way the users.email CHECK folds it -- lower(btrim(...)). The
    // repository folds again in SQL; doing it here as well is what makes the audit
    // row's detail.email the same string the lookup used.
    const email = body.email.trim().toLowerCase();

    // Acquired BEFORE the lookup, so the budget clock covers every path and the
    // 503 shed happens before anything credential-dependent has been read.
    await deps.scryptSemaphore.acquire();
    const startedAt = process.hrtime.bigint();
    try {
      const user = await deps.users.findByEmailForLogin(email);
      const verdict = await evaluateLogin(user, body.password, Date.now());

      if (!verdict.ok) {
        if (verdict.bumpUserId !== null) await deps.users.recordFailedLogin(verdict.bumpUserId);
        // WRITTEN FOR EVERY FAILURE, INCLUDING AN ADDRESS THAT MATCHES NO ROW.
        // Spec 5.7: this row is the only externally observable evidence of what the
        // server derived as the client IP, and deploy.yml block 4 selects it by
        // detail.email for an address no user has. Skip it when the user is unknown
        // and the deploy gate asserts on nothing.
        await deps.appendAuditEvent({
          actorKind: "anonymous",
          action: "auth.login_failed",
          outcome: "failure",
          sourceIp: req.core.clientIp,
          detail: { email }
        });
        await payTimeBudget(startedAt, deps.loginTimeBudgetMs);
        throw new ApiError(401, "invalid_credentials");
      }

      await deps.users.recordSuccessfulLogin(user.id);

      const token = mintToken();
      const session = await deps.sessions.createSession({
        userId: user.id,
        tokenHash: hashToken(token),
        idleSeconds: deps.sessionIdleSeconds,
        absoluteSeconds: deps.sessionAbsoluteSeconds
      });
      // A FRESH session selects no company. A platform admin therefore signs in
      // unscoped every time and chooses again through POST /api/admin/scope, which
      // is the property that keeps an acting company from outliving a sign-out.
      const scope = await deps.scopes.materialiseScope({
        userId: user.id,
        sessionId: session.id,
        role: user.role,
        companyId: user.companyId,
        actingCompanyId: null
      });

      await deps.appendAuditEvent({
        actorKind: "user",
        actorUserId: user.id,
        companyId: user.companyId,
        action: "auth.login",
        outcome: "success",
        targetKind: "user",
        targetId: user.id,
        sourceIp: req.core.clientIp
      });

      // The request log's actor. The pipeline sets these for auth:'user' routes at
      // step 5; login is public, so this is the one route that has to say who it
      // turned out to be.
      req.core.actorKind = "user";
      req.core.actorId = user.id;

      await payTimeBudget(startedAt, deps.loginTimeBudgetMs);
      sendJson(res, 200, meDocument({ user, scope, session }), {
        // Max-Age tracks the IDLE window, not the absolute one: a cookie outliving
        // its session leaves the browser presenting a credential the server has
        // already stopped honouring, which reads as a broken sign-out.
        "Set-Cookie": buildSessionCookie(token, deps.sessionIdleSeconds)
      });
    } finally {
      // Without this, one slot leaks per failed login and the service stops
      // answering login after SCRYPT_SLOTS wrong passwords -- as a 503, which
      // reads as a database problem.
      deps.scryptSemaphore.release();
    }
  }
);

module.exports = { meDocument, evaluateLogin, payTimeBudget };
