"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const { seedTwoTenant, IDS, FIXTURE_PASSWORD } = require("../testing/fixtures/two-tenant");
const { openRuntimePool, closeAllPools } = require("../db");
const { verifyPassword, hashPassword } = require("../lib/password");
const users = require("../repositories/auth/users");

const skip = skipDatabaseTests();
let db;

test("setup", { skip }, async () => {
  db = await cloneTemplate(__filename);
  await db.resetFixtures();
  await seedTwoTenant(db);
  // The repository reaches the database through db/index.js's runtime pool, which
  // is process-wide state. The harness DSN connects as the OWNER; that is fine
  // here because these statements are DML and the two-role split is enforced by
  // the grants, not by this test.
  await openRuntimePool({ connectionString: db.connectionString, max: 4 });
});

test("the login lookup returns the hash and the two suspension facts in one read", { skip }, async () => {
  const row = await users.findByEmailForLogin("a-admin@example.test");

  assert.equal(row.id, IDS.userAAdmin);
  assert.equal(row.role, "company_admin");
  assert.equal(row.companyId, IDS.companyA);
  assert.equal(row.status, "active");
  assert.equal(row.companyStatus, "active");
  assert.equal(row.mustChangePassword, false);
  assert.equal(await verifyPassword(FIXTURE_PASSWORD, row.passwordHash), true);
});

test("a platform admin has no company, and companyStatus is null rather than missing", { skip }, async () => {
  // users_platform_admin_has_no_company makes (role = 'platform_admin') =
  // (company_id IS NULL) an invariant, so the LEFT JOIN produces NULL here on
  // every correct row. A caller writing `row.companyStatus !== 'active'` must not
  // lock the platform admin out of the platform.
  const row = await users.findByEmailForLogin("padmin@example.test");
  assert.equal(row.companyId, null);
  assert.equal(row.companyStatus, null);
});

test("the email lookup is exact and case-folded the way the column is", { skip }, async () => {
  // users.email carries CHECK (email = lower(btrim(email))), so every stored
  // address is already folded. The LOOKUP has to fold too, or a user who types
  // "A-Admin@Example.test" gets 401 invalid_credentials forever and reads it as a
  // forgotten password.
  assert.ok(await users.findByEmailForLogin("  A-Admin@Example.TEST  "));
  assert.equal(await users.findByEmailForLogin("nobody@example.test"), null);
  assert.equal(await users.findByEmailForLogin(""), null);
  assert.equal(await users.findByEmailForLogin(null), null);
});

test("failures 1 and 2 carry no lockout; the third starts the backoff", { skip }, async () => {
  // Spec 5.7: "Failures 1-2 carry no delay; from the third,
  // locked_until = now() + min(2^(n-3) minutes, 15 minutes)". A cashier who
  // mistypes twice must not be locked out mid-service.
  const first = await users.recordFailedLogin(IDS.userAStaff);
  assert.equal(first.failedLoginCount, 1);
  assert.equal(first.lockedUntil, null);

  const second = await users.recordFailedLogin(IDS.userAStaff);
  assert.equal(second.failedLoginCount, 2);
  assert.equal(second.lockedUntil, null);

  const third = await users.recordFailedLogin(IDS.userAStaff);
  assert.equal(third.failedLoginCount, 3);
  assert.ok(third.lockedUntil instanceof Date, "the third failure must set locked_until");
  const minutes = (third.lockedUntil.getTime() - Date.now()) / 60000;
  assert.ok(minutes > 0.5 && minutes < 1.5, `expected ~1 minute, got ${minutes}`);
});

test("the backoff caps at 15 minutes and never overflows the cast", { skip }, async () => {
  // power(2, n)::int overflows for n around 31 and raises 22003 INSIDE the login
  // path -- a 500 where a 401 belongs, and reachable by anyone willing to spend
  // thirty-one wrong passwords. The exponent is clamped BEFORE the cast, not after.
  await db.unscoped("UPDATE users SET failed_login_count = 200 WHERE id = $1", [IDS.userAUnassigned]);
  const row = await users.recordFailedLogin(IDS.userAUnassigned);
  assert.equal(row.failedLoginCount, 201);
  const minutes = (row.lockedUntil.getTime() - Date.now()) / 60000;
  assert.ok(minutes > 14 && minutes < 15.5, `expected the 15-minute cap, got ${minutes}`);
});

test("a successful login clears the counter and the lock, so a correct password always works", { skip }, async () => {
  await users.recordSuccessfulLogin(IDS.userAStaff);
  const { rows } = await db.unscoped(
    "SELECT failed_login_count, locked_until, last_login_at FROM users WHERE id = $1",
    [IDS.userAStaff]
  );
  assert.equal(rows[0].failed_login_count, 0);
  assert.equal(rows[0].locked_until, null);
  assert.ok(rows[0].last_login_at instanceof Date);
});

test("writing a password bumps sessions_valid_from, which is what kills every session", { skip }, async () => {
  // Spec 5.2: sessions_valid_from is the bulk-invalidation lever and the resolver
  // requires user_sessions.created_at >= it, so revocation is a fail-closed UPDATE
  // that cannot miss a row. A password change that did not bump it would leave a
  // stolen session alive after the remedy for a stolen session.
  const before = await db.unscoped("SELECT sessions_valid_from FROM users WHERE id = $1", [IDS.userAManager]);
  const hash = await hashPassword("a-brand-new-password");
  await users.writePasswordHash(IDS.userAManager, hash, { mustChangePassword: false });

  const after = await db.unscoped(
    "SELECT sessions_valid_from, password_hash, must_change_password FROM users WHERE id = $1",
    [IDS.userAManager]
  );
  assert.ok(after.rows[0].sessions_valid_from > before.rows[0].sessions_valid_from);
  assert.equal(after.rows[0].password_hash, hash);
  assert.equal(after.rows[0].must_change_password, false);
  assert.equal(await verifyPassword("a-brand-new-password", after.rows[0].password_hash), true);
});

