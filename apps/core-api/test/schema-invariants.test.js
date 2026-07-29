const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");
const { cloneTemplate, migrationChecksums, skipDatabaseTests } = require("../testing/database");

// S1. Five entries, not the two the settled text names. Each one's own positive
// assertion lives in its own test below, so this is a stated shape rather than a
// hole: a Phase-2 table that omits company_id fails unless a developer
// consciously edits this list.
const TENANT_COLUMN_EXCEPTIONS = [
  "audit_events",
  "companies",
  "schema_migrations",
  "user_sessions",
  "users"
];

const CONTAINMENT_COLUMNS = ["shop_id", "terminal_id", "shop_table_id", "user_id", "pairing_code_id"];

// S2. Keyed by "<child table>.<ordered child columns>". Every entry states WHY.
const COMPOSITE_FK_EXCEPTIONS = {
  "users.created_by_user_id": "attribution, not ownership",
  "companies.created_by_user_id": "attribution, not ownership",
  "shops.created_by_user_id": "attribution, not ownership",
  "shop_tables.created_by_user_id": "attribution, not ownership",
  "user_shops.created_by_user_id": "attribution, not ownership",
  "terminals.created_by_user_id": "attribution, not ownership",
  "terminal_pairing_codes.created_by_user_id": "attribution, not ownership",
  "terminal_tokens.revoked_by_user_id": "attribution, not ownership",
  "audit_events.actor_user_id": "attribution, not ownership",
  "audit_events.actor_terminal_id":
    "attribution: references a TENANT table single-column, which needs saying out loud",
  "user_sessions.user_id": "pre-tenant: read in order to DISCOVER the tenant",
  "user_sessions.acting_company_id": "pre-tenant: read in order to DISCOVER the tenant",
  "terminal_tokens.pairing_code_id":
    "the row is already anchored by its own composite FK; making this composite needs a " +
    "4-column UNIQUE that 0001 does not create"
};

// S2b. CASCADE is permitted for exactly three FKs and nothing else.
const CASCADE_FKS = new Set([
  "user_shops.user_id,company_id",
  "user_sessions.user_id",
  "user_sessions.acting_company_id"
]);

// S3. Postgres already refuses a composite FK without a matching UNIQUE. The
// assertion with teeth is the reverse: a later migration dropping an anchor once
// its last composite FK is gone leaves the NEXT table quietly unable to declare one.
const ANCHORS = {
  users_id_company_key: ["id", "company_id"],
  shops_id_company_key: ["id", "company_id"],
  shop_tables_id_shop_company_key: ["id", "shop_id", "company_id"],
  terminals_id_shop_company_key: ["id", "shop_id", "company_id"]
};

test("S1's rule rejects a synthetic Phase-2 table that mishandles company_id", () => {
  assert.deepEqual(
    tablesMissingTenantColumn({
      companies: { id: { type: "uuid", notNull: true, isPrimaryKey: true } },
      shops: { company_id: { type: "uuid", notNull: true } },
      menu_items: { id: { type: "uuid", notNull: true }, shop_id: { type: "uuid", notNull: true } },
      menu_photos: { company_id: { type: "uuid", notNull: false } },
      menu_prices: { company_id: { type: "text", notNull: true } }
    }),
    ["menu_items", "menu_photos", "menu_prices"]
  );
});

test("S2's rule rejects a synthetic containment FK that omits company_id", () => {
  assert.deepEqual(
    foreignKeysMissingTenantColumn([
      {
        name: "shop_tables_shop_fkey",
        key: "shop_tables.shop_id,company_id",
        childColumns: ["shop_id", "company_id"],
        deleteAction: "r"
      },
      {
        name: "menu_items_shop_fkey",
        key: "menu_items.shop_id",
        childColumns: ["shop_id"],
        deleteAction: "r"
      },
      {
        name: "menu_items_terminal_fkey",
        key: "menu_items.terminal_id",
        childColumns: ["terminal_id"],
        deleteAction: "r"
      }
    ]),
    ["menu_items_shop_fkey", "menu_items_terminal_fkey"]
  );
});

