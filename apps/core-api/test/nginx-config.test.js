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
