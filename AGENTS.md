# Project Instructions

## Work in progress: the core-api re-architecture

The platform is being split so that one central API owns the data and the
existing apps become its clients. Two documents govern that work, and both are
written to be read cold — you do not need the conversation that produced them.

- **Design:** [docs/superpowers/specs/2026-07-29-core-api-phase1-design.md](docs/superpowers/specs/2026-07-29-core-api-phase1-design.md)
  — what Phase 1 is, the fifteen decisions already settled and the alternatives
  rejected, the full schema, and what was deliberately deferred. Read §2 before
  proposing anything; most obvious suggestions were already considered and
  rejected there for a stated reason.
- **Plan 1 — Foundation:** [docs/superpowers/plans/2026-07-29-core-api-phase1-plan1-foundation.md](docs/superpowers/plans/2026-07-29-core-api-phase1-plan1-foundation.md)
  — 48 task-by-task steps building `apps/core-api`. **Read "How to pick this up"
  at the top of that file before touching anything**, including the execution
  order warning: Task 18 and part of Task 19 must be done before Task 10.
  **Complete — 48 of 48.**
- **Plan 5 — Deployment:** [docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md](docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md)
  — 30 tasks. **29 of 30.** Task 18 is what remains and it cannot be done from a
  keyboard here: it uploads the nginx configs and both infra scripts to the box
  and creates `config/` and `~/backups`. It is also what unblocks Task 15's manual
  verification.
- **Plan 2a — Credential primitives:** [docs/superpowers/plans/2026-08-04-core-api-phase1-plan2a-primitives.md](docs/superpowers/plans/2026-08-04-core-api-phase1-plan2a-primitives.md)
  — **Complete, 11 of 11.** The `0002_identity` migration and the five pure `lib/`
  modules, with no route registered so the migration reached production before
  anything read it.
- **Plan 2b — Authentication:** [docs/superpowers/plans/2026-08-05-core-api-phase1-plan2b-authentication.md](docs/superpowers/plans/2026-08-05-core-api-phase1-plan2b-authentication.md)
  — **Complete, 17 of 17.** Sessions, the six identity routes, the §6.3.5 request
  pipeline, the role gate, the bootstrap CLI, and the deploy's forged-XFF probe.
  Read its execution log before starting anything nearby: it records two decisions
  an executor is forbidden to re-make, and both bit late.

**Where the work stopped is recorded in each plan's "Execution log" table, at the
very top of the file.** Read it first — and trust it over any prose summary,
including this one. Plan 2b's banner was wrong twice about its own state.

`apps/core-api` boots, migrates before it listens, serves `/health` and
`/health/ready`, carries the tenant choke point, and **a human can now sign in**:
`scripts/create-platform-admin.js` creates the first administrator, `POST
/api/admin/auth/login` returns a `__Host-core_session` cookie, and `me`, `logout`,
`logout-all`, `password` and `scope` all work.

**Plan 5 was written to run before Plans 2–4, on purpose** — every deployment
defect it shakes out surfaces against `/health` rather than against login. In
practice 2a and 2b landed first and Plan 5 stalled at its one on-box task, so that
ordering held in spirit rather than in sequence: the deploy pipeline's own asserts
were being changed by 2b while its manual step waited.

Running its tests needs a local PostgreSQL and one variable:

```sh
docker run -d --name core-db-dev -e POSTGRES_USER=core_api_owner -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=core -p 127.0.0.1:5433:5432 postgres:16-alpine
export CORE_API_TEST_DATABASE_URL='postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
```

Without it the database suites **throw** rather than skip, by design. The single
`CORE_API_SKIP_DB_TESTS=1` hatch turns them into *visible* TAP skips.

**Plan 2 was split into four, and two of them are done.** 2a and 2b are complete
(above). What is left:

- **Plan 2c — Tenant and platform CRUD.** Not written, but **its migration has
  landed ahead of it**: `0003_admin_console.sql` adds the columns the admin
  console's design needs — `companies.slug`, and on `shops` slug, address,
  currency, language, phone, opening_hours, receipt_footer and run_by_owner, plus
  `users.phone` and a nullable `users.language`. Shipped alone on purpose, the way
  2a shipped `0002`: **no route reads any of it yet**, so the schema reached
  production and was proved there before anything depended on it. The design is
  [docs/superpowers/specs/2026-08-06-admin-console-roles-design.md](docs/superpowers/specs/2026-08-06-admin-console-roles-design.md);
  its §8B lists what the API still owes it, and the largest item is a role that
  admits a **scoped platform admin but not the company's own admin** — which no
  alias in §5.4 can currently express.
  The rest of 2c: `/api/platform/companies`
  and `/api/platform/admins`, `/api/admin/users` and `/api/admin/shops`. It also
  inherits three things Plan 2b deliberately left: the **second half of §6.3.5
  step 10** (per-resource authorization — 2b landed only the static role gate),
  the rank lattice and shop containment in `lib/authorization.js`, and — read this
  before writing a line — **nothing in the service produces `409 scope_required`
  yet**, which §6.3.3 promises for a tenant route reached by an unscoped platform
  admin. 2c registers roughly twenty such routes. Slice spec §11.11 records it.
- **Plan 2d — Credential recovery.** Not written. Forgot-password, reset-password,
  email verification, the two server-rendered landing pages under `/admin`,
  `nodemailer` and the `mail/` area, plus `scripts/sweep-expired.js`,
  `set-password.js` and `unlock-account.js` — the last two are named as shipped
  levers in five spec sections and do not exist.

**The order is settled and it is not 2c next.** Slice spec §11.8: **2b → Phase 3 →
2c → 2d**. Phase 3 moves table visits and e-paper orchestration into core-api,
and it goes second because every plan landed before it is another plan built on a
boundary violation that §11.7 already calls the wrong shape.

Brainstorm and write 2c and 2d the same way 1, 2a and 2b were produced. Phase 1's
spec §10 lists what was deliberately deferred and to which phase.

Keep that log honest. At the end of a working session, append a row: the date,
what you did, the last task actually finished, the commits, and the next task. A
task counts as finished only when all five of its steps are ticked and its commit
exists — a half-done task is worse than an untouched one for whoever picks it up.
Tick the `- [ ]` boxes as you go and commit the plan file alongside the code.

`apps/core-api` is new in Phase 1. Until it exists, everything below still
describes the whole system.

## E-paper Hub Synchronization

Whenever `apps/epaper-hub` changes, check whether the change affects its API contract, authentication, endpoints, payload codec, screen dimensions or colors, templates, persistence, or deployment behavior. If it does:

- Update `packages/epaper-hub-sdk` implementation and tests in the same change.
- Update the relevant documentation in the root `README.md`, `apps/epaper-hub/README.md`, and `packages/epaper-hub-sdk/README.md`.
- Run the repository-level `npm test` before considering the change complete.

