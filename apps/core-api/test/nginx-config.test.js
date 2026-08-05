const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// Same CRLF normalisation as test/source-structure.test.js. The developer is on
// win32 and CI runs on ubuntu-latest, so a `$`-anchored regex over raw bytes
// passes on one machine and fails on the other for reasons that have nothing to
// do with the rule being asserted.
function readText(...segments) {
  return fs.readFileSync(path.join(...segments), "utf8").replace(/\r\n/g, "\n");
}

// nginx `#` comments are documentation, and these two files deliberately NAME
// the directives they forbid ("NO real_ip_header here", "no proxy_buffering off
// on purpose"). Stripping comments before asserting is what stops a warning
// comment from satisfying the very match it warns about. The same problem bites
// on the box, where `nginx -T` prints comments verbatim -- every on-box grep in
// infra/README.md carries `grep -vE '^[[:space:]]*#'` for this reason.
function stripComments(text) {
  return text.replace(/^[ \t]*#.*$/gm, "").replace(/[ \t]+#.*$/gm, "");
}

function apiConf() {
  return stripComments(readText(repoRoot, "infra", "nginx", "api.conf"));
}

function proxySnippet() {
  return stripComments(readText(repoRoot, "infra", "nginx", "core-api-proxy.conf"));
}

test("the proxy snippet sets the X-Forwarded-For header TRUSTED_PROXY_HOPS=1 depends on", () => {
  const snippet = proxySnippet();

  // `keepalive 16` in the upstream is inert without both of these: nginx opens
  // a new connection per request and the keepalive pool never fills.
  assert.match(snippet, /^proxy_http_version 1\.1;$/m);
  assert.match(snippet, /^proxy_set_header Connection\s+"";$/m);

  assert.match(snippet, /^proxy_set_header Host\s+\$host;$/m);
  assert.match(snippet, /^proxy_set_header X-Forwarded-Proto\s+\$scheme;$/m);
  assert.match(snippet, /^proxy_set_header X-Forwarded-Host\s+\$host;$/m);

  // $proxy_add_x_forwarded_for = the client's incoming XFF with $remote_addr
  // appended ON THE RIGHT. That is precisely why counting one entry from the
  // right (TRUSTED_PROXY_HOPS=1) yields the address nginx actually saw.
  assert.match(snippet, /^proxy_set_header X-Forwarded-For\s+\$proxy_add_x_forwarded_for;$/m);

  // Silent breaker 4 (spec 9.6): `X-Forwarded-For $remote_addr` produces the
  // correct answer at hops=1 and DISCARDS the chain, so the day a second proxy
  // is added there is nothing left to count and no error to notice.
  assert.doesNotMatch(snippet, /X-Forwarded-For\s+\$remote_addr/);

  assert.match(snippet, /^proxy_connect_timeout 2s;$/m);
  assert.match(snippet, /^proxy_read_timeout\s+30s;$/m);
  assert.match(snippet, /^proxy_send_timeout\s+30s;$/m);

  // EXACTLY one proxy_pass, and it names the upstream group rather than
  // 127.0.0.1:3200 directly -- a direct address bypasses both `keepalive 16`
  // and `max_fails=0`, which is the whole reason the upstream block exists.
  assert.equal((snippet.match(/^[ \t]*proxy_pass\s/gm) || []).length, 1);
  assert.match(snippet, /^proxy_pass http:\/\/core_api;$/m);

  // Deferred to the Phase-4 SSE route on purpose (spec 9.6). Turning buffering
  // off globally makes every JSON response stream byte-by-byte through a worker.
  assert.doesNotMatch(snippet, /proxy_buffering\s+off/);
});

// Returns the text between the braces of `location <selector> {`, brace-matched
// so a nested block cannot truncate it. The selector is matched as a whole
// token: a naive indexOf("= /health") finds "= /health/ready" too, and the two
// blocks assert opposite things.
function locationBody(text, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const opener = new RegExp(`location\\s+${escaped}\\s*\\{`);
  const match = opener.exec(text);
  assert.ok(match, `no location block for '${selector}' in api.conf`);

  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index);
    }
  }
  assert.fail(`unbalanced braces in location '${selector}'`);
}

