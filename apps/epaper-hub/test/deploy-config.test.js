const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// Spec 9.0: docker-compose.yml moved to the repository root. Reads normalise CRLF --
// this machine is win32, CI is ubuntu, and .gitattributes deliberately pins only
// *.sql and *.sh, so a `$`-anchored regex over raw bytes passes on one and fails on
// the other for reasons that have nothing to do with the rule being asserted.
function readCompose() {
  return fs
    .readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8")
    .replace(/\r\n/g, "\n");
}

test("Docker image includes server helper modules", () => {
  const dockerfile = fs.readFileSync(path.join(appRoot, "Dockerfile"), "utf8");

  assert.match(dockerfile, /COPY epaper-codec\.js/);
  assert.match(dockerfile, /COPY epaper-request-payload\.js/);
  assert.match(dockerfile, /COPY screen-store\.js/);
});

test("Docker Compose exposes app only on localhost for Nginx proxy", () => {
  const compose = readCompose();

  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /epaper-hub:/);
  assert.match(compose, /\$\{EPAPER_IMAGE:-epaper-hub\}/);
  assert.match(compose, /container_name: epaper-hub/);
  assert.match(compose, /\$\{EPAPER_ENV_FILE:-\.env\}/);
  assert.match(compose, /SCREEN_STORE_FILE: \/data\/screens\.json/);
  assert.match(compose, /epaper-data:\/data/);
  assert.match(compose, /^volumes:\n  epaper-data:/m);
  assert.doesNotMatch(compose, /caddy:/);

  // NOT `build: .`. A relative context resolves against the COMPOSE FILE's directory,
  // so this file's move to the repo root would silently repoint `.` at the root --
  // which copies the workspace package.json and then dies on `COPY server.js`.
  // `docker compose config` still prints ok, so nothing but this line catches it.
  assert.match(compose, /^    build:\n      context: apps\/epaper-hub$/m);
  assert.doesNotMatch(compose, /^\s+build: \.$/m);
  assert.doesNotMatch(compose, /^\s+context: \.$/m);
});

test("Docker Compose starts customer ordering after a healthy e-paper hub", () => {
  const compose = readCompose();

  assert.match(compose, /customer-order:/);
  assert.match(compose, /image: \$\{CUSTOMER_ORDER_IMAGE:-customer-order\}/);
  assert.match(compose, /127\.0\.0\.1:3100:3100/);
  assert.match(compose, /EPAPER_HUB_URL: http:\/\/epaper-hub:3000/);
  assert.match(compose, /ORDER_BASE_URL: https:\/\/order\.yeyintlwin\.com/);
  assert.match(compose, /BUSINESS_TIME_ZONE: Asia\/Tokyo/);
  assert.match(compose, /BUSINESS_DAY_ROLLOVER_HOUR: 6/);
  assert.doesNotMatch(compose, /^\s+(?:SHOP_ID|CHECKOUT_API_KEY):/m);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /wget.*http:\/\/localhost:3000\/health/);
});

test("customer environment example documents rollover configuration and server-only secrets", () => {
  const environment = fs.readFileSync(path.join(repoRoot, "apps", "customer-order", ".env.example"), "utf8");

  assert.match(environment, /^SHOP_ID=1$/m);
  assert.match(environment, /^CHECKOUT_API_KEY=replace-with-independent-random-secret$/m);
  assert.match(environment, /^BUSINESS_TIME_ZONE=Asia\/Tokyo$/m);
  assert.match(environment, /^BUSINESS_DAY_ROLLOVER_HOUR=6$/m);
});

