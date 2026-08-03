const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { composeText } = require("../testing/compose");

const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// CRLF normalised: the development machine is win32 and CI is ubuntu, so an
// anchored regex against raw bytes passes on one and fails on the other.
function readText(...segments) {
  return fs.readFileSync(path.join(...segments), "utf8").replace(/\r\n/g, "\n");
}

// The text from one `## ` heading up to the next. infra/README.md is appended to by
// four areas, so an assertion about one section must not be satisfiable by a
// sentence somebody else wrote three sections away.
function sectionSlice(readme, heading) {
  const start = readme.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `infra/README.md has no "${heading}" section`);
  const rest = readme.slice(start + 1);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

test("infra/README.md carries the client-IP chain and links to the secrets file", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const chain = sectionSlice(readme, "## The client-IP chain");

  // Spec 12 greps infra/README.md for this string by name.
  assert.match(chain, /TRUSTED_PROXY_HOPS/);
  assert.match(chain, /\$proxy_add_x_forwarded_for/);
  assert.match(chain, /count one from the right/i);

  // core-db publishes no host port: Docker's published ports install DNAT rules
  // that bypass ufw, so `5432:5432` would put the database on the internet.
  assert.match(chain, /bypass(?:es)? ufw/i);

  // The secrets file is documented ONCE, by the compose area. THIS SECTION must
  // carry the link -- asserting the heading exists somewhere in the README only
  // proves the compose area ran, which was already true before this task, so the
  // test's own "and links to the secrets file" half would be unenforced.
  assert.match(chain, /Core API runtime: two secrets files and core-net/);
  assert.match(chain, /~\/core-api\.env/);
});

test("the client-IP section names the four silent breakers and the probe's real status", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const chain = sectionSlice(readme, "## The client-IP chain");

  assert.match(chain, /set_real_ip_from/);
  assert.match(chain, /real_ip_header/);
  assert.match(chain, /core-api-proxy\.conf/);
  assert.match(chain, /\$remote_addr/);

  // Present tense only. The pipeline checks the four DIRECTIVES at the config
  // layer; the behavioural forged-XFF probe of spec 9.5 step 4 selects an
  // audit_events row written by POST /api/admin/auth/login, and neither the route
  // nor the writer exists before Plan 2. The `Plan 2` match is what keeps this
  // sentence from going stale once Plan 2 ships it.
  assert.match(chain, /sudo nginx -T/);
  assert.match(chain, /Plan 2/);
  assert.doesNotMatch(chain, /runs a forged-XFF probe as a gate/);

  // THE DETAIL LIVES IN EXACTLY ONE PLACE. The nginx area already wrote
  // "### TRUSTED_PROXY_HOPS=1, and the four ways it breaks silently" with all four
  // breakers and a *Checked:* line each. This section summarises and points at it;
  // restating the prose would be the second copy the section itself warns about.
  // Asserted as a cross-reference plus a length ceiling, because "is this a
  // duplicate" is otherwise exactly the question a text assertion cannot ask.
  // \s+ because the cross-reference is prose in a hard-wrapped file and the phrase
  // straddles the wrap. Written with a literal space first, and it went red on the
  // section this very task had just written -- the shape this plan has now hit in
  // four separate files.
  assert.match(chain, /the four ways it breaks\s+silently/);
  assert.ok(
    chain.split("\n").length <= 40,
    `the client-IP section is ${chain.split("\n").length} lines; it is a summary and a pointer, not a second copy of the nginx area's section`
  );
  assert.equal(
    (readme.match(/^### `TRUSTED_PROXY_HOPS=1`, and the four ways it breaks silently$/gm) || []).length,
    1,
    "the detailed breaker list must exist exactly once in infra/README.md"
  );
});

test("every nginx -T recipe in the runbook can actually match on a healthy box", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const snippet = readText(repoRoot, "infra", "nginx", "core-api-proxy.conf");

  // Two ways a copy-pasteable `nginx -T` recipe is wrong on a correct box, and both
  // have already shipped in this repository once:
  //   - a single-space pattern against a COLUMN-ALIGNED conf matches nothing;
  //   - piping the dump into `grep -q` closes the pipe on the first match, so once
  //     the dump exceeds the 64 KB pipe buffer nginx -T takes SIGPIPE.
  for (const line of readme.split("\n")) {
    if (!/nginx -T/.test(line)) continue;
    assert.doesNotMatch(
      line,
      /\| *grep -q/,
      `nginx -T piped into grep -q takes SIGPIPE on a large dump: ${line.trim()}`
    );
    // The broken form specifically: the header name, ONE literal space, then the
    // variable. `X-Forwarded-For +\$proxy…` (a regex quantifier) is correct, and so
    // is an awk recipe that matches the two as separate patterns -- neither of those
    // puts a single literal space between them.
    assert.doesNotMatch(
      line,
      /X-Forwarded-For \\?\$proxy_add/,
      `a literal single space against a column-aligned conf matches nothing: ${line.trim()}`
    );
  }

  // And the shipped snippet really is column-aligned, so the rule above is not
  // theoretical.
  assert.match(snippet, /proxy_set_header X-Forwarded-For {2,}\$proxy_add_x_forwarded_for/);
});

