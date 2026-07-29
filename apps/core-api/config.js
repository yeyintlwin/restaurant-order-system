"use strict";

// PURE (spec 8.8, Tier 1). startupConfiguration(env) reads nothing ambient -- no
// process.env, no clock, no filesystem -- so every rule below is exercised by
// handing it a plain object. server.js is the only production caller and it passes
// process.env, after env-file.js's loadDotEnv() has filled the gaps.
//
// Naming rule: every DEFAULTED config key is the camelCase of its environment
// variable name (ADMIN_MINT_RATE_PER_10MIN -> adminMintRatePer10min). Derived keys
// -- isProduction, databaseAppPassword, databaseMigration* -- have no environment
// variable of their own.

const ORIGIN_LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

// Hosts a Postgres connection may reach without TLS: the Compose service name and
// the loopback addresses. Anything else crosses a network we do not own.
const LOCAL_DATABASE_HOSTS = ["core-db", "localhost", "127.0.0.1", "::1"];

// The only three addresses HOST may take. 0.0.0.0 is correct INSIDE a container:
// a process bound to 127.0.0.1 there is unreachable from docker-proxy and answers
// nothing. The "not reachable except through Nginx" property comes from the
// Compose mapping 127.0.0.1:3200:3200, not from this bind.
const BIND_ADDRESSES = ["127.0.0.1", "::1", "0.0.0.0"];

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

class ConfigurationError extends Error {
  constructor(variable, problem) {
    super(`${variable} ${problem}`);
    this.name = "ConfigurationError";
    this.variable = variable;
  }
}

// Trimmed read, for values that are never secrets: a stray trailing space in a
// .env file is a typo everywhere except in a password.
function readValue(env, name) {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Untrimmed read. A password may legitimately end in a space, and trimming one
// silently turns a correct secret into an authentication failure nobody can see.
function readSecret(env, name) {
  const raw = env[name];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function required(name, value) {
  if (value === undefined) {
    throw new ConfigurationError(name, "must be set to a non-empty value");
  }
  return value;
}

function parseInteger(name, raw, min, max) {
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigurationError(name, `must be an integer, got "${raw}"`);
  }
  const value = Number(raw);
  const bound = max === UNBOUNDED ? `at least ${min}` : `between ${min} and ${max}`;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(name, `must be an integer ${bound}, got "${raw}"`);
  }
  return value;
}

function readInteger(env, name, fallback, min, max) {
  return parseInteger(name, readValue(env, name) ?? fallback, min, max);
}

function decodeComponent(name, part, value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ConfigurationError(
      name,
      `has a ${part} that is not valid percent-encoding (a literal % must be written %25)`
    );
  }
}

// `requiredUsername === null` means "any username", which is how CI, running as
// postgres, is allowed to drive the migration runner.
function parseDatabaseUrl(name, raw, requiredUsername) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(name, "must be a postgres:// connection string");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigurationError(name, `must use the postgres: or postgresql: scheme, got "${url.protocol}"`);
  }
  if (url.username === "") throw new ConfigurationError(name, "must include a username");
  if (url.password === "") throw new ConfigurationError(name, "must include a password");

  const database = decodeComponent(name, "database name", url.pathname.replace(/^\//, ""));
  if (database === "") throw new ConfigurationError(name, "must name a database");

  // new URL() keeps the square brackets on an IPv6 literal; every comparison here
  // wants the bare address.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_DATABASE_HOSTS.includes(host) && url.searchParams.get("sslmode") !== "require") {
    throw new ConfigurationError(
      name,
      `must set sslmode=require unless the host is one of ${LOCAL_DATABASE_HOSTS.join(", ")}, got "${host}"`
    );
  }

  const username = decodeComponent(name, "username", url.username);
  if (requiredUsername !== null && username !== requiredUsername) {
    throw new ConfigurationError(name, `must connect as ${requiredUsername}, got "${username}"`);
  }

  return {
    href: raw,
    username,
    password: decodeComponent(name, "password", url.password),
    database,
    host,
    port: url.port === "" ? 5432 : Number(url.port)
  };
}