test("S2b's rule rejects SET NULL, SET DEFAULT and an unlisted CASCADE", () => {
  assert.deepEqual(
    foreignKeysWithWrongDeleteAction([
      { name: "ok_restrict", key: "shops.company_id", childColumns: ["company_id"], deleteAction: "r" },
      { name: "ok_cascade", key: "user_sessions.user_id", childColumns: ["user_id"], deleteAction: "c" },
      { name: "bad_setnull", key: "menu_items.shop_id", childColumns: ["shop_id"], deleteAction: "n" },
      { name: "bad_default", key: "menu_items.user_id", childColumns: ["user_id"], deleteAction: "d" },
      { name: "bad_cascade", key: "menu_items.company_id", childColumns: ["company_id"], deleteAction: "c" }
    ]),
    ["bad_cascade:c", "bad_default:d", "bad_setnull:n"]
  );
});

test("S3's rule rejects a dropped anchor and a reshaped one", () => {
  assert.deepEqual(
    reshapedAnchors({
      users_id_company_key: ["id", "company_id"],
      shops_id_company_key: ["id", "company_id"],
      terminals_id_shop_company_key: ["id", "company_id"]
    }),
    ["shop_tables_id_shop_company_key", "terminals_id_shop_company_key"]
  );
});

describe("schema invariants", { skip: skipDatabaseTests() }, () => {
  let db;
  const catalog = { tables: {}, foreignKeys: [], uniques: {}, constraintNames: new Set() };

  before(async () => {
    db = await cloneTemplate(__filename);

    const columns = await db.unscoped(`
      SELECT c.relname AS table_name,
             a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             a.attnotnull AS not_null,
             COALESCE(pk.is_pk, false) AS is_primary_key
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN LATERAL (
          SELECT true AS is_pk FROM pg_constraint pc
           WHERE pc.conrelid = c.oid AND pc.contype = 'p' AND a.attnum = ANY (pc.conkey)
        ) pk ON true
       WHERE n.nspname = 'public' AND c.relkind = 'r'`);

    for (const row of columns.rows) {
      catalog.tables[row.table_name] = catalog.tables[row.table_name] || {};
      catalog.tables[row.table_name][row.column_name] = {
        type: row.data_type,
        notNull: row.not_null,
        isPrimaryKey: row.is_primary_key
      };
    }

    const constraints = await db.unscoped(`
      SELECT con.conname,
             con.contype,
             con.confdeltype,
             child.relname AS child_table,
             -- attname is "name", so array_agg yields name[] (OID 1003), which
             -- node-postgres has no parser for: it hands back the raw string
             -- "{id,company_id}" and every .join() below is a TypeError. The
             -- ::text cast produces text[] (OID 1009), which it does parse.
             (SELECT array_agg(att.attname::text ORDER BY u.ord)
                FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
                JOIN pg_attribute att
                  ON att.attrelid = con.conrelid AND att.attnum = u.attnum) AS child_columns
        FROM pg_constraint con
        JOIN pg_class child ON child.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = child.relnamespace
       WHERE n.nspname = 'public'`);

    for (const row of constraints.rows) {
      catalog.constraintNames.add(row.conname);
      if (row.contype === "f") {
        catalog.foreignKeys.push({
          name: row.conname,
          key: `${row.child_table}.${row.child_columns.join(",")}`,
          childTable: row.child_table,
          childColumns: row.child_columns,
          deleteAction: row.confdeltype
        });
      }
      if (row.contype === "u") catalog.uniques[row.conname] = row.child_columns;
    }
  });

  after(async () => {
    if (db) await db.end();
  });

  test("S1: every base table carries company_id uuid NOT NULL, or is a named exception", () => {
    const scanned = Object.keys(catalog.tables);
    assert.ok(scanned.length >= 11, `expected at least 11 base tables, scanned ${scanned.length}`);
    assert.deepEqual(tablesMissingTenantColumn(catalog.tables), []);
  });

  test("S1: each named exception carries its own positive assertion instead", () => {
    assert.equal(
      catalog.tables.schema_migrations.company_id,
      undefined,
      "schema_migrations must have no company_id at all"
    );

    assert.equal(catalog.tables.companies.id.type, "uuid");
    assert.equal(catalog.tables.companies.id.isPrimaryKey, true, "companies.id must be the primary key");

    assert.equal(catalog.tables.users.company_id.type, "uuid");
    assert.equal(catalog.tables.users.company_id.notNull, false, "users.company_id is nullable for platform_admin");
    assert.ok(catalog.constraintNames.has("users_platform_admin_has_no_company"));

    assert.equal(catalog.tables.user_sessions.acting_company_id.type, "uuid");
    assert.equal(catalog.tables.user_sessions.acting_company_id.notNull, false);

    assert.equal(catalog.tables.audit_events.company_id.type, "uuid");
    assert.equal(catalog.tables.audit_events.company_id.notNull, false);
    assert.ok(catalog.constraintNames.has("audit_events_shop_implies_company"));

    // The exception list itself cannot rot into naming tables that no longer exist.
    for (const table of TENANT_COLUMN_EXCEPTIONS) {
      assert.ok(catalog.tables[table], `the exception list names a table that does not exist: ${table}`);
    }
  });

  test("S2: every containment foreign key includes company_id", () => {
    assert.ok(catalog.foreignKeys.length >= 20, "the FK query returned implausibly few rows");
    assert.deepEqual(foreignKeysMissingTenantColumn(catalog.foreignKeys), []);

    const observed = new Set(catalog.foreignKeys.map((fk) => fk.key));
    for (const key of Object.keys(COMPOSITE_FK_EXCEPTIONS)) {
      assert.ok(observed.has(key), `the exception list names a foreign key that does not exist: ${key}`);
    }
  });

  test("S2b: no SET NULL or SET DEFAULT, and CASCADE only on the three named keys", () => {
    assert.deepEqual(foreignKeysWithWrongDeleteAction(catalog.foreignKeys), []);

    for (const key of CASCADE_FKS) {
      assert.ok(
        catalog.foreignKeys.some((fk) => fk.key === key),
        `the CASCADE allowlist names a foreign key that does not exist: ${key}`
      );
    }
  });

  test("S3: the four composite anchors exist by name with exact column lists", () => {
    assert.deepEqual(reshapedAnchors(catalog.uniques), []);
  });

  test("S4: every %_hash column is bytea(32), except the one that carries a PHC string", async () => {
    const { rows } = await db.unscoped(`
      SELECT c.relname AS table_name,
             a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             COALESCE(string_agg(pg_get_constraintdef(con.oid), ' '), '') AS checks
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_constraint con
          ON con.conrelid = c.oid AND con.contype = 'c' AND a.attnum = ANY (con.conkey)
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname LIKE '%\\_hash'
       GROUP BY c.relname, a.attname, a.atttypid, a.atttypmod`);

    const columns = rows.map((row) => ({
      table: row.table_name,
      column: row.column_name,
      type: row.data_type,
      checks: row.checks
    }));

    assert.ok(columns.length >= 4, `expected at least four %_hash columns, found ${columns.length}`);
    assert.deepEqual(hashColumnViolations(columns), []);

    for (const key of TEXT_HASH_EXCEPTIONS) {
      assert.ok(
        columns.some((column) => `${column.table}.${column.column}` === key),
        `the text-hash exception names a column that does not exist: ${key}`
      );
    }
  });

  test("S5: every table with updated_at has a BEFORE UPDATE set_updated_at() trigger", async () => {
    const { rows } = await db.unscoped(`
      SELECT c.relname AS table_name, pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal`);

    const triggers = {};
    for (const row of rows) {
      if (!triggers[row.table_name]) triggers[row.table_name] = [];
      triggers[row.table_name].push(row.definition);
    }

    // Conditional on the column, so the rule self-maintains as tables come and go.
    const withUpdatedAt = Object.keys(catalog.tables).filter((table) => catalog.tables[table].updated_at);
    assert.ok(withUpdatedAt.length >= 5, `implausibly few tables carry updated_at: ${withUpdatedAt.length}`);

    assert.deepEqual(tablesMissingUpdatedAtTrigger(catalog.tables, triggers), []);
  });

  test("S6: the migration ledger agrees, as a set, with the migrations directory", async () => {
    const { rows } = await db.unscoped(
      "SELECT filename, encode(checksum, 'hex') AS checksum FROM schema_migrations"
    );

    assert.deepEqual(ledgerDisagreements(migrationChecksums(), rows), []);
  });

  test("S7: no column is named like a plaintext credential", () => {
    assert.deepEqual(plaintextShapedColumns(catalog.tables), []);
  });

});
// --- the rules themselves, as pure predicates over an introspected catalogue.
// Each returns the SORTED list of offenders, so a failure prints what is wrong
// rather than "expected true to be false".

