"use strict";

// Reads the REAL docker-compose.yml so tests assert on the file the deploy scp's to
// the box rather than on a copy of it. Deliberately a hand-written reader and not a
// YAML dependency: apps/core-api declares exactly express and pg, and
// test/source-structure.test.js pins that list. The only two shapes this file has to
// understand are the ones the compose file uses -- blocks nested by indentation, and
// `KEY: value` scalar mappings.
//
// It lives in testing/, not test/: test/ holds only *.test.js (C13), and the
// source-structure walker excludes testing/.

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const COMPOSE_PATH = path.join(REPO_ROOT, "docker-compose.yml");

// CRLF normalised: the development machine is win32 and CI is ubuntu, so an
// anchored regex against raw bytes passes on one and fails on the other.
function composeText() {
  return fs.readFileSync(COMPOSE_PATH, "utf8").replace(/\r\n/g, "\n");
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// Blank and comment-only lines never open, close, or belong to a block.
function isSkippable(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

// Every line indented deeper than lines[start], stopping at the first line that is not.
function childLines(lines, start) {
  const base = indentOf(lines[start]);
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isSkippable(lines[index])) continue;
    if (indentOf(lines[index]) <= base) break;
    block.push(lines[index]);
  }
  return block;
}

function keyIndex(lines, key, where) {
  const pattern = new RegExp(`^\\s*${key}:(\\s|$)`);
  const index = lines.findIndex((line) => !isSkippable(line) && pattern.test(line));
  if (index === -1) throw new Error(`docker-compose.yml has no "${key}:" key ${where}`);
  return index;
}

// The lines of one service block, e.g. serviceLines("core-api").
function serviceLines(service, text = composeText()) {
  const lines = text.split("\n");
  const services = childLines(lines, keyIndex(lines, "services", "at the top level"));
  // Matched at the services' own indentation only: `core-db:` also appears inside
  // core-api's `depends_on:` block, two levels deeper.
  const top = Math.min(...services.map(indentOf));
  const pattern = new RegExp(`^\\s*${service}:\\s*(#.*)?$`);
  const start = services.findIndex((line) => indentOf(line) === top && pattern.test(line));
  if (start === -1) throw new Error(`docker-compose.yml declares no service "${service}"`);
  return childLines(services, start);
}

// Strips one layer of surrounding quotes and a trailing ` # comment`, and returns the
// RAW STRING -- "3200", never 3200. config.js's DEFAULTS stores raw strings for
// exactly this comparison.
function scalarOf(raw) {
  if (/^["']/.test(raw)) {
    const end = raw.indexOf(raw[0], 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  const comment = raw.indexOf(" #");
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

// The `environment:` mapping of one service, as { NAME: "raw string" }.
function composeEnvironment(service, text = composeText()) {
  const lines = serviceLines(service, text);
  const entries = {};
  for (const line of childLines(lines, keyIndex(lines, "environment", `in service "${service}"`))) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!match) throw new Error(`unparsable environment line in "${service}": ${line}`);
    entries[match[1]] = scalarOf(match[2].trim());
  }
  return entries;
}

module.exports = {
  COMPOSE_PATH,
  composeText,
  composeEnvironment,
  serviceLines,
  childLines,
  scalarOf
};
