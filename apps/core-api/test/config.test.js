const assert = require("node:assert/strict");
const test = require("node:test");

const { startupConfiguration, ConfigurationError, DEFAULTS } = require("../config");

// The literal recipe from spec 9.9 "Local development". Every case below starts
// from one of these two environments and breaks exactly one thing, so a failure
// names the rule that fired rather than the first rule in the file.
const DEV_ENV = Object.freeze({
  NODE_ENV: "development",
  API_PUBLIC_ORIGIN: "http://localhost:3200",
  POSTGRES_PASSWORD: "devpassword",
  DATABASE_MIGRATION_URL: "postgres://core_api_owner:devpassword@127.0.0.1:5433/core",
  DATABASE_URL: "postgres://core_api_app:devpassword@127.0.0.1:5433/core"
});

const PRODUCTION_SECRET = "0123456789abcdef0123456789"; // 26 characters

const PRODUCTION_ENV = Object.freeze({
  NODE_ENV: "production",
  API_PUBLIC_ORIGIN: "https://api.yeyintlwin.com",
  TRUSTED_PROXY_HOPS: "1",
  POSTGRES_PASSWORD: PRODUCTION_SECRET,
  DATABASE_MIGRATION_URL: `postgres://core_api_owner:${PRODUCTION_SECRET}@core-db:5432/core`,
  DATABASE_URL: `postgres://core_api_app:${PRODUCTION_SECRET}@core-db:5432/core`
});

// An override of `undefined` deletes the key, which is how "the operator forgot
// this one" is expressed.
function withEnv(base, overrides) {
  const env = { ...base, ...overrides };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
  }
  return env;
}

function assertRefusal(env, variable) {
  assert.throws(() => startupConfiguration(env), (error) => {
    assert.ok(
      error instanceof ConfigurationError,
      `expected a ConfigurationError, got ${error.name}: ${error.message}`
    );
    assert.equal(
      error.variable,
      variable,
      `expected the refusal to name ${variable}, got ${error.variable} ("${error.message}")`
    );
    return true;
  });
}

test("accepts the documented local development environment", () => {
  const config = startupConfiguration(DEV_ENV);

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.isProduction, false);
  assert.equal(config.apiPublicOrigin, "http://localhost:3200");
  assert.equal(config.postgresPassword, "devpassword");
  // The credential db/migrate.js feeds to ALTER ROLE core_api_app on every boot.
  assert.equal(config.databaseAppPassword, "devpassword");
  assert.equal(config.databaseUrl, DEV_ENV.DATABASE_URL);
  assert.equal(config.databaseMigrationUrl, DEV_ENV.DATABASE_MIGRATION_URL);
  assert.equal(config.databaseMigrationHost, "127.0.0.1");
  assert.equal(config.databaseMigrationPort, 5433);
  assert.equal(config.databaseMigrationDatabase, "core");
  assert.equal(config.trustedProxyHops, 0);
  assert.ok(Object.isFrozen(config));
});

test("refuses to listen when a required variable is missing or empty", () => {
  for (const variable of [
    "POSTGRES_PASSWORD", "DATABASE_MIGRATION_URL", "DATABASE_URL", "API_PUBLIC_ORIGIN"
  ]) {
    assertRefusal(withEnv(DEV_ENV, { [variable]: undefined }), variable);
    assertRefusal(withEnv(DEV_ENV, { [variable]: "" }), variable);
  }

  // Whitespace is emptiness for everything except a password, which is read
  // untrimmed because a password may legitimately end in a space.
  assertRefusal(withEnv(DEV_ENV, { API_PUBLIC_ORIGIN: "   " }), "API_PUBLIC_ORIGIN");
  assertRefusal(withEnv(DEV_ENV, { DATABASE_URL: "   " }), "DATABASE_URL");
});