function tablesMissingTenantColumn(tables) {
  return Object.keys(tables)
    .filter((table) => !TENANT_COLUMN_EXCEPTIONS.includes(table))
    .filter((table) => {
      const column = tables[table].company_id;
      return !column || column.type !== "uuid" || column.notNull !== true;
    })
    .sort();
}

function foreignKeysMissingTenantColumn(foreignKeys) {
  return foreignKeys
    .filter((fk) => !COMPOSITE_FK_EXCEPTIONS[fk.key])
    .filter((fk) => fk.childColumns.some((column) => CONTAINMENT_COLUMNS.includes(column)))
    .filter((fk) => !fk.childColumns.includes("company_id"))
    .map((fk) => fk.name)
    .sort();
}

function foreignKeysWithWrongDeleteAction(foreignKeys) {
  // 'r' RESTRICT everywhere, 'c' CASCADE only on the allowlist. 'n' (SET NULL)
  // and 'd' (SET DEFAULT) are impossible by construction on a composite FK whose
  // company_id is NOT NULL, and are a silent history rewrite on a single-column one.
  return foreignKeys
    .filter((fk) => fk.deleteAction !== (CASCADE_FKS.has(fk.key) ? "c" : "r"))
    .map((fk) => `${fk.name}:${fk.deleteAction}`)
    .sort();
}

