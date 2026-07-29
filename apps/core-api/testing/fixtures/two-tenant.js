"use strict";

const crypto = require("node:crypto");

// Hardcoded mnemonic UUIDs, never random, so a failure prints
// "expected aaaaaaaa-0003-...-0002, got bbbbbbbb-0003-...-0001" and you know which
// tenant leaked without opening a second window.
//
//   prefix : aaaaaaaa = company A, bbbbbbbb = B, cccccccc = C, 00000000 = platform
//   group2 : 0001 company  0002 shop   0003 user      0004 shop_table
//            0005 terminal 0006 token  0007 pairing   0008 session
const IDS = {
  companyA: "aaaaaaaa-0001-4000-8000-000000000001",
  companyB: "bbbbbbbb-0001-4000-8000-000000000001",
  companyC: "cccccccc-0001-4000-8000-000000000001",

  shopA1: "aaaaaaaa-0002-4000-8000-000000000001",
  shopA2: "aaaaaaaa-0002-4000-8000-000000000002",
  shopA3: "aaaaaaaa-0002-4000-8000-000000000003",
  shopB1: "bbbbbbbb-0002-4000-8000-000000000001",
  shopC1: "cccccccc-0002-4000-8000-000000000001",

  userPlatformAdmin: "00000000-0003-4000-8000-000000000001",
  userAAdmin: "aaaaaaaa-0003-4000-8000-000000000001",
  userAManager: "aaaaaaaa-0003-4000-8000-000000000002",
  userAStaff: "aaaaaaaa-0003-4000-8000-000000000003",
  userAUnassigned: "aaaaaaaa-0003-4000-8000-000000000004",
  userBAdmin: "bbbbbbbb-0003-4000-8000-000000000001",
  userCAdmin: "cccccccc-0003-4000-8000-000000000001",

  tableA1: "aaaaaaaa-0004-4000-8000-000000000001",
  tableA2: "aaaaaaaa-0004-4000-8000-000000000002",
  tableA3: "aaaaaaaa-0004-4000-8000-000000000003",
  tableB1: "bbbbbbbb-0004-4000-8000-000000000001",
  tableC1: "cccccccc-0004-4000-8000-000000000001",

  terminalA1Kitchen: "aaaaaaaa-0005-4000-8000-000000000001",
  terminalA1Suspended: "aaaaaaaa-0005-4000-8000-000000000002",
  terminalA2Kitchen: "aaaaaaaa-0005-4000-8000-000000000003",
  terminalA2Counter: "aaaaaaaa-0005-4000-8000-000000000004",
  terminalA3Kitchen: "aaaaaaaa-0005-4000-8000-000000000005",
  terminalB1Kitchen: "bbbbbbbb-0005-4000-8000-000000000001",
  terminalC1Kitchen: "cccccccc-0005-4000-8000-000000000001",

  tokenA1KitchenLive: "aaaaaaaa-0006-4000-8000-000000000001",
  tokenA1KitchenRevoked: "aaaaaaaa-0006-4000-8000-000000000002",
  tokenA1SuspendedLive: "aaaaaaaa-0006-4000-8000-000000000003",
  tokenA2KitchenLive: "aaaaaaaa-0006-4000-8000-000000000004",
  tokenA2CounterLive: "aaaaaaaa-0006-4000-8000-000000000005",
  tokenA3KitchenLive: "aaaaaaaa-0006-4000-8000-000000000006",
  tokenB1KitchenLive: "bbbbbbbb-0006-4000-8000-000000000001",
  tokenC1KitchenLive: "cccccccc-0006-4000-8000-000000000001",

  pairingCodeA2Counter: "aaaaaaaa-0007-4000-8000-000000000001",

  sessionPlatformUnscoped: "00000000-0008-4000-8000-000000000001",
  sessionPlatformInA: "00000000-0008-4000-8000-000000000002",
  sessionAAdmin: "aaaaaaaa-0008-4000-8000-000000000001",
  sessionAManager: "aaaaaaaa-0008-4000-8000-000000000002",
  sessionAStaff: "aaaaaaaa-0008-4000-8000-000000000003",
  sessionAUnassigned: "aaaaaaaa-0008-4000-8000-000000000004",
  sessionBAdmin: "bbbbbbbb-0008-4000-8000-000000000001",
  sessionCAdmin: "cccccccc-0008-4000-8000-000000000001"
};

