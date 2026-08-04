# E-paper Hub SDK

Server-side JavaScript SDK for the restaurant's 296x128 white/black/red table displays. Its built-in table template renders the table number, status, and a QR code for the exact ordering URL, then sends the compact `epd-2bit-v1` payload to the hub.

## Install

From this monorepo:

```bash
npm --prefix packages/epaper-hub-sdk ci
```

## Use

```js
const { createEpaperHubSdk } = require("@restaurant/epaper-hub-sdk");

const epaper = createEpaperHubSdk({
  baseUrl: process.env.EPAPER_HUB_URL,
  apiKey: process.env.EPAPER_API_KEY
});

await epaper.updateTableDisplay({
  epaperId: 7,
  tableLabel: "A1",
  status: "Table is in use",
  url: "https://order.yeyintlwin.com/t/EXAMPLEtokenEXAMPLEtok"
});
```

`epaperId` must be from 1 to 12. `tableLabel`, `status`, and `url` are rendered into the built-in template.

`tableLabel` is the dining table's own label and must match `^[A-Z0-9][A-Z0-9 -]{0,7}$` — uppercase A-Z, digits, space and dash, **at most 8 characters in total**. That is the `shop_tables.label` CHECK constraint from `apps/core-api/migrations/0001_init.sql:196`, copied character for character so the renderer and the column cannot drift; validation is on the raw string, so a lowercase label is rejected rather than quietly uppercased. Note the 8-character cap applies to the whole label: `A1`, `B12` and `TERRACE2` are legal, `TERRACE 2` is nine characters and is not.

The label is drawn verbatim at scale 5, with no `TABLE` prefix in front of it. At that scale each character consumes 20px from `x=12`, and the QR frame begins at `x=194` in the same vertical band, which leaves room for 9 characters; the schema's 8-character maximum ends at `x=166`. A prefix would have spent 6 of those 9 and pushed long labels into the QR's quiet zone, and shrinking to fit would have dropped the label to the status line's size. The URL is encoded as a QR code without modification and is rejected if its QR matrix cannot fit the screen safely. Callers pass the exact ordering URL; the SDK never builds one. In production that URL is the table's opaque visit URL, `https://order.yeyintlwin.com/t/` followed by 22 Base64URL characters, which the customer-order service rotates at checkout, on every service start, and at the `06:00 Asia/Tokyo` business rollover. The current status font supports uppercase ASCII letters, digits, spaces, and hyphens across two 15-character lines.

To render without sending:

```js
const payload = epaper.renderTableDisplay({
  tableLabel: "A1",
  status: "Welcome",
  url: "https://order.yeyintlwin.com/t/EXAMPLEtokenEXAMPLEtok"
});
```

The returned object can be posted directly to `/api/epapers/:id`. Keep the API key and SDK calls in server code only.

## Docker Runtime

**This package has exactly one permitted caller, and it is `apps/core-api`.**

That is the identity-slice design §11.7, and it is enforced rather than agreed: rule C16 in `apps/core-api/test/source-structure.test.js` scans `apps/` and `packages/` for `require("@restaurant/epaper-hub-sdk")` and asserts the result is the one-element list `["apps/core-api/epaper/hub-client.js"]`. A second caller is a failing test, not a code-review remark. The reason is that this package reaches twelve physical panels and renders a QR from a URL that *is* a table's visit credential, so "which process may drive a display" is an authorisation question.

The **core-api** container uses this SDK through the private Compose address `http://epaper-hub:3000`, not the public e-paper hub URL. Keep `EPAPER_API_KEY` (the same value the hub reads as `API_KEY`) in `~/core-api.env`.

`apps/customer-order` used to hold it. It now reaches a display through core-api instead:

```text
customer-order  →  core-api  →  @restaurant/epaper-hub-sdk  →  epaper-hub
```

Its startup bootstrap still resets tables 1 through 12 to `Welcome` before customer traffic is accepted; those twelve requests are now `POST /api/terminal/table-displays/{n}` against core-api, authenticated with the interim shared `TABLE_DISPLAY_SERVICE_TOKEN` of §11.9 and replaced by terminal pairing in Phase 3.

The same external runtime environment file must provide the customer-order production values below. Compose supplies the non-secret timezone and rollover defaults, while `SHOP_ID` and `CHECKOUT_API_KEY` remain in that file.

```dotenv
SHOP_ID=1
CHECKOUT_API_KEY=<independent-random-secret>
BUSINESS_TIME_ZONE=Asia/Tokyo
BUSINESS_DAY_ROLLOVER_HOUR=6
```
