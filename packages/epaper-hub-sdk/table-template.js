const qrcode = require("qrcode-generator");
const { DISPLAY_HEIGHT, DISPLAY_WIDTH, encodeBitmapRows } = require("./codec");

const FONT = {
  " ": ["000", "000", "000", "000", "000"],
  "-": ["000", "000", "111", "000", "000"],
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "010", "010", "010"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  A: ["010", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  C: ["111", "100", "100", "100", "111"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  F: ["111", "100", "110", "100", "100"],
  G: ["111", "100", "101", "101", "111"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  J: ["001", "001", "001", "101", "111"],
  K: ["101", "101", "110", "101", "101"],
  L: ["100", "100", "100", "100", "111"],
  M: ["101", "111", "111", "101", "101"],
  N: ["101", "111", "111", "111", "101"],
  O: ["111", "101", "101", "101", "111"],
  P: ["111", "101", "111", "100", "100"],
  Q: ["111", "101", "101", "111", "001"],
  R: ["110", "101", "110", "101", "101"],
  S: ["111", "100", "111", "001", "111"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"],
  V: ["101", "101", "101", "101", "010"],
  W: ["101", "101", "111", "111", "101"],
  X: ["101", "101", "010", "101", "101"],
  Y: ["101", "101", "010", "010", "010"],
  Z: ["111", "001", "010", "100", "111"]
};

function rectangle(canvas, x, y, width, height, color, fill = false) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      if (fill || row === y || row === y + height - 1 || column === x || column === x + width - 1) {
        if (canvas[row]?.[column]) canvas[row][column] = color;
      }
    }
  }
}

function drawText(canvas, value, x, y, color, scale) {
  let cursor = x;
  for (const character of String(value).toUpperCase()) {
    const glyph = FONT[character] || FONT[" "];
    glyph.forEach((row, glyphY) => {
      [...row].forEach((pixel, glyphX) => {
        if (pixel === "1") rectangle(canvas, cursor + glyphX * scale, y + glyphY * scale, scale, scale, color, true);
      });
    });
    cursor += 4 * scale;
  }
}

function wrapStatus(value) {
  const words = String(value).trim().toUpperCase().split(/\s+/);
  const lines = [];
  for (const word of words) {
    if (!lines.length) lines.push(word.slice(0, 15));
    else if (`${lines.at(-1)} ${word}`.length <= 15) lines[lines.length - 1] += ` ${word}`;
    else if (lines.length < 2) lines.push(word.slice(0, 15));
  }
  return lines.slice(0, 2);
}

function drawQr(canvas, url) {
  const qr = qrcode(0, "M");
  qr.addData(url, "Byte");
  qr.make();

  const modules = qr.getModuleCount();
  if (modules + 8 > 96) throw new Error("url is too long for the e-paper QR area");
  const scale = Math.floor(96 / (modules + 8));
  const size = (modules + 8) * scale;
  const startX = 196 + Math.floor((96 - size) / 2);
  const startY = 16 + Math.floor((96 - size) / 2);

  rectangle(canvas, 194, 14, 100, 100, "B");
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (qr.isDark(row, column)) {
        rectangle(canvas, startX + (column + 4) * scale, startY + (row + 4) * scale, scale, scale, "B", true);
      }
    }
  }
}

// Mirrors apps/core-api/migrations/0001_init.sql:196 --
//   label text NOT NULL CHECK (label ~ '^[A-Z0-9][A-Z0-9 -]{0,7}$')
// -- character for character. That column is the dining table's identity and this
// renderer is what draws it, so the two must not drift again: the FONT map above was
// itself derived from this charset (see the comment at 0001_init.sql:186). Note the
// quantifier caps the whole label at 8 characters, not 8 after the first.
//
// Verified equivalent to the Postgres POSIX operator on this database, including the
// trailing-newline case: JS `$` without /m anchors to end-of-input, so unlike Python
// it does not admit "A1\n" where `~` would reject it.
const TABLE_LABEL_PATTERN = /^[A-Z0-9][A-Z0-9 -]{0,7}$/;

function validateInput({ tableLabel, status, url }) {
  // Checked on the raw string. drawText() uppercases, but leaning on that would let a
  // lowercase label through here and silently disagree with the CHECK constraint.
  if (typeof tableLabel !== "string" || !TABLE_LABEL_PATTERN.test(tableLabel)) {
    throw new Error("tableLabel must match ^[A-Z0-9][A-Z0-9 -]{0,7}$");
  }
  if (!String(status || "").trim()) throw new Error("status is required");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    throw new Error("url must be an http or https URL");
  }
}

// The label is drawn verbatim -- no "TABLE " prefix. Measured, not assumed: at scale 5
// drawText advances 4*5=20px per character over 3*5=15px of ink, so an n-character label
// from x=12 ends at 12 + 20*(n-1) + 14. The binding limit is not the 296px right edge
// (14 characters) but drawQr's frame at x=194, which shares this y band (14..38) and is
// drawn unfilled -- ink past x=193 lands in the QR quiet zone instead of being covered.
// That caps the label at 9 characters. The schema caps it at 8, ending at x=166, so every
// legal label clears the QR with a character to spare.
//
// A "TABLE " prefix cost 6 of those 9: the worst legal case "TABLE " + 8 characters ran to
// x=286, clear of the right edge but 93px into the QR. Shrinking to fit needed scale 3,
// which is the status line's size -- the table's identity would have stopped outranking its
// status, and this is read at a glance across a table, not up close. So the prefix went.
function renderTableDisplay(input) {
  validateInput(input);
  const canvas = Array.from({ length: DISPLAY_HEIGHT }, () => Array(DISPLAY_WIDTH).fill("W"));

  rectangle(canvas, 0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, "B");
  drawText(canvas, input.tableLabel, 12, 14, "R", 5);
  wrapStatus(input.status).forEach((line, index) => drawText(canvas, line, 12, 62 + index * 22, "B", 3));
  drawText(canvas, "SCAN TO ORDER", 12, 109, "R", 2);
  drawQr(canvas, input.url);

  return encodeBitmapRows(canvas.map((row) => row.join("")));
}

module.exports = { renderTableDisplay };