function reshapedAnchors(uniques) {
  return Object.keys(ANCHORS)
    .filter((name) => JSON.stringify(uniques[name]) !== JSON.stringify(ANCHORS[name]))
    .sort();
}

// S4. A one-entry literal, in the same style as S1: a Phase-2 %_hash column
// added as text fails unless a developer consciously edits this.
const TEXT_HASH_EXCEPTIONS = ["users.password_hash"];

function hashColumnViolations(columns) {
  return columns
    .filter((column) => {
      if (TEXT_HASH_EXCEPTIONS.includes(`${column.table}.${column.column}`)) {
        // Postgres renders LIKE as ~~ in pg_get_constraintdef, so match the literal.
        return column.type !== "text" || !/'scrypt\$%'/.test(column.checks);
      }
      return (
        column.type !== "bytea" ||
        !column.checks.includes(`octet_length(${column.column}) = 32`)
      );
    })
    .map((column) => `${column.table}.${column.column}`)
    .sort();
}

function tablesMissingUpdatedAtTrigger(tables, triggers) {
  return Object.keys(tables)
    .filter((table) => tables[table].updated_at)
    .filter(
      (table) =>
        !(triggers[table] || []).some(
          (definition) =>
            /BEFORE UPDATE ON /.test(definition) &&
            /EXECUTE FUNCTION set_updated_at\(\)/.test(definition)
        )
    )
    .sort();
}

function ledgerDisagreements(diskRows, ledgerRows) {
  const keys = (rows) => rows.map((row) => `${row.filename}:${row.checksum}`);
  const disk = keys(diskRows);
  const ledger = keys(ledgerRows);
  return [
    ...disk.filter((key) => !ledger.includes(key)).map((key) => `disk-only ${key}`),
    ...ledger.filter((key) => !disk.includes(key)).map((key) => `ledger-only ${key}`)
  ].sort();
}

// S7. Exact names only: password_hash and token_hash are the shapes this schema
// wants, and a substring rule would forbid them.
const PLAINTEXT_COLUMN_NAMES = ["password", "token", "code", "secret", "session_id"];

function plaintextShapedColumns(tables) {
  const found = [];
  for (const table of Object.keys(tables)) {
    for (const column of Object.keys(tables[table])) {
      if (PLAINTEXT_COLUMN_NAMES.includes(column)) found.push(`${table}.${column}`);
    }
  }
  return found.sort();
}
