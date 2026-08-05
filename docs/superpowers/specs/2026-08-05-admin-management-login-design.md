# Admin Management — Sign-in Design

The first screen of `apps/admin-management`: sign in, see who you are, change your
password, sign out. Nothing else.

**Parent spec:** [2026-07-29-core-api-phase1-design.md](2026-07-29-core-api-phase1-design.md).
Bare section references (§5.3, §6.2) point there. This document records only what is
**new or amended**.

---

## 1. Why this exists

`core-api` has answered six authentication routes since Plan 2b, and the only way to
use them is `curl`. A platform administrator exists in production and cannot change
their own password without a shell on the box. This closes that.

It is deliberately small. There are no companies, shops or users to manage until
Plan 2c, so a navigation shell would be scaffolding around an empty room.

### 1.1 In scope

- One page. Sign in, see your identity, change your password, sign out.
- `apps/admin-management` as a running service for the first time: static files plus
  an `/api` proxy.
- One new subdomain, `admin.yeyintlwin.com`, with its nginx server block.

### 1.2 Out of scope

Company, shop, user and terminal management — Plan 2c owns the routes and this UI
grows into them afterwards. Forgot-password and email verification — Plan 2d. The
company selector: `POST /api/admin/scope` exists, but with zero companies there is
nothing to select, so the UI does not offer it.

---

## 2. Settled decisions

Each was an explicit fork. Recorded so nobody re-derives them.

| # | Decision | Rejected alternative |
| --- | --- | --- |
| 1 | **`apps/admin-management` is a frontend on its own subdomain. `core-api` is the one backend and serves no HTML.** This is the developer's architecture, stated repeatedly. | Parent decision 11, "the admin UI is served same-origin from core-api at `/admin`" — **superseded**, see §2.1. |
| 2 | **`admin-management` proxies `/api/*` to core-api**, so the browser only ever talks to one origin. | A direct cross-origin `fetch` to `api.yeyintlwin.com`, which needs CORS with credentials — forbidden by §6.5 in terms that name this exact scenario. |
| 3 | **`API_PUBLIC_ORIGIN` becomes `https://admin.yeyintlwin.com`.** It names the origin browsers use for cookie-authenticated requests, and after this change that is the admin app. | Rewriting the `Origin` header in nginx to keep the old value. That makes the §5.3 check a no-op for everything arriving through the proxy — it would pass for a forged cross-site request too. |
| 4 | **No build step.** Plain HTML, CSS and ES modules, matching `customer-order` and `epaper-hub`. | A bundler, for a page with two forms. |
| 5 | **The API-calling code is a separate module from the DOM code**, and takes `fetch` as an argument. | One `app.js`, which is what `customer-order` did — and its whole test suite is one function asserting that strings appear in files. See §6. |
| 6 | **Error text comes from core-api, never from the client.** | Client-authored messages, which would drift from §6.3.2's vocabulary and are how "wrong password" and "unknown email" end up distinguishable. |
| 7 | **Sign-in does not redirect.** The form is replaced in place on the same URL. | A `/login` page and a `/` page, which needs redirect handling, a "where was I going" parameter, and a second HTML file, for one screen. |

### 2.1 Parent decision 11 is superseded, and by whom

§2's decision 11 reads: *"The admin UI (Phase 2) is served **same-origin** from
core-api at `/admin`"*, rejecting *"`admin.` subdomain, which needs CORS with
credentials"*.

The **requirement** in that sentence is sound and is kept: the browser must see one
origin, because `__Host-core_session` is host-only and a cookie-authenticated
cross-origin `fetch` would need `Access-Control-Allow-Credentials`, which §6.5
forbids for `/api/admin/*`.

The **implementation** in that sentence — that core-api must be the process serving
the bytes — does not follow from it. A proxy satisfies the same requirement: the UI
and the API appear at one origin because one front door serves both. Decision 11
conflated the two.

**Two claims made while working this out were wrong and are recorded so they are not
repeated:**

1. *"A separate subdomain cannot work, the session cookie will not be sent."*
   `admin.yeyintlwin.com` and `api.yeyintlwin.com` share the registrable domain, so
   they are **same-site**. `SameSite=Lax` does not block that request. The only
   shipped blocker was `http/csrf.js` requiring `origin === API_PUBLIC_ORIGIN`.
2. *"Therefore core-api must serve the UI."* Same *origin* is required; same
   *process* is not.

---

## 3. Architecture

```text
                    admin.yeyintlwin.com          (nginx, TLS)
                              │
                ┌─────────────┴─────────────┐
                │                           │
        GET /                        /api/admin/*
                │                           │
        admin-management  ──── proxy ───►  core-api
        (static files)                    (unchanged)
```

`apps/admin-management/server.js` does two things and nothing else: serve
`public/`, and forward `/api/*` to `CORE_API_URL`. It holds no credential, reads no
database, and makes no decision about who may do what — every such decision stays in
core-api, where the tests for it live.

