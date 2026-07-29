#!/usr/bin/env node
"use strict";

// npm `pretest`. This is an OPTIMISATION, not the correctness guarantee:
// cloneTemplate() re-checks staleness itself, because typing `node --test`
// directly is the house habit (apps/customer-order/package.json trains it) and
// Node 20 -- the CI pin and the base image -- has no --test-global-setup.
const { ensureTemplateDatabase, skipDatabaseTests } = require("../testing/database");

async function main() {
  if (skipDatabaseTests()) {
    console.log("setup-template-db: CORE_API_SKIP_DB_TESTS=1 is set, nothing to build.");
    return;
  }

  if (!process.env.CORE_API_TEST_DATABASE_URL) {
    console.log(
      "setup-template-db: CORE_API_TEST_DATABASE_URL is unset, skipping the template build.\n" +
        "The database-backed suites will fail with setup instructions when they run."
    );
    return;
  }

  await ensureTemplateDatabase();
  console.log("setup-template-db: core_api_test_template is up to date.");
}

main().catch((error) => {
  console.error(`setup-template-db failed: ${error.message}`);
  process.exit(1);
});