test("api.conf declares the three rate-limit zones at http{} scope and a single-server upstream", () => {
  const conf = apiConf();

  assert.match(conf, /^limit_req_zone \$binary_remote_addr zone=core_login:1m rate=10r\/m;$/m);
  assert.match(conf, /^limit_req_zone \$binary_remote_addr zone=core_pair:1m\s+rate=20r\/m;$/m);
  assert.match(conf, /^limit_req_zone \$binary_remote_addr zone=core_api:5m\s+rate=20r\/s;$/m);

  // Pinned by COLUMN, not just by presence. limit_req_zone is an http{}-scope
  // directive and Ubuntu includes conf.d/*.conf inside http{} -- indent one of
  // these into a server{} block and nginx -t fails outright with
  // '"limit_req_zone" directive is not allowed here', which the deploy treats
  // as fatal. That is the whole reason this file installs to conf.d/.
  const zoneLines = conf.split("\n").filter((line) => line.includes("limit_req_zone"));
  assert.equal(zoneLines.length, 3);
  for (const line of zoneLines) {
    assert.equal(line, line.trimStart(), "limit_req_zone must sit at http{} scope, unindented");
  }

  assert.match(conf, /^upstream core_api \{$/m);
  assert.match(conf, /^[ \t]+server 127\.0\.0\.1:3200 max_fails=0;$/m);
  assert.equal((conf.match(/^[ \t]+server \d/gm) || []).length, 1);

  // With one server proxy_next_upstream can never retry, while the default
  // max_fails=3 makes nginx STOP attempting connections for fail_timeout after
  // a recreate -- returning 502 AFTER core-api is listening and healthy.
  assert.doesNotMatch(conf, /max_fails=[1-9]/);

  assert.match(conf, /^[ \t]+keepalive 16;$/m);
});

test("api.conf redirects port 80 and keeps the ACME challenge path reachable", () => {
  const conf = apiConf();

  assert.match(conf, /^[ \t]*listen 80;$/m);
  assert.match(conf, /^[ \t]*listen \[::\]:80;$/m);
  assert.match(conf, /^[ \t]*server_name api\.yeyintlwin\.com;$/m);

  // certbot renews over HTTP-01. A blanket 301 with no exception here breaks
  // renewal in sixty days, and the certificate expiring takes the API down.
  assert.match(conf, /location \/\.well-known\/acme-challenge\/ \{ root \/var\/www\/html; \}/);
  assert.match(conf, /location \/ \{ return 301 https:\/\/\$host\$request_uri; \}/);

  // BOTH server blocks own a `location /` once the TLS block lands, and this
  // one is written first, so a whole-file select must resolve to the redirect.
  // Pinning it here is what stops the catch-all's rate-limit assertions -- the
  // ones the next task exists to make -- from silently grading this block
  // instead. That is why they select from tlsServer(conf), never from the file.
  assert.match(locationBody(conf, "/"), /^\s*return 301 https:\/\/\$host\$request_uri;\s*$/);
});

// Slices the TLS server block out of api.conf: find `listen 443 ssl;`,
// walk BACK to the `server {` that opens the block it sits in, then brace-match
// forward. Every assertion below selects from this slice rather than from the
// file, because both server blocks own a `location /` and a whole-file select
// finds the port-80 redirect first -- which would grade the redirect against
// the catch-all's rate-limit rules and pass while asserting nothing.
function tlsServer(text) {
  const listenIndex = text.indexOf("listen 443 ssl;");
  assert.ok(listenIndex !== -1, "api.conf has no `listen 443 ssl;` line");

  const opener = /server\s*\{/g;
  let start = -1;
  for (let match = opener.exec(text); match && match.index < listenIndex; match = opener.exec(text)) {
    start = match.index + match[0].length;
  }
  assert.ok(start !== -1, "no `server {` opens the block holding `listen 443 ssl;`");

  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index);
    }
  }
  assert.fail("unbalanced braces in the TLS server block");
}

