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
- **Plan:** [docs/superpowers/plans/2026-07-29-core-api-phase1-plan1-foundation.md](docs/superpowers/plans/2026-07-29-core-api-phase1-plan1-foundation.md)
  — 48 task-by-task steps building `apps/core-api`. **Read "How to pick this up"
  at the top of that file before touching anything**, including the execution
  order warning: Task 18 and part of Task 19 must be done before Task 10.

**Where the work stopped is recorded in the plan's "Execution log" table, at the
very top of the file.** Read it first; it says which task was last finished and
which one is next. As of 2026-07-29 it reads *0 of 48 tasks done, no code
written yet* — the spec and the plan exist, `apps/core-api` does not.

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