**The proxy is what makes development and production identical.** Both run the same
two hops. There is no "works locally, breaks deployed" gap, which is the failure mode
a CORS-in-production-only design has.

### 3.1 What the proxy must not do

- **It must not alter `Origin`.** core-api's §5.3 check is the CSRF control; a proxy
  that rewrites the header disables it for every request that passes through.
- **It must not append to `X-Forwarded-For`, and this is the subtle one.** core-api
  derives the client address by counting `TRUSTED_PROXY_HOPS` entries **from the
  right** of that header, and the value is pinned at 1 against the depth
  `infra/nginx/` deploys — `nginx-config.test.js` asserts the pair. Inserting this
  app into the chain and letting it append would make the depth 2 for requests that
  came through `/api` and 1 for everything else, so **one hop count cannot be right
  for both**. Forward the header exactly as nginx wrote it and add nothing: this
  process is transparent, nginx remains the only hop, and `TRUSTED_PROXY_HOPS` stays
  1 with its assertion intact.

  The failure if this is got wrong is silent and bad. The pick lands one place to
  the left, on an entry the client controls, and every attacker owns their own
  rate-limit bucket — the exact attack `lib/client-ip.js` exists to prevent, and
  §11.5 records that no per-request test can catch it.
- **It must not add, drop or rewrite `Cookie` or `Set-Cookie`.** The `__Host-`
  prefix constrains what the browser accepts; a proxy that touches the attributes
  can only weaken it.
- **It must not log request bodies.** The sign-in body carries a password. This is
  the same rule §6.3.6 states for core-api, and it applies here for the same reason.
- **It must not proxy anything but `/api/`.** `/health` and `/health/ready` are not
  the admin app's to expose.

---

## 4. The page

One HTML document, three states, no navigation.

### 4.1 On load

`GET /api/admin/auth/me`.

| Response | State shown |
| --- | --- |
| `200` | **Signed in.** Identity, change-password form, sign-out. |
| `401` | **Signed out.** The sign-in form. |
| `403 password_change_required` | **Must change password.** The change-password form alone, with the reason. |

The third row is why §1.1 includes the password form in a "sign-in only" slice: a
user an administrator created carries `must_change_password`, and §5.4 makes every
route except `password` and `logout` answer 403 while it is true. Without the form
they would have a working credential and nothing to do with it.

### 4.2 Signing in

`POST /api/admin/auth/login` with `{ email, password }`.

| Response | Behaviour |
| --- | --- |
| `200`, `user.mustChangePassword === false` | Swap to the signed-in state using the me-document already in the response. Do not re-fetch. |
| `200`, `user.mustChangePassword === true` | Swap straight to the **must change password** state of §4.1. Sign-in succeeded and the cookie is set; the account simply cannot do anything else yet. Landing on the ordinary signed-in state and letting them discover the 403 by clicking is the version to avoid. |
| `401 invalid_credentials` | Show the message. **Keep the email, clear the password.** |
| `422 validation_failed` | Mark the named fields from `errors[]`. |
| `429 rate_limited` | Show the message. There is no `Retry-After` on this route by design (§5.7), so the UI must not promise a time. |
| `403 origin_not_allowed` / `415` | A misconfiguration, not a user error. Say so plainly rather than blaming the password. |

**The form stays on screen for every failure.** A page that clears itself on a wrong
password makes a typo cost the whole entry.

### 4.3 Changing the password

`POST /api/admin/auth/password` with `{ currentPassword, newPassword }`. Both are
required in all cases, including the forced-change flow — §6.2 settles that, and the
server-minted `initialPassword` **is** the current password.

`403 current_password_invalid` marks the current-password field. `422` with field
code `too_short` marks the new one; the minimum is 12 characters and the UI says so
before the request rather than after.

A success returns a fresh session and a new cookie: every other session is gone.
The UI says that, because "you have been signed out on your phone" is surprising
otherwise.

### 4.4 Signing out

`POST /api/admin/auth/logout` returns to the signed-out state.
`POST /api/admin/auth/logout-all` does the same and reports the count it revoked.

---

## 5. The lockstep change list

`API_PUBLIC_ORIGIN` moving is the dangerous part of this change, and it has the same
shape as Plan 2b Task 12: **locally correct files that are wrong as a set.**

Today `docker-compose.yml` sets `API_PUBLIC_ORIGIN: https://api.yeyintlwin.com`, and
`deploy.yml` blocks 4 and 5 send `-H 'Origin: https://api.yeyintlwin.com'` on the
login probes. Change the variable alone and both probes get **`403
origin_not_allowed`** where they expect 401 — and the deploy fails **after the
migration has applied**, which is the failure shape §9.5 is written to design away.

