# Customer Order App

Mobile-first customer ordering interface opened from the e-paper table QR code.

For now this app is English-only. Internationalization will be added after the main workflows are complete.

## Run Locally

```bash
npm ci
cp .env.example .env
npm start
```

Read table 1's QR code from the e-paper emulator at `http://localhost:3000`, then request its `/t/` path against the local port:

```text
http://localhost:3100/t/<token-from-the-table-1-QR>
```

Table QR codes always encode the production origin `https://order.yeyintlwin.com`, so copy only the 22-character token when testing locally.

For direct local processes outside Docker, set `CORE_API_URL=http://localhost:3200`. Compose overrides it with the private service address shown below.

## This app does not drive the e-paper displays

It asks `core-api` to, and `core-api` calls the SDK. That is the boundary of the identity-slice design §11.7: **core-api is the controlling API, and `@restaurant/epaper-hub-sdk` has exactly one permitted caller.** Concretely:

- `apps/customer-order/table-display-client.js` sends `POST /api/terminal/table-displays/{tableNumber}` to core-api with `{ "status": …, "orderingUrl": … }`.
- core-api renders the frame and posts it to the hub.
- This app holds no hub URL and no hub key. `EPAPER_HUB_URL` and `EPAPER_API_KEY` are `core-api`'s configuration and live in `~/core-api.env`.

The bearer it presents is `TABLE_DISPLAY_SERVICE_TOKEN`, an **interim shared service token** (§11.9): core-api compares it with `crypto.timingSafeEqual` over SHA-256 digests. Phase 3 pairs this app as a terminal and replaces the shared token with a `terminal_tokens` bearer at the same route.

What has **not** moved yet is the QR itself. `table-visit-store.js` still mints, rotates and expires the visit token here, and the ordering URL travels to core-api in the request body. §11.7's end state has core-api resolving the token so no front end ever holds one; that is Phase 3, together with `order-store.js` and a `table_visits` migration. §11.9 records why the SDK moved first.

## Environment

```bash
PORT=3100
CORE_API_URL=http://core-api:3200
TABLE_DISPLAY_SERVICE_TOKEN=<32-plus-character-random-secret>
ORDER_BASE_URL=https://order.yeyintlwin.com
SHOP_ID=1
CHECKOUT_API_KEY=<independent-random-secret>
BUSINESS_TIME_ZONE=Asia/Tokyo
BUSINESS_DAY_ROLLOVER_HOUR=6
TABLE_DISPLAY_API_KEY=replace-with-a-separate-long-random-secret
```

`CHECKOUT_API_KEY`, `TABLE_DISPLAY_API_KEY` and `TABLE_DISPLAY_SERVICE_TOKEN` are server-only credentials and are never exposed to browser code. `TABLE_DISPLAY_SERVICE_TOKEN` is **outbound** (presented to core-api) while `TABLE_DISPLAY_API_KEY` is **inbound** (required by this app's own provisioning route); they are different secrets and must not be set to the same value. `ORDER_BASE_URL` is the public page encoded into each table QR code. Production deployment reads `SHOP_ID`, `CHECKOUT_API_KEY` and `TABLE_DISPLAY_SERVICE_TOKEN` from the external runtime environment file at `~/restaurant-order-system.env`; Compose supplies the exact `BUSINESS_TIME_ZONE` and `BUSINESS_DAY_ROLLOVER_HOUR` defaults.

Startup **refuses to listen** without `CORE_API_URL`, `TABLE_DISPLAY_SERVICE_TOKEN` and `ORDER_BASE_URL`. That is deliberately stricter than core-api, which treats its half of the pair as optional and answers 503: core-api migrates the database before it listens, so a required secret missing there would fail the deploy gate after the schema had already changed. This container crash-looping is the loud half of that pair.

## Initialize A Table Display

```bash
curl -X POST "http://localhost:3100/api/table-displays/7/welcome" \
  -H "Authorization: Bearer $TABLE_DISPLAY_API_KEY"
```

On every customer-order startup, the service resets all 12 displays to their `Welcome` ordering screens before accepting traffic. Startup also mints a fresh visit token per table, so a restart or redeploy replaces all 12 QR URLs and invalidates every enrolled phone session. This deliberately replaces prior `Table is in use` display state in the current in-memory milestone. The protected endpoint above remains available for preparing one inactive table while the service is running; active sessions return `409` and are not reset by that endpoint.

## Table Access Contract

The QR code carries an opaque visit token and nothing else:

```text
https://order.yeyintlwin.com/t/AAAAAAAAAAAAAAAAAAAAAA
```

That path segment is exactly 22 Base64URL characters from 16 random bytes. Visit lookup is keyed solely on its SHA-256 hash; the raw token stays in private process memory (and inside `orderingUrl` on every visit snapshot) so the live QR can be re-rendered, so treat snapshots and logs as carrying a real credential. The raw token never crosses the HTTP boundary.

| Step | Contract |
| --- | --- |
| Enrollment | `GET /t/<token>` returns `302` to `/` and sets `rsid=<22 Base64URL characters>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=<seconds until expiry>` |
| Dead token | malformed, unknown, expired, or rotated all `302`-redirect to `/?e=expired`, which shows a full-screen "This QR code is no longer valid" block and disables ordering |
| Multiple phones | each scan of the current QR mints its own `rsid`; all phones share one visit, slip, and order list |
| Customer APIs | table comes only from `rsid`; missing or forged returns `401` `{"error":"Scan the current table QR to continue"}` |
| POST guards | `Origin: https://order.yeyintlwin.com` else `403`; `Content-Type: application/json` else `415` |
| Checkout | `POST /api/tables/{tableNumber}/checkout` with `Authorization: Bearer $CHECKOUT_API_KEY` |
| Expiry | next `06:00 Asia/Tokyo` rollover |

Checkout revokes the old QR and every enrolled phone session **before** it updates the display, so old credentials die even when the display update fails. That failure returns `502` and keeps exactly one pending replacement token, so a retry re-sends the same URL instead of minting a second QR. Replacement URLs and tokens never appear in a response body.

Accepted limitation: a photograph of the table QR taken before checkout remains usable during that active visit. Customers order over mobile data rather than a controlled Wi-Fi network, so no network signal can bind a phone to a table, and the QR is shared by every phone at the table and deliberately does not rotate mid-visit. Checkout, service startup, and the `06:00 Asia/Tokyo` rollover each invalidate it.

## Current Flow

1. Scan the table QR; the server resolves the table from the resulting `rsid` cookie.
2. Show menu categories, recommendations, search, service items, desserts, and drinks.
3. Add items to cart.
4. Place order.
5. First order creates a table session and slip number.
6. Later orders from the same table keep the same slip number.
7. First order securely updates the e-paper hub status to `Table is in use`.
8. Customer can call staff.
9. Checkout preview shows subtotal, service fee, tax, total, bill split, and a checkout barcode.
10. Protected checkout closes the active in-memory order session, revokes enrolled phones, and rotates the table QR; cashier UI integration remains future work.
