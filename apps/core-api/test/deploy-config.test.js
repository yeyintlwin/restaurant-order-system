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
  assert.match(text, /wget --no-verbose --tries=1 --spider http:\/\/127\.0\.0\.1:3200\/health \|\| exit 1/);
  assert.doesNotMatch(text, /127\.0\.0\.1:3200\/health\/ready/);
  assert.match(text, /^      start_period: 60s$/m);

  // The probe must dial 127.0.0.1, never the hostname form: /etc/hosts in this image
  // maps that name to ::1 ONLY, and core-api sets HOST=0.0.0.0, which is IPv4-only.
  // Shipped as the hostname form, this probe dialled [::1]:3200 and was refused on
  // every run -- unhealthy from the first deploy while /health answered 200 throughout.
  //
  // Scoped twice over. To the line that EXECUTES, because the compose file explains
  // this trap in a comment directly above the directive and a document-wide
  // doesNotMatch would be red against a CORRECT file -- this plan's signature defect.
  // And to core-api's own probe (:3200), because epaper-hub's keeps the hostname form
  // on purpose: it binds dual-stack, and its literal is pinned by the hub area's suite.
  const coreApiProbe = text
    .split("\n")
    .filter((line) => line.includes("--spider") && line.includes(":3200") && !line.trim().startsWith("#"));
  assert.equal(coreApiProbe.length, 1, "expected exactly one core-api wget --spider probe");
  assert.doesNotMatch(
    coreApiProbe[0],
    /:\/\/localhost:/,
    `core-api's healthcheck dials ::1, which HOST=0.0.0.0 never answers: ${coreApiProbe[0].trim()}`
  );

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

test("only core-db and core-api see the Postgres secrets file and the core network", () => {
  const services = servicesOf(composeText());

  // Pin core-db from its own side first, exactly, so `[core-net, default]` cannot
  // slip past a substring match.
  assert.match(services["core-db"], /^    networks: \[core-net\]$/m);
  assert.doesNotMatch(services["core-db"], /networks:.*default/);

  // epaper-hub is internet-facing and authenticates on req.query.api_key. Sharing an
  // env_file or a network with core-db would turn any code-execution or SSRF bug
  // there into `COPY ... TO PROGRAM` as core_api_owner -- a shell in the database
  // container, every tenant row, every scrypt hash.
  for (const [name, body] of Object.entries(services)) {
    const core = name === "core-db" || name === "core-api";
    assert.equal(/\$\{CORE_ENV_FILE:-\.env\}/.test(body), core, `${name} env_file`);
    assert.equal(/^    networks: \[[^\]]*\bcore-net\b/m.test(body), core, `${name} core-net`);
    // core-api is the ONLY service on both. epaper-hub and customer-order declare no
    // networks key at all, so they are on default implicitly -- which is correct.
    assert.equal(
      /^    networks: \[[^\]]*\bdefault\b/m.test(body),
      name === "core-api",
      `${name} default`
    );
  }

  assert.match(services["epaper-hub"], /\$\{EPAPER_ENV_FILE:-\.env\}/);
  assert.match(services["customer-order"], /\$\{EPAPER_ENV_FILE:-\.env\}/);
  assert.doesNotMatch(services["core-db"], /EPAPER_ENV_FILE/);
  assert.doesNotMatch(services["core-api"], /EPAPER_ENV_FILE/);

  // The OOM killer is the named top risk on this box: point it at the three
  // restartable app containers and away from the one holding the data.
  assert.match(services["core-db"], /^    oom_score_adj: -500$/m);
  for (const name of ["core-api", "epaper-hub", "customer-order"]) {
    assert.match(services[name], /^    oom_score_adj: 500$/m, name);
  }
});