test("reads only the environment object it was given, never process.env", () => {
  const previous = process.env.API_PUBLIC_ORIGIN;
  process.env.API_PUBLIC_ORIGIN = "https://leaked.example.test";
  try {
    assertRefusal(withEnv(DEV_ENV, { API_PUBLIC_ORIGIN: undefined }), "API_PUBLIC_ORIGIN");
  } finally {
    if (previous === undefined) delete process.env.API_PUBLIC_ORIGIN;
    else process.env.API_PUBLIC_ORIGIN = previous;
  }
});

test("the POSTGRES_PASSWORD length floor applies only under NODE_ENV=production", () => {
  const short = "short-but-fine"; // 14 characters

  const development = withEnv(DEV_ENV, {
    POSTGRES_PASSWORD: short,
    DATABASE_MIGRATION_URL: `postgres://core_api_owner:${short}@127.0.0.1:5433/core`,
    DATABASE_URL: `postgres://core_api_app:${short}@127.0.0.1:5433/core`
  });
  assert.equal(startupConfiguration(development).postgresPassword, short);

  assertRefusal(withEnv(PRODUCTION_ENV, {
    POSTGRES_PASSWORD: short,
    DATABASE_MIGRATION_URL: `postgres://core_api_owner:${short}@core-db:5432/core`,
    DATABASE_URL: `postgres://core_api_app:${short}@core-db:5432/core`
  }), "POSTGRES_PASSWORD");
});

test("POSTGRES_PASSWORD must equal the password inside DATABASE_MIGRATION_URL, always", () => {
  // The two live in one secrets file as two views of one credential. A difference
  // means somebody edited one line and not the other, in either environment.
  assertRefusal(withEnv(DEV_ENV, { POSTGRES_PASSWORD: "devpassword-typo" }), "POSTGRES_PASSWORD");
  assertRefusal(withEnv(PRODUCTION_ENV, {
    DATABASE_MIGRATION_URL: `postgres://core_api_owner:${PRODUCTION_SECRET}x@core-db:5432/core`
  }), "POSTGRES_PASSWORD");
});

test("a percent-encoded DSN password is compared after decoding", () => {
  const password = "p@ss word/50%";
  const env = withEnv(DEV_ENV, {
    POSTGRES_PASSWORD: password,
    DATABASE_MIGRATION_URL: "postgres://core_api_owner:p%40ss%20word%2F50%25@127.0.0.1:5433/core",
    DATABASE_URL: "postgres://core_api_app:p%40ss%20word%2F50%25@127.0.0.1:5433/core"
  });

  const config = startupConfiguration(env);
  assert.equal(config.postgresPassword, password);
  // ALTER ROLE ... PASSWORD must receive the decoded value, not the DSN escaping.
  assert.equal(config.databaseAppPassword, password);
});

test("a DSN whose password is not valid percent-encoding is refused by name", () => {
  assertRefusal(withEnv(DEV_ENV, {
    DATABASE_MIGRATION_URL: "postgres://core_api_owner:pa%ss@127.0.0.1:5433/core"
  }), "DATABASE_MIGRATION_URL");
});

test("both DSNs must be complete postgres connection strings", () => {
  for (const variable of ["DATABASE_MIGRATION_URL", "DATABASE_URL"]) {
    const username = variable === "DATABASE_URL" ? "core_api_app" : "core_api_owner";

    assertRefusal(withEnv(DEV_ENV, { [variable]: "not a url" }), variable);
    assertRefusal(withEnv(DEV_ENV, {
      [variable]: `mysql://${username}:devpassword@127.0.0.1:5433/core`
    }), variable);
    assertRefusal(withEnv(DEV_ENV, {
      [variable]: "postgres://:devpassword@127.0.0.1:5433/core"
    }), variable);
    assertRefusal(withEnv(DEV_ENV, {
      [variable]: `postgres://${username}@127.0.0.1:5433/core`
    }), variable);
    assertRefusal(withEnv(DEV_ENV, {
      [variable]: `postgres://${username}:devpassword@127.0.0.1:5433/`
    }), variable);
    // A host that is neither core-db nor loopback crosses a network we do not own,
    // so plaintext is refused there.
    assertRefusal(withEnv(DEV_ENV, {
      [variable]: `postgres://${username}:devpassword@db.example.com:5432/core`
    }), variable);
  }

  const remote = withEnv(DEV_ENV, {
    DATABASE_MIGRATION_URL: "postgresql://core_api_owner:devpassword@db.example.com:5432/core?sslmode=require",
    DATABASE_URL: "postgresql://core_api_app:devpassword@db.example.com:5432/core?sslmode=require"
  });
  const config = startupConfiguration(remote);
  assert.equal(config.databaseMigrationHost, "db.example.com");
  assert.equal(config.databaseMigrationPort, 5432);
});

