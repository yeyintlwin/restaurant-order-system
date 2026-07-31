const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// --- shared helpers ---------------------------------------------------------
// This file is the Plan 5 deploy-assertion suite. The workflow area appends its own
// top-level test() blocks BELOW, re-reading the files inside each test body and
// redeclaring none of these four helpers.
//
// Every read normalises CRLF. The developer machine is win32 and the CI runner is
// ubuntu, and .gitattributes deliberately pins only *.sql and *.sh, so a
// `$`-anchored regex against raw bytes passes on one and fails on the other for
// reasons that have nothing to do with the rule being asserted.
function readText(...segments) {
  return fs.readFileSync(path.join(...segments), "utf8").replace(/\r\n/g, "\n");
}

function composeText() {
  return readText(repoRoot, "docker-compose.yml");
}

function workflowText() {
  return readText(repoRoot, ".github", "workflows", "deploy.yml");
}

// Split the compose text into { serviceName: bodyText }. A regex over the whole file
// cannot tell "epaper-hub does NOT list CORE_ENV_FILE" from "the string appears
// somewhere in the file", and that difference is the entire point of spec 9.2.
function servicesOf(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("services:");
  assert.ok(start >= 0, "docker-compose.yml has no services: block");

  const bodies = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;                       // next top-level key
    const header = line.match(/^  ([a-z][a-z0-9-]*):\s*$/);
    if (header) {
      current = header[1];
      bodies[current] = [];
      continue;
    }
    if (current) bodies[current].push(line);
  }
  return Object.fromEntries(
    Object.entries(bodies).map(([name, body]) => [name, body.join("\n")])
  );
}

test("the core-api image installs from its own lockfile and ships its scripts", () => {
  const dockerfile = readText(appRoot, "Dockerfile");

  assert.match(dockerfile, /^FROM node:20-alpine$/m);
  assert.match(dockerfile, /^WORKDIR \/app$/m);

  // Built from the REPOSITORY ROOT with an explicit -f, exactly like customer-order.
  // This single COPY also carries scripts/, which create-platform-admin.js (Plan 2),
  // unlock-account.js and set-password.js need at `docker compose exec` time.
  assert.match(dockerfile, /^COPY apps\/core-api \.\/apps\/core-api$/m);
  assert.doesNotMatch(dockerfile, /^COPY apps\/core-api\/server\.js/m);

  // `ci`, not `install`: core-api is the first app here with a real dependency tree,
  // and failing loudly on a stale lockfile is what a release build should do.
  assert.match(dockerfile, /npm --prefix apps\/core-api ci --omit=dev --workspaces=false/);
  // npm ci cannot run without it.
  assert.ok(fs.existsSync(path.join(appRoot, "package-lock.json")), "apps/core-api/package-lock.json");

  assert.match(dockerfile, /^ENV NODE_ENV=production PORT=3200 HOST=0\.0\.0\.0 TZ=UTC$/m);
  assert.match(dockerfile, /^EXPOSE 3200$/m);
  assert.match(dockerfile, /^CMD \["node", "apps\/core-api\/server\.js"\]$/m);

  // pg-native needs libpq plus a C toolchain and fails instantly on the win32 dev
  // machine; the pure-JS driver is the only supported one. Scoped to INSTRUCTION
  // lines: the comment above the RUN names pg-native deliberately, to say why it is
  // absent, and a bare /pg-native/ would forbid the Dockerfile from explaining
  // itself -- the same defect the Plan 5 review found in Task 12's --no-owner rule.
  const instructions = dockerfile
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(instructions, /pg-native/);

  // The build context is the repository ROOT, which is what makes this line
  // load-bearing: without it a developer's apps/core-api/.env -- now holding
  // DATABASE_URL -- is baked into the production image. Added by Plan 1 Task 2 and
  // also asserted by C12; re-asserted here because this image is what it protects.
  const dockerignore = readText(repoRoot, ".dockerignore");
  assert.match(dockerignore, /^apps\/\*\/\.env$/m);
  assert.match(dockerignore, /^node_modules$/m);
});