test("the operator docs name the second secrets file and why core-db publishes no port", () => {
  const infra = readText(repoRoot, "infra", "README.md");
  const rootReadme = readText(repoRoot, "README.md");
  const hubReadme = readText(repoRoot, "apps", "epaper-hub", "README.md");
  const coreReadme = readText(repoRoot, "apps", "core-api", "README.md");

  assert.match(infra, /^## Core API runtime: two secrets files and core-net$/m);
  assert.match(infra, /~\/core-api\.env/);
  assert.match(infra, /mode `600`/);
  assert.match(infra, /CORE_ENV_FILE=\.\.\/core-api\.env/);
  assert.match(infra, /POSTGRES_PASSWORD/);
  assert.match(infra, /DATABASE_MIGRATION_URL/);
  assert.match(infra, /DATABASE_URL/);
  assert.match(infra, /COPY \.\.\. TO PROGRAM/);
  assert.match(infra, /core-net/);
  assert.match(infra, /api\.yeyintlwin\.com/);
  assert.match(infra, /127\.0\.0\.1:3200/);

  // The ufw fact infra/README.md does not currently record, and this phase must add.
  assert.match(infra, /DNAT/);
  assert.match(infra, /bypasses ufw/);
  assert.match(infra, /no `ports:` key at all/);

  // `docker compose config` INTERPOLATES env_file contents into its output. A bare
  // invocation on the box prints POSTGRES_PASSWORD and both DSNs in cleartext.
  assert.match(infra, /Never run `docker compose config` on this box without `--quiet` or `--services`/);

  // And nobody is told to put the database secrets in the shared file.
  assert.doesNotMatch(infra, /POSTGRES_PASSWORD[^\n]*restaurant-order-system\.env/);
  assert.doesNotMatch(rootReadme, /POSTGRES_PASSWORD[^\n]*restaurant-order-system\.env/);

  assert.match(rootReadme, /~\/core-api\.env/);
  assert.match(hubReadme, /^CORE_ENV_FILE=\/path\/to\/core-api\.env \\$/m);

  // Plan 2 owns the script itself; the runbook line must at least be RUNNABLE when it
  // arrives. Compose validates EVERY service's env_file on EVERY subcommand, so a
  // one-variable `docker compose exec` dies at project load complaining about the
  // OTHER file. This is a per-line rule, so it cannot pass by matching a fixture.
  for (const [label, document] of [
    ["infra/README.md", infra],
    ["apps/core-api/README.md", coreReadme],
    ["apps/epaper-hub/README.md", hubReadme],
    ["README.md", rootReadme]
  ]) {
    for (const line of document.split("\n")) {
      if (line.includes("docker compose") && line.includes("CORE_ENV_FILE=")) {
        assert.match(line, /EPAPER_ENV_FILE=/, `${label}: ${line}`);
      }
    }
  }

  // Plan 2, said plainly, so nobody goes looking for the script in this plan.
  assert.match(coreReadme, /Ships in a later plan of this phase/);
});

test("deploy workflow serialises production deploys with a concurrency group", () => {
  const workflow = workflowText();

  // Two simultaneous deploys share one host, one project directory, one set of
  // container_name: values and one set of fixed /tmp paths. Spec 9.5 calls this a
  // blocker, not hardening.
  assert.match(workflow, /^concurrency:$/m);
  assert.match(workflow, /^  group: deploy-production$/m);

  // cancel-in-progress: false SPECIFICALLY. Cancelling mid-ssh kills the LOCAL SSH
  // client and leaves the remote shell running, which is how the migration advisory
  // lock gets orphaned.
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/);

  // Workflow level, not job level: a job-level key would not serialise across runs.
  const concurrencyAt = workflow.indexOf("\nconcurrency:");
  const jobsAt = workflow.indexOf("\njobs:");
  assert.ok(
    concurrencyAt > -1 && jobsAt > -1 && concurrencyAt < jobsAt,
    "concurrency: must be declared at workflow level, above jobs:",
  );
});

