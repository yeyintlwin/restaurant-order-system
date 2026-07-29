const { withUnscopedConnection } = require("./index");
const { migrationsStatus } = require("./migrate");

// The readiness probe's own ceiling. A readiness check that can hang is worse
// than one that fails: the deploy gate waits on it.
const READINESS_STATEMENT_TIMEOUT_MS = 2000;

// Transient: the cluster is coming up, DNS has not settled, the port is not
// bound yet. Every one of these is fixed by waiting a second.
const RETRYABLE_ERROR_CODES = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "57P03"];

function isRetryableConnectionError(error) {
  return error !== null && error !== undefined && RETRYABLE_ERROR_CODES.includes(error.code);
}

// Deterministic failures. Retrying them for ten seconds buries the real cause
// behind a timeout and makes a credential problem look like an outage.
function fatalConnectionMessage(error, variableName) {
  const code = error === null || error === undefined ? undefined : error.code;
  if (code === "28P01" || code === "28000") {
    return `${variableName} was rejected by the server (${code}). If you rotated POSTGRES_PASSWORD, the running cluster still holds the old value — see apps/core-api/README.md "Rotating database passwords".`;
  }
  if (code === "3D000") {
    return `${variableName} names a database that does not exist (3D000). Create it or fix the database name in the DSN — waiting cannot make it appear.`;
  }
  return null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `attempt` is any function that opens or uses a connection. Injecting `sleep`
// keeps the bound testable in milliseconds instead of ten real seconds.
async function connectWithRetry(attempt, options = {}) {
  const attempts = options.attempts === undefined ? 10 : options.attempts;
  const delayMs = options.delayMs === undefined ? 1000 : options.delayMs;
  const variableName = options.variableName === undefined ? "DATABASE_URL" : options.variableName;
  const sleep = options.sleep === undefined ? defaultSleep : options.sleep;
  const onRetry = options.onRetry === undefined ? () => {} : options.onRetry;

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await attempt();
    } catch (error) {
      const fatal = fatalConnectionMessage(error, variableName);
      if (fatal !== null) {
        const failure = new Error(fatal);
        failure.cause = error;
        throw failure;
      }
      if (!isRetryableConnectionError(error) || attemptNumber >= attempts) throw error;
      onRetry(attemptNumber, error);
      await sleep(delayMs);
    }
  }
}

// Step 11 of the §9.4 startup order: the runtime pool is open, prove it works
// before listen() rather than discovering it on the first request.
async function waitForDatabase({ attempts = 10, delayMs = 1000 } = {}) {
  await connectWithRetry(() => withUnscopedConnection((c) => c.query("SELECT 1")), {
    attempts,
    delayMs,
    variableName: "DATABASE_URL"
  });
}

// Returns one of the closed vocabulary "ready" | "timeout" | "unreachable".
// That word goes to the request log against the requestId; the client gets the
// ordinary opaque error envelope, because readiness detail is a precise "the
// database is down" signal and is not public.
async function probeReadiness() {
  try {
    return await withUnscopedConnection(async (connection) => {
      await connection.query("BEGIN");
      try {
        // SET LOCAL is the only form that reverts when the transaction ends; a
        // bare SET would leave this 2s ceiling on a pooled connection for
        // whatever request checks it out next.
        await connection.query(`SET LOCAL statement_timeout = ${READINESS_STATEMENT_TIMEOUT_MS}`);
        await connection.query("SELECT 1");
        await connection.query("COMMIT");
        return "ready";
      } catch (error) {
        try {
          await connection.query("ROLLBACK");
        } catch (rollbackError) {
          // The connection is already gone; the outer catch classifies it.
        }
        throw error;
      }
    });
  } catch (error) {
    return error !== null && error !== undefined && error.code === "57014" ? "timeout" : "unreachable";
  }
}

// The whole readiness verdict, both halves of the closed vocabulary §6.3.6
// keeps out of public bodies. It NEVER throws: any failure degrades to the
// fail-closed pair, because the only thing a thrown readiness check achieves is
// a 500 where the caller needed a 503.
async function checkReadiness({ migrationsDir }) {
  const database = await probeReadiness();
  if (database !== "ready") {
    // No usable connection means no verdict on the ledger either, and "pending"
    // is the word that keeps the gate shut.
    return { database, migrations: "pending" };
  }
  try {
    const migrations = await withUnscopedConnection((connection) => migrationsStatus(connection, migrationsDir));
    return { database, migrations };
  } catch (error) {
    return { database: "unreachable", migrations: "pending" };
  }
}

module.exports = {
  probeReadiness,
  checkReadiness,
  waitForDatabase,
  connectWithRetry,
  isRetryableConnectionError,
  fatalConnectionMessage,
  READINESS_STATEMENT_TIMEOUT_MS
};