test("DATABASE_URL is always core_api_app; the owner username is required only in production", () => {
  // Pasting the migration DSN here hands the runtime pool DDL rights.
  assertRefusal(withEnv(DEV_ENV, {
    DATABASE_URL: "postgres://core_api_owner:devpassword@127.0.0.1:5433/core"
  }), "DATABASE_URL");

  // CI runs as postgres, so a non-owner migration username must stay legal outside
  // production or the runner could not be exercised at all.
  const ci = withEnv(DEV_ENV, {
    DATABASE_MIGRATION_URL: "postgres://postgres:devpassword@127.0.0.1:5433/core"
  });
  assert.equal(startupConfiguration(ci).databaseMigrationUrl, ci.DATABASE_MIGRATION_URL);

  assertRefusal(withEnv(PRODUCTION_ENV, {
    DATABASE_MIGRATION_URL: `postgres://postgres:${PRODUCTION_SECRET}@core-db:5432/core`
  }), "DATABASE_MIGRATION_URL");
});

test("DATABASE_URL must differ from DATABASE_MIGRATION_URL", () => {
  const same = "postgres://core_api_app:devpassword@127.0.0.1:5433/core";
  assertRefusal(withEnv(DEV_ENV, {
    DATABASE_MIGRATION_URL: same,
    DATABASE_URL: same
  }), "DATABASE_URL");
});

test("API_PUBLIC_ORIGIN is an origin, and plaintext is a development-only relaxation", () => {
  assert.equal(
    startupConfiguration(withEnv(DEV_ENV, { API_PUBLIC_ORIGIN: "https://api.yeyintlwin.com/" })).apiPublicOrigin,
    "https://api.yeyintlwin.com"
  );
  assert.equal(
    startupConfiguration(withEnv(DEV_ENV, { API_PUBLIC_ORIGIN: "http://127.0.0.1:3200" })).apiPublicOrigin,
    "http://127.0.0.1:3200"
  );
  assert.equal(startupConfiguration(PRODUCTION_ENV).apiPublicOrigin, "https://api.yeyintlwin.com");

  for (const bad of [
    "api.yeyintlwin.com",
    "https://api.yeyintlwin.com/admin",
    "https://api.yeyintlwin.com/?x=1",
    "https://api.yeyintlwin.com/#fragment",
    "https://user:pw@api.yeyintlwin.com",
    "http://evil.example.test"
  ]) {
    assertRefusal(withEnv(DEV_ENV, { API_PUBLIC_ORIGIN: bad }), "API_PUBLIC_ORIGIN");
  }

  assertRefusal(withEnv(PRODUCTION_ENV, { API_PUBLIC_ORIGIN: "http://localhost:3200" }), "API_PUBLIC_ORIGIN");
});

test("TRUSTED_PROXY_HOPS defaults to 0 outside production and is mandatory inside it", () => {
  assert.equal(startupConfiguration(DEV_ENV).trustedProxyHops, 0);
  assert.equal(startupConfiguration(withEnv(DEV_ENV, { TRUSTED_PROXY_HOPS: "2" })).trustedProxyHops, 2);
  assert.equal(startupConfiguration(PRODUCTION_ENV).trustedProxyHops, 1);

  // A wrong hop count fails silently in both directions, so production states it.
  assertRefusal(withEnv(PRODUCTION_ENV, { TRUSTED_PROXY_HOPS: undefined }), "TRUSTED_PROXY_HOPS");
  for (const bad of ["-1", "1.5", "one"]) {
    assertRefusal(withEnv(DEV_ENV, { TRUSTED_PROXY_HOPS: bad }), "TRUSTED_PROXY_HOPS");
  }
});