test("the bootstrap is MONOTONIC: the guard is an audit row, not the current state", { skip }, async () => {
  // Spec 12's acceptance checkbox, verbatim: "a second run with a different address
  // exits NON-ZERO; DELETE the platform_admin row and re-run -- still non-zero (the
  // audit_events guard is monotonic, not current-state)".
  //
  // THIS IS NOT A TIDY-UP. design.md:714 and :855 make "create-platform-admin.js is
  // monotonic" the load-bearing justification for POST /api/platform/admins being the
  // ONE route in the system permitted to create a peer. A current-state guard --
  // "does a platform_admin row exist" -- would let anyone who can delete a row mint an
  // unlimited number of them, and Plan 2c would inherit an escalation exception whose
  // premise had quietly been removed.
  const hash = await hashPassword("bootstrap-password-1");

  // TRUNCATE FIRST, and it is not tidiness. seedTwoTenant makes IDS.userPlatformAdmin
  // the created_by_user_id of every company, user, shop, shop_table, user_shop,
  // terminal and pairing code it writes, and 0001_init.sql makes every attribution FK
  // ON DELETE RESTRICT -- two of them (terminals, terminal_pairing_codes) NOT NULL as
  // well, so the reference cannot even be nulled. The DELETE below therefore raises
  // 23503 users_created_by_user_id_fkey against the seeded fixture.
  //
  // Excluding the fixture admin instead -- `AND id <> IDS.userPlatformAdmin` -- would
  // run green and WEAKEN the test to nothing: with a platform_admin row still standing,
  // a current-state guard ("does a platform_admin exist") also answers
  // already_bootstrapped for `third`, so the one assertion this test exists to make
  // would pass against the very implementation it is meant to reject. Clearing the
  // fixture is what leaves genuinely ZERO platform admins at the DELETE below, which is
  // the only state in which "still already_bootstrapped" distinguishes the audit-row
  // guard from a current-state one.
  await db.resetFixtures();

  await db.unscoped("DELETE FROM audit_events WHERE action = 'platform.admin_created'");
  await db.unscoped("DELETE FROM users WHERE role = 'platform_admin'");

  const first = await users.bootstrapPlatformAdmin({
    email: "boot@example.test",
    displayName: "Boot",
    passwordHash: hash
  });
  assert.equal(first.reason, null);
  assert.ok(first.created && first.created.id);

  // The audit row is written INSIDE the same transaction as the user row. If it were
  // written afterwards by appendAuditEvent -- which opens its own connection -- a
  // crash between the two would leave the guard disarmed forever.
  const audited = await db.unscoped(
    "SELECT actor_kind, target_id, detail FROM audit_events WHERE action = 'platform.admin_created'"
  );
  assert.equal(audited.rows.length, 1);
  assert.equal(audited.rows[0].actor_kind, "system");
  assert.equal(audited.rows[0].target_id, first.created.id);
  assert.deepEqual(audited.rows[0].detail, { email: "boot@example.test" });

  // A DIFFERENT address. A current-state guard would happily create a second admin.
  const second = await users.bootstrapPlatformAdmin({
    email: "second@example.test",
    displayName: "Second",
    passwordHash: hash
  });
  assert.equal(second.created, null);
  assert.equal(second.reason, "already_bootstrapped");

  // And the monotonic half: deleting the row does not re-open the door.
  await db.unscoped("DELETE FROM users WHERE role = 'platform_admin'");
  const third = await users.bootstrapPlatformAdmin({
    email: "third@example.test",
    displayName: "Third",
    passwordHash: hash
  });
  assert.equal(third.created, null);
  assert.equal(third.reason, "already_bootstrapped");

  // Restore the fixture for the tests below, which expect one active platform admin.
  await db.unscoped("DELETE FROM audit_events WHERE action = 'platform.admin_created'");
  await db.unscoped("DELETE FROM users WHERE role = 'platform_admin'");
  await users.bootstrapPlatformAdmin({ email: "boot@example.test", displayName: "Boot", passwordHash: hash });
});

test("a repeated address inside the same bootstrap is email_taken, not already_bootstrapped", { skip }, async () => {
  // Two distinguishable refusals, because the operator's next move differs: one says
  // "the platform is already bootstrapped, use set-password.js", the other says "that
  // address is taken". Collapsing them into one null was the earlier draft's mistake.
  const hash = await hashPassword("bootstrap-password-2");
  await db.unscoped("DELETE FROM audit_events WHERE action = 'platform.admin_created'");

  const again = await users.bootstrapPlatformAdmin({
    email: "boot@example.test",
    displayName: "Boot",
    passwordHash: hash
  });
  assert.equal(again.created, null);
  assert.equal(again.reason, "email_taken");
});

test("countActivePlatformAdmins sees only active ones", { skip }, async () => {
  const before = await users.countActivePlatformAdmins();
  assert.ok(before >= 1);
  await db.unscoped("UPDATE users SET status = 'suspended' WHERE role = 'platform_admin'");
  assert.equal(await users.countActivePlatformAdmins(), 0);
  await db.unscoped("UPDATE users SET status = 'active' WHERE role = 'platform_admin'");
});

test("teardown", { skip }, async () => {
  await closeAllPools();
  await db.drop();
});
