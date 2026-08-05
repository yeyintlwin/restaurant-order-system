# Admin Management

The restaurant management front end. Plain HTML, CSS and ES modules — no framework,
no build step, no runtime dependency.

Served at **`https://admin.yeyintlwin.com`**.

## What it does

It serves `public/` and forwards `/api/*` to `core-api`. That is the whole server.

The proxy is not a convenience. `core-api`'s session cookie is `__Host-` prefixed
and host-only, and a cookie-authenticated cross-origin `fetch` would need
`Access-Control-Allow-Credentials`, which the parent spec forbids on `/api/admin/*`.
Putting both behind one origin removes the problem instead of configuring around it.

**Three headers it must never touch**, each with a test in `test/server.test.js`:

| Header | Why |
| --- | --- |
| `Origin` | core-api compares it to `API_PUBLIC_ORIGIN`. That is the CSRF control. |
| `X-Forwarded-For` | core-api counts hops from the right. Appending here makes `TRUSTED_PROXY_HOPS` wrong for `/api` and right for everything else. |
| `Set-Cookie` | `__Host-` is only worth anything if `Path=/; Secure; HttpOnly; SameSite=Lax` survives the hop. |

## Screens

One page today: sign in, see who you are, change your password, sign out. Company,
shop and user management arrive with Plan 2c, which builds the routes.

## Running it

```sh
CORE_API_URL=http://127.0.0.1:3200 PORT=3400 npm start
```

`CORE_API_URL` is required and the process refuses to start without it.

## Tests

```sh
npm test
```

`api.js` takes `fetch` as an argument, so every status core-api can return is a real
test rather than a string match against the source.