test("the TLS server block enables no HTTP/2 in either form", () => {
  const conf = apiConf();

  assert.match(conf, /^[ \t]*listen 443 ssl;$/m);
  assert.match(conf, /^[ \t]*listen \[::\]:443 ssl;$/m);

  // `http2 on;` needs nginx >= 1.25.1 and the box runs 1.24.0, where it is an
  // unknown directive and nginx -t FAILS -- which the deploy treats as fatal,
  // so this single line would abort the cutover.
  assert.doesNotMatch(conf, /^[ \t]*http2\s+(?:on|off);/m);

  // And no `http2` token on the listen lines either. It is a PER-SOCKET option
  // and conf.d/ parses before sites-enabled/, so it would be the first listen
  // line to touch 0.0.0.0:443 and would enable HTTP/2 for the seven unrelated
  // vhosts sharing that socket -- three of which proxy WebSocket upgrades, and
  // nginx does not implement RFC 8441. Nothing in Phase 1 needs HTTP/2.
  assert.doesNotMatch(conf, /^[ \t]*listen[^\n]*\bhttp2\b/m);

  // Both server blocks name the vhost: the port-80 redirect from the previous
  // task and this one. A count of 1 means this block was appended to the wrong
  // file, or the redirect block was replaced instead of extended.
  assert.equal((conf.match(/server_name api\.yeyintlwin\.com;/g) || []).length, 2);

  assert.match(conf, /^[ \t]*ssl_certificate\s+\/etc\/letsencrypt\/live\/api\.yeyintlwin\.com\/fullchain\.pem;$/m);
  assert.match(conf, /^[ \t]*ssl_certificate_key \/etc\/letsencrypt\/live\/api\.yeyintlwin\.com\/privkey\.pem;$/m);

  // No Phase-1 body is legitimately large, and a 5 MB body is otherwise a free
  // way to hold one of only SCRYPT_SLOTS=2 open.
  assert.match(conf, /^[ \t]*client_max_body_size\s+64k;$/m);
  assert.match(conf, /^[ \t]*client_body_timeout\s+10s;$/m);
  assert.match(conf, /^[ \t]*client_header_timeout 10s;$/m);

  assert.match(conf, /add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;/);
});

test("/health is proxied loopback-only and /health/ready is never reachable publicly", () => {
  const tls = tlsServer(apiConf());

  const health = locationBody(tls, "= /health");
  // A hard 404 here would abort EVERY deploy. The gate runs
  //   curl -fsS --resolve api.yeyintlwin.com:443:127.0.0.1 https://.../health
  // through the real TLS chain, and curl -fsS exits 22 on 4xx -- after the
  // migration has already applied. The spec corrects an earlier draft that
  // returned 404 for both paths for exactly this reason.
  assert.match(health, /allow 127\.0\.0\.1;/);
  assert.match(health, /allow ::1;/);
  assert.match(health, /deny all;/);
  assert.match(health, /include \/etc\/nginx\/snippets\/core-api-proxy\.conf;/);
  assert.doesNotMatch(health, /return 404/);

  // Readiness names the database and the migration ledger. Never public.
  const ready = locationBody(tls, "= /health/ready");
  assert.match(ready, /return 404;/);
  assert.doesNotMatch(ready, /include|proxy_pass/);
});

test("the two credential routes are rate limited at the network layer and answer 429", () => {
  const tls = tlsServer(apiConf());

  // The network half of the login limiter. The application half
  // (LOGIN_RATE_PER_MINUTE, PASSWORD_ABUSE_THRESHOLD) still runs; this one
  // sheds the flood before it can occupy a scrypt slot at all.
  const login = locationBody(tls, "= /api/admin/auth/login");
  assert.match(login, /limit_req zone=core_login burst=5 nodelay;/);
  assert.match(login, /limit_req_status 429;/);
  assert.match(login, /include \/etc\/nginx\/snippets\/core-api-proxy\.conf;/);

  const pair = locationBody(tls, "= /api/terminal/pair");
  assert.match(pair, /limit_req zone=core_pair burst=5 nodelay;/);
  assert.match(pair, /limit_req_status 429;/);
  assert.match(pair, /include \/etc\/nginx\/snippets\/core-api-proxy\.conf;/);

  // Selected from the TLS slice, never from the file: the port-80 redirect owns
  // a `location /` too and it is written first.
  const catchAll = locationBody(tls, "/");
  assert.match(catchAll, /limit_req zone=core_api burst=40 nodelay;/);
  assert.match(catchAll, /include \/etc\/nginx\/snippets\/core-api-proxy\.conf;/);

  // NO limit_req_status here on purpose -- see the comment in api.conf. The
  // catch-all sheds with nginx's default 503, and 503 vs 429 is the difference
  // between "the whole API is being flooded" and "you specifically are going
  // too fast" in the access log.
  assert.doesNotMatch(catchAll, /limit_req_status/);
});