test("the local SDK runtime dependency ships in the core-api image, not the customer one", () => {
  // Was "Customer order Docker image includes its local SDK runtime dependency".
  // Spec 11.7 made apps/core-api the ONLY permitted caller of @restaurant/epaper-hub-sdk,
  // so the COPY-and-install pair moved with the require. Asserted as a PAIR, in one test,
  // because the failure that matters is the half-move: leave the lines in
  // customer-order's Dockerfile and the SDK is shipped to a container that cannot use it;
  // drop them from core-api's and the image builds, boots, passes /health/ready and then
  // dies at the first display update with MODULE_NOT_FOUND on qrcode-generator.
  const customer = fs.readFileSync(
    path.join(repoRoot, "apps", "customer-order", "Dockerfile"),
    "utf8",
  );
  const core = fs.readFileSync(path.join(repoRoot, "apps", "core-api", "Dockerfile"), "utf8");

  assert.match(customer, /FROM node:20-alpine/);
  assert.match(customer, /COPY apps\/customer-order \.\/apps\/customer-order/);
  assert.match(customer, /npm --prefix apps\/customer-order install --omit=dev --workspaces=false/);
  assert.match(customer, /EXPOSE 3100/);
  assert.match(customer, /CMD \["node", "apps\/customer-order\/server\.js"\]/);

  // Scoped to the lines that EXECUTE: this Dockerfile explains in a comment directly
  // above the COPY why the SDK is deliberately absent, and a document-wide doesNotMatch
  // would be red against the correct file.
  const customerInstructions = customer
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(customerInstructions, /epaper-hub-sdk/);

  assert.match(core, /COPY packages\/epaper-hub-sdk \.\/packages\/epaper-hub-sdk/);
  assert.match(core, /npm --prefix packages\/epaper-hub-sdk ci --omit=dev/);
});

test("operations docs describe automatic twelve-table startup readiness", () => {
  const rootReadme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const customerReadme = fs.readFileSync(path.join(repoRoot, "apps", "customer-order", "README.md"), "utf8");
  const hubReadme = fs.readFileSync(path.join(repoRoot, "apps", "epaper-hub", "README.md"), "utf8");
  const sdkReadme = fs.readFileSync(path.join(repoRoot, "packages", "epaper-hub-sdk", "README.md"), "utf8");
  const infraReadme = fs.readFileSync(path.join(repoRoot, "infra", "README.md"), "utf8");
  const priorSpec = fs.readFileSync(path.join(repoRoot, "docs", "superpowers", "specs", "2026-07-20-sdk-table-entry-design.md"), "utf8");
  const priorPlan = fs.readFileSync(path.join(repoRoot, "docs", "superpowers", "plans", "2026-07-20-sdk-table-entry.md"), "utf8");
  const docs = [rootReadme, customerReadme, hubReadme, sdkReadme, infraReadme, priorSpec, priorPlan].join("\n");

  assert.match(rootReadme, /resets all 12 displays.*before accepting traffic/i);
  assert.match(customerReadme, /resets all 12 displays.*before accepting traffic/i);
  assert.match(docs, /EPAPER_HUB_URL=http:\/\/epaper-hub:3000/);
  assert.match(docs, /order\.yeyintlwin\.com/);
  assert.match(docs, /127\.0\.0\.1:3100/);
  assert.doesNotMatch(docs, /server startup does not reset displays|startup is intentionally excluded|must not automatically reset displays|next deployment task/i);
});

test("deployment docs list required customer runtime values in the external environment file", () => {
  const paths = [
    path.join(repoRoot, "README.md"),
    path.join(repoRoot, "apps", "epaper-hub", "README.md"),
    path.join(repoRoot, "apps", "customer-order", "README.md"),
    path.join(repoRoot, "packages", "epaper-hub-sdk", "README.md")
  ];

  for (const file of paths) {
    const document = fs.readFileSync(file, "utf8");
    assert.match(document, /SHOP_ID=1/, file);
    assert.match(document, /CHECKOUT_API_KEY=(?:<independent-random-secret>|replace-with-independent-random-secret)/, file);
    assert.match(document, /BUSINESS_TIME_ZONE=Asia\/Tokyo/, file);
    assert.match(document, /BUSINESS_DAY_ROLLOVER_HOUR=6/, file);
    assert.match(document, /external (?:production |runtime )?environment file/i, file);
  }

  const lifecycleDocs = [
    fs.readFileSync(path.join(repoRoot, "README.md"), "utf8"),
    fs.readFileSync(path.join(repoRoot, "apps", "customer-order", "README.md"), "utf8")
  ].join("\n");
  assert.doesNotMatch(lifecycleDocs, /session closure (?:is outside|will be owned)|does not yet close active sessions|not available in the current in-memory order store/i);
});

