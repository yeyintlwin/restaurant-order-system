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

test("nothing in the client logs a password or puts one in a URL", () => {
  for (const name of ["app.js", "api.js"]) {
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
