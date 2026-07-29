const { AsyncLocalStorage } = require("node:async_hooks");

const pool = require("./pool");
const { ApiError, pgErrorToHttp } = require("./errors");
const { assertTenantScope } = require("./scope");

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