const secureQrDocs = () => [
  ["README.md", path.join(repoRoot, "README.md")],
  ["apps/customer-order/README.md", path.join(repoRoot, "apps", "customer-order", "README.md")],
  ["apps/epaper-hub/README.md", path.join(repoRoot, "apps", "epaper-hub", "README.md")],
  ["packages/epaper-hub-sdk/README.md", path.join(repoRoot, "packages", "epaper-hub-sdk", "README.md")],
  ["infra/README.md", path.join(repoRoot, "infra", "README.md")],
  ["docs/restaurant-management-system-spec.md", path.join(repoRoot, "docs", "restaurant-management-system-spec.md")]
].map(([label, file]) => [label, fs.readFileSync(file, "utf8")]);

test("documentation no longer instructs the removed table-number ordering flow", () => {
  for (const [label, document] of secureQrDocs()) {
    assert.doesNotMatch(document, /\?table=/, label);
    assert.doesNotMatch(document, /table_number/, label);
    assert.doesNotMatch(document, /table number in the URL/i, label);
  }
});

test("every table-facing document shows the opaque table visit URL", () => {
  for (const [label, document] of secureQrDocs()) {
    assert.match(document, /https:\/\/order\.yeyintlwin\.com\/t\/[A-Za-z0-9_-]{22}/, label);
  }
});

