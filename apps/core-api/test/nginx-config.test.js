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
