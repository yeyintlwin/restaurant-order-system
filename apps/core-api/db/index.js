const { AsyncLocalStorage } = require("node:async_hooks");

const pool = require("./pool");
const { ApiError, pgErrorToHttp } = require("./errors");
const { assertTenantScope, assertPlatformScope } = require("./scope");

const SHOP_SCOPE_VALUES = [false, "active", "administered"];

const COMPANY_PREDICATE = /\bcompany_id\b\s*=\s*\$1\b/i;
// Every operand company_id is compared or assigned to. A hardcoded uuid and a
// SET company_id = $3 are both caught here.
//
// Deliberately NOT a lookahead of the form /company_id\s*=\s*(?!\$1\b)/. There
// `\s*` can match zero-width after the `=`, so the lookahead is evaluated
// against " $1" -- leading space -- the negative lookahead succeeds, and the one
// correct predicate `company_id = $1` is rejected as misbound. Capturing the
// operand and testing it leaves no such backtracking hole.
const COMPANY_OPERAND = /\bcompany_id\b\s*=\s*([^\s,)]+)/gi;
const ALLOWED_COMPANY_OPERAND = /^(?:\$1|[a-z_][a-z0-9_]*\.company_id)$/i;

function companyIdIsMisbound(sql) {
  COMPANY_OPERAND.lastIndex = 0;
  for (let match = COMPANY_OPERAND.exec(sql); match !== null; match = COMPANY_OPERAND.exec(sql)) {
    if (!ALLOWED_COMPANY_OPERAND.test(match[1])) return true;
  }
  return false;
}
const SHOP_PREDICATE = /\bshop_id\b\s*=\s*ANY\s*\(\s*\$2\s*\)/i;
const INSERT_SHAPE = /^(\s*INSERT\s+INTO\s+[a-z_][a-z0-9_]*\s*\()([^()]+)(\)\s*VALUES\s*\()/i;
const MULTI_ROW_VALUES = /\)\s*,\s*\(/;

function statementKind(sql) {
  const match = sql.match(/^\s*([a-z]+)/i);
  return match === null ? "" : match[1].toUpperCase();
}

function highestPlaceholder(text) {
  let highest = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) {
    highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

// The SET list of an UPDATE, taken as everything between SET and the first
// WHERE. Repository SQL is hand-written and single-statement, so the simple
// slice is exact here; a subselect in the SET list would only make the slice
// SHORTER, and companyIdIsMisbound already covers what that would hide.
function updateSetList(sql) {
  const setAt = sql.search(/\bSET\b/i);
  if (setAt === -1) return "";
  const whereAt = sql.search(/\bWHERE\b/i);
  return whereAt === -1 || whereAt < setAt ? sql.slice(setAt) : sql.slice(setAt, whereAt);
}

// PURE. Turns a descriptor plus caller parameters into the exact text and
// values that will be sent, or throws. Every rule here is a tenant-isolation
// rule, which is why they are assertions and not documentation.
function buildTenantStatement(scope, descriptor, params = []) {
  assertTenantScope(scope);

  if (descriptor === null || typeof descriptor !== "object") {
    throw new Error("tenantQuery requires a descriptor object { sql, shopScoped, conflicts }");
  }
  const { sql, shopScoped, conflicts } = descriptor;
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new Error("tenantQuery descriptor requires sql");
  }
  if (!SHOP_SCOPE_VALUES.includes(shopScoped)) {
    throw new Error(
      `tenantQuery descriptor requires shopScoped false | "active" | "administered" (got ${JSON.stringify(
        shopScoped === undefined ? null : shopScoped
      )})`
    );
  }
  if (conflicts !== undefined && (conflicts === null || typeof conflicts !== "object")) {
    throw new Error("tenantQuery descriptor conflicts must be an object mapping constraint name to error code");
  }
  if (!Array.isArray(params)) {
    throw new Error("tenantQuery params must be an array");
  }

  const kind = statementKind(sql);
  const values = [scope.companyId];
  let text = sql;

  if (kind === "INSERT") {
    if (shopScoped !== false) {
      throw new Error(
        "tenantQuery: an INSERT cannot declare shopScoped; resolve the shop with a scoped SELECT first and let the composite foreign key anchor the write"
      );
    }
    if (/\bcompany_id\b/i.test(sql)) {
      throw new Error(
        "tenantQuery: an INSERT may not name company_id; the helper injects the column and the scope's value"
      );
    }
    if (/\$1\b/.test(sql)) {
      throw new Error("tenantQuery: $1 is reserved for company_id; an INSERT's own parameters start at $2");
    }
    if (MULTI_ROW_VALUES.test(sql)) {
      throw new Error("tenantQuery: an INSERT must have a single VALUES row");
    }
    text = sql.replace(INSERT_SHAPE, (match, head, columns, tail) => `${head}company_id, ${columns}${tail}$1, `);
    if (text === sql) {
      throw new Error("tenantQuery supports INSERT INTO <table> (<columns>) VALUES (...) only");
    }
  } else {
    // Order matters, and each step is the most specific answer available at that
    // point. Misbinding first: `SET company_id = $2` and `WHERE company_id = $2`
    // are both "compared to the wrong thing", and saying so beats the vaguer
    // "an UPDATE may not assign company_id" or "must filter on company_id = $1".
    if (companyIdIsMisbound(sql)) {
      throw new Error("tenantQuery: company_id may only be compared to $1 or to another company_id column");
    }
    // Then a correctly-bound but still forbidden assignment: SET company_id = $1.
    if (kind === "UPDATE" && /\bcompany_id\b/i.test(updateSetList(sql))) {
      throw new Error("tenantQuery: an UPDATE may not assign company_id; the scope owns that column");
    }
    // Only then the absence of the predicate entirely.
    if (!COMPANY_PREDICATE.test(sql)) {
      throw new Error("tenantQuery: the SQL must filter on company_id = $1");
    }
    if (shopScoped === false) {
      if (SHOP_PREDICATE.test(sql)) {
        throw new Error('tenantQuery: shop_id = ANY($2) requires shopScoped "active" or "administered"');
      }
    } else {
      if (!SHOP_PREDICATE.test(sql)) {
        throw new Error(`tenantQuery: shopScoped "${shopScoped}" requires the SQL to filter on shop_id = ANY($2)`);
      }
      const shopIds = shopScoped === "active" ? scope.shopIds : scope.administeredShopIds;
      const setName = shopScoped === "active" ? "shopIds" : "administeredShopIds";
      // A missing set must be a throw, never a NULL that widens the query.
      if (!Array.isArray(shopIds) || !shopIds.every((id) => typeof id === "string")) {
        throw new Error(`tenantQuery: this scope carries no ${setName} to bind`);
      }
      values.push(shopIds);
    }
  }

  values.push(...params);

  const highest = highestPlaceholder(text);
  if (highest !== values.length) {
    throw new Error(
      `tenantQuery: the SQL uses $${highest} but ${values.length} value${
        values.length === 1 ? " is" : "s are"
      } bound; caller parameters start at $${values.length - params.length + 1}`
    );
  }

  return { text, values };
}

// One open transaction per async context. tenantQuery takes no client argument
// on purpose: a repository that could choose its own connection could also
// choose one with nobody's company_id set.
const transactionStorage = new AsyncLocalStorage();

// err.constraint is read to pick a declared code and is NEVER serialised, which
// keeps _key/_fkey/_check strings out of every response and decouples the API
// vocabulary from the DDL. An undeclared constraint stays a raw error so the
// top-level handler answers 500 rather than inventing a code.
function translatePgError(error, conflicts) {
  const mapped = pgErrorToHttp(error && error.code);
  if (mapped === null) return error;
  if (mapped.code !== null) return new ApiError(mapped.status, mapped.code);
  const declared =
    conflicts &&
    error &&
    typeof error.constraint === "string" &&
    Object.prototype.hasOwnProperty.call(conflicts, error.constraint)
      ? conflicts[error.constraint]
      : null;
  return declared === null ? error : new ApiError(mapped.status, declared);
}

// One client, one transaction, one company_id, for the whole of fn.
async function withTenantScope(scope, fn) {
  assertTenantScope(scope);
  if (typeof fn !== "function") throw new Error("withTenantScope requires a function");

  const open = transactionStorage.getStore();
  if (open !== undefined) {
    if (open.scope !== scope) {
      throw new Error("withTenantScope() cannot open a second scope inside an open transaction");
    }
    // Composition: a repository calling another repository joins the caller's
    // transaction rather than deadlocking against it on a second connection.
    return fn();
  }

  const client = await pool.acquireRuntimeClient();
  let committed = false;
  try {
    await client.query("BEGIN");
    // A parameter cannot appear in SET LOCAL, so the GUC is written with
    // set_config(..., is_local => true), which is transaction-local in exactly
    // the same way and keeps the value out of the statement text.
    await client.query("SELECT set_config('app.company_id', $1, true)", [scope.companyId]);
    const result = await transactionStorage.run({ client, scope }, fn);
    await client.query("COMMIT");
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // The connection is already gone; releasing it is all that is left.
      }
    }
    client.release();
  }
}