test("lifecycle docs describe QR enrollment, multi-phone sessions, and checkout revocation", () => {
  const lifecycle = [
    fs.readFileSync(path.join(repoRoot, "README.md"), "utf8"),
    fs.readFileSync(path.join(repoRoot, "apps", "customer-order", "README.md"), "utf8")
  ].join("\n");

  assert.match(lifecycle, /22 Base64URL characters/i);
  assert.match(lifecycle, /rsid/);
  assert.match(lifecycle, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(lifecycle, /multiple phones/i);
  assert.match(lifecycle, /Scan the current table QR to continue/);
  assert.match(lifecycle, /\b401\b/);
  assert.match(lifecycle, /\/\?e=expired/);
  assert.match(lifecycle, /POST \/api\/tables\/\{tableNumber\}\/checkout/);
  assert.match(lifecycle, /CHECKOUT_API_KEY/);
  assert.match(lifecycle, /06:00 Asia\/Tokyo/);

  assert.match(lifecycle, /revokes the old QR/i);
  assert.match(lifecycle, /every (?:enrolled )?phone session/i);
  assert.match(lifecycle, /before it updates the display|before the display update/i);
  assert.match(lifecycle, /one pending replacement token/i);
});

test("lifecycle docs state the accepted active-visit photograph limitation", () => {
  const lifecycle = [
    fs.readFileSync(path.join(repoRoot, "README.md"), "utf8"),
    fs.readFileSync(path.join(repoRoot, "apps", "customer-order", "README.md"), "utf8")
  ].join("\n");

  assert.match(lifecycle, /photograph/i);
  assert.match(lifecycle, /remains usable (?:during|for) that active visit/i);
});

test("infra deployment notes cover the secure QR runtime contract", () => {
  const infraReadme = fs.readFileSync(path.join(repoRoot, "infra", "README.md"), "utf8");

  assert.match(infraReadme, /SHOP_ID=1/);
  assert.match(infraReadme, /CHECKOUT_API_KEY/);
  assert.match(infraReadme, /BUSINESS_TIME_ZONE=Asia\/Tokyo/);
  assert.match(infraReadme, /BUSINESS_DAY_ROLLOVER_HOUR=6/);
  assert.match(infraReadme, /06:00 Asia\/Tokyo/);
  assert.match(infraReadme, /restaurant-order-system\.env/);
});

test("GitHub Actions deploys from GitHub-hosted runner over SSH", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "deploy.yml"),
    "utf8",
  );

  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /LIGHTSAIL_SSH_KEY/);
  assert.match(workflow, /npm --prefix apps\/epaper-hub ci/);
  assert.match(workflow, /npm --prefix apps\/epaper-hub test/);
  assert.match(workflow, /npm --prefix packages\/epaper-hub-sdk ci/);
  assert.match(workflow, /npm --prefix packages\/epaper-hub-sdk test/);
  assert.match(workflow, /npm --prefix apps\/customer-order ci/);
  assert.match(workflow, /npm --prefix apps\/customer-order test/);
  assert.doesNotMatch(workflow, /working-directory: apps\/epaper-hub/);
  assert.match(workflow, /docker build -t epaper-hub:\$\{\{ github\.sha \}\} apps\/epaper-hub/);
  assert.match(workflow, /docker save epaper-hub:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /docker build -f apps\/customer-order\/Dockerfile -t customer-order:\$\{\{ github\.sha \}\} \./);
  assert.match(workflow, /docker save customer-order:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /customer-order-image\.tgz/);
  assert.match(workflow, /docker load -i \/tmp\/epaper-hub-image\.tgz/);
  assert.match(workflow, /docker load -i \/tmp\/customer-order-image\.tgz/);
  assert.match(workflow, /scp -i/);
  // `\S+` for the key, then the SOURCE argument, then the opening quote of the
  // destination. NOT `[^\n]*docker-compose\.yml`: that is greedy and the source and
  // destination end in the same basename, so it matches on the DESTINATION alone and
  // stays green when the source is repointed at another file or dropped entirely.
  // Verified by mutation -- source -> infra/docker-compose.yml, -> README.md, and
  // source deleted all pass the loose form and fail this one.
  assert.match(workflow, /scp -i \S+ docker-compose\.yml "/);
  assert.doesNotMatch(workflow, /apps\/epaper-hub\/docker-compose\.yml/);
  assert.match(workflow, /ssh -i/);
  assert.match(workflow, /~\/restaurant-order-system/);
  assert.match(workflow, /restaurant-order-system\.env/);
  assert.match(workflow, /docker compose down \|\| docker stop epaper-emulator \|\| true/);
  assert.match(workflow, /docker volume create restaurant-order-system_epaper-data/);
  assert.match(workflow, /epaper-emulator_epaper-data/);
  assert.match(workflow, /EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env/);
  assert.match(workflow, /CUSTOMER_ORDER_IMAGE=customer-order:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /find ~\/restaurant-order-system -mindepth 1 -maxdepth 1/);
  assert.doesNotMatch(workflow, /docker build -t epaper-hub:\$\{\{ github\.sha \}\} \./);
  assert.doesNotMatch(workflow, /app\.tgz|tar -xzf|APP_API_KEY|cat > \.env|self-hosted/);
});

test("the e-paper hub runbook builds from the repository root, where the compose file now lives", () => {
  // Spec 9.0 lists apps/epaper-hub/README.md:26 explicitly BECAUSE no test covered
  // it. This is that test.
  const hubReadme = fs
    .readFileSync(path.join(repoRoot, "apps", "epaper-hub", "README.md"), "utf8")
    .replace(/\r\n/g, "\n");

  // Deliberately not `$`-anchored: a later task in this plan appends the two service
  // names to this line, and that refinement must not turn this assertion red.
  assert.match(hubReadme, /^ {2}docker compose up -d --build/m);
  assert.doesNotMatch(hubReadme, /docker compose -f apps\/epaper-hub\/docker-compose\.yml/);
  assert.match(hubReadme, /docker-compose\.yml` lives at the repository root/);
});
