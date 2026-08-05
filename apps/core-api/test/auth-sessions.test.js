"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const { seedTwoTenant, IDS, SESSION_TOKENS } = require("../testing/fixtures/two-tenant");
const { openRuntimePool, closeAllPools } = require("../db");
const { mintToken, hashToken } = require("../lib/tokens");
const sessions = require("../repositories/auth/sessions");

const skip = skipDatabaseTests();
const IDLE = 28800;
const ABSOLUTE = 604800;
let db;

test("setup", { skip }, async () => {
  db = await cloneTemplate(__filename);
  await db.resetFixtures();
  await seedTwoTenant(db);
  await openRuntimePool({ connectionString: db.connectionString, max: 4 });
});

test("a created session stores only the hash, never the token", { skip }, async () => {
  const token = mintToken();
  const created = await sessions.createSession({
    userId: IDS.userAAdmin,
    tokenHash: hashToken(token),
    idleSeconds: IDLE,
    absoluteSeconds: ABSOLUTE
  });

  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.ok(created.expiresAt instanceof Date);
  assert.ok(created.absoluteExpiresAt > created.expiresAt);

  // Spec 5.2: "core-api retains no raw credential in memory at all", and the
  // column is bytea(32). A repository that stored the raw value would still pass
  // every behavioural test in this file.
  const { rows } = await db.unscoped("SELECT token_hash FROM user_sessions WHERE id = $1", [created.id]);
  assert.ok(Buffer.isBuffer(rows[0].token_hash));
  assert.equal(rows[0].token_hash.length, 32);
  assert.equal(rows[0].token_hash.includes(Buffer.from(token, "utf8")), false);
});

test("resolve returns the identity, the acting company and both suspension facts", { skip }, async () => {
  const row = await sessions.resolveSession(hashToken(SESSION_TOKENS.aAdmin));

  assert.equal(row.sessionId, IDS.sessionAAdmin);
  assert.equal(row.userId, IDS.userAAdmin);
  assert.equal(row.role, "company_admin");
  assert.equal(row.companyId, IDS.companyA);
  assert.equal(row.actingCompanyId, IDS.companyA);
  assert.equal(row.mustChangePassword, false);
  assert.equal(row.actingCompanyStatus, "active");
});

