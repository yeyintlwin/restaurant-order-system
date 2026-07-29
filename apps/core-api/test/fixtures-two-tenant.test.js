const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, test } = require("node:test");
const { cloneTemplate, skipDatabaseTests } = require("../testing/database");
const {
  IDS,
  FIXTURE_PASSWORD,
  SESSION_TOKENS,
  TERMINAL_TOKENS,
  PAIRING_CODE,
  seedTwoTenant
} = require("../testing/fixtures/two-tenant");

test("every minted credential has the house shape and is unique", () => {
  const raw = [...Object.values(SESSION_TOKENS), ...Object.values(TERMINAL_TOKENS)];

  for (const value of raw) {
    assert.match(value, /^[A-Za-z0-9_-]{22}$/, `bad credential shape: ${value}`);
  }
  assert.equal(new Set(raw).size, raw.length);
  assert.match(PAIRING_CODE.folded, /^[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.equal(PAIRING_CODE.display, "A2CTR-00001");
  assert.ok(FIXTURE_PASSWORD.length >= 12);
});

test("every fixture uuid is mnemonic, distinct and v4-shaped", () => {
  const values = Object.values(IDS);

  for (const value of values) {
    assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.equal(new Set(values).size, values.length);
});

describe("two-tenant fixture", { skip: skipDatabaseTests() }, () => {
  let db;

  before(async () => {
    db = await cloneTemplate(__filename);
  });

  beforeEach(async () => {
    await db.resetFixtures();
    await seedTwoTenant(db);
  });

  after(async () => {
    if (db) await db.end();
  });

  test("seeding is repeatable: a truncate-and-reseed leaves the same row counts", async () => {
    const count = async (table) =>
      (await db.unscoped(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

    const first = {
      companies: await count("companies"),
      users: await count("users"),
      shops: await count("shops"),
      terminals: await count("terminals"),
      tokens: await count("terminal_tokens")
    };

    await db.resetFixtures();
    await seedTwoTenant(db);

    assert.deepEqual(
      {
        companies: await count("companies"),
        users: await count("users"),
        shops: await count("shops"),
        terminals: await count("terminals"),
        tokens: await count("terminal_tokens")
      },
      first
    );
    assert.equal(first.companies, 3);
    assert.equal(first.users, 7);
    assert.equal(first.shops, 5);
    assert.equal(first.terminals, 7);
    assert.equal(first.tokens, 8);
  });

  test("Company C is suspended and still holds an active admin, a live session and a live token", async () => {
    const company = await db.unscoped("SELECT status FROM companies WHERE id = $1", [IDS.companyC]);
    assert.equal(company.rows[0].status, "suspended");

    const admin = await db.unscoped("SELECT status, role FROM users WHERE id = $1", [IDS.userCAdmin]);
    assert.equal(admin.rows[0].status, "active");
    assert.equal(admin.rows[0].role, "company_admin");

    const session = await db.unscoped(
      "SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1 AND expires_at > now()",
      [IDS.userCAdmin]
    );
    assert.equal(session.rows[0].n, 1);

    const token = await db.unscoped(
      "SELECT count(*)::int AS n FROM terminal_tokens WHERE company_id = $1 AND revoked_at IS NULL",
      [IDS.companyC]
    );
    assert.equal(token.rows[0].n, 1);
  });

  test("Shop A3 is suspended and still holds an assignment, a live terminal and a live token", async () => {
    const shop = await db.unscoped("SELECT status FROM shops WHERE id = $1", [IDS.shopA3]);
    assert.equal(shop.rows[0].status, "suspended");

    const assignment = await db.unscoped(
      "SELECT count(*)::int AS n FROM user_shops WHERE user_id = $1 AND shop_id = $2",
      [IDS.userAManager, IDS.shopA3]
    );
    assert.equal(assignment.rows[0].n, 1);

    const terminal = await db.unscoped("SELECT status FROM terminals WHERE id = $1", [
      IDS.terminalA3Kitchen
    ]);
    assert.equal(terminal.rows[0].status, "active");

    const token = await db.unscoped(
      "SELECT count(*)::int AS n FROM terminal_tokens WHERE terminal_id = $1 AND revoked_at IS NULL",
      [IDS.terminalA3Kitchen]
    );
    assert.equal(token.rows[0].n, 1);
  });

  test("A-unassigned has zero shop assignments -- the fail-closed COALESCE case", async () => {
    const { rows } = await db.unscoped(
      "SELECT count(*)::int AS n FROM user_shops WHERE user_id = $1",
      [IDS.userAUnassigned]
    );
    assert.equal(rows[0].n, 0);
  });

  test("A-staff is assigned to two shops -- the duplicate-row semi-join case", async () => {
    const { rows } = await db.unscoped(
      "SELECT shop_id FROM user_shops WHERE user_id = $1 ORDER BY shop_id",
      [IDS.userAStaff]
    );
    assert.deepEqual(rows.map((row) => row.shop_id).sort(), [IDS.shopA1, IDS.shopA2].sort());
  });

  test("A1 holds a suspended terminal that still carries a live token", async () => {
    const terminal = await db.unscoped("SELECT status, shop_id FROM terminals WHERE id = $1", [
      IDS.terminalA1Suspended
    ]);
    assert.equal(terminal.rows[0].status, "suspended");
    assert.equal(terminal.rows[0].shop_id, IDS.shopA1);

    const token = await db.unscoped(
      "SELECT count(*)::int AS n FROM terminal_tokens " +
        "WHERE terminal_id = $1 AND revoked_at IS NULL AND expires_at > now()",
      [IDS.terminalA1Suspended]
    );
    assert.equal(token.rows[0].n, 1);
  });

  test("A1's kitchen terminal holds one live token and one admin_revoke'd token", async () => {
    const { rows } = await db.unscoped(
      "SELECT revoked_reason FROM terminal_tokens WHERE terminal_id = $1 ORDER BY revoked_at NULLS FIRST",
      [IDS.terminalA1Kitchen]
    );
    assert.deepEqual(rows.map((row) => row.revoked_reason), [null, "admin_revoke"]);
  });

  test("the platform admin has two sessions: one unscoped, one pinned to A", async () => {
    const { rows } = await db.unscoped(
      "SELECT acting_company_id FROM user_sessions WHERE user_id = $1 ORDER BY acting_company_id NULLS FIRST",
      [IDS.userPlatformAdmin]
    );
    assert.deepEqual(rows.map((row) => row.acting_company_id), [null, IDS.companyA]);
  });

  test("every shop has a table labelled '1', proving the unique index is per-shop", async () => {
    const { rows } = await db.unscoped(
      "SELECT count(*)::int AS n FROM shop_tables WHERE label = '1' AND status = 'active'"
    );
    assert.equal(rows[0].n, 5);
  });

  test("A2's cashier terminal holds exactly one live pairing code", async () => {
    const { rows } = await db.unscoped(
      "SELECT count(*)::int AS n FROM terminal_pairing_codes " +
        "WHERE terminal_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()",
      [IDS.terminalA2Counter]
    );
    assert.equal(rows[0].n, 1);
  });

  test("password hashes satisfy the column CHECK and are computed once", async () => {
    const { rows } = await db.unscoped("SELECT DISTINCT password_hash FROM users");

    assert.equal(rows.length, 1, "all seven users share one hash: scrypt at N=32768 is ~100ms");
    assert.match(rows[0].password_hash, /^scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.ok(rows[0].password_hash.length >= 40 && rows[0].password_hash.length <= 512);
  });
});