test("the three secrets live only in ~/core-api.env, never in a file the repository ships", () => {
  const compose = composeText();
  const workflow = readText(repoRoot, ".github", "workflows", "deploy.yml");

  // A value in compose or in the workflow is a value in git history for ever.
  // `(^|[^A-Z_])` so CORE_API_TEST_DATABASE_URL -- a legitimate CI value pointing at
  // a throwaway localhost cluster -- does not match DATABASE_URL.
  for (const secret of ["POSTGRES_PASSWORD", "DATABASE_MIGRATION_URL", "DATABASE_URL"]) {
    assert.doesNotMatch(
      compose,
      new RegExp(`(^|[^A-Z_])${secret}\\s*:`, "m"),
      `docker-compose.yml must not set ${secret}; it comes from env_file`
    );
  }

  // BAN THE WRITE, NOT THE WORD. deploy.yml names ~/core-api.env legitimately three
  // times -- the `test -f` precondition, `export CORE_ENV_FILE=`, and the crontab
  // printf that installs the sweep line -- and none of those writes a secret. What
  // must never appear is a REDIRECTION INTO the file: it is created once, by hand,
  // at mode 600.
  const WRITES_THE_SECRETS_FILE = /(?:>|>>|tee)\s*["']?(?:~|\$HOME)\/core-api\.env/;
  // Positive control, written as a concatenation so a repo-wide grep for the banned
  // string does not hit the test that enforces the ban. Without this the rule could
  // pass because the regex is wrong rather than because the workflow is clean.
  assert.match("cat > " + "~/core-api.env", WRITES_THE_SECRETS_FILE);
  assert.doesNotMatch(workflow, WRITES_THE_SECRETS_FILE);

  // And no owner or app DSN anywhere in the workflow. `-U core_api_owner` in the
  // dump and psql calls is fine; `core_api_owner:<password>@` is not.
  assert.doesNotMatch(workflow, /core_api_(?:owner|app):[^@\s]+@/);

  // ...but both must reference the file that does carry them.
  assert.match(compose, /\$\{CORE_ENV_FILE:-\.env\}/);
  assert.match(workflow, /CORE_ENV_FILE=\.\.\/core-api\.env/);
});

test("infra/README.md warns that every push resets the dining room", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const window = sectionSlice(readme, "## Deploy window");

  // Spec 9.5. Phase 1 does not introduce this; it lengthens the window by putting a
  // migration in front of it, which is the whole reason the sentence has to be here.
  // \s+ throughout: this file is hard-wrapped prose and both phrases straddle a wrap.
  assert.match(window, /resets all twelve e-paper\s+displays to `Welcome`/);
  assert.match(window, /in-memory order session/i);
  assert.match(window, /lengthens the window/);

  // Spec 12 greps infra/README.md for both of these strings by name.
  assert.match(window, /outside service\s+hours/);
  assert.match(window, /business_date/);

  // deploy.yml preserves docker-compose.yml AND config/. Stating it as "empties the
  // folder" is how the two infra scripts end up installed somewhere the find deletes,
  // with the workflow-text assertion still green.
  assert.match(window, /! -name docker-compose\.yml ! -name config/);
  assert.match(window, /config\/backup-core-db\.sh/);
  assert.doesNotMatch(readme, /empties that (?:directory|folder) on every push/);

  // PINNED TO THE REAL COMMAND. infra/README.md quotes this `find` twice -- once in
  // the nginx section to explain why the confs go to /tmp, once here -- and a quoted
  // command is a copy that goes stale the day deploy.yml's changes. Every copy must be
  // byte-identical to the line the deploy actually runs.
  const workflow = readText(repoRoot, ".github", "workflows", "deploy.yml");
  const live = workflow
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("find ~/restaurant-order-system -mindepth 1"));
  assert.equal(live.length, 1, `deploy.yml runs ${live.length} such find commands, expected 1`);
  const quoted = readme
    .split("\n")
    .map((line) => line.replace(/^`|`$/g, "").trim())
    .filter((line) => line.startsWith("find ~/restaurant-order-system -mindepth 1"));
  assert.ok(quoted.length >= 1, "infra/README.md quotes the deploy's find nowhere");
  for (const copy of quoted) {
    assert.equal(copy, live[0], "infra/README.md quotes a find that deploy.yml no longer runs");
  }
});

test("infra/README.md carries the cutover order, certbot before the first push", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const cutover = sectionSlice(readme, "## Cutover checklist");

  // A needle that is absent returns -1, which compares "less than" everything and
  // would make every ordering assertion below pass vacuously.
  const step = (needle) => {
    const index = cutover.indexOf(needle);
    assert.notEqual(index, -1, `the cutover list never mentions "${needle}"`);
    return index;
  };

  assert.ok(step("DNS") < step("certbot"), "DNS must come before certbot");
  assert.ok(step("certbot") < step("core-api.env"), "certbot must come before the secrets file");
  assert.ok(step("core-api.env") < step("Push"), "the secrets file must exist before the first push");
  assert.ok(step("Push") < step("restore drill"), "the restore drill runs after the first deploy");

  assert.match(cutover, /vm\.swappiness=10/);
  assert.match(cutover, /systemctl reload nginx/);

  // PATH PINNED. The drill is a HOST script driving `docker compose`, so it cannot
  // live inside the image; the deploy scp's it into config/, which the find spares.
  assert.match(cutover, /~\/restaurant-order-system\/config\/restore-drill\.sh/);

  // create-platform-admin.js needs the users table, lib/password.js and the audit
  // writer. None exist yet, so the bootstrap step must say which plan brings them
  // rather than sending an operator to a script that is not there.
  assert.match(cutover, /Plan 2/);
});