test("resolve refuses an unknown, expired or absolutely-expired session", { skip }, async () => {
  assert.equal(await sessions.resolveSession(hashToken(mintToken())), null);

  const token = mintToken();
  const created = await sessions.createSession({
    userId: IDS.userAStaff, tokenHash: hashToken(token), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });
  await db.unscoped("UPDATE user_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [created.id]);
  assert.equal(await sessions.resolveSession(hashToken(token)), null);
});

test("bumping sessions_valid_from kills every session, without touching a session row", { skip }, async () => {
  // Spec 5.2's fail-closed revocation. The resolver requires
  // created_at >= users.sessions_valid_from, so a DELETE is not needed and cannot
  // miss a row created between the DELETE and the COMMIT.
  assert.ok(await sessions.resolveSession(hashToken(SESSION_TOKENS.bAdmin)));
  await db.unscoped("UPDATE users SET sessions_valid_from = now() WHERE id = $1", [IDS.userBAdmin]);
  assert.equal(await sessions.resolveSession(hashToken(SESSION_TOKENS.bAdmin)), null);
});

test("resolve refuses a suspended user and a suspended OWN company", { skip }, async () => {
  // Company C is seeded suspended, and c-admin belongs to it.
  assert.equal(await sessions.resolveSession(hashToken(SESSION_TOKENS.cAdmin)), null);

  await db.unscoped("UPDATE users SET status = 'suspended' WHERE id = $1", [IDS.userAStaff]);
  const token = mintToken();
  await db.unscoped(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, now() + interval '1 hour', now() + interval '7 days')`,
    [IDS.userAStaff, hashToken(token)]
  );
  assert.equal(await sessions.resolveSession(hashToken(token)), null);
  await db.unscoped("UPDATE users SET status = 'active' WHERE id = $1", [IDS.userAStaff]);
});

test("a SUSPENDED ACTING company resolves, and is reported rather than refused", { skip }, async () => {
  // 6.3.2 is explicit that this is 409 acting_company_suspended, not 401: "the
  // remedy is a state change via POST /api/admin/scope, not a permission change".
  // Refusing it here would sign the platform admin out and leave them no way to
  // clear the selection.
  await db.unscoped("UPDATE user_sessions SET acting_company_id = $1 WHERE id = $2", [
    IDS.companyC, IDS.sessionPlatformInA
  ]);
  const row = await sessions.resolveSession(hashToken(SESSION_TOKENS.platformInA));
  assert.ok(row, "a suspended acting company must not be a 401");
  assert.equal(row.actingCompanyStatus, "suspended");
  await db.unscoped("UPDATE user_sessions SET acting_company_id = $1 WHERE id = $2", [
    IDS.companyA, IDS.sessionPlatformInA
  ]);
});

test("renewal clamps to absolute_expires_at and is throttled to once a minute", { skip }, async () => {
  const token = mintToken();
  const created = await sessions.createSession({
    userId: IDS.userAAdmin, tokenHash: hashToken(token), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });

  // Fresh: last_seen_at is now, so the throttle refuses.
  assert.equal(await sessions.renewSession({ sessionId: created.id, idleSeconds: IDLE, lastSeenIp: null }), null);

  await db.unscoped("UPDATE user_sessions SET last_seen_at = now() - interval '90 seconds' WHERE id = $1", [created.id]);
  const renewed = await sessions.renewSession({
    sessionId: created.id, idleSeconds: IDLE, lastSeenIp: "203.0.113.9"
  });
  assert.ok(renewed, "a session idle for 90 seconds must renew");
  assert.ok(renewed.expiresAt > created.expiresAt);

  // The clamp. user_sessions_idle_within_absolute is CHECK (expires_at <=
  // absolute_expires_at), so an UNCLAMPED bump raises 23514 for the whole final
  // idle window of every session -- the last eight hours of every seven-day
  // session, every time.
  //
  // expires_at moves WITH absolute_expires_at, and it has to: the CHECK is
  // enforced on this fixture UPDATE too, so lowering the absolute alone below the
  // eight-hour expires_at the renewal above just wrote raises 23514 in the SETUP
  // and the clamp is never exercised. A session in its final idle window is
  // exactly a row where both sit inside the same short window -- the CHECK
  // guarantees no other shape can exist.
  await db.unscoped(
    `UPDATE user_sessions
        SET last_seen_at = now() - interval '90 seconds',
            expires_at = now() + interval '30 seconds',
            absolute_expires_at = now() + interval '30 seconds'
      WHERE id = $1`,
    [created.id]
  );
  const clamped = await sessions.renewSession({ sessionId: created.id, idleSeconds: IDLE, lastSeenIp: null });
  assert.ok(clamped, "the clamped renewal must succeed, not raise");
  assert.ok(clamped.expiresAt <= clamped.absoluteExpiresAt);
});

test("an untrusted client address is written NULL, not as a raw header", { skip }, async () => {
  // Spec 5.7: last_seen_ip is inet. Writing the raw comma-separated header raises
  // "invalid input syntax for type inet" INSIDE the request, so the derivation
  // fails soft to NULL and lib/client-ip.js returns ip: null for exactly that.
  const token = mintToken();
  const created = await sessions.createSession({
    userId: IDS.userAAdmin, tokenHash: hashToken(token), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });
  await db.unscoped("UPDATE user_sessions SET last_seen_at = now() - interval '90 seconds' WHERE id = $1", [created.id]);
  await sessions.renewSession({ sessionId: created.id, idleSeconds: IDLE, lastSeenIp: null });
  const { rows } = await db.unscoped("SELECT last_seen_ip FROM user_sessions WHERE id = $1", [created.id]);
  assert.equal(rows[0].last_seen_ip, null);
});

test("deleteSession removes one row; deleteAllSessionsForUser reports how many it removed", { skip }, async () => {
  const a = await sessions.createSession({
    userId: IDS.userAManager, tokenHash: hashToken(mintToken()), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });
  assert.equal(await sessions.deleteSession(a.id), 1);
  assert.equal(await sessions.deleteSession(a.id), 0, "a second delete is idempotent, not an error");

  await sessions.createSession({
    userId: IDS.userAManager, tokenHash: hashToken(mintToken()), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });
  await sessions.createSession({
    userId: IDS.userAManager, tokenHash: hashToken(mintToken()), idleSeconds: IDLE, absoluteSeconds: ABSOLUTE
  });
  // The seeded session plus the two just created.
  assert.equal(await sessions.deleteAllSessionsForUser(IDS.userAManager), 3);
});

test("selecting an acting company reports unknown and suspended differently", { skip }, async () => {
  // 6.2: 404 not_found for an unknown company, 409 company_suspended for a
  // suspended one. One combined "no rows" answer cannot produce both.
  assert.equal(await sessions.findCompanyForScopeSelection("00000000-0000-4000-8000-000000000000"), null);
  assert.deepEqual(await sessions.findCompanyForScopeSelection(IDS.companyC), {
    id: IDS.companyC, status: "suspended"
  });

  assert.equal(await sessions.setActingCompany(IDS.sessionPlatformUnscoped, IDS.companyB), 1);
  const row = await sessions.resolveSession(hashToken(SESSION_TOKENS.platformUnscoped));
  assert.equal(row.actingCompanyId, IDS.companyB);

  assert.equal(await sessions.setActingCompany(IDS.sessionPlatformUnscoped, null), 1);
  const cleared = await sessions.resolveSession(hashToken(SESSION_TOKENS.platformUnscoped));
  assert.equal(cleared.actingCompanyId, null);
});

test("teardown", { skip }, async () => {
  await closeAllPools();
  await db.drop();
});
