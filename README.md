# Restaurant Management System

Restaurant ordering platform with table e-paper monitors, customer ordering, kitchen order display, cashier checkout, and admin management.

## Apps

- `apps/epaper-hub` - running e-paper emulator and secure update API for 12 table monitors.
- `apps/customer-order` - customer phone ordering flow after scanning the table QR code.
- `apps/kitchen-display` - kitchen monitor for incoming orders and preparation status.
- `apps/cashier-counter` - checkout, bill review, checkout barcode scanning, and final settlement.
- `apps/admin-management` - menu management, pricing, daily sales, and transaction history.
- `apps/captive-portal` - guest Wi-Fi onboarding and survey flow.
- `packages/epaper-hub-sdk` - server-side SDK that renders table/status/QR templates and securely updates e-paper screens.
- `packages/shared` - shared schemas and helpers used across apps.
- `infra` - deployment and infrastructure notes.

## Current Status

The first deployed service is the e-paper hub at `apps/epaper-hub`. It is deployed at `https://epaper-hub.yeyintlwin.com` and still uses the same GitHub Actions CI/CD pipeline.

The customer ordering app lives at `apps/customer-order` and is deployed at `https://order.yeyintlwin.com`.

Run the current app locally:

```bash
cd apps/epaper-hub
cp .env.example .env
npm install
npm start
```

Run the customer ordering app locally:

```bash
cd apps/customer-order
npm ci
cp .env.example .env
npm start
```

Open the e-paper emulator at `http://localhost:3000`, read table 1's QR code, and request its `/t/` path against the local port:

```text
http://localhost:3100/t/<token-from-the-table-1-QR>
```

Table QR codes always encode the production origin, so copy only the 22-character token when testing locally.

Applications can update a table display through the SDK:

```js
const { createEpaperHubSdk } = require("./packages/epaper-hub-sdk");

const epaper = createEpaperHubSdk({
  baseUrl: "https://epaper-hub.yeyintlwin.com",
  apiKey: process.env.EPAPER_API_KEY
});

await epaper.updateTableDisplay({
  epaperId: 3,
  tableNumber: 3,
  status: "Welcome",
  url: "https://order.yeyintlwin.com/t/EXAMPLEtokenEXAMPLEtok"
});
```

Keep this call on the server so `EPAPER_API_KEY` is never exposed to customers. `TABLE_DISPLAY_API_KEY` is a separate server-only credential for the customer-order provisioning endpoint; it is not the e-paper hub `EPAPER_API_KEY` or its `API_KEY` fallback.

Initialize a table display through the customer-order service:

```bash
curl -X POST "https://order.yeyintlwin.com/api/table-displays/7/welcome" \
  -H "Authorization: Bearer $TABLE_DISPLAY_API_KEY"
```

This securely uses the server-side e-paper SDK to display table 7, `Welcome`, and a QR for that table's current opaque visit URL. It re-renders the existing credential and never rotates it. On every customer-order startup, the service resets all 12 displays to their `Welcome` ordering screens before accepting traffic. Use this endpoint only to prepare an inactive table while the service is running. Active tables return `409` with `Table is in use` and are not reset by this endpoint. The protected checkout operation closes the in-memory order session, revokes the table visit, and renders a fresh `Welcome` QR.

Run tests from the repository root:

```bash
npm test
```

## Core Flow

1. Each restaurant table has an e-paper monitor showing table number, status, and a QR code.
2. Initial table status is `Welcome`.
3. The customer scans the QR code. The opaque token enrols that phone into the table's current visit and sets a session cookie; the table is resolved server-side and never travels in the URL or request body.
4. The customer selects a language: Thai, English, Chinese, Japanese, or Burmese.
5. The customer adds menu items to the cart and places an order.
6. When the first order is placed, the table status updates to `Table is in use`.
7. The kitchen monitor receives the order with the table number.
8. The kitchen printer prints a slip with table number, ordered items, slip number, and barcode.
9. The first order creates the slip number. All later orders from the same table session keep that same slip number while the session remains active.
10. Protected checkout closes the current in-memory order session and rotates the table QR; cashier workflow integration remains future work.