// The only way to issue SQL under a tenant scope.
async function tenantQuery(scope, descriptor, params = []) {
  const store = transactionStorage.getStore();
  if (store === undefined) {
    throw new Error("tenantQuery() must run inside withTenantScope()");
  }
  if (store.scope !== scope) {
    throw new Error("tenantQuery() was given a different scope than the open transaction");
  }

  const { text, values } = buildTenantStatement(scope, descriptor, params);
  try {
    return await store.client.query(text, values);
  } catch (error) {
    throw translatePgError(error, descriptor.conflicts);
  }
}

// ---------------------------------------------------------------------------
// The platform seam
// ---------------------------------------------------------------------------
// Spec §5.4: repositories/platform/ holds only genuinely cross-tenant operations
// and exports the deliberately alarming name that fronts them. That NAME is not
// written here -- structural rule C5 and the spec's own definition-of-done grep
// both require it to appear only under repositories/platform/, which is what makes
// "the entire cross-tenant surface is one grep" true. The primitive
// lives HERE rather than there for the reason C2 and C4 exist: db/ is the one
// directory allowed to hold a raw connection, and putting it anywhere else would
// mean widening an allowlist whose own comment says that adding a file is always
// the wrong repair.
//
// There is no company_id to bind and no app.company_id to set, which is the whole
// point -- so none of buildTenantStatement's predicates can apply. What replaces
// them is narrower than it looks:
//
//   1. The scope must be STAMPED and kind === 'platform'. An unscoped platform
//      admin is the only actor who has one.
//   2. A WRITE may only target a platform-owned table. Reads stay open, because a
//      platform admin legitimately reads across tenants -- the console's Companies
//      screen counts every company's shops and tables. Writes do not: a platform
//      admin changing something inside a company does it by selecting that company
//      and driving the ORDINARY tenant repositories under an ordinary tenant
//      scope, which is what §5.4 says and what keeps the tenant choke point on the
//      path that mutates tenant rows.
//
// Rule 2 is the one that would be missing if this were written from the spec
// sentence alone, and it is the half that matters: a hatch that can only READ
// widely is an information-disclosure risk bounded by the role that already sees
// the data, while one that can WRITE widely is a way to edit another company's
// rows with no company_id in sight.
// `shops` is the fourth, and it is here for exactly one column. A branch's LOGO is
// the platform owner's, set from the Companies screen where they are above every
// company and inside none -- so the statement that writes it has no company_id to
// be scoped by, which is what this hatch is for.
//
// The guard is table-level and cannot say "only logo_key", so the narrowing lives
// where it can be read: repositories/platform/logos.js is the only file that writes
// shops through this seam, it is small, and its single UPDATE names one column and
// binds one id. Everything else about a shop -- its name, its country, its manager
// -- still goes through the tenant choke point after a company is selected, which
// is why opening a branch did not need this and setting its mark does.
const PLATFORM_WRITABLE_TABLES = Object.freeze(["companies", "users", "audit_events", "shops"]);

