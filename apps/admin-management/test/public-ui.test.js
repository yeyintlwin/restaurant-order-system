"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicRoot = path.join(__dirname, "..", "public");
const read = (name) => fs.readFileSync(path.join(publicRoot, name), "utf8");

test("the document carries the three states and the fields each one needs", () => {
  const html = read("index.html");

  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /id="signedOut"/);
  assert.match(html, /id="signedIn"/);
  assert.match(html, /id="mustChange"/);

  assert.match(html, /id="email"[\s\S]{0,200}type="email"/);
  assert.match(html, /id="password"[\s\S]{0,200}type="password"/);
  assert.match(html, /id="currentPassword"[\s\S]{0,200}type="password"/);
  assert.match(html, /id="newPassword"[\s\S]{0,200}type="password"/);
  assert.match(html, /id="signOut"/);
  assert.match(html, /id="signOutAll"/);
});

test("the password fields are not autofilled into the wrong form", () => {
  const html = read("index.html");
  assert.match(html, /id="password"[\s\S]{0,240}autocomplete="current-password"/);
  assert.match(html, /id="newPassword"[\s\S]{0,240}autocomplete="new-password"/);
});

test("EVERY new password is typed twice, on both screens that set one", () => {
  const html = read("index.html");
  const js = read("app.js");

  // There are two places a password is chosen: the forced screen somebody lands on
  // the first time they sign in, and the dialog in Account settings. The first is
  // the dangerous one -- the password that got them there is spent the moment it
  // succeeds, so a single typo locks them out of an account they have never used,
  // and the only way back is to ring the person above them for another one.
  for (const id of ["forcedConfirm", "confirmPassword"]) {
    assert.match(html, new RegExp('id="' + id + '"[^]{0,200}type="password"'), id + " is missing");
    assert.match(html, new RegExp('id="' + id + '"[^]{0,300}autocomplete="new-password"'));
  }

  // And both are actually compared. The server never sees a confirmation field, so
  // a box nobody reads is worse than no box: it looks like a check and is not one.
  for (const pair of [
    ['$("forcedNew").value !== $("forcedConfirm").value', "the forced screen"],
    ['$("newPassword").value !== $("confirmPassword").value', "the account dialog"]
  ]) {
    const [needle, where] = pair;
    const compared =
      js.includes(needle) ||
      js.includes('$(newId).value !== $(confirmId).value');
    assert.ok(compared, `${where} does not compare its two boxes`);
  }
});

test("the minimum length is stated before the request, not after", () => {
  // 5.1 sets it at 12. A form that only learns this from a 422 makes the user guess.
  assert.match(read("index.html"), /12/);
});

