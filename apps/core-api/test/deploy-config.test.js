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

test("core-db is pinned to a major, publishes no host port, and reaps an orphaned advisory lock", () => {
  const text = composeText();

  assert.match(text, /^networks:\n  core-net:$/m);
  assert.match(text, /^  core-db:$/m);

  // An unpinned tag eventually pulls 17, which refuses to start against a PGDATA
  // written by 16 and presents as a total outage at 22:00.
  assert.match(text, /^    image: postgres:16-alpine$/m);
  assert.match(text, /^    container_name: core-db$/m);

  // NO `ports:` key at all -- not a loopback-only publish, which differs from a
  // public one by a single deletion. Docker installs published ports as DNAT rules
  // evaluated before ufw's filter chains, so a published port bypasses ufw. Nothing
  // needs one: core-api uses core-net, psql and pg_dump go through
  // `docker compose exec`. Asserting the string is absent from the WHOLE file is
  // stronger than asserting no mapping, and deliberately so.
  assert.doesNotMatch(text, /5432/);

  assert.match(text, /^      POSTGRES_USER: core_api_owner$/m);
  assert.match(text, /^      POSTGRES_DB: core$/m);
  assert.match(text, /^      POSTGRES_INITDB_ARGS: "--data-checksums --encoding=UTF8"$/m);
  assert.match(text, /^      PGDATA: \/var\/lib\/postgresql\/data\/pgdata$/m);

  assert.match(text, /max_connections=40/);
  assert.match(text, /shared_buffers=128MB/);
  assert.match(text, /effective_cache_size=384MB/);
  assert.match(text, /work_mem=4MB/);
  assert.match(text, /maintenance_work_mem=64MB/);
  // Phase 1's largest table holds a few dozen rows; each parallel worker is a memory
  // spike, and the OOM killer is the named top risk on this box.
  assert.match(text, /max_parallel_workers_per_gather=0/);
  assert.match(text, /timezone=UTC/);

  // The default keepalive idle is 2 HOURS, so a SIGKILLed core-api holding the
  // migration lock blocks every deploy for that long. 20 + 5*3 = ~35 s, inside the
  // runner's 60 s bounded retry.
  assert.match(text, /tcp_keepalives_idle=20/);
  assert.match(text, /tcp_keepalives_interval=5/);
  assert.match(text, /tcp_keepalives_count=3/);

  // -h 127.0.0.1 IS LOAD-BEARING: during initdb the entrypoint runs a temporary
  // server on the unix socket ONLY, so a socket pg_isready reports healthy while TCP
  // is still refused and compose starts core-api against nothing.
  assert.match(text, /pg_isready -U core_api_owner -d core -h 127\.0\.0\.1 \|\| exit 1/);
  assert.match(text, /^      start_period: 30s$/m);

  assert.match(text, /^    stop_grace_period: 60s$/m);  // checkpoint instead of SIGKILL at 10 s
  assert.match(text, /^    shm_size: 128mb$/m);
  assert.match(text, /^    oom_score_adj: -500$/m);     // bias the kernel AWAY from the data

  assert.match(text, /core-db-data:\/var\/lib\/postgresql\/data/);
  assert.match(text, /^volumes:\n  epaper-data:\n  core-db-data:$/m);
});

test("core-api joins both networks, publishes only on loopback, and health-checks /health", () => {
  const text = composeText();

  assert.match(text, /^  core-api:$/m);
  assert.match(text, /^    image: \$\{CORE_API_IMAGE:-core-api\}$/m);
  assert.match(text, /^    container_name: core-api$/m);
  assert.match(text, /^    networks: \[core-net, default\]$/m);

  // The "not exposed past Nginx" property lives HERE, not in HOST: a process bound
  // to 127.0.0.1 inside a container is unreachable from docker-proxy and the compose
  // network, so HOST must be 0.0.0.0 and the mapping is what confines it.
  assert.match(text, /127\.0\.0\.1:3200:3200/);
  assert.match(text, /^      HOST: 0\.0\.0\.0$/m);

  assert.match(text, /^      PORT: 3200$/m);
  assert.match(text, /^      API_PUBLIC_ORIGIN: https:\/\/api\.yeyintlwin\.com$/m);
  assert.match(text, /^      TERMINAL_ALLOWED_ORIGINS: ""$/m);   // Phase 1: no CORS headers at all
  assert.match(text, /^      TRUSTED_PROXY_HOPS: 1$/m);
  assert.match(text, /^      SESSION_IDLE_SECONDS: 28800$/m);
  assert.match(text, /^      SESSION_ABSOLUTE_SECONDS: 604800$/m);
  assert.match(text, /^      SCRYPT_SLOTS: 2$/m);
  assert.match(text, /^      DB_POOL_MAX: 8$/m);

  assert.match(text, /depends_on:\n      core-db:\n        condition: service_healthy/);

  // /health, NOT /health/ready. Nothing depends_on core-api, so an unhealthy mark
  // would restart nothing, and a transient DB blip should not produce a misleading
  // container status. The DEPLOY GATE is what calls /health/ready.
  assert.match(text, /wget --no-verbose --tries=1 --spider http:\/\/localhost:3200\/health \|\| exit 1/);
  assert.doesNotMatch(text, /localhost:3200\/health\/ready/);
  assert.match(text, /^      start_period: 60s$/m);

  assert.match(text, /^    mem_limit: 512m$/m);
});

