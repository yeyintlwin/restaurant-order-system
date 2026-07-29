#!/usr/bin/env node
"use strict";

// npm `db:reset`. The only script in this repository that destroys data, and the
// sanctioned answer to a local checksum surprise -- against a database with real
// rows there is no such escape, and there should not be.
//
// Three INDEPENDENT guards: each refuses on its own, so weakening one does not
// open the door.
//
// The DROP/CREATE mechanics live in testing/database.js's recreateDatabase().
// This file therefore contains no `pg` require and no `.query(` call of its own:
// C1 pins the pg requirer to db/pool.js and C2 bans raw query calls outside db/,
// and the walker scans scripts/.
const { recreateDatabase, maintenanceDsn } = require("../testing/database");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function refuse(message) {
  console.error(`db:reset refused: ${message}`);
  process.exit(1);
}

async function main(argv, env) {
  if (env.NODE_ENV === "production") {
    refuse("NODE_ENV is production. This script never runs against production.");
  }

  const dsn = env.DATABASE_MIGRATION_URL;
  if (!dsn) refuse("DATABASE_MIGRATION_URL is not set.");

  const url = new URL(dsn);
  const host = url.hostname;
  if (!LOCAL_HOSTS.has(host)) {
    refuse(`DATABASE_MIGRATION_URL host ${host} is not local (localhost, 127.0.0.1 or ::1).`);
  }

  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) refuse("DATABASE_MIGRATION_URL names no database.");

  if (!argv.includes("--yes")) {
    refuse(
      `about to DROP host=${host} port=${port} database=${database}. ` +
        "Re-run with --yes if that is what you meant."
    );
  }

  await recreateDatabase(maintenanceDsn(dsn, "postgres"), database);

  console.log(
    `db:reset dropped and recreated ${database} on ${host}:${port}. ` +
      "Start the server to re-run migrations."
  );
}

main(process.argv.slice(2), process.env).catch((error) => {
  console.error(`db:reset failed: ${error.message}`);
  process.exit(1);
});