test("app.js wires the DOM and holds no fetch of its own", () => {
  const js = read("app.js");
  assert.match(js, /createApi/);
  // Every call goes through api.js, which is the file with the tests.
  assert.doesNotMatch(js.replace(/createApi\(\s*fetch\s*\)/g, ""), /\bfetch\s*\(/);
});

test("the console holds no fetch either, and no URL of its own", () => {
  const js = read("console.js");
  // It is handed an api object. The moment it can build a request itself, half the
  // request layer stops being the tested one.
  assert.doesNotMatch(js, /\bfetch\s*\(/);
  assert.doesNotMatch(js, /["'`]\/api\//);
  assert.match(js, /export function mountConsole/);
});

test("every element the client reaches for is in the document", () => {
  // A typo in a getElementById is a TypeError on whichever screen nobody happened to
  // open during review. This is the check that opens all of them.
  const html = read("index.html");
  const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const name of ["app.js", "console.js"]) {
    const wanted = [...read(name).matchAll(/\$\("([a-zA-Z0-9_-]+)"\)/g)].map((match) => match[1]);
    const missing = [...new Set(wanted)].filter((id) => !present.has(id));
    assert.deepEqual(missing, [], `${name} reaches for ids the document does not have`);
  }
});

test("the console draws by persona, and the document hides on the same five", () => {
  const css = read("styles.css");
  const html = read("index.html");
  // The mockup had four. A platform admin who has SELECTED a company is the fifth,
  // and if the CSS does not know the name the persona resolves to, every [data-for]
  // element stays visible for them -- including the ones that are not theirs.
  for (const persona of ["platform", "operator", "company", "manager", "staff"]) {
    assert.match(css, new RegExp(`body\\[data-as="${persona}"\\]`), `${persona} has no hiding rule`);
  }
  // The Companies screen belongs to the unscoped platform owner alone. An operator
  // is inside one company and cannot list them all.
  assert.match(html, /id="v-companies" data-for="platform"/);
});

test("NOBODY BELOW THE PLATFORM OWNER IS SHOWN THE WORD \"user\"", () => {
  // Everybody who reads these screens runs a restaurant. "User" is a word about
  // software, and the people it would be describing are a CEO, a branch manager and
  // a waiter. They say "staff", so the console says staff.
  //
  // Comments are exempt -- they are for whoever edits this file next, and one of them
  // is the paragraph explaining this rule.
  const html = read("index.html").replace(/<!--[\s\S]*?-->/g, "");
  const visible = html
    .match(/>([^<]+)</g)
    .map((chunk) => chunk.slice(1, -1).trim())
    .filter(Boolean)
    .concat([...html.matchAll(/data-(?:title|action)="([^"]+)"/g)].map((match) => match[1]));

  for (const text of visible) {
    assert.doesNotMatch(text, /\buser\b/i, `the screen says: ${text}`);
  }

  // The console writes text too, and the same rule applies to every string in it.
  const js = read("console.js").replace(/^\s*\/\/.*$/gm, "");
  for (const [, literal] of js.matchAll(/"([^"\\]*)"/g)) {
    // Property and function names are not read by anybody -- `user.role` names a
    // field of a record, and renaming the API is a different job with no reader.
    if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(literal)) continue;
    assert.doesNotMatch(literal, /\buser\b/i, `the console writes: ${literal}`);
  }
});

test("one Staff link, not one per persona", () => {
  // Two links saying the same thing is a copy waiting to drift from its original.
  const html = read("index.html");
  const links = [...html.matchAll(/<a[^>]*data-go="users"[^>]*>/g)];
  assert.equal(links.length, 1);
  assert.match(links[0][0], /data-for="operator company manager"/);
  assert.match(links[0][0], /data-title="Staff"/);
});

test("nothing that cannot work is left on the screen", () => {
  const html = read("index.html");
  // The mockup's logo upload has no endpoint behind it. A control that shows a
  // preview and loses it on reload is worse than one that is absent, so it is absent
  // -- and the comment in its place says it comes back with the route.
  assert.doesNotMatch(html, /id="logo-file"/);
  assert.doesNotMatch(html, /id="logo-btn"/);
  // The Viewing-as switch was how the mockup faked a persona. Who you are comes from
  // the session now, and a control that could change it would be the whole
  // authorisation model made decorative.
  assert.doesNotMatch(html, /asview/);
});

test("no sample record from the mockup survives into the shipped document", () => {
  const html = read("index.html");
  // Three invented restaurants that look real until somebody clicks one. The tables
  // are empty and fill from the API.
  for (const invented of ["Sakura Kitchen", "Mandalay Grill", "Khin Myat", "Thura Zaw", "09 77 123 4567"]) {
    assert.doesNotMatch(html, new RegExp(invented), `${invented} is still in the document`);
  }
  for (const id of ["co-rows", "shops-rows", "ceo-rows", "staff-rows"]) {
    assert.match(html, new RegExp(`<tbody id="${id}"></tbody>`), `${id} still carries sample rows`);
  }
  // Every select is filled from a list the API answered with. A hard-coded <option>
  // is a name that exists on the screen and nowhere in the database.
  for (const id of ["sh-mgr", "st-shop", "scope-shop", "a5", "sh-tz", "sh-cur", "sh-lang"]) {
    assert.match(html, new RegExp(`<select[^>]*id="${id}"[^>]*></select>`), `${id} carries options`);
  }
});

test("nothing in the client logs a password or puts one in a URL", () => {
  for (const name of ["app.js", "api.js", "console.js", "shape.js"]) {
    const js = read(name);
    assert.doesNotMatch(js, /console\.(log|info|warn|error)[^\n]*(password|Password)/);
    assert.doesNotMatch(js, /[?&](password|currentPassword|newPassword)=/);
  }
});

test("the stylesheet uses the house palette rather than inventing one", () => {
  const css = read("styles.css");
  assert.match(css, /#2e7d5b/i);
  assert.match(css, /#f4f5f7/i);
  assert.match(css, /Inter/);
});

test("a logo is chosen by a real file input, and only the kinds the server keeps", () => {
  const html = read("index.html");

  // Both dialogs, the same control. A company MUST have one; a branch may.
  for (const prefix of ["co", "sh"]) {
    assert.match(html, new RegExp(`id="${prefix}-logo-file"`));
    assert.match(html, new RegExp(`id="${prefix}-logo-preview"`));
    assert.match(html, new RegExp(`id="${prefix}-logo-btn"`));
    assert.match(html, new RegExp(`id="${prefix}-logo-warn"`));
  }

  // The accept list is the storage layer's sniffer, spelled for the file picker.
  // SVG is absent from both on purpose: it is a document that can carry script.
  const accepts = html.match(/accept="[^"]*"/g) || [];
  assert.equal(accepts.length, 2);
  for (const value of accepts) {
    assert.equal(value, 'accept="image/png,image/jpeg,image/webp"');
  }
  assert.doesNotMatch(html, /svg/i);
});

test("only a branch can go back to the company's mark", () => {
  const html = read("index.html");

  // A branch with no logo of its own wears the company's, so taking its own away is
  // a real thing to want. A company has nothing to fall back TO, so the same button
  // must not exist on that dialog -- §4E says a company always has one.
  assert.match(html, /id="sh-logo-clear"/);
  assert.doesNotMatch(html, /id="co-logo-clear"/);
});

test("a picture is never sent to a record that does not exist yet", () => {
  const js = read("console.js");

  // A company is CREATED by the same Save that carries its first logo, so the upload
  // cannot happen when the file is picked -- there is no id to attach it to. The
  // picker holds the File and the save path sends it.
  assert.match(js, /const pendingLogo = \{ co: null, sh: null \}/);
  assert.match(js, /await uploadLogo\("co", created\.data\.id\)/);
  assert.match(js, /await uploadLogo\("sh", result\.data\.id\)/);
});

test("a company cannot be created without a mark", () => {
  const js = read("console.js");

  // It cannot be a NOT NULL column -- the row has to exist before a file can be
  // attached to it -- so this is the only place the rule can live, and it has to
  // refuse BEFORE the company is created rather than complain afterwards.
  const create = js.slice(js.indexOf("if (!pendingLogo.co)"), js.indexOf("api.createCompany({ name, slug })"));
  assert.ok(create.length > 0 && create.length < 700, "the check must sit immediately before the create");
  assert.match(create, /A company needs a logo/);
});

test("a branch row shows the mark it actually wears, not only its own", () => {
  const js = read("console.js");

  // effectiveLogoKey, not logoKey: a branch with none of its own wears the company's,
  // and the list exists so the platform owner can see which ones differ.
  assert.match(js, /logoKey: shop\.effectiveLogoKey/);
  assert.doesNotMatch(js, /logoKey: shop\.logoKey/);
});

test("the repository test script runs this app's suite", () => {
  // Without this line the suite exists and nothing runs it -- not locally, not in
  // the deploy gate. Same reasoning as source-structure.test.js's C11.
  const rootPackage = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
  assert.match(rootPackage.scripts.test, /npm --prefix apps\/admin-management test/);
});

test("this app's README describes what it is, not what it was going to be", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /proxy|proxies/i);
  assert.match(readme, /admin\.yeyintlwin\.com/);
  // The placeholder promised menu editing and sales reports. Those are Plan 2c and
  // later; a README that still promises them sends the next reader looking for code
  // that does not exist.
  assert.doesNotMatch(readme, /daily sales report/i);
});

test("the compose service names this app and points it at core-api", () => {
  const compose = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docker-compose.yml"), "utf8");
  assert.match(compose, /^ {2}admin-management:/m);
  assert.match(compose, /ADMIN_MANAGEMENT_IMAGE/);
  // It reaches core-api by service name over the default bridge, not through nginx.
  assert.match(compose, /CORE_API_URL: http:\/\/core-api:3200/);
});

test("the image carries no secret and publishes only to loopback", () => {
  const compose = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docker-compose.yml"), "utf8");
  const block = compose.slice(compose.indexOf("\n  admin-management:"));
  // Bound at the next line indented ZERO or exactly two spaces -- the next top-level
  // key or the next service. `indexOf("\n  ", 3)` stops at the first NESTED key
  // instead: "\n    image:" is a newline followed by two spaces too. That left a
  // "service block" of nothing but the header line, which no assertion below could
  // ever match and which made the `doesNotMatch` pass without reading anything.
  const next = block.slice(3).search(/\n(?: {2})?\S/);
  const service = next === -1 ? block : block.slice(0, next + 3);
  // This app holds no credential at all -- that is the point of it being a proxy.
  assert.doesNotMatch(service, /env_file|PASSWORD|TOKEN|SECRET|API_KEY/);
  assert.match(service, /127\.0\.0\.1:3400:3400/);
});
