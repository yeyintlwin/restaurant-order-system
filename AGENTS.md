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
  — 30 tasks. **This is the next thing to execute.** Start at Task 1.

**Where the work stopped is recorded in each plan's "Execution log" table, at the
very top of the file.** Read it first; it says which task was last finished and
which one is next. As of 2026-07-31 **Plan 1 is complete — 48 of 48 tasks.**
`apps/core-api` boots, validates its configuration, migrates before it listens,
serves `/health` and `/health/ready`, and carries the tenant choke point.

**Plan 5 runs before Plans 2–4, on purpose.** The service has two routes, and that
is the point: every deployment defect it shakes out surfaces against `/health`
rather than against login, tenant CRUD and terminal pairing. Its execution log is
at 0 of 30 — nothing in it has been run yet. It has already been through the same
adversarial review Plan 1 got; the ten must-fix defects that review found are
fixed in the text, and listed under its execution log so you can see the shapes
they took.

Running its tests needs a local PostgreSQL and one variable:

```sh
docker run -d --name core-db-dev -e POSTGRES_USER=core_api_owner -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=core -p 127.0.0.1:5433:5432 postgres:16-alpine
export CORE_API_TEST_DATABASE_URL='postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres'
```

Without it the database suites **throw** rather than skip, by design. The single
`CORE_API_SKIP_DB_TESTS=1` hatch turns them into *visible* TAP skips.

**Plan 2 has not been written.** It covers the menu in the database plus admin
CRUD; brainstorm and write it before touching code, the same way Plan 1 was
produced. Phase 1's spec §10 lists what was deliberately deferred and to which
phase.

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