// 22 Base64URL characters, the shape lib/tokens.js mints, but fixed so a failing
// assertion prints something a human recognises.
const SESSION_TOKENS = {
  platformUnscoped: "SessionPlatformUnscopd",
  platformInA: "SessionPlatformInAaaaa",
  aAdmin: "SessionAdminAaaaaaaaaa",
  aManager: "SessionManagerAaaaaaaa",
  aStaff: "SessionStaffAaaaaaaaaa",
  aUnassigned: "SessionUnassignedAaaaa",
  bAdmin: "SessionAdminBbbbbbbbbb",
  cAdmin: "SessionAdminCccccccccc"
};

const TERMINAL_TOKENS = {
  a1KitchenLive: "TokenA1KitchenLiveaaaa",
  a1KitchenRevoked: "TokenA1KitchenRevokedX",
  a1SuspendedLive: "TokenA1SuspendedLiveaa",
  a2KitchenLive: "TokenA2KitchenLiveaaaa",
  a2CounterLive: "TokenA2CounterLiveaaaa",
  a3KitchenLive: "TokenA3KitchenLiveaaaa",
  b1KitchenLive: "TokenB1KitchenLivebbbb",
  c1KitchenLive: "TokenC1KitchenLivecccc"
};

// Crockford base32, 10 characters, displayed XXXXX-XXXXX. Folded before hashing:
// uppercase, dashes and whitespace stripped, I/L -> 1, O -> 0.
const PAIRING_CODE = { display: "A2CTR-00001", folded: "A2CTR00001" };

const FIXTURE_PASSWORD = "fixture-password-1234";

// Guards against a typo silently shortening a credential and making a "22 Base64URL
// characters" assertion elsewhere pass for the wrong reason.
for (const value of [...Object.values(SESSION_TOKENS), ...Object.values(TERMINAL_TOKENS)]) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new Error(`two-tenant fixture credential is not 22 Base64URL chars: ${value}`);
  }
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest();

