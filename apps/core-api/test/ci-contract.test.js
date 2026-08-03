const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// apps/core-api/test/ -> apps/core-api/ -> apps/ -> repository root
const repoRoot = path.join(__dirname, "..", "..", "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "deploy.yml");

// Every read normalises CRLF, the same rule as source-structure.test.js's readText().
// These are `^`/`$`-anchored assertions against a .yml file; .gitattributes pins the
// extension as the belt, and this is the braces.
function readWorkflow() {
  return fs.readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");
}

test("CI runs the core-api suite against a real Postgres service container", () => {
  const workflow = readWorkflow();

  // Spec 8.9: a job-level service container in the EXISTING deploy job. A separate
  // test.yml would let a push deploy without tests unless a needs: edge were wired.
  assert.match(workflow, /^    services:$/m);
  assert.match(workflow, /^      postgres:$/m);

  // Pinned to the same literal tag the production compose file uses. An unpinned tag
  // eventually pulls a major the schema was never applied against.
  assert.match(workflow, /image: postgres:16-alpine/);

  // -h 127.0.0.1 for the same reason as production: during initdb the entrypoint runs
  // a temporary server on the unix socket only, so a socket pg_isready reports healthy
  // while TCP is still refused and the first client connection is refused.
  assert.match(workflow, /--health-cmd "pg_isready -U postgres -h 127\.0\.0\.1"/);

  assert.match(workflow, /npm --prefix apps\/core-api ci/);
  assert.match(workflow, /npm --prefix apps\/core-api test/);

  // The MAINTENANCE database the harness connects to in order to create the template
  // and the per-file clones -- never the database under test.
  assert.match(
    workflow,
    /CORE_API_TEST_DATABASE_URL: postgres:\/\/postgres:postgres@127\.0\.0\.1:5432\/postgres/,
  );
});

test("CI never sets the database-test escape hatch", () => {
  const workflow = readWorkflow();

  // CORE_API_SKIP_DB_TESTS=1 is the one deliberate hatch for a laptop with no Postgres,
  // and it produces VISIBLE TAP skips there. Set in CI it would turn the schema and
  // choke-point suites into a green no-op, which is the single failure this file exists
  // to prevent.
  assert.doesNotMatch(workflow, /CORE_API_SKIP_DB_TESTS/);
});

test("the core-api test step runs after the other suites and before the image build", () => {
  const workflow = readWorkflow();

  const customerAt = workflow.indexOf("npm --prefix apps/customer-order test");
  const coreAt = workflow.indexOf("npm --prefix apps/core-api test");
  const buildAt = workflow.indexOf("name: Build images");

  assert.ok(customerAt > -1 && coreAt > customerAt, "core-api steps must follow customer-order");
  assert.ok(buildAt > -1 && coreAt < buildAt, "core-api tests must run before Build images");
});