test("deploy workflow uploads the nginx configs and both infra scripts", () => {
  const workflow = workflowText();
  const root = path.join(__dirname, "..", "..", "..");

  // ~/backups must exist and be 0700 before block 1 writes the first pre-deploy dump
  // into it, and config/ is the one directory the deploy's find preserves.
  assert.match(
    workflow,
    /mkdir -p ~\/restaurant-order-system\/config ~\/backups && chmod 700 ~\/backups/,
  );

  // The mkdir above runs in Upload app, BEFORE Deploy on Lightsail, so `[ ! -d
  // ~/restaurant-order-system/config ]` is false from this commit onward: the mv is
  // dead code and `rm -rf ~/epaper-emulator` becomes the only line touching the legacy
  // config. Content-aware, and a copy -- `mv` into an existing directory would also
  // produce config/config.
  assert.match(workflow, /\[ -z "\$\(ls -A ~\/restaurant-order-system\/config 2>\/dev\/null\)" \]/);
  assert.match(workflow, /cp -a ~\/epaper-emulator\/config\/\. ~\/restaurant-order-system\/config\//);
  assert.doesNotMatch(workflow, /\[ ! -d ~\/restaurant-order-system\/config \]/);
  assert.doesNotMatch(workflow, /mv ~\/epaper-emulator\/config ~\/restaurant-order-system\/config/);

  // Nginx files land in /tmp. The find in the deploy heredoc deletes everything in
  // ~/restaurant-order-system that is not docker-compose.yml or config/, so a file
  // scp'd "alongside the compose file" is erased before docker compose up -d while
  // every text assertion here would still be green.
  assert.match(workflow, /scp -i [^\n]*infra\/nginx\/api\.conf [^\n]*:\/tmp\/api\.conf"/);
  assert.match(
    workflow,
    /scp -i [^\n]*infra\/nginx\/core-api-proxy\.conf [^\n]*:\/tmp\/core-api-proxy\.conf"/,
  );
  assert.doesNotMatch(
    workflow,
    /scp -i [^\n]*api\.conf [^\n]*:~\/restaurant-order-system\/api\.conf/,
  );

  // Both host scripts go under config/. restore-drill.sh drives `docker compose`, so
  // it cannot live inside the image -- spec 9.7's scripts/ path is superseded, and
  // without this line the drill is never on the box.
  assert.match(
    workflow,
    /scp -i [^\n]*infra\/backup-core-db\.sh [^\n]*:~\/restaurant-order-system\/config\/backup-core-db\.sh"/,
  );
  assert.match(
    workflow,
    /scp -i [^\n]*infra\/restore-drill\.sh [^\n]*:~\/restaurant-order-system\/config\/restore-drill\.sh"/,
  );

  // Every scp SOURCE that is a tracked repository file must exist, or the deploy dies
  // on the box for a reason node --test could have caught. The image tarballs are
  // build outputs and are deliberately not in this list.
  for (const source of [
    "docker-compose.yml",
    "infra/nginx/api.conf",
    "infra/nginx/core-api-proxy.conf",
    "infra/backup-core-db.sh",
    "infra/restore-drill.sh",
  ]) {
    assert.ok(
      fs.existsSync(path.join(root, source)),
      `${source} is scp'd by the Upload app step but does not exist in the working tree`,
    );
  }
});

test("deploy heredoc gates on disk, prunes tarballs and takes a pre-deploy dump", () => {
  const workflow = workflowText();

  // A full disk is the most common cause of a truncated dump. In block 6 this fires
  // AFTER the migration applied; at the top of the heredoc it aborts before anything
  // on the box has changed.
  assert.match(workflow, /df -P "\$HOME" \| awk 'NR==2 && \$5\+0 > 85 \{ print "disk " \$5 " full"; exit 1 \}'/);
  const dfAt = workflow.indexOf('df -P "$HOME"');
  const loadAt = workflow.indexOf("docker load -i /tmp/epaper-hub-image.tgz");
  assert.ok(dfAt > -1 && loadAt > dfAt, "the disk gate must run before the first docker load");

  // One tarball per deploy, kept forever, is what eventually trips the gate above for
  // a reason that has nothing to do with the database.
  assert.match(
    workflow,
    /rm -f \/tmp\/core-api-image-\*\.tgz \/tmp\/epaper-hub-image\.tgz \/tmp\/customer-order-image\.tgz/,
  );
  const pruneAt = workflow.indexOf("rm -f /tmp/core-api-image-*.tgz");
  assert.ok(pruneAt > loadAt, "the tarballs are deleted only once they are in the image store");

  assert.match(workflow, /docker volume create restaurant-order-system_core-db-data/);

  // The exports must be exports, not a one-line prefix: every later `docker compose`
  // call in the heredoc has to agree about CORE_ENV_FILE. Compose's two variables must
  // survive the rewrite verbatim.
  assert.match(workflow, /export EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env/);
  assert.match(workflow, /export CORE_ENV_FILE=\.\.\/core-api\.env/);
  assert.match(workflow, /export CORE_API_IMAGE=core-api:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /export CUSTOMER_ORDER_IMAGE=customer-order:\$\{\{ github\.sha \}\}/);

  // ONCE each, not merely present. Task 3's log records this plan shipping
  // `EPAPER_ENV_FILE=` twice on one line because the verifier of the day checked only
  // that it appeared; this task's own Step 3 text then wrote the export twice. A
  // duplicate is harmless until the two copies disagree, and then it is a variable
  // whose value depends on which line came last.
  for (const name of ["EPAPER_ENV_FILE", "CORE_ENV_FILE", "EPAPER_IMAGE", "CUSTOMER_ORDER_IMAGE", "CORE_API_IMAGE"]) {
    const exports = workflow.split("\n").filter((line) => line.trim().startsWith(`export ${name}=`));
    assert.equal(exports.length, 1, `export ${name} appears ${exports.length} times, expected once`);
  }

  // `docker compose ps --quiet core-db` is true only when core-db is RUNNING, so it
  // cannot tell "does not exist yet" from "exists and is down" -- and the deploy most
  // likely to need the dump is the one that would silently skip it.
  assert.match(
    workflow,
    /if docker volume inspect restaurant-order-system_core-db-data >\/dev\/null 2>&1; then/,
  );
  // Scoped to the lines that EXECUTE. The heredoc explains the `ps` trap in a comment
  // directly above the gate, so a document-wide doesNotMatch is red against a CORRECT
  // workflow -- this plan's signature shape, seventh occurrence. Mutation-tested:
  // swapping the volume gate for the ps form turns this red.
  const executable = workflow.split("\n").filter((line) => !line.trim().startsWith("#"));
  for (const line of executable) {
    assert.doesNotMatch(line, /docker compose ps --quiet core-db/, `ps cannot see a stopped core-db: ${line.trim()}`);
  }

  // exec -T on every dump: a TTY translates CRLF and silently corrupts a binary
  // custom-format dump, which is not visible until the restore.
  assert.match(
    workflow,
    /docker compose exec -T core-db sh -c 'PGPASSWORD="\$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d core -Fc'/,
  );
  assert.doesNotMatch(workflow, /docker compose exec core-db[^\n]*pg_dump/);

  // The heredoc IS the remote shell's stdin; an exec -T with stdin attached eats the
  // rest of it and truncates the deploy at an arbitrary line with no error.
  assert.match(workflow, /pg_isready -U core_api_owner -d core -h 127\.0\.0\.1 <\/dev\/null/);

  // Size, then structure -- an OOM kill or a full disk mid-dump yields a truncated file
  // that pg_dump exits 0 on often enough to matter.
  assert.match(workflow, /test -s ~\/backups\/pre-deploy-"\$ts"\.dump/);
  assert.match(workflow, /pg_restore --list < ~\/backups\/pre-deploy-"\$ts"\.dump/);
  assert.match(workflow, /chmod 600 ~\/backups\/pre-deploy-"\$ts"\.dump/);

  // The sha in LAST_PRE_DEPLOY is what lets the artifact step refuse a stale dump.
  assert.match(
    workflow,
    /printf '%s %s\\n' "\$\{\{ github\.sha \}\}" "pre-deploy-\$ts\.dump" > ~\/backups\/LAST_PRE_DEPLOY/,
  );
  assert.match(workflow, /ln -sfn ~\/backups\/pre-deploy-"\$ts"\.dump ~\/backups\/latest-pre-deploy\.dump/);

  // Retention: one pre-deploy dump per deploy, forever, is the other new disk consumer.
  assert.match(
    workflow,
    /ls -1t "\$HOME"\/backups\/pre-deploy-\*\.dump 2>\/dev\/null \| tail -n \+15 \| xargs -r rm -f/,
  );

  // The volume literal in deploy.yml must not drift from docker-compose.yml's
  // declaration. Docker names the volume <project>_<declared name>, and the project is
  // the deploy directory -- so renaming the volume in compose alone would leave this
  // deploy creating and inspecting a volume nothing else uses, and the dump gate would
  // silently skip on every deploy. Both literals ship in THIS task, which is why the
  // check lives here.
  const compose = composeText();
  const volumesAt = compose.indexOf("\nvolumes:\n");
  assert.notEqual(volumesAt, -1, "docker-compose.yml has no top-level volumes: block");
  const declared = (compose.slice(volumesAt).match(/^ {2}([a-z0-9_-]+):$/gm) || [])
    .map((line) => line.trim().replace(":", ""));
  const coreVolume = declared.find((name) => name.includes("core-db"));
  assert.ok(coreVolume, `docker-compose.yml declares no core-db volume; found ${declared.join(", ")}`);
  const full = `restaurant-order-system_${coreVolume}`;
  assert.ok(workflow.includes(`docker volume create ${full}`), `deploy.yml does not create ${full}`);
  assert.ok(workflow.includes(`docker volume inspect ${full}`), `deploy.yml does not inspect ${full}`);
});

test("deploy heredoc installs nginx with a two-file snapshot, validate and rollback", () => {
  const workflow = workflowText();

  // Order is the whole point. Install-then-validate leaves a broken file on disk that
  // only bites days later, when certbot's renew hook or a reboot reloads nginx.
  const staleAt = workflow.indexOf("sudo rm -f /tmp/api.conf.bak /tmp/core-api-proxy.conf.bak");
  const snapshotAt = workflow.indexOf("/tmp/api.conf.bak 2>/dev/null");
  const installAt = workflow.indexOf("sudo install -m0644 /tmp/api.conf");
  const validateAt = workflow.indexOf("if ! sudo nginx -t; then");
  const reloadAt = workflow.indexOf("sudo systemctl reload nginx");
  const proofAt = workflow.indexOf("nginx_dump=$(sudo nginx -T");

  assert.ok(staleAt > -1, "the stale .bak files must be removed before this run snapshots");
  assert.ok(snapshotAt > staleAt, "the snapshot must follow the stale-bak removal");
  assert.ok(installAt > snapshotAt, "the snapshot must be taken before the install");
  assert.ok(validateAt > installAt, "nginx -t must run after the install");
  assert.ok(reloadAt > validateAt, "the reload must come only after a passing nginx -t");
  assert.ok(proofAt > reloadAt, "the directive proofs read the config nginx actually loaded");

  // BOTH files are snapshotted and BOTH are restored. Rolling back half of a two-file
  // change leaves the box in a state neither version produced.
  assert.match(
    workflow,
    /sudo cp -a \/etc\/nginx\/snippets\/core-api-proxy\.conf \/tmp\/core-api-proxy\.conf\.bak 2>\/dev\/null \|\| :/,
  );
  assert.match(
    workflow,
    /sudo cp -a \/tmp\/api\.conf\.bak \/etc\/nginx\/conf\.d\/api\.yeyintlwin\.com\.conf/,
  );
  assert.match(
    workflow,
    /sudo cp -a \/tmp\/core-api-proxy\.conf\.bak \/etc\/nginx\/snippets\/core-api-proxy\.conf/,
  );
  assert.match(workflow, /sudo rm -f \/etc\/nginx\/conf\.d\/api\.yeyintlwin\.com\.conf/);
  assert.match(workflow, /sudo rm -f \/etc\/nginx\/snippets\/core-api-proxy\.conf/);
  assert.match(
    workflow,
    /sudo install -m0644 -D \/tmp\/core-api-proxy\.conf \/etc\/nginx\/snippets\/core-api-proxy\.conf/,
  );

  // The two directives TRUSTED_PROXY_HOPS=1 and the login rate limit depend on.
  // Captured ONCE: `nginx -T` piped straight into `grep -q` has the pipe closed on the
  // first match, and once the config dump exceeds the 64 KB pipe buffer nginx -T takes
  // SIGPIPE and pipefail aborts the deploy AFTER the reload has already happened.
  assert.match(workflow, /nginx_dump=\$\(sudo nginx -T 2>\/dev\/null\)/);
  // Scoped to the lines that EXECUTE: the heredoc names the broken form in a comment
  // to explain why it is forbidden, so a document-wide doesNotMatch is red against a
  // CORRECT workflow. Eighth occurrence of this plan's signature shape.
  for (const line of workflow.split("\n").filter((l) => !l.trim().startsWith("#"))) {
    assert.doesNotMatch(line, /sudo nginx -T \| grep/, `nginx -T into grep -q takes SIGPIPE: ${line.trim()}`);
  }

  // Whitespace-tolerant: api.conf is column-aligned (`X-Forwarded-For   $proxy_add_…`,
  // three spaces) and a literal single-space pattern never matches anything.
  assert.match(
    workflow,
    /printf '%s\\n' "\$nginx_dump" \| grep -Eq 'limit_req_zone \+\[\^;\]\*zone=core_login' \|\| \{ echo/,
  );
  assert.match(
    workflow,
    /printf '%s\\n' "\$nginx_dump" \| grep -Eq 'proxy_set_header \+X-Forwarded-For \+\\\$proxy_add_x_forwarded_for' \|\| \{ echo/,
  );

  // The patterns must match the files this step actually installs. If they do not, the
  // deploy reloads nginx and THEN aborts -- the failure mode is a live reload followed
  // by a red build, which reads as "nginx is broken" when nginx is fine.
  const apiConf = readText(repoRoot, "infra", "nginx", "api.conf");
  const proxyConf = readText(repoRoot, "infra", "nginx", "core-api-proxy.conf");
  assert.match(apiConf, /limit_req_zone +[^;]*zone=core_login/);
  assert.match(proxyConf, /proxy_set_header +X-Forwarded-For +\$proxy_add_x_forwarded_for/);
});

test("deploy heredoc gates on /health/ready and then on the real TLS chain", () => {
  const workflow = workflowText();

  // 45 iterations x 2 s = the 90 s the spec settles on.
  assert.match(workflow, /while \[ "\$i" -lt 45 \]; do/);

  // The DEPLOY gate reads /health/ready; the container healthcheck deliberately reads
  // /health, because nothing depends on core-api and an unhealthy mark would restart
  // nothing.
  assert.match(workflow, /curl -fsS -m 3 http:\/\/127\.0\.0\.1:3200\/health\/ready/);

  // A failed gate must print why, or the only artefact of a bad deploy is a red tick.
  assert.match(workflow, /docker compose logs --tail 200 core-api/);
  assert.match(workflow, /docker compose logs --tail 50 core-db/);

  // nginx -T proves the DIRECTIVES are loaded. It does not prove a server block matches
  // api.yeyintlwin.com, that the certificate serves, or that the request reaches
  // core-api.
  assert.match(
    workflow,
    /curl -fsS -m 5 --resolve api\.yeyintlwin\.com:443:127\.0\.0\.1 https:\/\/api\.yeyintlwin\.com\/health >/,
  );

  const upAt = workflow.indexOf("docker compose up -d --no-build");
  const gateAt = workflow.indexOf("http://127.0.0.1:3200/health/ready");
  assert.ok(upAt > -1 && gateAt > upAt, "the health gate must run after docker compose up");

  // The gate does not roll back, and the runbook line is carried in the file on purpose
  // so nobody has to find it under pressure.
  assert.match(workflow, /THIS GATE DOES NOT AUTO-ROLL-BACK/);
  assert.match(workflow, /CORE_API_IMAGE=core-api:<previous-sha> docker compose up -d core-api/);

  // The rollback recipe is a COMMENT, and must stay one: run as code it would pin
  // production to a literal image tag named "<previous-sha>".
  for (const line of workflow.split("\n")) {
    if (line.includes("core-api:<previous-sha>")) {
      assert.match(line.trim(), /^#/, `the rollback recipe must stay commented: ${line.trim()}`);
    }
  }
});

test("deploy heredoc probes the login path before it exhausts the limit_req bucket", () => {
  const workflow = workflowText();

  const probeAt = workflow.indexOf("xff-probe@invalid.test");
  const burstAt = workflow.indexOf("deploy-probe@invalid.test");
  assert.ok(probeAt > -1, "the login-path probe is missing");
  assert.ok(burstAt > -1, "the limit_req burst probe is missing");
  // Run the burst first and it exhausts the core_login bucket for this source address:
  // nginx then sheds the probe, it never reaches core-api, and every assertion below is
  // vacuous.
  assert.ok(probeAt < burstAt, "the login-path probe must run BEFORE the limit_req burst");

  // The probe asserts on the RESPONSE. A `curl -fsS … || true` proves nothing at all.
  assert.match(workflow, /-H 'X-Forwarded-For: 203\.0\.113\.99'/);
  assert.match(workflow, /test "\$probe_status" = "404"/);
  assert.match(workflow, /grep -q '"code":"not_found"' \/tmp\/xff-probe\.body/);
  assert.doesNotMatch(workflow, /xff-probe@invalid\.test[^\n]*\|\| true/);

  // Read the RUNNING PROCESS, not the project files. The `exec … printenv` form echoes
  // back the compose file this same deploy uploaded, so it agrees with itself while
  // PID 1 still carries an older environment.
  assert.match(workflow, /tr "\\0" "\\n" < \/proc\/1\/environ/);
  assert.match(workflow, /sed -n 's\/\^TRUSTED_PROXY_HOPS=\/\/p'/);
  assert.match(workflow, /test "\$hops" = "1" \|\| \{ echo "core-api PID 1 has TRUSTED_PROXY_HOPS/);
  // Scoped to the lines that EXECUTE: the heredoc names the `printenv` form in a comment
  // to explain why it is forbidden, so a document-wide doesNotMatch is red against a
  // CORRECT workflow. Ninth occurrence of this plan's signature shape.
  for (const line of workflow.split("\n").filter((l) => !l.trim().startsWith("#"))) {
    assert.doesNotMatch(
      line,
      /printenv TRUSTED_PROXY_HOPS/,
      `printenv reports the environment compose builds now, not PID 1's: ${line.trim()}`,
    );
  }

  // The forgeability half needs Plan 2's auth route and audit writer. The marker is what
  // stops it from being forgotten, and it has a defined removal trigger.
  assert.match(workflow, /PLAN 2: restore the full forgeability assertion here/);
  assert.match(workflow, /detail->>'email' = 'xff-probe@invalid\.test'/);

  // The burst itself ships in full today: nginx applies limit_req before proxying, so
  // the 429s appear whether or not the route exists.
  assert.match(workflow, /for n in \$\(seq 1 20\)/);
  assert.match(workflow, /echo "\$codes" \| grep -q 429/);

  // The 404 expectation must break HERE, in CI, and not at 22:00 on the box after the
  // migration has already applied.
  const routesDir = path.join(__dirname, "..", "http", "routes");
  for (const entry of fs.readdirSync(routesDir)) {
    if (!entry.endsWith(".js")) continue;
    const source = fs
      .readFileSync(path.join(routesDir, entry), "utf8")
      .replace(/\r\n/g, "\n");
    assert.ok(
      !source.includes('"/api/admin/auth/login"'),
      `http/routes/${entry} registers /api/admin/auth/login, so the deploy's block 4 probe now gets 401 and aborts the deploy AFTER the migration applied. In the same commit that registers the route: change block 4's expected status from 404 to 401, restore the audit_events forgeability assertion, delete the PLAN 2 marker.`,
    );
  }
});

test("deploy heredoc makes a silent backup failure a red build", () => {
  const workflow = workflowText();

  // A truncated dump never replaces a good one and never counts toward retention; the
  // leftovers are swept here so they cannot accumulate.
  assert.match(workflow, /rm -f "\$HOME"\/backups\/\*\.part/);

  // LAST_OK means "a dump completed AND WAS READ END TO END": the nightly touches it
  // only after `pg_restore --data-only -f /dev/null`, never after `--list` alone --
  // -Fc writes the TOC first, so a dump truncated at 80% by a full disk passes --list.
  // Checking the newest nightly-*.dump instead would be satisfied by that same file.
  assert.match(workflow, /find "\$HOME\/backups\/LAST_OK" -mtime -2 2>\/dev\/null \| grep -q \./);
  // And the workflow must not restate the weaker definition, which is the one an
  // operator would act on at 02:00.
  assert.doesNotMatch(workflow, /LAST_OK means[^\n]*passed pg_restore --list/);
  assert.match(workflow, /no successful core-db nightly in 48h/);

  // Gated on the BOOTSTRAP MARKER, not on LAST_OK's existence. `&& [ -f LAST_OK ]`
  // makes the one failure this gate exists to catch -- the nightly never having
  // succeeded even once -- silent forever, because a missing LAST_OK simply skips the
  // check. CRON_INSTALLED_AT is written once, when the deploy first installs the
  // crontab, so the gate stays quiet only while the nightly has legitimately had no
  // chance to run.
  assert.match(workflow, /find "\$HOME\/backups\/CRON_INSTALLED_AT" -mtime -2/);
  assert.doesNotMatch(workflow, /&& \[ -f "\$HOME\/backups\/LAST_OK" \]/);

  // The disk gate lives at the TOP of the heredoc, not here: in this position it fires
  // after the migration has already applied.
  const dfAt = workflow.indexOf('df -P "$HOME"');
  const sweepAt = workflow.indexOf('rm -f "$HOME"/backups/*.part');
  assert.ok(dfAt > -1 && sweepAt > dfAt, "the disk gate must stay above the backup-health block");
});

test("deploy heredoc installs cron in a way that survives a box with no crontab", () => {
  const workflow = workflowText();

  // On a box with NO crontab: crontab -l exits 1, grep on empty input exits 1, pipefail
  // propagates, and set -e aborts the deploy with an EMPTY message before the service
  // starts. On Vixie cron `| crontab -` with empty stdin also wipes whatever crontab did
  // exist.
  assert.match(
    workflow,
    /\{ crontab -l 2>\/dev\/null \|\| true; \} \| \{ grep -Fv [^\n]*\|\| true; \} > \/tmp\/ct\.\$\$/,
  );
  // Scoped to the lines that EXECUTE: the heredoc names the fragile form in a comment to
  // explain why it is forbidden, so a document-wide doesNotMatch is red against a CORRECT
  // workflow. Tenth occurrence of this plan's signature shape.
  for (const line of workflow.split("\n").filter((l) => !l.trim().startsWith("#"))) {
    assert.doesNotMatch(
      line,
      /crontab -l \| grep -Fv/,
      `this form aborts the deploy on a box with no crontab: ${line.trim()}`,
    );
  }
  assert.doesNotMatch(workflow, /\| crontab -$/m);
  assert.match(workflow, /crontab \/tmp\/ct\.\$\$ && rm -f \/tmp\/ct\.\$\$/);

  // Rewriting the crontab every deploy must be idempotent. The PATH line is re-appended
  // by the printf below, so the EXACT string has to be in the strip list or the crontab
  // grows by one line per deploy, forever.
  assert.match(
    workflow,
    /grep -Fv -e 'backup-core-db\.sh' -e 'sweep-expired\.js' -e 'PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'/,
  );

  assert.match(workflow, /17 3 \* \* \* %s\/restaurant-order-system\/config\/backup-core-db\.sh/);
  assert.match(
    workflow,
    /43 3 \* \* \* cd %s\/restaurant-order-system && CORE_ENV_FILE=\.\.\/core-api\.env EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env docker compose exec -T core-api node apps\/core-api\/scripts\/sweep-expired\.js/,
  );

  // Both proofs. AUDIT_RETENTION_DAYS configures nothing unless the sweep is installed,
  // and the line without its grep is the one combination that must never ship.
  assert.match(workflow, /crontab -l \| grep -q backup-core-db\.sh/);
  assert.match(workflow, /crontab -l \| grep -q sweep-expired\.js/);

  // The bootstrap marker block 6 gates on. Written ONCE -- touching it every deploy
  // would keep it permanently fresh on a repo that deploys daily and the 48-hour
  // backup-health gate would never fire. Nothing else in the deploy writes this file,
  // so if this line is missing the gate in Task 23 is inert forever.
  assert.match(
    workflow,
    /\[ -f "\$HOME\/backups\/CRON_INSTALLED_AT" \] \|\| touch "\$HOME\/backups\/CRON_INSTALLED_AT"/,
  );

  // scp does not reliably carry the executable bit; cron would fail with
  // "Permission denied" and restore-drill.sh would refuse to run by hand.
  assert.match(
    workflow,
    /chmod 700 ~\/restaurant-order-system\/config\/backup-core-db\.sh ~\/restaurant-order-system\/config\/restore-drill\.sh/,
  );

  // Cron is LAST, after the health gate and the probes.
  const gateAt = workflow.indexOf("http://127.0.0.1:3200/health/ready");
  const cronAt = workflow.indexOf("crontab /tmp/ct.$$");
  assert.ok(gateAt > -1 && cronAt > gateAt, "cron must be installed after the health gate");

  // The tarballs are already gone -- they are deleted straight after docker load, so the
  // final cleanup is the two nginx files and nothing else.
  assert.match(workflow, /rm -f \/tmp\/api\.conf \/tmp\/core-api-proxy\.conf/);
  assert.doesNotMatch(workflow, /rm -f \/tmp\/\*-image\*\.tgz/);
});

test("deploy uploads the pre-deploy dump, and never a stale one", () => {
  const workflow = workflowText();

  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4/);
  assert.match(workflow, /if-no-files-found: error/);

  // retention-days must be asserted on the EXECUTING `with:` line. The header comment
  // above the step explains the retention decision in prose and contains the same
  // literal, so a document-wide match is green with the `with:` key deleted -- the
  // artifact would then default to 90 days and hold scrypt hashes three times as long
  // as the file says.
  const retention = workflow
    .split("\n")
    .filter((line) => !line.trim().startsWith("#") && /retention-days:/.test(line));
  assert.equal(retention.length, 1, `expected one retention-days: key, found ${retention.length}`);
  assert.match(retention[0], /^ {10}retention-days: 14$/);

  // if: always() runs after failures too. A run that died before "Install SSH key" has
  // no key, and that is not this step's failure to report.
  assert.match(workflow, /test -f ~\/\.ssh\/lightsail\.pem/);

  // The MARKER is the evidence, not the volume: `docker volume create` runs
  // unconditionally above block 1's gate, so the volume exists after the first ATTEMPT
  // whether or not a dump was ever written.
  assert.match(workflow, /cat ~\/backups\/LAST_PRE_DEPLOY/);
  assert.match(workflow, /no pre-deploy dump recorded - the run failed before block 1/);
  assert.doesNotMatch(workflow, /"\$remote" 'docker volume inspect/);

  // Hard-fail on a stale sha only when the deploy itself succeeded. On a failed run an
  // older sha is the expected reading, and a second red X would bury the real failure.
  assert.match(workflow, /if \[ "\$\{\{ job\.status \}\}" = "success" \]; then/);
  assert.match(workflow, /refusing to upload a stale dump/);
  assert.match(workflow, /the deploy failed before block 1 rewrote the marker - nothing to upload/);

  // The exposure is named in the file, not only in the spec. [\s#]+, not a literal space
  // and not even \s+: this is must-fix 10's shape again, but in a YAML COMMENT block, so
  // the wrap between the two words is "\n      # " -- and `#` is not whitespace. Task 14
  // hit the same shape in hard-wrapped markdown, where \s+ was enough; it is not enough
  // here. Any prose assertion over a commented, wrapped block must tolerate the marker.
  assert.match(workflow, /scrypt[\s#]+hashes/);

  // Registration count, not a pass count. Compose writes the header, the shared helpers
  // and the first six tests; this area appends exactly one top-level test per deploy.yml
  // task. A different number means a test was nested inside another test(), where
  // node --test still runs it but --test-name-pattern cannot select it.
  const suite = fs
    .readFileSync(path.join(__dirname, "deploy-config.test.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const registered = (suite.match(/^test\(/gm) || []).length;
  assert.equal(
    registered,
    15,
    `apps/core-api/test/deploy-config.test.js registers ${registered} top-level tests, expected 15 (compose's six plus nine deploy.yml tasks)`,
  );
});
