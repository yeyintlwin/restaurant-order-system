const assert = require("node:assert/strict");
const test = require("node:test");

const { startupConfiguration, ConfigurationError } = require("../config");

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
