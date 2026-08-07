"use strict";

// The six routes of spec 6.2's authentication block, in one file because they share
// the me-document -- which 6.2 defines once and four of them return.
//
// WHAT IS NOT HERE: any SQL. Every statement lives in repositories/auth/*, which are
// the files rule C4's nine-entry allowlist sanctions to call withUnscopedConnection.
// Rule C2's second needle bans a `.query(` in this file whatever the handle is called.

const { route } = require("../router");
const { readJsonBody } = require("../body");
const { sendJson, sendError } = require("../respond");
const { ApiError } = require("../../db/errors");
const { hashPassword, verifyPassword, PasswordPolicyError } = require("../../lib/password");
const { mintToken, hashToken } = require("../../lib/tokens");
const { buildSessionCookie, buildClearingCookie } = require("../cookies");

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
    },
    // The company this session is acting in, NAMED. null for an unscoped platform
    // admin, who is acting in none of them.
    //
    // It is a top-level key rather than a field on `user` because it is not a fact
    // about the person: the same platform admin has a different one before and after
    // selecting a company. The console prints it in the rail, where "which company
    // am I in" is the question being answered.
    company:
      scope.companyId == null
        ? null
        : {
            id: scope.companyId,
            name: user.companyName ?? null,
            slug: user.companySlug ?? null,
            logoKey: user.companyLogoKey ?? null
          }
  };
  // Present ONLY for company_admin and scoped platform_admin -- db/scope.js throws
  // if any other role is handed one, so its absence here is the same fact.
  if (scope.administeredShopIds !== undefined) {
    document.scope.administeredShopIds = [...scope.administeredShopIds];
  }
  return document;
}