test("startupConfiguration refuses anything that is not an environment object", () => {
  for (const value of [undefined, null, "PORT=3200", 42]) {
    assert.throws(() => startupConfiguration(value), TypeError);
  }
});

test("PORT and HOST default to the container's values and reject anything else", () => {
  const config = startupConfiguration(DEV_ENV);
  assert.equal(config.port, 3200);
  assert.equal(config.host, "0.0.0.0");

  assert.equal(startupConfiguration(withEnv(DEV_ENV, { PORT: "65535" })).port, 65535);
  for (const port of ["0", "65536", "3.5", "3200abc", "-1"]) {
    assertRefusal(withEnv(DEV_ENV, { PORT: port }), "PORT");
  }

  for (const host of ["127.0.0.1", "::1", "0.0.0.0"]) {
    assert.equal(startupConfiguration(withEnv(DEV_ENV, { HOST: host })).host, host);
  }
  // HOST is a closed set of three: a public-IP typo here would publish the API
  // past Nginx. Note 0.0.0.0 is correct INSIDE a container -- a process bound to
  // 127.0.0.1 there is unreachable from docker-proxy and answers nothing.
  for (const host of ["localhost", "192.0.2.10", "0.0.0.0:3200"]) {
    assertRefusal(withEnv(DEV_ENV, { HOST: host }), "HOST");
  }
});

test("TERMINAL_ALLOWED_ORIGINS is an empty, frozen list by default", () => {
  const origins = startupConfiguration(DEV_ENV).terminalAllowedOrigins;

  assert.deepEqual(origins, []);
  assert.ok(Object.isFrozen(origins));
  assert.deepEqual(
    startupConfiguration(withEnv(DEV_ENV, { TERMINAL_ALLOWED_ORIGINS: "" })).terminalAllowedOrigins,
    []
  );
});

test("TERMINAL_ALLOWED_ORIGINS accepts exact https origins and nothing else", () => {
  assert.deepEqual(
    startupConfiguration(withEnv(DEV_ENV, {
      TERMINAL_ALLOWED_ORIGINS: "https://kitchen.example.test, https://counter.example.test"
    })).terminalAllowedOrigins,
    ["https://kitchen.example.test", "https://counter.example.test"]
  );

  for (const value of [
    "https://kitchen.example.test/app",                            // trailing path
    "https://kitchen.example.test,https://kitchen.example.test/",  // duplicate
    "http://localhost:3200",                                       // plaintext, even loopback
    "kitchen.example.test"                                         // not absolute
  ]) {
    assertRefusal(withEnv(DEV_ENV, { TERMINAL_ALLOWED_ORIGINS: value }), "TERMINAL_ALLOWED_ORIGINS");
  }
});

test("the tunables default to the container's values", () => {
  const config = startupConfiguration(DEV_ENV);

  assert.equal(config.sessionIdleSeconds, 28800);
  assert.equal(config.sessionAbsoluteSeconds, 604800);
  assert.equal(config.pairingCodeTtlSeconds, 900);
  assert.equal(config.terminalTokenTtlSeconds, 7776000);
  assert.equal(config.loginRatePerMinute, 30);
  assert.equal(config.loginTimeBudgetMs, 400);
  assert.equal(config.scryptSlots, 2);
  assert.equal(config.pairRatePerMinute, 20);
  assert.equal(config.adminMintRatePer10min, 20);
  assert.equal(config.pairingMintRatePer10min, 30);
  assert.equal(config.passwordAbuseThreshold, 5);
  assert.equal(config.rotateRatePerHour, 5);
  assert.equal(config.auditRetentionDays, 365);
  assert.equal(config.dbPoolMax, 8);
});

