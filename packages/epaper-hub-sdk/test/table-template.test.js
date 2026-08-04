const assert = require("node:assert/strict");
const test = require("node:test");
const { decodePackedBase64, PACKED_BYTE_LENGTH } = require("../codec");
const { renderTableDisplay } = require("../table-template");

test("renders a compact 296x128 three-color table display", () => {
  const payload = renderTableDisplay({
    tableLabel: "A1",
    status: "Table is in use",
    url: "https://order.example.test/t/EXAMPLEtokenEXAMPLEtok"
  });

  assert.equal(payload.format, "epd-2bit-v1");
  assert.equal(payload.width, 296);
  assert.equal(payload.height, 128);
  assert.equal(Buffer.from(payload.data, "base64").length, PACKED_BYTE_LENGTH);

  const rows = decodePackedBase64(payload);
  assert.equal(rows.length, 128);
  assert.ok(rows.some((row) => row.includes("B")));
  assert.ok(rows.some((row) => row.includes("R")));
});

test("embeds the exact ordering URL into different QR pixels", () => {
  const common = { tableLabel: "A1", status: "Welcome" };
  const first = renderTableDisplay({ ...common, url: "https://order.example.test/t/EXAMPLEtokenEXAMPLEtok" });
  const second = renderTableDisplay({ ...common, url: "https://order.example.test/t/SECONDtokenSECONDtok22" });

  assert.notEqual(first.data, second.data);
});

test("renders different status text into the frame", () => {
  const common = { tableLabel: "A1", url: "https://order.example.test/t/EXAMPLEtokenEXAMPLEtok" };
  const welcome = renderTableDisplay({ ...common, status: "Welcome" });
  const inUse = renderTableDisplay({ ...common, status: "Table is in use" });

  assert.notEqual(welcome.data, inUse.data);
});

test("renders QR modules at the largest supported one-pixel scale", () => {
  const payload = renderTableDisplay({
    tableLabel: "B12",
    status: "Welcome",
    url: `https://order.example.test/?token=${"x".repeat(425)}`
  });
  const rows = decodePackedBase64(payload);
  const darkQrPixels = rows
    .slice(16, 112)
    .reduce((total, row) => total + [...row.slice(196, 292)].filter((pixel) => pixel === "B").length, 0);

  assert.ok(darkQrPixels > 100);
});

test("fits a production opaque table visit URL", () => {
  const payload = renderTableDisplay({
    tableLabel: "TERRACE2",
    status: "Table is in use",
    url: "https://order.yeyintlwin.com/t/______________________"
  });

  assert.equal(payload.width, 296);
  assert.equal(payload.height, 128);
});

test("validates table template input", () => {
  assert.throws(
    () => renderTableDisplay({ tableLabel: "b12", status: "Welcome", url: "https://order.example.test" }),
    /tableLabel must match/
  );
  assert.throws(
    () => renderTableDisplay({ tableLabel: "B12", status: "", url: "https://order.example.test" }),
    /status is required/
  );
  assert.throws(
    () => renderTableDisplay({ tableLabel: "B12", status: "Welcome", url: "not-a-url" }),
    /url must be an http or https URL/
  );
  assert.throws(
    () => renderTableDisplay({
      tableLabel: "B12",
      status: "Welcome",
      url: `https://order.example.test/?token=${"x".repeat(500)}`
    }),
    /url is too long for the e-paper QR area/
  );
});

test("accepts every label shape the shop_tables CHECK constraint accepts", () => {
  // The defect this replaces: these all satisfy 0001_init.sql:196 yet the old integer
  // check threw on all of them, so a table labelled A1 could not be drawn at all.
  for (const tableLabel of ["A1", "B12", "TERRACE2", "PATIO 12", "A", "9", "A-1", "12345678", "TABLE 07"]) {
    const payload = renderTableDisplay({
      tableLabel,
      status: "Welcome",
      url: "https://order.example.test/t/EXAMPLEtokenEXAMPLEtok"
    });
    assert.equal(payload.width, 296, tableLabel);
    assert.equal(payload.height, 128, tableLabel);
    assert.equal(Buffer.from(payload.data, "base64").length, PACKED_BYTE_LENGTH, tableLabel);
  }
});

test("rejects exactly what the shop_tables CHECK constraint rejects", () => {
  // Cross-checked against the live Postgres `~` operator: each of these is false there too.
  // 9 characters included deliberately -- the quantifier caps the whole label at 8, so
  // "TERRACE 2" is not a legal label however natural it looks.
  const illegal = ["a1", "TERRACE 2", "123456789", "A1!", "A1.", "", " A1", "-A1", "A1\n", "TABLE  07"];
  for (const tableLabel of illegal) {
    assert.throws(
      () => renderTableDisplay({ tableLabel, status: "Welcome", url: "https://order.example.test" }),
      /tableLabel must match/,
      `expected ${JSON.stringify(tableLabel)} to be rejected`
    );
  }
  // A number is not a label. Coercing would silently resurrect the old integer call shape.
  for (const tableLabel of [7, null, undefined, ["A1"]]) {
    assert.throws(
      () => renderTableDisplay({ tableLabel, status: "Welcome", url: "https://order.example.test" }),
      /tableLabel must match/,
      `expected ${JSON.stringify(tableLabel)} to be rejected`
    );
  }
});

test("keeps the longest legal label clear of the QR quiet zone", () => {
  // Guards the measurement that removed the "TABLE " prefix. drawQr frames x 194..293 over
  // y 14..113 and does not fill it, so red label ink past x=193 would sit in the quiet zone
  // rather than being covered. Re-adding a prefix would put it there and fail this test.
  const rows = decodePackedBase64(renderTableDisplay({
    tableLabel: "12345678",
    status: "Welcome",
    url: "https://order.example.test/t/EXAMPLEtokenEXAMPLEtok"
  }));

  let rightmostRed = -1;
  for (let y = 14; y <= 38; y += 1) {
    for (let x = 0; x < 296; x += 1) if (rows[y][x] === "R") rightmostRed = Math.max(rightmostRed, x);
  }

  assert.equal(rightmostRed, 166);
  assert.ok(rightmostRed < 194, `label ink reached x=${rightmostRed}, into the QR frame`);
});