test("every service the compose file declares is one the deploy can actually start", () => {
  // Collapse the Actions expression first: `EPAPER_IMAGE=epaper-hub:${{ github.sha }}`
  // carries two spaces of its own, so whitespace tokenisation is wrong without this.
  const flat = workflowText().replace(/\$\{\{ github\.sha \}\}/g, "SHA");
  const services = servicesOf(composeText());

  assert.deepEqual(
    Object.keys(services).sort(),
    ["core-api", "core-db", "customer-order", "epaper-hub"]
  );

  for (const [name, body] of Object.entries(services)) {
    // Every service interpolates its env_file, and the deploy must export that
    // variable -- Compose validates EVERY service's env_file on EVERY subcommand, so
    // one unresolvable path makes `up`, `config` and `exec` all fail at project load.
    const envFileVar = body.match(/^    env_file:\n      - \$\{([A-Z_]+):-\.env\}$/m);
    assert.ok(envFileVar, `${name}: no interpolated env_file`);
    assert.match(flat, new RegExp(`${envFileVar[1]}=\\.\\./[a-z-]+\\.env`), `${name} env_file`);

    // Only the three built services interpolate an image; core-db pins a literal tag.
    const imageVar = body.match(/^    image: \$\{([A-Z_]+):-/m);
    if (!imageVar) {
      assert.match(body, /^    image: postgres:16-alpine$/m, name);
      continue;
    }
    const assignment = flat.match(new RegExp(`${imageVar[1]}=(\\S+)`));
    assert.ok(assignment, `${name}: deploy.yml never sets ${imageVar[1]}`);
    if (assignment[1].endsWith(":SHA")) {
      // A sha-tagged image exists on the box only because the deploy put it there:
      // there is no registry in this pipeline, so `up` would fail at image PULL.
      const imageName = assignment[1].slice(0, -":SHA".length);
      assert.match(flat, new RegExp(`docker build [^\\n]*-t ${imageName}:SHA`), name);
      assert.match(flat, new RegExp(`docker load -i /tmp/[^\\n]*${imageName}[^\\n]*\\.tgz`), name);
    }
  }

  // The two env paths must never collapse into one another.
  assert.match(flat, /CORE_ENV_FILE=\.\.\/core-api\.env/);
  assert.match(flat, /EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env/);
  assert.doesNotMatch(flat, /CORE_ENV_FILE=\.\.\/restaurant-order-system\.env/);
  assert.doesNotMatch(flat, /EPAPER_ENV_FILE=\.\.\/core-api\.env/);

  // Both files live OUTSIDE the deploy folder, which :84 wipes on every push.
  assert.match(flat, /find ~\/restaurant-order-system -mindepth 1 -maxdepth 1/);

  // The precondition beside the existing one. Without it a missing ~/core-api.env
  // leaves a compose file on the box that NO subcommand can load -- up, config and
  // exec all die at project load -- so the ssh-and-restart reflex is dead too.
  assert.match(flat, /test -f ~\/restaurant-order-system\.env/);
  assert.match(flat, /test -f ~\/core-api\.env \|\| \{ echo 'MISSING ~\/core-api\.env/);

  // The runner's /tmp is not swept between jobs and the box's certainly is not.
  // Deliberately loose: the workflow area may fold these into /tmp/*-image*.tgz.
  assert.match(flat, /rm -f \/tmp\/[^\n]*image[^\n]*\.tgz/);
});