test("every count-style tunable refuses zero, a negative and a non-integer", () => {
  for (const variable of [
    "SESSION_IDLE_SECONDS", "SESSION_ABSOLUTE_SECONDS", "PAIRING_CODE_TTL_SECONDS",
    "TERMINAL_TOKEN_TTL_SECONDS", "LOGIN_RATE_PER_MINUTE", "SCRYPT_SLOTS",
    "PAIR_RATE_PER_MINUTE", "ADMIN_MINT_RATE_PER_10MIN", "PAIRING_MINT_RATE_PER_10MIN",
    "PASSWORD_ABUSE_THRESHOLD", "ROTATE_RATE_PER_HOUR", "AUDIT_RETENTION_DAYS", "DB_POOL_MAX"
  ]) {
    for (const bad of ["0", "-1", "1.5", "lots"]) {
      assertRefusal(withEnv(DEV_ENV, { [variable]: bad }), variable);
    }
  }
});

test("LOGIN_TIME_BUDGET_MS must leave room for worst-case scrypt", () => {
  // The fixed budget must exceed ~100 ms of scrypt with margin, or the
  // "byte-identical outcome after the same wall-clock budget" property leaks
  // through overrun.
  assert.equal(
    startupConfiguration(withEnv(DEV_ENV, { LOGIN_TIME_BUDGET_MS: "250" })).loginTimeBudgetMs,
    250
  );
  assertRefusal(withEnv(DEV_ENV, { LOGIN_TIME_BUDGET_MS: "249" }), "LOGIN_TIME_BUDGET_MS");
  assertRefusal(withEnv(DEV_ENV, { LOGIN_TIME_BUDGET_MS: "0" }), "LOGIN_TIME_BUDGET_MS");
});

test("SCRYPT_SLOTS and DB_POOL_MAX are bounded above as well as below", () => {
  // Above 8 slots the memory-hard parameters put the process inside OOM-killer
  // range on a 512 MB container; DB_POOL_MAX is sized against max_connections=40.
  assert.equal(startupConfiguration(withEnv(DEV_ENV, { SCRYPT_SLOTS: "8" })).scryptSlots, 8);
  assertRefusal(withEnv(DEV_ENV, { SCRYPT_SLOTS: "9" }), "SCRYPT_SLOTS");

  assert.equal(startupConfiguration(withEnv(DEV_ENV, { DB_POOL_MAX: "20" })).dbPoolMax, 20);
  assertRefusal(withEnv(DEV_ENV, { DB_POOL_MAX: "21" }), "DB_POOL_MAX");
});

test("SESSION_ABSOLUTE_SECONDS must strictly exceed SESSION_IDLE_SECONDS", () => {
  // Otherwise every session violates user_sessions_idle_within_absolute on its
  // first renewal.
  assertRefusal(
    withEnv(DEV_ENV, { SESSION_IDLE_SECONDS: "600", SESSION_ABSOLUTE_SECONDS: "600" }),
    "SESSION_ABSOLUTE_SECONDS"
  );
  assertRefusal(
    withEnv(DEV_ENV, { SESSION_IDLE_SECONDS: "600", SESSION_ABSOLUTE_SECONDS: "599" }),
    "SESSION_ABSOLUTE_SECONDS"
  );
  assert.equal(
    startupConfiguration(withEnv(DEV_ENV, {
      SESSION_IDLE_SECONDS: "600",
      SESSION_ABSOLUTE_SECONDS: "601"
    })).sessionAbsoluteSeconds,
    601
  );
});

// --- the Compose contract ---------------------------------------------------
// docker-compose.yml is Plan 5. Until it lands, these two literals ARE the
// contract: they are copied character for character from the core-api service's
// `environment:` block in spec 9.1. When the compose file arrives, replace them
// with a parse of the real file; the assertions below do not change.