// resolveSession returns the joined user columns under different names than the
// login lookup does (userId, not id), and every route except login builds its
// me-document from a resolved session. One adapter, so the shape cannot drift
// between four routes.
//
// user.companyId is the user's OWN company and is null for every platform_admin --
// users_platform_admin_has_no_company makes that a constraint. The ACTING company
// lives in scope.companyId, which is exactly the distinction spec 6.2 draws when it
// says scope.kind is what the UI branches on.
function userFromSession(session) {
  return {
    id: session.userId,
    email: session.email,
    displayName: session.displayName,
    role: session.role,
    companyId: session.companyId,
    mustChangePassword: session.mustChangePassword,
    // Carried through so meDocument has ONE place to read the company from. The
    // login path builds its user from the login row and /me from the session row,
    // and both rows join companies -- but only one of them is called `session`.
    companyName: session.companyName ?? null,
    companySlug: session.companySlug ?? null,
    companyLogoKey: session.companyLogoKey ?? null
  };
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

// ---------------------------------------------------------------------------
// GET /api/admin/auth/me
// ---------------------------------------------------------------------------

// DELIBERATELY NOT exempt from the password-change gate (spec 6.2): the 403 is
// self-describing, and login already told the caller mustChangePassword.
route(
  "GET",
  "/api/admin/auth/me",
  // BOTH aliases -- Part 5 departure (d). `anyUser` admits a SCOPED platform admin
  // and deliberately excludes an unscoped one, and the account the bootstrap CLI
  // creates is unscoped from the moment it signs in. This route binds no company, so
  // admitting it here widens no tenant query.
  { auth: "user", roles: ["platform", "anyUser"], sample: {} },
  async (req, res) => {
    sendJson(
      res,
      200,
      meDocument({
        user: userFromSession(req.core.session),
        scope: req.core.scope,
        session: req.core.session
      })
    );
  }
);

// ---------------------------------------------------------------------------
// POST /api/admin/auth/logout
// ---------------------------------------------------------------------------

route(
  "POST",
  "/api/admin/auth/logout",
  {
    auth: "user",
    // Part 5 departure (d). Signing out is the one thing every actor must be able to
    // do, and an unscoped platform admin is an actor.
    roles: ["platform", "anyUser"],
    body: null,
    audit: "auth.logout",
    // One of exactly two exemptions (spec 8.5 rule 3). A user who must change their
    // password and cannot sign out is stuck holding a session they must not use.
    exemptFromPasswordChange: true,
    sample: {}
  },
  async (req, res) => {
    const deps = req.core.deps;
    const session = req.core.session;

    await deps.sessions.deleteSession(session.sessionId);
    await deps.appendAuditEvent({
      actorKind: "user",
      actorUserId: session.userId,
      companyId: session.companyId,
      action: "auth.logout",
      outcome: "success",
      targetKind: "user",
      targetId: session.userId,
      sourceIp: req.core.clientIp
    });

    // Step 14 runs after this handler and will try to renew a session that no longer
    // exists. That is a zero-row UPDATE, not an error, and renewSession is written to
    // treat zero rows as the ordinary case. Do not "fix" it by clearing
    // req.core.session -- the pipeline reads it to decide whether to renew at all,
    // and a handler reaching back into the pipeline's state is worse than one
    // harmless statement.
    sendJson(res, 200, { ok: true }, { "Set-Cookie": buildClearingCookie() });
  }
);

// ---------------------------------------------------------------------------
// POST /api/admin/auth/logout-all
// ---------------------------------------------------------------------------

route(
  "POST",
  "/api/admin/auth/logout-all",
  // Part 5 departure (d).
  { auth: "user", roles: ["platform", "anyUser"], body: null, audit: "auth.logout_all", sample: {} },
  async (req, res) => {
    const deps = req.core.deps;
    const session = req.core.session;

    // DELETE FIRST, THEN BUMP, and the order is the correctness argument rather than
    // a style choice. Bump-then-delete leaves a session created in the gap with
    // created_at > sessions_valid_from, so the resolver accepts it and the DELETE has
    // already run -- the stolen session survives the one button that exists to kill
    // it. This way round, anything created in the gap has created_at <
    // sessions_valid_from and is rejected, so the pair fails closed with no
    // transaction. The residual is that the COUNT under-reports by whatever landed in
    // the gap; it is an informational number, not a guarantee.
    const revokedSessionCount = await deps.sessions.deleteAllSessionsForUser(session.userId);
    await deps.users.bumpSessionsValidFrom(session.userId);

    await deps.appendAuditEvent({
      actorKind: "user",
      actorUserId: session.userId,
      companyId: session.companyId,
      action: "auth.logout_all",
      outcome: "success",
      targetKind: "user",
      targetId: session.userId,
      sourceIp: req.core.clientIp,
      detail: { revokedSessionCount }
    });

    sendJson(res, 200, { ok: true, revokedSessionCount }, { "Set-Cookie": buildClearingCookie() });
  }
);

// ---------------------------------------------------------------------------
// POST /api/admin/auth/password
// ---------------------------------------------------------------------------

// Responds in place rather than throwing, for the same reason the pipeline does:
// both branches may need to set a header, and ApiError cannot carry one.
async function refuseCurrentPassword(req, res, deps, session) {
  // The roster's only consume:"failure" limiter, so the pipeline skipped it -- a
  // per-request decrement would lock a user out of their own password-change route
  // for SUCCEEDING at it.
  const verdict = deps.rateLimiter.consume(
    "password-change-abuse",
    session.userId,
    deps.passwordAbuseThreshold
  );

  if (verdict.count < deps.passwordAbuseThreshold) {
    // 403, not 401, and spec 6.3.7(a) is explicit about why: the session credential
    // IS valid, and a client's global "401 -> drop the session and redirect" handler
    // would otherwise let a stolen session grief the real user out of theirs.
    sendError(res, { status: 403, code: "current_password_invalid" }, req.core.requestId);
    return;
  }

  // Punish the credential ACTUALLY being abused. Writing users.locked_until instead
  // -- the obvious move -- hands a stolen session a permanent denial of service
  // against the legitimate owner's login, which is the whole of spec 5.8(a).
  await deps.sessions.deleteSession(session.sessionId);
  await deps.appendAuditEvent({
    actorKind: "user",
    actorUserId: session.userId,
    companyId: session.companyId,
    action: "user.password_change_abuse",
    outcome: "failure",
    targetKind: "user",
    targetId: session.userId,
    sourceIp: req.core.clientIp,
    detail: { consecutiveFailures: verdict.count }
  });

  const headers = { "Set-Cookie": buildClearingCookie() };
  // Retry-After IS sent here, unlike on login and pair. This bucket is keyed on a
  // principal the caller has already authenticated as, so the header confirms
  // nothing they did not already know -- which is the exact test spec 5.7 applies.
  if (verdict.retryAfterSeconds !== null) headers["Retry-After"] = String(verdict.retryAfterSeconds);
  sendError(res, { status: 429, code: "rate_limited" }, req.core.requestId, headers);
}

route(
  "POST",
  "/api/admin/auth/password",
  {
    auth: "user",
    // Part 5 departure (d), and this is the route where it bites hardest: the
    // bootstrap admin's FIRST action is usually to change the password the CLI set,
    // and under a plain `anyUser` they would get 403 for it.
    roles: ["platform", "anyUser"],
    body: { currentPassword: "string", newPassword: "string" },
    audit: "auth.password_changed",
    // The second of exactly two exemptions (spec 8.5 rule 3). Without it, the only
    // route that can clear must_change_password is gated on must_change_password.
    exemptFromPasswordChange: true,
    limit: { key: "user", name: "password-change-abuse" },
    sample: {
      body: { currentPassword: "not-a-real-password", newPassword: "not-a-real-password-either" }
    }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const session = req.core.session;
    const body = await readJsonBody(req);

    const errors = [];
    if (typeof body.currentPassword !== "string" || body.currentPassword === "") {
      errors.push({ field: "currentPassword", code: "required" });
    }
    if (typeof body.newPassword !== "string" || body.newPassword === "") {
      errors.push({ field: "newPassword", code: "required" });
    }
    if (errors.length > 0) throw new ApiError(422, "validation_failed", errors);

    // ONE slot for BOTH scrypt calls on this path -- the verify and the hash. Taking
    // two would let a caller hold half the service's CPU budget with one request.
    await deps.scryptSemaphore.acquire();
    try {
      const user = await deps.users.findById(session.userId);
      // The resolver already proved the session live and the user active, so null
      // here means the row went away mid-request. 401, never a 500.
      if (user === null) throw new ApiError(401, "unauthenticated");

      if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
        await refuseCurrentPassword(req, res, deps, session);
        return;
      }
      // CONSECUTIVE, not cumulative (spec 5.8(a)).
      deps.rateLimiter.reset("password-change-abuse", session.userId);

      let passwordHash;
      try {
        passwordHash = await hashPassword(body.newPassword);
      } catch (error) {
        // PasswordPolicyError carries `code` but deliberately NOT `status`: the same
        // policy failure is a 400 on a create route and a 422 here, so the route
        // decides. Anything else is a real fault and belongs in the 500 tail.
        if (!(error instanceof PasswordPolicyError)) throw error;
        throw new ApiError(422, "validation_failed", [{ field: "newPassword", code: error.code }]);
      }

      // WRITE, DELETE, CREATE -- in that order, and none of the three is
      // interchangeable. writePasswordHash bumps sessions_valid_from, so a session
      // minted before it would be invalidated by it; and the DELETE has to run before
      // the mint or it takes out the session this response is about to hand back.
      //
      // writePasswordHash does NOT touch failed_login_count or locked_until, by
      // construction -- see its own comment in repositories/auth/users.js.
      await deps.users.writePasswordHash(session.userId, passwordHash, { mustChangePassword: false });
      await deps.sessions.deleteAllSessionsForUser(session.userId);

      const token = mintToken();
      const fresh = await deps.sessions.createSession({
        userId: session.userId,
        tokenHash: hashToken(token),
        idleSeconds: deps.sessionIdleSeconds,
        absoluteSeconds: deps.sessionAbsoluteSeconds
      });

      // actingCompanyId is null because acting_company_id is a per-SESSION column and
      // this is a new row. A platform admin who changes their password re-selects
      // their company, which is the same thing that happens after any sign-in.
      const scope = await deps.scopes.materialiseScope({
        userId: session.userId,
        sessionId: fresh.id,
        role: session.role,
        companyId: session.companyId,
        actingCompanyId: null
      });

      await deps.appendAuditEvent({
        actorKind: "user",
        actorUserId: session.userId,
        companyId: session.companyId,
        action: "auth.password_changed",
        outcome: "success",
        targetKind: "user",
        targetId: session.userId,
        sourceIp: req.core.clientIp
      });

      sendJson(
        res,
        200,
        meDocument({
          // They just chose it themselves, so the gate is cleared -- and the document
          // must say so or the client re-prompts forever.
          user: { ...userFromSession(session), mustChangePassword: false },
          scope,
          session: fresh
        }),
        { "Set-Cookie": buildSessionCookie(token, deps.sessionIdleSeconds) }
      );
    } finally {
      deps.scryptSemaphore.release();
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/admin/scope
// ---------------------------------------------------------------------------

// Lives in this file despite its path: it changes AUTHENTICATION state -- it writes
// user_sessions.acting_company_id -- and it returns the me-document. A
// http/routes/scope.js would import every helper above and add nothing.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Materialised AFTER the write, never reused from req.core.scope: the pipeline's
// scope was built from the session as it was when this request arrived, so it is one
// selection out of date by construction.
async function respondWithScope(req, res, deps, session, actingCompanyId) {
  const scope = await deps.scopes.materialiseScope({
    userId: session.userId,
    sessionId: session.sessionId,
    role: session.role,
    companyId: session.companyId,
    actingCompanyId
  });
  sendJson(res, 200, meDocument({ user: userFromSession(session), scope, session }));
}

route(
  "POST",
  "/api/admin/scope",
  {
    auth: "user",
    // BOTH, because spec 5.4's four aliases cannot express "platform_admin, scoped or
    // unscoped": `platform` admits only the unscoped one, `companyAdmin` admits the
    // scoped one AND every real company admin. This is the narrowest static
    // declaration available; the handler closes the rest.
    roles: ["platform", "companyAdmin"],
    body: { companyId: "uuid|null" },
    // The handler writes scope.cleared for a null body. `audit` is one string, and
    // this is the route's principal action.
    audit: "scope.selected",
    sample: { body: { companyId: null } }
  },
  async (req, res) => {
    const deps = req.core.deps;
    const session = req.core.session;

    // session.role is users.role -- the fact being tested. scope.role would work by
    // accident today (a scoped platform admin materialises 'platform_admin' and a
    // company admin materialises 'company_admin') and stop working the moment spec
    // 5.4's rank lattice is extended.
    if (session.role !== "platform_admin") throw new ApiError(403, "forbidden");

    const body = await readJsonBody(req);

    // REQUIRED and explicitly NULLABLE (spec 6.2). hasOwnProperty rather than an
    // `=== undefined` test, because {} and {"companyId": null} are two different
    // requests: one is a mistake and the other clears the selection.
    if (!Object.prototype.hasOwnProperty.call(body, "companyId")) {
      throw new ApiError(422, "validation_failed", [{ field: "companyId", code: "required" }]);
    }
    const companyId = body.companyId;
    if (companyId !== null && (typeof companyId !== "string" || !UUID_PATTERN.test(companyId))) {
      // 422, and the "422 never describes a path segment" rule does not apply: that
      // rule is about PATH parameters, where a malformed segment cannot name a
      // resource. This is a body field and step 11 owns it.
      throw new ApiError(422, "validation_failed", [{ field: "companyId", code: "invalid_uuid" }]);
    }

    if (companyId === null) {
      await deps.sessions.setActingCompany(session.sessionId, null);
      await deps.appendAuditEvent({
        actorKind: "user",
        actorUserId: session.userId,
        action: "scope.cleared",
        outcome: "success",
        sourceIp: req.core.clientIp
      });
      await respondWithScope(req, res, deps, session, null);
      return;
    }

    // Read BEFORE the write, and separately, because 6.2 distinguishes 404 not_found
    // from 409 company_suspended and one zero-row UPDATE cannot produce both.
    const company = await deps.sessions.findCompanyForScopeSelection(companyId);

    // THE PROBED ID GOES IN target_id, NOT IN company_id. audit_events.company_id
    // REFERENCES companies (0001_init.sql), so an id matching no row raises 23503
    // inside the failure path and turns a 404 into a 500 -- reachable by anyone who
    // can reach this route, with any uuid at all. target_id is text with no FK, and
    // 0001's own comment says why: "a target may legitimately be gone".
    const attempt = {
      actorKind: "user",
      actorUserId: session.userId,
      action: "scope.selected",
      outcome: "failure",
      targetKind: "company",
      targetId: companyId,
      sourceIp: req.core.clientIp
    };

    if (company === null) {
      await deps.appendAuditEvent(attempt);
      throw new ApiError(404, "not_found");
    }
    if (company.status !== "active") {
      await deps.appendAuditEvent(attempt);
      throw new ApiError(409, "company_suspended");
    }

    await deps.sessions.setActingCompany(session.sessionId, companyId);
    await deps.appendAuditEvent({
      ...attempt,
      outcome: "success",
      // Only now that the row is known to exist can the tenant column carry it --
      // which is what makes "everything done inside this company" a query.
      companyId
    });
    await respondWithScope(req, res, deps, session, companyId);
  }
);

module.exports = { meDocument, userFromSession, evaluateLogin, payTimeBudget };
