"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * A copy of loadDotEnv() from apps/customer-order/server.js:28-35, duplicated
 * rather than shared: packages/shared is not in the root "workspaces" array, so
 * consuming it would mean changing the workspace layout for eight lines.
 *
 * A name already present in `environment` is never overwritten, so a real
 * environment variable always beats the file.
 *
 * The `environment` parameter is the one change from the original: it exists so the
 * test can assert against a plain object instead of mutating process.env for the
 * whole test worker. server.js calls loadDotEnv() with no arguments at all.
 */
function loadDotEnv(file = path.join(__dirname, ".env"), environment = process.env) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || environment[match[1]] !== undefined) continue;
    environment[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

module.exports = { loadDotEnv };