const COMPOSE_CORE_API_ENVIRONMENT_KEYS = [
  "PORT", "HOST", "TZ", "API_PUBLIC_ORIGIN", "TERMINAL_ALLOWED_ORIGINS", "TRUSTED_PROXY_HOPS",
  "SESSION_IDLE_SECONDS", "SESSION_ABSOLUTE_SECONDS", "PAIRING_CODE_TTL_SECONDS",
  "TERMINAL_TOKEN_TTL_SECONDS", "LOGIN_RATE_PER_MINUTE", "LOGIN_TIME_BUDGET_MS", "SCRYPT_SLOTS",
  "PAIR_RATE_PER_MINUTE", "ADMIN_MINT_RATE_PER_10MIN", "PAIRING_MINT_RATE_PER_10MIN",
  "PASSWORD_ABUSE_THRESHOLD", "ROTATE_RATE_PER_HOUR", "AUDIT_RETENTION_DAYS", "DB_POOL_MAX"
];

const COMPOSE_DEFAULTS = {
  PORT: "3200",
  HOST: "0.0.0.0",
  TERMINAL_ALLOWED_ORIGINS: "",
  SESSION_IDLE_SECONDS: "28800",
  SESSION_ABSOLUTE_SECONDS: "604800",
  PAIRING_CODE_TTL_SECONDS: "900",
  TERMINAL_TOKEN_TTL_SECONDS: "7776000",
  LOGIN_RATE_PER_MINUTE: "30",
  LOGIN_TIME_BUDGET_MS: "400",
  SCRYPT_SLOTS: "2",
  PAIR_RATE_PER_MINUTE: "20",
  ADMIN_MINT_RATE_PER_10MIN: "20",
  PAIRING_MINT_RATE_PER_10MIN: "30",
  PASSWORD_ABUSE_THRESHOLD: "5",
  ROTATE_RATE_PER_HOUR: "5",
  AUDIT_RETENTION_DAYS: "365",
  DB_POOL_MAX: "8"
};

// The three keys Compose sets that config.js deliberately does NOT default, each
// with the reason stated so the exclusion is a decision rather than a hole.
const NOT_DEFAULTED_IN_CODE = {
  TZ: "a process concern (log timestamps, now(), psql output); config.js exposes no field",
  API_PUBLIC_ORIGIN: "required with no default: a default would let a misconfigured box accept logins for the wrong origin",
  TRUSTED_PROXY_HOPS: "required under NODE_ENV=production; the development default is 0, deliberately not Compose's 1"
};

function camelCaseOf(name) {
  return name
    .toLowerCase()
    .split("_")
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

test("config.js defaults every knob to the value the Compose file sets", () => {
  assert.deepEqual(DEFAULTS, COMPOSE_DEFAULTS);
  assert.ok(Object.isFrozen(DEFAULTS));
});

test("the Compose keys config.js does not default are a stated, closed list", () => {
  assert.deepEqual(
    [...Object.keys(COMPOSE_DEFAULTS), ...Object.keys(NOT_DEFAULTED_IN_CODE)].sort(),
    [...COMPOSE_CORE_API_ENVIRONMENT_KEYS].sort()
  );
  for (const [variable, reason] of Object.entries(NOT_DEFAULTED_IN_CODE)) {
    assert.ok(reason.length > 0, `${variable} needs a stated reason`);
  }
});

test("the defaults table is what config.js actually applies", () => {
  // Spelling every default out explicitly must produce a config identical to
  // leaving them all unset. A correct DEFAULTS table the parser ignores fails
  // here and nowhere else.
  assert.deepEqual(
    startupConfiguration(DEV_ENV),
    startupConfiguration({ ...DEV_ENV, ...COMPOSE_DEFAULTS })
  );
});

test("every defaulted variable has a config field named by the mechanical camelCase rule", () => {
  const config = startupConfiguration(DEV_ENV);
  for (const name of Object.keys(DEFAULTS)) {
    assert.ok(
      Object.hasOwn(config, camelCaseOf(name)),
      `config has no "${camelCaseOf(name)}" field for ${name}`
    );
  }
});