// EVERY write target in the statement, not just the leading verb's.
//
// The first version of this read only the first word, and a data-modifying CTE
// walked straight past it: `WITH d AS (DELETE FROM shop_tables RETURNING id)
// SELECT * FROM d` is a SELECT to statementKind() and a DELETE to Postgres. So is
// `WITH x AS (SELECT 1) UPDATE shops SET ...`. Three shapes, all of them writes to
// tenant tables through the one hatch that is allowed to ignore company_id.
//
// Scanning globally rather than anchoring at the start is what closes it, and it
// costs nothing: a statement with no write verb in it produces no matches.
//
// `public.` and double quotes are tolerated because refusing them was a false
// NEGATIVE in the first version -- INSERT INTO "companies" is an ordinary way to
// write an ordinary statement, and a guard that refuses legitimate SQL teaches
// people to route around it.
const WRITE_TARGET = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/gi;
const WRITE_VERB = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
// SELECT ... FOR UPDATE is a READ that takes a row lock, and the word UPDATE in it
// is not a verb. Left in, the scan below sees a write verb, finds no table after
// it, and fails closed -- refusing the exact statement that makes the
// last-platform-admin check race-free. A guard that refuses correct SQL teaches
// people to route around it, which is how the guard stops guarding anything.
const LOCKING_CLAUSE = /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b/gi;