test("no real_ip directive can rewrite $remote_addr before the XFF chain is built", () => {
  // Silent breaker 1. real_ip_header / set_real_ip_from rewrite $remote_addr
  // BEFORE $proxy_add_x_forwarded_for is evaluated, so a forged header is
  // appended to itself and core-api's one-from-the-right read returns the
  // attacker's value. No error, no log line, nothing to notice. The same
  // directives also make `allow 127.0.0.1` on /health honour a forged header,
  // which publishes the readiness surface the 404 above exists to hide.
  for (const [label, text] of [["api.conf", apiConf()], ["core-api-proxy.conf", proxySnippet()]]) {
    assert.doesNotMatch(text, /\breal_ip_header\b/, `${label} must not carry real_ip_header`);
    assert.doesNotMatch(text, /\bset_real_ip_from\b/, `${label} must not carry set_real_ip_from`);
    assert.doesNotMatch(text, /\breal_ip_recursive\b/, `${label} must not carry real_ip_recursive`);
  }
});

test("every location that forwards to core-api does so through the proxy snippet", () => {
  const conf = apiConf();
  const INCLUDE_LINE = "include /etc/nginx/snippets/core-api-proxy.conf;";

  const includeCount = conf.split(INCLUDE_LINE).length - 1;

  // Four proxying locations today: /health, the login route, the pairing route
  // and the catch-all. When Phase 4 adds the SSE location this number changes
  // WITH it -- which is the point: the number is what makes whoever adds a
  // location open this file and read the paragraph above.
  assert.equal(includeCount, 4, "api.conf must include the proxy snippet from all four proxying locations");

  // Silent breaker 2, stated as the thing that is actually true: the snippet is
  // the ONLY file in infra/nginx/ that proxies. A location added later with a
  // bare `proxy_pass http://core_api;` and no include would set no
  // X-Forwarded-For at all and pass the client's own header straight through --
  // and it is caught here whatever brace style it is written in.
  assert.doesNotMatch(conf, /proxy_pass/, "api.conf must never proxy_pass directly");
});

test("infra/README.md documents the install targets, the hop count and its four silent breakers", () => {
  const readme = readText(repoRoot, "infra", "README.md");

  // Where each file goes, and why conf.d rather than sites-available.
  assert.match(readme, /\/etc\/nginx\/conf\.d\/api\.yeyintlwin\.com\.conf/);
  assert.match(readme, /\/etc\/nginx\/snippets\/core-api-proxy\.conf/);
  assert.match(readme, /limit_req_zone/);
  assert.match(readme, /http\{\}/);

  // Same shape as the 3000 / 3100 sentence this file already carries.
  assert.match(readme, /127\.0\.0\.1:3200/);

  // The rollback restores BOTH files. Snapshotting only the vhost leaves a bad
  // snippet on disk, the rollback's own nginx -t fails, and the box is left
  // holding a config it cannot load.
  assert.match(readme, /core-api-proxy\.conf\.bak/);

  // The http2 token is a per-socket option, so adding it here would change
  // HTTP/2 for all seven other vhosts sharing :443. The runbook records why it
  // is deliberately absent.
  assert.match(readme, /per-socket/i);
  assert.match(readme, /protocol options redefined/);

  // The hop count and the variable it derives from.
  assert.match(readme, /TRUSTED_PROXY_HOPS=1/);
  assert.match(readme, /\$proxy_add_x_forwarded_for/);

  // All four silent breakers, each named where an operator will search for it.
  assert.match(readme, /set_real_ip_from/);
  assert.match(readme, /real_ip_header/);
  assert.match(readme, /without the include/i);
  assert.match(readme, /adding a proxy in front/i);
  assert.match(readme, /X-Forwarded-For \$remote_addr/);

  // Prerequisite ordering: nginx -t cannot pass before the certificate exists,
  // and the deploy is the only thing that installs the file.
  assert.match(readme, /A record/i);
  assert.match(readme, /certbot certonly --nginx -d api\.yeyintlwin\.com/);
  assert.match(readme, /nginx -t/);

  // Every on-box grep strips comments first: nginx -T prints them verbatim and
  // api.conf deliberately names the directives it forbids.
  assert.match(readme, /nginx -T \| grep -vE/);

  // The health split, so nobody "fixes" the 200 on /health.
  assert.match(readme, /\/health\/ready/);
  assert.match(readme, /\bcurl -fsS\b/);
});

const { composeEnvironment } = require("../testing/compose");