function parseOrigin(name, raw, allowHttpLoopback) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(name, `must be an absolute URL, got "${raw}"`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError(name, `must not carry a username or password, got "${raw}"`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigurationError(name, `must not carry a query string or fragment, got "${raw}"`);
  }
  if (url.pathname !== "/") {
    throw new ConfigurationError(name, `must be an origin with no path, got "${url.pathname}"`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && allowHttpLoopback && ORIGIN_LOOPBACK_HOSTS.includes(host)) {
    return url.origin;
  }
  throw new ConfigurationError(name, allowHttpLoopback
    ? `must use https:, or http: with a ${ORIGIN_LOOPBACK_HOSTS.join("/")} host, got "${raw}"`
    : `must use https:, got "${raw}"`);
}

function parseOriginList(name, raw) {
  const origins = [];
  for (const entry of raw.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    // https unconditionally, with no loopback relaxation: these origins name
    // browser apps on real subdomains, and an http entry would make the terminal
    // CORS responder advertise a plaintext origin from a production box.
    const origin = parseOrigin(name, entry, false);
    if (origins.includes(origin)) {
      throw new ConfigurationError(name, `lists ${origin} more than once`);
    }
    origins.push(origin);
  }
  return Object.freeze(origins);
}

function parseBindAddress(name, raw) {
  if (!BIND_ADDRESSES.includes(raw)) {
    throw new ConfigurationError(name, `must be one of ${BIND_ADDRESSES.join(", ")}, got "${raw}"`);
  }
  return raw;
}

function startupConfiguration(env) {
  if (env === null || typeof env !== "object") {
    throw new TypeError("startupConfiguration(env) requires an environment object");
  }

  const nodeEnv = readValue(env, "NODE_ENV") ?? "development";
  const isProduction = nodeEnv === "production";

  const postgresPassword = required("POSTGRES_PASSWORD", readSecret(env, "POSTGRES_PASSWORD"));
  if (isProduction && postgresPassword.length < 24) {
    throw new ConfigurationError(
      "POSTGRES_PASSWORD",
      "must be at least 24 characters when NODE_ENV=production"
    );
  }

  // The core_api_owner rule is production-only so CI, which connects as postgres,
  // can run the migration runner at all (spec 9.4).
  const migration = parseDatabaseUrl(
    "DATABASE_MIGRATION_URL",
    required("DATABASE_MIGRATION_URL", readSecret(env, "DATABASE_MIGRATION_URL")),
    isProduction ? "core_api_owner" : null
  );

  // core_api_app is required in EVERY environment: pasting the migration DSN here
  // hands the runtime pool DDL rights and deletes the two-role design that
  // 0001_init.sql exists to create.
  const runtime = parseDatabaseUrl(
    "DATABASE_URL",
    required("DATABASE_URL", readSecret(env, "DATABASE_URL")),
    "core_api_app"
  );

  if (runtime.href === migration.href) {
    throw new ConfigurationError("DATABASE_URL", "must differ from DATABASE_MIGRATION_URL");
  }

  // Unconditional. The two are two views of one credential held in one secrets
  // file, so a difference means one line was edited and the other was not.
  if (migration.password !== postgresPassword) {
    throw new ConfigurationError(
      "POSTGRES_PASSWORD",
      "must equal the password component of DATABASE_MIGRATION_URL"
    );
  }

  const apiPublicOrigin = parseOrigin(
    "API_PUBLIC_ORIGIN",
    required("API_PUBLIC_ORIGIN", readValue(env, "API_PUBLIC_ORIGIN")),
    !isProduction
  );

  // Deliberately NOT defaulted to the Compose value of 1: a wrong hop count fails
  // silently in both directions, so production must state it and development gets
  // the fail-safe 0 ("use the socket address").
  const trustedProxyHopsRaw = readValue(env, "TRUSTED_PROXY_HOPS");
  if (isProduction && trustedProxyHopsRaw === undefined) {
    throw new ConfigurationError("TRUSTED_PROXY_HOPS", "must be set when NODE_ENV=production");
  }
  const trustedProxyHops = parseInteger("TRUSTED_PROXY_HOPS", trustedProxyHopsRaw ?? "0", 0, UNBOUNDED);

  const sessionIdleSeconds = readInteger(env, "SESSION_IDLE_SECONDS", "28800", 1, UNBOUNDED);
  const sessionAbsoluteSeconds = readInteger(env, "SESSION_ABSOLUTE_SECONDS", "604800", 1, UNBOUNDED);
  if (sessionAbsoluteSeconds <= sessionIdleSeconds) {
    // Otherwise every session violates user_sessions_idle_within_absolute on its
    // first renewal.
    throw new ConfigurationError(
      "SESSION_ABSOLUTE_SECONDS",
      `must be strictly greater than SESSION_IDLE_SECONDS (${sessionIdleSeconds}), got ${sessionAbsoluteSeconds}`
    );
  }

  return Object.freeze({
    nodeEnv,
    isProduction,

    port: readInteger(env, "PORT", "3200", 1, 65535),
    host: parseBindAddress("HOST", readValue(env, "HOST") ?? "0.0.0.0"),

    postgresPassword,
    // The decoded password component of DATABASE_URL. db/migrate.js feeds it to
    // `ALTER ROLE core_api_app LOGIN PASSWORD <quote_literal($1)>` on every boot,
    // which is what makes "edit DATABASE_URL and redeploy" a real rotation and
    // what gives the role LOGIN at all on a fresh cluster.
    databaseAppPassword: runtime.password,
    databaseUrl: runtime.href,
    databaseMigrationUrl: migration.href,
    // Derived from DATABASE_MIGRATION_URL, for scripts/reset-database.js, which
    // prints host, port and database before it will destroy anything.
    databaseMigrationHost: migration.host,
    databaseMigrationPort: migration.port,
    databaseMigrationDatabase: migration.database,

    apiPublicOrigin,
    terminalAllowedOrigins: parseOriginList(
      "TERMINAL_ALLOWED_ORIGINS",
      readValue(env, "TERMINAL_ALLOWED_ORIGINS") ?? ""
    ),
    trustedProxyHops,

    sessionIdleSeconds,
    sessionAbsoluteSeconds,
    pairingCodeTtlSeconds: readInteger(env, "PAIRING_CODE_TTL_SECONDS", "900", 1, UNBOUNDED),
    terminalTokenTtlSeconds: readInteger(env, "TERMINAL_TOKEN_TTL_SECONDS", "7776000", 1, UNBOUNDED),
    loginRatePerMinute: readInteger(env, "LOGIN_RATE_PER_MINUTE", "30", 1, UNBOUNDED),
    // 250 ms floor: the budget must exceed worst-case scrypt (~100 ms) with margin
    // or the fixed-time login property leaks through overrun.
    loginTimeBudgetMs: readInteger(env, "LOGIN_TIME_BUDGET_MS", "400", 250, UNBOUNDED),
    // Above 8 the memory-hard parameters put the process inside OOM-killer range
    // on a 512 MB container that shares the box with Postgres.
    scryptSlots: readInteger(env, "SCRYPT_SLOTS", "2", 1, 8),
    pairRatePerMinute: readInteger(env, "PAIR_RATE_PER_MINUTE", "20", 1, UNBOUNDED),
    adminMintRatePer10min: readInteger(env, "ADMIN_MINT_RATE_PER_10MIN", "20", 1, UNBOUNDED),
    pairingMintRatePer10min: readInteger(env, "PAIRING_MINT_RATE_PER_10MIN", "30", 1, UNBOUNDED),
    passwordAbuseThreshold: readInteger(env, "PASSWORD_ABUSE_THRESHOLD", "5", 1, UNBOUNDED),
    rotateRatePerHour: readInteger(env, "ROTATE_RATE_PER_HOUR", "5", 1, UNBOUNDED),
    auditRetentionDays: readInteger(env, "AUDIT_RETENTION_DAYS", "365", 1, UNBOUNDED),
    // Sized against max_connections=40, leaving room for psql, pg_dump and the
    // migration connection.
    dbPoolMax: readInteger(env, "DB_POOL_MAX", "8", 1, 20)
  });
}

module.exports = { startupConfiguration, ConfigurationError };