| Site | Edit |
| --- | --- |
| `docker-compose.yml` | `API_PUBLIC_ORIGIN` → `https://admin.yeyintlwin.com` |
| `.github/workflows/deploy.yml` | Block 4's probe `Origin` header |
| `.github/workflows/deploy.yml` | Block 5's `limit_req` burst `Origin` header |
| `apps/core-api/test/config.test.js` | The frozen `PRODUCTION_ENV` fixture |
| `infra/nginx/` | A new `admin.yeyintlwin.com` server block |
| `infra/README.md` | The new subdomain and its certificate |

**A fifth app is itself a lockstep change**, separately from the origin move, and
these sites are not co-located either:

| Site | Edit |
| --- | --- |
| root `package.json` | `scripts.test` gains `npm --prefix apps/admin-management test`. Nothing runs the suite otherwise — `source-structure.test.js`'s C11 exists because a suite the root script does not invoke is a suite the deploy gate never sees. |
| `.github/workflows/deploy.yml` | An `npm ci` and an `npm test` step, beside the four that are there |
| `.github/workflows/deploy.yml` | A `docker build`, a tarball, and an `ADMIN_MANAGEMENT_IMAGE` export beside the other three |
| `docker-compose.yml` | The service block |
| root `README.md` | `monorepo-structure.test.js` reads it |

`workspaces` needs no edit: it is `["apps/*"]`, asserted by `deepEqual`, and the new
directory is already inside it.

**All six move in one commit.** Find them with:

```bash
grep -rn "API_PUBLIC_ORIGIN\|api.yeyintlwin.com" docker-compose.yml .github apps/core-api/test infra
```

**Nothing in `apps/core-api/` source changes.** The variable's *value* moves; no
check, route or header is touched.

### 5.1 Certificate before deploy

`admin.yeyintlwin.com` needs a DNS record and `certbot certonly --nginx -d
admin.yeyintlwin.com` **before** the nginx block ships, or `nginx -t` fails in the
deploy and the whole run aborts. §9.11's cutover list gains this as a step.

---

## 6. Testing

The house pattern for a frontend is `customer-order/test/public-ui.test.js`: one
function, `readFileSync`, and thirty `assert.match` calls against raw source. It
asserts that strings exist. For a page whose interesting behaviour is *what happens
on a 401*, that is not coverage — it is a spell-checker.

So the client splits in two:

| File | What it is | How it is tested |
| --- | --- | --- |
| `public/api.js` | Every call to core-api. Takes `fetch` as an argument. Returns typed results; never touches the DOM. | Unit, with a stub `fetch`. Every status in §4 gets a case. |
| `public/app.js` | DOM wiring only. Reads `api.js`, writes elements. | Structural, in the house style — the elements and ids exist. |
| `server.js` | Static + proxy. | Real HTTP against a real listener, in the shape of `customer-order/test/server.test.js`. |

### 6.1 The four tests that justify the split

1. **A wrong password leaves the email in the field and empties the password.**
2. **The password never leaves the process except in the request body** — not in a
   URL, not in `console`, not in an attribute. Asserted by scanning what the stub
   `fetch` was called with, and by a source scan for the field's id near a logging
   call.
3. **The proxy forwards `Origin` unchanged.** A test that sends a known `Origin`
   through `server.js` and asserts core-api would have seen the same bytes. This is
   the one that fails if somebody "fixes" a CORS error by rewriting the header.
4. **The proxy forwards `Set-Cookie` unchanged**, attributes included. `__Host-` is
   only worth anything if `Path=/; Secure; HttpOnly; SameSite=Lax` survives the hop.

---

## 7. Visual design

A centred card on the house palette: `#2e7d5b` on `#f4f5f7`, Inter, 16px radius,
taken from `apps/customer-order/public/styles.css`. Chosen over a split brand panel
(a second layout for phones) and an unstyled page (reads as unfinished).

The signed-in state replaces the card's contents in place — same card, same position.

---

## 8. Residuals

**The company selector is absent.** `POST /api/admin/scope` works and a platform
administrator will eventually need it. With zero companies there is nothing to put in
it; it arrives with Plan 2c, which creates the first company.

**`logout-all` reports a count that can under-report.** Plan 2b's route deletes then
bumps `sessions_valid_from`, and a session created between the two is invalidated but
not counted. The UI shows the number as informational, not as a guarantee.

**No forgot-password link.** Plan 2d builds it. Until then a locked-out administrator
needs `scripts/set-password.js`, which does not exist either — the honest current
answer is direct SQL, and the sign-in page should not imply otherwise by showing a
link that goes nowhere.

**One origin means one certificate to remember.** If `admin.yeyintlwin.com`'s
certificate lapses, the admin UI is unreachable and the API is not, which will read
as "the API is broken". The renewal is certbot's existing timer; the note is for
whoever debugs it at 22:00.