function assertPlatformStatement(sql) {
  const scanned = sql.replace(LOCKING_CLAUSE, " ");
  if (!WRITE_VERB.test(scanned)) return;

  WRITE_TARGET.lastIndex = 0;
  const targets = [];
  for (let m = WRITE_TARGET.exec(scanned); m !== null; m = WRITE_TARGET.exec(scanned)) {
    targets.push({ verb: m[1].toUpperCase().replace(/\s+/g, " "), table: m[2].toLowerCase() });
  }
  // A write verb is present but no target parsed out of it. Fail CLOSED: an
  // unparseable write is not waved through on the grounds that the regex did not
  // understand it.
  if (targets.length === 0) {
    throw new Error("platformQuery: cannot identify the table this statement writes to");
  }
  for (const { verb, table } of targets) {
    if (PLATFORM_WRITABLE_TABLES.includes(table)) continue;
    throw new Error(
      `platformQuery: ${verb} "${table}" is not a platform-owned table ` +
      `(${PLATFORM_WRITABLE_TABLES.join(", ")}); select the company and use the tenant repository`
    );
  }
}

const platformStorage = new AsyncLocalStorage();

// One client, one transaction, NO app.company_id -- there is no company to set it
// to, and setting it to anything would be a lie the tenant helpers might later read.
async function withPlatformScope(scope, fn) {
  assertPlatformScope(scope);
  if (typeof fn !== "function") throw new Error("withPlatformScope requires a function");

  const open = platformStorage.getStore();
  if (open !== undefined) {
    if (open.scope !== scope) {
      throw new Error("withPlatformScope() cannot open a second scope inside an open transaction");
    }
    return fn();
  }
  // Nesting the two seams would mean one transaction holding both a company_id and
  // a claim to be above all of them. Refused rather than resolved.
  if (transactionStorage.getStore() !== undefined) {
    throw new Error("withPlatformScope() cannot open inside a tenant transaction");
  }

  const client = await pool.acquireRuntimeClient();
  let committed = false;
  try {
    await client.query("BEGIN");
    const result = await platformStorage.run({ client, scope }, fn);
    await client.query("COMMIT");
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // The connection is already gone; releasing it is all that is left.
      }
    }
    client.release();
  }
}

// The only way to issue SQL under a platform scope. `descriptor` is { sql,
// conflicts } -- the same shape tenantQuery takes minus shopScoped, which has no
// meaning here.
async function platformQuery(scope, descriptor, params = []) {
  const store = platformStorage.getStore();
  if (store === undefined) {
    throw new Error("platformQuery() must run inside withPlatformScope()");
  }
  if (store.scope !== scope) {
    throw new Error("platformQuery() was given a different scope than the open transaction");
  }
  if (descriptor === null || typeof descriptor !== "object") {
    throw new Error("platformQuery requires a descriptor object { sql, conflicts }");
  }
  const { sql, conflicts } = descriptor;
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new Error("platformQuery descriptor requires sql");
  }
  if (!Array.isArray(params)) {
    throw new Error("platformQuery params must be an array");
  }
  assertPlatformStatement(sql);

  const highest = highestPlaceholder(sql);
  if (highest !== params.length) {
    throw new Error(
      `platformQuery: the SQL uses $${highest} but ${params.length} value${
        params.length === 1 ? " is" : "s are"
      } bound`
    );
  }

  try {
    return await store.client.query(sql, params);
  } catch (error) {
    throw translatePgError(error, conflicts);
  }
}

// Deliberately narrow: pre-tenant lookups (login, session resolution, bearer
// resolution, the pre-tenant audit writer) run before any company_id exists.
// The caller set is pinned by structural test C4, not by good intentions.
async function withUnscopedConnection(fn) {
  if (typeof fn !== "function") throw new Error("withUnscopedConnection requires a function");
  const client = await pool.acquireRuntimeClient();
  try {
    return await fn({ query: (text, values) => client.query(text, values) });
  } finally {
    client.release();
  }
}

module.exports = {
  withTenantScope,
  tenantQuery,
  withPlatformScope,
  platformQuery,
  assertPlatformStatement,
  withUnscopedConnection,
  buildTenantStatement,
  // Straight re-exports of db/pool.js. server.js and db/health.js reach the
  // pool through this file because db/index.js is the declared seam.
  openRuntimePool: pool.openRuntimePool,
  openMigrationPool: pool.openMigrationPool,
  acquireRuntimeClient: pool.acquireRuntimeClient,
  acquireMigrationClient: pool.acquireMigrationClient,
  isRuntimePoolOpen: pool.isRuntimePoolOpen,
  runtimePoolStats: pool.runtimePoolStats,
  closeMigrationPool: pool.closeMigrationPool,
  closeAllPools: pool.closeAllPools
};
