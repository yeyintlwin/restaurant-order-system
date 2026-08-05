"use strict";

// Spec 5.6 and 9.10. The ONLY way the first account comes into existence.
//
//   cd ~/restaurant-order-system
//   CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec core-api \
//     node apps/core-api/scripts/create-platform-admin.js you@example.com
//
// BOTH variables, on a subcommand that touches only core-api. Compose validates
// every service's env_file on every subcommand, so a one-variable invocation dies at
// project load complaining about the OTHER file and never reaches this script. This
// is the form apps/core-api/README.md ships, and deploy-config.test.js enforces it
// per line -- but only in .md files, so these two copies are on their author.
//
// `docker compose exec`, NEVER `exec -T`: this reads the password from a TTY with
// echo disabled and REFUSES a pipe. The path inside the container is
// apps/core-api/scripts/... because WORKDIR is /app and the Dockerfile copies into
// ./apps/core-api.
//
// It connects with DATABASE_URL -- core_api_app, the RUNTIME role -- and not with the
// owner. It performs pure DML, so the superuser credential stays unused.
//
// There is no --force. Creating the same address twice is a no-op (ON CONFLICT DO
// NOTHING in the repository) that exits non-zero, and the remedy for a forgotten
// password is scripts/set-password.js, not a second row.

const { startupConfiguration } = require("../config");
const { loadDotEnv } = require("../env-file");
const { openRuntimePool, closeAllPools } = require("../db");
const { hashPassword, PasswordPolicyError, PASSWORD_MIN_LENGTH } = require("../lib/password");
const users = require("../repositories/auth/users");
// NO require of repositories/auth/audit.js. The audit row is written inside
// bootstrapPlatformAdmin's transaction; appendAuditEvent would open a second
// connection and put it outside, which is the whole defect the guard exists to avoid.

// The users.email CHECK, mirrored. Reaching the database to be told 23514 would put a
// constraint name in front of an operator and describe DDL rather than what they typed.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// users.display_name is CHECK (length(btrim(display_name)) BETWEEN 1 AND 80).
const DISPLAY_NAME_MAX = 80;

function usage() {
  return [
    "usage: node apps/core-api/scripts/create-platform-admin.js <email> [display name]",
    "",
    "Run it through an interactive session -- `docker compose exec`, without -T.",
    "Both env-file variables, or compose refuses the project before this runs:",
    "  CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec core-api \\",
    "    node apps/core-api/scripts/create-platform-admin.js you@example.com"
  ].join("\n");
}

// PUBLIC API, deliberately. readline's echo-off recipe overrides _writeToOutput, an
// underscore-prefixed internal, and a credential prompt is the last place to depend on
// one. setRawMode is documented and stable.
function promptSecret(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let value = "";
    const finish = (error, answer) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(answer);
    };

    function onData(chunk) {
      // Compared by CODE POINT, never against string literals. The three that matter
      // -- EOT, ETX and DEL -- have no printable spelling, so source carrying them raw
      // is one careless editor, diff tool or copy-paste away from silent repair.
      const ENTER = 13;
      const NEWLINE = 10;
      const EOT = 4;
      const ETX = 3;
      const DEL = 127;
      const BACKSPACE = 8;

      for (const character of chunk) {
        const code = character.codePointAt(0);

        // EOT is here because raw mode delivers Ctrl-D as a BYTE rather than as
        // end-of-stream, so without it the prompt hangs on the key an operator who
        // wants to abandon it is most likely to reach for.
        if (code === ENTER || code === NEWLINE || code === EOT) {
          finish(null, value);
          return;
        }
        // Raw mode also suppresses SIGINT, so this is the only way out.
        if (code === ETX) {
          finish(new Error("cancelled"));
          return;
        }
        // Terminals disagree about which byte the backspace key sends.
        if (code === DEL || code === BACKSPACE) {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    }

    process.stdin.on("data", onData);
  });
}

async function main(argv) {
  const email = typeof argv[0] === "string" ? argv[0].trim().toLowerCase() : "";
  // btrim + a bound, matching the column. Defaulting to the local part means the
  // one-argument invocation spec 9.10 documents actually works.
  const displayName = (typeof argv[1] === "string" && argv[1].trim() !== ""
    ? argv[1].trim()
    : email.split("@")[0]
  ).slice(0, DISPLAY_NAME_MAX);

  if (email === "" || !EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new Error(`a valid email address is required\n\n${usage()}`);
  }

  // THE GUARD. A pipe means `docker compose exec -T`, which means the password came
  // from a shell command and is now in that shell's history.
  if (!process.stdin.isTTY) {
    throw new Error(
      "this script will not read a password from a pipe: run it on an interactive terminal " +
        `(\`docker compose exec\`, without -T)\n\n${usage()}`
    );
  }

  loadDotEnv(undefined, process.env);
  const config = startupConfiguration(process.env);

  const password = await promptSecret(`Password for ${email} (min ${PASSWORD_MIN_LENGTH} characters): `);
  const again = await promptSecret("Repeat it: ");
  // Typed blind, twice, because the cost of a typo here is an account nobody can sign
  // in to and no way to tell that from a wrong password at the login screen.
  if (password !== again) throw new Error("the two passwords did not match");

  let passwordHash;
  try {
    passwordHash = await hashPassword(password);
  } catch (error) {
    if (!(error instanceof PasswordPolicyError)) throw error;
    throw new Error(`the password was rejected: ${error.code}`);
  }

  // max: 1. This process issues one transaction and exits; a pool sized for the server
  // would open connections against max_connections=40 for no reason.
  await openRuntimePool({ connectionString: config.databaseUrl, max: 1 });
  try {
    // The lock, the monotonic guard, the user row and its audit row are ONE
    // transaction inside the repository. That is not tidiness: pg_advisory_xact_lock
    // is transaction-scoped, and an audit row written afterwards by appendAuditEvent
    // -- on its own connection -- could be lost to a crash, leaving the guard
    // disarmed and the platform bootstrappable a second time.
    //
    // 'system' is the actor kind, and audit_events_actor_arc settles it rather than
    // taste: 'user' requires actor_user_id and 'terminal' requires actor_terminal_id,
    // and there is no authenticated actor at the moment the first account comes into
    // existence. platform.admin_created declares both 'user' and 'system' for exactly
    // this reason -- POST /api/platform/admins (Plan 2c) writes it as 'user'.
    const { created, reason } = await users.bootstrapPlatformAdmin({ email, displayName, passwordHash });

    // Two distinguishable refusals, because the operator's next move differs. Exiting
    // 0 on either would let a bootstrap report success while creating nothing.
    if (reason === "already_bootstrapped") {
      throw new Error(
        "this platform has already been bootstrapped, and that is permanent by design: " +
          "the guard is an audit_events row, so deleting the administrator does not re-open it. " +
          "Use scripts/set-password.js to recover an account, or POST /api/platform/admins to add one."
      );
    }
    if (reason === "email_taken") {
      throw new Error(`${email} already exists; use scripts/set-password.js to change its password`);
    }

    process.stdout.write(`created platform administrator ${created.email} (${created.id})\n`);
  } finally {
    await closeAllPools();
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