## Secure Table QR Lifecycle

Table QR codes are opaque. They encode no shop ID, table number, business date, generation, or validity data:

```text
https://order.yeyintlwin.com/t/AAAAAAAAAAAAAAAAAAAAAA
```

The path segment is exactly 22 Base64URL characters generated from 16 random bytes. Visit lookup is keyed only on the token's SHA-256 hash. The raw token itself stays in private process memory for the life of the visit so the QR can be re-rendered when the table's status changes, and it never appears in an HTTP response or a log — treat a visit snapshot as carrying a live credential.

- **Enrollment.** `GET /t/<token>` answers `302` to `/` and sets `rsid=<22 Base64URL characters>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=<seconds until expiry>`. A token that is malformed, unknown, expired, or already rotated instead redirects (`302`) to `/?e=expired`, which renders a full-screen "This QR code is no longer valid. Scan the current QR code at your table." screen and blocks ordering — the four cases are indistinguishable to the client. Opening the app with no session at all (`/` with no cookie) renders a full-screen "Scan your table's QR code to start ordering." screen.
- **Multiple phones.** Every scan of the current QR mints a separate `rsid`. Multiple phones at one table share the same visit, slip number, order list, and totals.
- **Customer APIs.** `GET /api/session`, `POST /api/orders`, and `POST /api/staff-calls` derive the table only from the `rsid` cookie. A missing or forged cookie returns `401` with `{"error":"Scan the current table QR to continue"}`. The two POST routes additionally require `Origin: https://order.yeyintlwin.com` (otherwise `403`) and `Content-Type: application/json` (otherwise `415`).
- **Checkout.** `POST /api/tables/{tableNumber}/checkout` with `Authorization: Bearer $CHECKOUT_API_KEY` is a server-to-server route. It closes the order session, revokes the old QR and every phone session enrolled against it, then renders a fresh `Welcome` QR. Success is `200` with `{"ok":true,"tableNumber":7,"status":"Welcome"}`; a failed display update is `502` with `{"error":"E-paper display update failed"}`. Revocation happens before the display update, so old credentials die immediately either way. A failed update retains exactly one pending replacement token, making retry idempotent. The replacement URL and token never appear in any response.
- **Expiry.** Every visit expires at the next `06:00 Asia/Tokyo` rollover, and a scheduled reconciliation rotates each expired table to a fresh `Welcome` QR.

Accepted limitation: a photograph of the table QR taken before checkout remains usable during that active visit. Customers order over mobile data rather than a controlled Wi-Fi network, so there is no network signal to bind a phone to a table, and the QR is deliberately shared by every phone at the table and does not rotate mid-visit. Those two choices were made together, and this is their accepted cost. That photograph stops working the moment checkout, service startup, or the `06:00 Asia/Tokyo` rollover rotates the table.

## Management Requirements

The admin interface must support menu item management, price changes, daily sales reports, and full transaction history.

## Deployment Shape

The Lightsail server should keep only the runtime deployment files in `~/restaurant-order-system`:

- `docker-compose.yml`
- optional `config/`

The environment files remain outside that folder: `~/restaurant-order-system.env` for `epaper-hub`
and `customer-order`, and `~/core-api.env` for `core-db` and `core-api`. They are separate on
purpose — see `infra/README.md`, "Core API runtime: two secrets files and core-net".

Customer-order production startup requires these values. Keep `SHOP_ID` and `CHECKOUT_API_KEY` in the external production environment file; Compose supplies the two non-secret business-time defaults.

```dotenv
SHOP_ID=1
CHECKOUT_API_KEY=<independent-random-secret>
BUSINESS_TIME_ZONE=Asia/Tokyo
BUSINESS_DAY_ROLLOVER_HOUR=6
```

Docker Compose runs `epaper-hub` and `customer-order` together. The hub and order ports bind only to `127.0.0.1`; Nginx owns public HTTPS. The order service waits for the hub health check, then connects to it privately at `http://epaper-hub:3000` while rendering public QR links for `https://order.yeyintlwin.com`.