// Computed ONCE at module load. scrypt at N=32768 is ~100 ms; seven users times a
// per-test re-seed would dominate every database suite in the service. All seven
// users share one password, so one hash covers the fixture.
//
// PHC-style string, matching the users.password_hash CHECK (LIKE 'scrypt$%').
// maxmem: 128 * 32768 * 8 is exactly 33,554,432 and Node's default cap is exactly
// 32 MiB with the implementation needing slightly more, so omitting it throws at
// module load. lib/password.js must parse this encoding -- base64url, not base64.
const FIXTURE_PASSWORD_HASH = (() => {
  const salt = Buffer.from("core-api-fixture", "utf8");
  const key = crypto.scryptSync(FIXTURE_PASSWORD.normalize("NFKC"), salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$N=32768,r=8,p=1$${salt.toString("base64url")}$${key.toString("base64url")}`;
})();

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

async function insert(db, table, rows) {
  for (const row of rows) {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    await db.unscoped(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
      columns.map((column) => row[column])
    );
  }
}

function user(id, companyId, role, email, displayName, createdBy) {
  return {
    id,
    company_id: companyId,
    role,
    email,
    display_name: displayName,
    password_hash: FIXTURE_PASSWORD_HASH,
    created_by_user_id: createdBy
  };
}

function session(id, userId, actingCompanyId, rawToken, now) {
  return {
    id,
    user_id: userId,
    acting_company_id: actingCompanyId,
    token_hash: sha256(rawToken),
    expires_at: new Date(now + 8 * 60 * MINUTE),
    absolute_expires_at: new Date(now + 7 * DAY)
  };
}

function terminal(id, companyId, shopId, kind, name, status, createdBy) {
  return {
    id,
    company_id: companyId,
    shop_id: shopId,
    kind,
    name,
    status,
    created_by_user_id: createdBy
  };
}

function token(id, companyId, shopId, terminalId, rawToken, now, revocation) {
  return {
    id,
    company_id: companyId,
    shop_id: shopId,
    terminal_id: terminalId,
    token_hash: sha256(rawToken),
    expires_at: new Date(now + 90 * DAY),
    revoked_at: revocation ? new Date(now - MINUTE) : null,
    revoked_reason: revocation || null
  };
}

// Seeding order is forced by the FK cycle: companies with created_by_user_id NULL
// -> the platform admin (company_id NULL) -> tenant users created by them ->
// UPDATE companies to close the cycle. terminals.created_by_user_id and
// terminal_pairing_codes.created_by_user_id are NOT NULL, so they come last.
async function seedTwoTenant(db) {
  const now = Date.now();
  const pAdmin = IDS.userPlatformAdmin;

  await insert(db, "companies", [
    { id: IDS.companyA, name: "Company A", status: "active" },
    { id: IDS.companyB, name: "Company B", status: "active" },
    { id: IDS.companyC, name: "Company C", status: "suspended" }
  ]);

  await insert(db, "users", [
    user(pAdmin, null, "platform_admin", "padmin@example.test", "P Admin", null)
  ]);

  await insert(db, "users", [
    user(IDS.userAAdmin, IDS.companyA, "company_admin", "a-admin@example.test", "A Admin", pAdmin),
    user(IDS.userAManager, IDS.companyA, "shop_manager", "a-manager@example.test", "A Manager", pAdmin),
    user(IDS.userAStaff, IDS.companyA, "staff", "a-staff@example.test", "A Staff", pAdmin),
    user(IDS.userAUnassigned, IDS.companyA, "staff", "a-unassigned@example.test", "A Unassigned", pAdmin),
    user(IDS.userBAdmin, IDS.companyB, "company_admin", "b-admin@example.test", "B Admin", pAdmin),
    user(IDS.userCAdmin, IDS.companyC, "company_admin", "c-admin@example.test", "C Admin", pAdmin)
  ]);

  await db.unscoped("UPDATE companies SET created_by_user_id = $1", [pAdmin]);

  await insert(db, "shops", [
    { id: IDS.shopA1, company_id: IDS.companyA, name: "Shop A1", time_zone: "Asia/Tokyo",
      business_day_rollover_hour: 6, status: "active", created_by_user_id: pAdmin },
    { id: IDS.shopA2, company_id: IDS.companyA, name: "Shop A2", time_zone: "Asia/Tokyo",
      business_day_rollover_hour: 6, status: "active", created_by_user_id: pAdmin },
    // Suspended, and still carrying an assignment, a terminal and a live token.
    { id: IDS.shopA3, company_id: IDS.companyA, name: "Shop A3", time_zone: "Asia/Yangon",
      business_day_rollover_hour: 4, status: "suspended", created_by_user_id: pAdmin },
    { id: IDS.shopB1, company_id: IDS.companyB, name: "Shop B1", time_zone: "Asia/Tokyo",
      business_day_rollover_hour: 6, status: "active", created_by_user_id: pAdmin },
    { id: IDS.shopC1, company_id: IDS.companyC, name: "Shop C1", time_zone: "Asia/Tokyo",
      business_day_rollover_hour: 6, status: "active", created_by_user_id: pAdmin }
  ]);

  // All labelled '1': shop_tables_shop_label_active_key is per-shop, and this is
  // what proves it.
  await insert(db, "shop_tables", [
    { id: IDS.tableA1, company_id: IDS.companyA, shop_id: IDS.shopA1, label: "1", created_by_user_id: pAdmin },
    { id: IDS.tableA2, company_id: IDS.companyA, shop_id: IDS.shopA2, label: "1", created_by_user_id: pAdmin },
    { id: IDS.tableA3, company_id: IDS.companyA, shop_id: IDS.shopA3, label: "1", created_by_user_id: pAdmin },
    { id: IDS.tableB1, company_id: IDS.companyB, shop_id: IDS.shopB1, label: "1", created_by_user_id: pAdmin },
    { id: IDS.tableC1, company_id: IDS.companyC, shop_id: IDS.shopC1, label: "1", created_by_user_id: pAdmin }
  ]);

  await insert(db, "user_shops", [
    { company_id: IDS.companyA, user_id: IDS.userAManager, shop_id: IDS.shopA1, created_by_user_id: pAdmin },
    { company_id: IDS.companyA, user_id: IDS.userAManager, shop_id: IDS.shopA3, created_by_user_id: pAdmin },
    { company_id: IDS.companyA, user_id: IDS.userAStaff, shop_id: IDS.shopA1, created_by_user_id: pAdmin },
    { company_id: IDS.companyA, user_id: IDS.userAStaff, shop_id: IDS.shopA2, created_by_user_id: pAdmin }
    // A-unassigned deliberately gets none: array_agg over zero rows returns NULL,
    // and without COALESCE(..., '{}') that scope is byte-identical to a company
    // admin's -- revocation escalating privilege.
  ]);

  await insert(db, "user_sessions", [
    session(IDS.sessionPlatformUnscoped, pAdmin, null, SESSION_TOKENS.platformUnscoped, now),
    session(IDS.sessionPlatformInA, pAdmin, IDS.companyA, SESSION_TOKENS.platformInA, now),
    session(IDS.sessionAAdmin, IDS.userAAdmin, IDS.companyA, SESSION_TOKENS.aAdmin, now),
    session(IDS.sessionAManager, IDS.userAManager, IDS.companyA, SESSION_TOKENS.aManager, now),
    session(IDS.sessionAStaff, IDS.userAStaff, IDS.companyA, SESSION_TOKENS.aStaff, now),
    session(IDS.sessionAUnassigned, IDS.userAUnassigned, IDS.companyA, SESSION_TOKENS.aUnassigned, now),
    session(IDS.sessionBAdmin, IDS.userBAdmin, IDS.companyB, SESSION_TOKENS.bAdmin, now),
    session(IDS.sessionCAdmin, IDS.userCAdmin, IDS.companyC, SESSION_TOKENS.cAdmin, now)
  ]);

  await insert(db, "terminals", [
    terminal(IDS.terminalA1Kitchen, IDS.companyA, IDS.shopA1, "kitchen_display", "Kitchen A1", "active", pAdmin),
    // Suspended terminal holding a live token: a bearer resolver written as a bare
    // token_hash probe passes every other fixture and fails only here.
    terminal(IDS.terminalA1Suspended, IDS.companyA, IDS.shopA1, "epaper_hub", "Old Panel A1", "suspended", pAdmin),
    terminal(IDS.terminalA2Kitchen, IDS.companyA, IDS.shopA2, "kitchen_display", "Kitchen A2", "active", pAdmin),
    // The cross-shop escalation target for Mode 3.
    terminal(IDS.terminalA2Counter, IDS.companyA, IDS.shopA2, "cashier_counter", "Counter A2", "active", pAdmin),
    terminal(IDS.terminalA3Kitchen, IDS.companyA, IDS.shopA3, "kitchen_display", "Kitchen A3", "active", pAdmin),
    terminal(IDS.terminalB1Kitchen, IDS.companyB, IDS.shopB1, "kitchen_display", "Kitchen B1", "active", pAdmin),
    terminal(IDS.terminalC1Kitchen, IDS.companyC, IDS.shopC1, "kitchen_display", "Kitchen C1", "active", pAdmin)
  ]);

  await insert(db, "terminal_pairing_codes", [
    {
      id: IDS.pairingCodeA2Counter,
      company_id: IDS.companyA,
      shop_id: IDS.shopA2,
      terminal_id: IDS.terminalA2Counter,
      code_hash: sha256(PAIRING_CODE.folded),
      expires_at: new Date(now + 15 * MINUTE),
      created_by_user_id: pAdmin
    }
  ]);

  await insert(db, "terminal_tokens", [
    token(IDS.tokenA1KitchenLive, IDS.companyA, IDS.shopA1, IDS.terminalA1Kitchen, TERMINAL_TOKENS.a1KitchenLive, now, null),
    token(IDS.tokenA1KitchenRevoked, IDS.companyA, IDS.shopA1, IDS.terminalA1Kitchen, TERMINAL_TOKENS.a1KitchenRevoked, now, "admin_revoke"),
    token(IDS.tokenA1SuspendedLive, IDS.companyA, IDS.shopA1, IDS.terminalA1Suspended, TERMINAL_TOKENS.a1SuspendedLive, now, null),
    token(IDS.tokenA2KitchenLive, IDS.companyA, IDS.shopA2, IDS.terminalA2Kitchen, TERMINAL_TOKENS.a2KitchenLive, now, null),
    token(IDS.tokenA2CounterLive, IDS.companyA, IDS.shopA2, IDS.terminalA2Counter, TERMINAL_TOKENS.a2CounterLive, now, null),
    token(IDS.tokenA3KitchenLive, IDS.companyA, IDS.shopA3, IDS.terminalA3Kitchen, TERMINAL_TOKENS.a3KitchenLive, now, null),
    token(IDS.tokenB1KitchenLive, IDS.companyB, IDS.shopB1, IDS.terminalB1Kitchen, TERMINAL_TOKENS.b1KitchenLive, now, null),
    token(IDS.tokenC1KitchenLive, IDS.companyC, IDS.shopC1, IDS.terminalC1Kitchen, TERMINAL_TOKENS.c1KitchenLive, now, null)
  ]);
}

module.exports = {
  IDS,
  FIXTURE_PASSWORD,
  FIXTURE_PASSWORD_HASH,
  SESSION_TOKENS,
  TERMINAL_TOKENS,
  PAIRING_CODE,
  seedTwoTenant
};