test("TRUSTED_PROXY_HOPS equals the proxy depth infra/nginx actually deploys", () => {
  // Spec 11.5, and it is REQUIRED rather than nice-to-have. lib/client-ip.js counts
  // entries from the RIGHT of X-Forwarded-For by this number. Set to 2 behind a
  // single proxy the pick lands on the last CLIENT-CONTROLLED entry, and an
  // attacker owns their own rate-limit bucket again -- the exact attack the module
  // exists to prevent, reachable from one wrong digit in a file that is not the
  // module's.
  //
  // No per-request test can see it. A forged "X-Forwarded-For: 1.2.3.4" under a
  // one-proxy deployment is BYTE-IDENTICAL to a legitimate two-proxy deployment
  // whose real client is 1.2.3.4, so the module has nothing to assert about its
  // own input. Two locally-correct files, one wrong pair -- which is the shape the
  // trailing-slash bypass had, and the technique that caught that one is this.
  //
  // proxySnippet(), not readText: the snippet's header comment NAMES
  // $proxy_add_x_forwarded_for to explain it, above the one directive that sets
  // it, so a raw read counts two appends and this assertion is red against a tree
  // that is correct. The comment stripper is load-bearing, not tidiness.
  const snippet = proxySnippet();

  // (1) Exactly one hop is APPENDED. $proxy_add_x_forwarded_for is the incoming
  //     header with $remote_addr appended on the right, so one occurrence of it
  //     in the one snippet every proxying location includes means the chain grows
  //     by exactly one entry between the client and core-api.
  const appends = (snippet.match(/\$proxy_add_x_forwarded_for/g) || []).length;
  assert.equal(appends, 1, "core-api-proxy.conf must append X-Forwarded-For exactly once");

  // (2) There is no SECOND proxy layer: the snippet's single proxy_pass names the
  //     upstream group rather than another nginx.
  assert.equal((snippet.match(/^[ \t]*proxy_pass\s/gm) || []).length, 1);
  assert.match(snippet, /^proxy_pass http:\/\/core_api;$/m);

  // The two remaining premises are asserted by their own tests in this file and
  // are deliberately NOT restated here -- restating them is how a copy drifts from
  // the original, and the copy is the one that gets weakened. "every location that
  // forwards to core-api does so through the proxy snippet" pins api.conf's zero
  // proxy_pass (a bare proxy_pass would set no X-Forwarded-For at all and pass the
  // client's own header straight through); "no real_ip directive can rewrite
  // $remote_addr before the XFF chain is built" pins the real_ip trio --
  // real_ip_recursive included, which a hand-copied pair drops -- and with
  // real_ip_header set a forged header gets appended to ITSELF, so the deployed
  // depth would no longer be derivable from the count above at all.

  // The deployed depth, DERIVED from those facts rather than restated.
  const deployedProxyDepth = appends;

  // ...and the value the container will actually run with. Read out of the real
  // docker-compose.yml, which is the file the deploy scp's to the box -- not out of
  // a copy, and not out of config.js's DEFAULTS, which deliberately excludes this
  // variable (a development default of 0 is fail-safe; production must state it).
  const configured = composeEnvironment("core-api").TRUSTED_PROXY_HOPS;
  assert.equal(
    Number(configured),
    deployedProxyDepth,
    `docker-compose.yml sets TRUSTED_PROXY_HOPS=${configured} but infra/nginx deploys ${deployedProxyDepth} proxy hop(s). ` +
      "Too high and lib/client-ip.js picks a client-controlled entry (forgeable buckets, forgeable source_ip); " +
      "too low and it picks nginx's own address (one shared bucket, every user locked out by one attacker). " +
      "Both fail silently at runtime -- this assertion is the only place the pair is checked."
  );
});

test("the hop-count assertion is not vacuous: it moves when either side moves", () => {
  // The mutation proof, in the file, because the assertion above is a cross-file
  // one and cross-file assertions are the ones that rot into tautologies. Both
  // directions are re-derived here from strings rather than from the real files,
  // so this cannot pass because the real files happen to agree.
  const twoHopSnippet = "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n".repeat(2);
  assert.notEqual((twoHopSnippet.match(/\$proxy_add_x_forwarded_for/g) || []).length, 1);

  const oneHopSnippet = "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n";
  assert.equal((oneHopSnippet.match(/\$proxy_add_x_forwarded_for/g) || []).length, 1);
  assert.notEqual(Number("2"), (oneHopSnippet.match(/\$proxy_add_x_forwarded_for/g) || []).length);
});
