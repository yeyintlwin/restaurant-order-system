# Core API Phase 1 — Plan 5: Deployment Implementation Plan

> **For agentic workers:** each task is self-contained — files, the complete test, the exact
> command, the expected output, the complete implementation, the commit. Steps use checkbox
> (`- [ ]`) syntax; tick them as you go and commit this file alongside the code.

**Goal:** Ship the whole core-api deployment pipeline while the service still serves only GET /health and GET /health/ready, so that every deployment defect surfaces against two routes instead of against Plans 2-4's auth, CRUD and terminal pairing. At the end of Plan 5 a push to main builds core-api from the repo root, runs its 242 tests against a real Postgres in CI, loads the image on the Lightsail box, takes a pre-deploy dump, installs and validates the api.yeyintlwin.com Nginx front door with rollback, starts core-db and core-api on an isolated core-net with their own mode-600 secrets file, gates on /health/ready through the real TLS chain, and installs a nightly backup whose silence is a red build.

**Architecture:** One repo-root docker-compose.yml owns four services: core-db and core-api on a private core-net reading ${CORE_ENV_FILE:-.env}, epaper-hub and customer-order on the default network reading ${EPAPER_ENV_FILE:-.env}. core-db publishes no host port at all. Secrets live in two mode-600 files in the deploy user's home directory (~/restaurant-order-system.env, ~/core-api.env), never in the repository. .github/workflows/deploy.yml is the single deployer: build/save/scp/load per image, then one ssh heredoc that dumps, installs nginx from /tmp with snapshot-and-rollback, runs docker compose up -d --no-build, gates on health, probes the login route and the rate limiter, checks backup freshness and disk, and rewrites the crontab. infra/ holds the two nginx conf files and the two host shell scripts (backup-core-db.sh, restore-drill.sh), scp'd to /tmp and config/ respectively. Nothing about the deploy is unit-testable, so every deploy file is asserted as TEXT by node --test suites that read it, copying apps/epaper-hub/test/deploy-config.test.js's established pattern; the handful of checks that genuinely need the host are written as numbered MANUAL VERIFICATION blocks that run once at cutover.

**Tech Stack:** Plain CommonJS JavaScript, node --test + node:assert/strict, no new dependencies. Docker Compose v2 (non-swarm keys: mem_limit, shm_size, oom_score_adj, stop_grace_period), node:20-alpine, postgres:16-alpine. GitHub Actions on ubuntu-latest with a job-level postgres:16-alpine service container. POSIX sh in the deploy heredoc and in infra/*.sh (.gitattributes already pins *.sh and *.sql to eol=lf). Nginx on Ubuntu with certbot. Every command in the plan runs from the repository root; the developer machine is win32, so bash-only forms (VAR=value cmd, git grep pathspecs) must be labelled as Bash-tool commands, not PowerShell.

**Spec:** [2026-07-29-core-api-phase1-design.md](../specs/2026-07-29-core-api-phase1-design.md) §9
and §9.12. Section references below point at it.

**Depends on:** [Plan 1 — Foundation](2026-07-29-core-api-phase1-plan1-foundation.md), complete at
48/48. `apps/core-api` exists and serves `GET /health` and `GET /health/ready` — and nothing else.
Auth, CRUD and terminal pairing are Plans 2, 3 and 4, none of which is written.

---

## Execution log

**Status: 4 of 30 tasks done. Part 1 is complete.** The next thing to do is **Task 5**
(`infra/nginx/core-api-proxy.conf`), the first task of Part 2.

> ⛔ **DO NOT PUSH past Task 3 until `~/core-api.env` exists on the Lightsail box.** Task 3's
> MANUAL VERIFICATION block is spec §9.11 step 4 and it is a **precondition, not a follow-up**.
> From Task 3's commit onward the deploy runs `test -f ~/core-api.env || exit 1`, and the compose
> file that lands on the box declares `env_file: ${CORE_ENV_FILE:-.env}` for `core-db` — so
> without that file **no** compose subcommand can load the project: not `up`, not `config`, not
> `exec`. The ssh-and-restart reflex is dead too. Create the file first, then push.

Append one row per working session. A task counts as finished only when all of its steps are
ticked and its commit exists — a half-applied task recorded as done is worse than an untouched one.

| Date | Session did | Tasks finished | Commits | Next |
| --- | --- | --- | --- | --- |
| 2026-07-31 | Wrote this plan, then put it through the same adversarial review Plan 1 got. 35 raw findings → **10 must-fix**, all applied before any task ran; 14 should-fix recorded below. No task executed. | none — 0/30 | `be5ed90`, `29010d4` | Task 1 |
| 2026-07-31 | **Task 1.** `git mv` of the compose file to the repo root (rename detected, history follows), the `build:` context pinned to `apps/epaper-hub`, `deploy.yml:49` scp source, and the hub README's `## Docker` block. Step 2 failed 4 of 14 exactly as written, including the ENOENT path. `docker compose config` resolves the context to `…\apps\epaper-hub`, not the root — the check that `docker compose config` alone would not have caught. Repository-wide `npm test` green: 352 tests, 351 pass, 1 visible skip, 0 fail. | **1/30** | (this commit) | Task 2 |
| 2026-07-31 | **Task 2.** `apps/core-api/Dockerfile` (root context, `npm ci`) and the new `apps/core-api/test/deploy-config.test.js` with its four shared helpers. **Plan defect found on execution:** Step 1 forbade `/pg-native/` anywhere while Step 3's Dockerfile explained in a comment why pg-native is absent — the task failed its own assertion. Scoped to instruction lines and mutation-tested. Docker-verified: image builds, `scripts/` and `pg` present, and a planted `apps/core-api/.env` does NOT reach the image. | **2/30** | `5c0dee7` | Task 3 |
| 2026-07-31 | Tightened Task 1's scp assertion after an adversarial review of `b713280` proved it matched the DESTINATION path and stayed green with the scp source deleted. Mutation-tested all four ways. Third assertion in this plan that could not fail for its stated reason. | — | `9ad9303` | Task 3 |
| 2026-07-31 | **Task 3.** `core-db` and `core-api` in Compose (`core-net`, no `ports:` on the database, pinned major, keepalive trio, `-h 127.0.0.1` healthcheck) plus the whole core-api image pipeline in `deploy.yml` — build, sha-named save, scp, load, both variables, and the `~/core-api.env` precondition. **Defect found and fixed first:** the must-fix pass had left `EPAPER_ENV_FILE=` twice on the `:86` line in two places; the earlier verifier checked only that it was PRESENT, never that it appeared once. `docker compose config --services` resolves all four services; `--quiet` clean; `deploy.yml` still valid YAML. 356 tests, 355 pass, 1 skip. | **3/30** | (this commit) | Task 4 |
| 2026-07-31 | **Task 4 — Part 1 complete.** `oom_score_adj: 500` on the three restartable app containers, and the operator runbook: `infra/README.md`'s two-secrets-files section, plus the root, hub and core-api READMEs. **Defect found and fixed first:** the must-fix pass had rewritten the `-` side of Task 4's `apps/core-api/README.md` diff as well as the `+` side, making it an instruction to replace a line with itself — the real edit would have been silently skipped. Wrote a no-op-diff scanner; it was the only one. `~/core-api.env` created on the Lightsail box (mode 600, 3 lines, owner password verified identical in both places). Area gate green: 64 tests. 358 total, 357 pass, 1 skip. | **4/30** | (this commit) | Task 5 |

**The ten must-fix defects are already fixed in the text below.** They are listed here because
each one is a thing that looked fine while being written and would have failed on contact, and
because a reader who finds one of these shapes elsewhere should treat it the same way:

1. **Every `git add` named the wrong plan filename** (`2026-07-29-…` for a file dated
   `2026-07-30-…`). `git add` on a missing pathspec exits 128 and stages **nothing** —
   reproduced — so 21 of these 30 tasks would have committed nothing at all.
2. Task 12 Step 1 forbade `--no-owner` anywhere in `restore-drill.sh` while Step 3 of the same
   task wrote it into two comments. The assertion is now scoped to the `pg_restore` line.
3. Both host scripts exported only `CORE_ENV_FILE`. Compose interpolates every `env_file` in the
   project at load time, so the nightly and the drill would have died before reaching Postgres —
   never writing `LAST_OK`, leaving the backup-health gate silent.
4. Task 14 appended a `docker compose` line to `infra/README.md` that violated the assertion
   Task 4 installs. Every task that appends to that file now re-runs the suite.
5. **The backup-health gate was mutually exclusive with its own design.** Part 3 specified a
   `CRON_INSTALLED_AT` bootstrap marker *because* `[ -f LAST_OK ]` makes the one failure worth
   catching — the nightly never having succeeded even once — green forever; Task 23 then shipped
   exactly that forbidden form, and nothing wrote the marker three other places told the operator
   to look for.
6. Task 18 added the `mkdir` that makes the legacy-config `mv` dead code, but never fixed the
   migration — so the same commit that added the `mkdir` made `rm -rf ~/epaper-emulator` delete
   the legacy config unmigrated.
7. Handoff (e) said "paste this one `test()` block at EOF" for assertions that belong to four
   different tasks' test blocks. It is now a fold-in table.
8. **The only irreversible command in this plan** (`docker volume rm`) was gated on
   `count(*) from schema_migrations` being `0` or `1` — but Plan 1 ships exactly one migration,
   so that is true on every deploy forever. The guard was inert. It now counts `companies` and
   checks the deploy history.
9. Four checks, including two Definition-of-Done gates, grepped for `set_real_ip_from\|real_ip_header`
   and expected `0` — matching `api.conf`'s own deliberate warning comment, so they could never
   pass on a healthy box.
10. Three `X-Forwarded-For` greps used single spaces against a column-aligned conf file, so they
    matched nothing and would have reported a broken client-IP chain on a correct box.

## Why this plan runs before Plans 2–4

The service has two routes. That is the point. Every deployment defect this plan shakes out
surfaces against a `/health` endpoint instead of against login, tenant CRUD and terminal pairing —
and Plan 1 has already shown that the defects which matter only appear when something is actually
executed. Seven were found that way while building the foundation, every one of which read as
"this task is broken" rather than "the order is wrong".

## What cannot be automated, and is not pretended to be

You cannot unit-test a deploy. This plan asserts deploy **configuration** by reading the files and
checking their text, which is the pattern `apps/epaper-hub/test/deploy-config.test.js` already
establishes in this repository. The checks that genuinely need the Lightsail host appear as
**MANUAL VERIFICATION** blocks with exact commands and exact expected output, run once at cutover:

- Create ~/core-api.env on the Lightsail box by hand, mode 600, with POSTGRES_PASSWORD, DATABASE_MIGRATION_URL and DATABASE_URL, as the deploy user - run `whoami` first and compare it to secrets.LIGHTSAIL_USER, because the file landing in the wrong home directory looks perfect and fails the deploy after the deploy directory has already been wiped.
- Point the DNS A record for api.yeyintlwin.com at the Lightsail instance and run `sudo certbot certonly --nginx -d api.yeyintlwin.com`; the deploy's `nginx -t` fails without the certificate.
- Confirm the deploy user has passwordless sudo for `install`, `nginx -t` and `systemctl reload nginx` - a password prompt hangs the ssh heredoc forever.
- Host prerequisites: 2 GB swap plus vm.swappiness=10, then record `free -m` and `docker stats` in infra/README.md.
- Validate the whole compose project on the box before the cutover push: `cd ~/restaurant-order-system && CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose config --quiet` (never a bare `docker compose config` - it prints both DSNs and POSTGRES_PASSWORD in cleartext).
- Watch the 90-second health gate on the cutover push and, on failure, read `docker compose logs core-api` - the migration runner prints file, digest and verdict.
- Verify the TLS chain end to end from the box: `curl -fsS -m 5 --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health`.
- Run the login-path routing probe and the limit_req burst by hand once, confirming 404-vs-429 (there is no login route until Plan 2), then wait a full minute before any further request from that address - the burst empties the core_login bucket.
- Prove the nginx rollback by deliberately installing a broken api.conf and confirming the deploy restores both files and leaves `nginx -t` passing; a normal deploy never reproduces this.
- Prove the concurrency key and the failure-proof crontab by deliberately creating their failure conditions: two overlapping pushes, and a run against a box with no crontab at all.
- Prove the backup guard bites by truncating a known-good dump with `head -c` and watching the verification reject it - stopping core-db only produces a zero-byte file, which `test -s` catches instead.
- After the first successful deploy, run `./config/backup-core-db.sh` by hand, then `./config/restore-drill.sh` with no argument, and confirm it exits 0, prints row counts, and drops core_restore_check. Do not skip it because it is the day everything worked.
- RESOLVED 2026-07-31: api.conf ships NO http2 token, so nothing is redefined. Originally: check for `protocol options redefined` in `sudo nginx -t` output - a `listen 443 ssl http2;` in conf.d/ changes the protocol for order.yeyintlwin.com and epaper-hub.yeyintlwin.com, which are parsed later from sites-enabled/.
- Confirm `~/restaurant-order-system.env` is untouched, and confirm `sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -E 'real_ip_header|set_real_ip_from|real_ip_recursive'` prints NONE.
- Deploy outside service hours: every push recreates epaper-hub and customer-order, resetting all twelve table displays to Welcome and dropping every in-memory order session, and Phase 1 lengthens that window by putting a migration in front of it.

## File ownership

Several files are touched by more than one part. Each has exactly one owner; the others hand their
requirements to the owner rather than editing in parallel. Ignoring this table is how two parts
produce a file that satisfies neither.

**`.github/workflows/deploy.yml`** — owned by *workflow*

CONTRACT CHANGE from the drafts. Exactly one other area may edit it: `compose`, and only in two of its tasks - (a) Task 1, the spec 9.0 five-file atomic commit, which changes the `:49` scp source path from `apps/epaper-hub/docker-compose.yml` to `docker-compose.yml`; (b) the task that adds the core-api service to docker-compose.yml, which must in the SAME commit add the whole core-api image pipeline (`docker build -f apps/core-api/Dockerfile -t core-api:${{ github.sha }} .`, `docker save … | gzip > /tmp/core-api-image-${{ github.sha }}.tgz`, the scp of that tarball, `docker load -i`, `CORE_API_IMAGE=`, `CORE_ENV_FILE=../core-api.env`, and the `test -f ~/core-api.env` precondition beside the existing `:71` guard). That is what keeps every intermediate commit deployable and closes the danger window the drafts left open. `nginx`, `backup` and `cutover` NEVER edit this file: each hands `workflow` a verbatim required-assertion list (nginx: the two scp lines, the two `install -m0644` lines, the snippet snapshot and the rollback branch; backup: the `mkdir -p ~/restaurant-order-system/config ~/backups && chmod 700`, the scp of both infra scripts into config/, the content-aware legacy config migration at `:72-74` — which must land in the SAME commit as the `mkdir`, because the `mkdir` is what makes the old `[ ! -d … ]` guard permanently false and hands the legacy config to `rm -rf` unmigrated — the backup-health block, the cron block and both `crontab -l | grep -q` proofs) which `workflow` implements and asserts. When `workflow` replaces `:86` with the `export` block it must preserve compose's two variables so `/CORE_API_IMAGE=core-api:\$\{\{ github\.sha \}\}/` and `/CORE_ENV_FILE=\.\.\/core-api\.env/` still match.

**`docker-compose.yml`** — owned by *compose*

Created by `git mv` from apps/epaper-hub/docker-compose.yml in Task 1 and grown only by compose-area tasks. No other area edits it. `cutover` reads it through apps/core-api/testing/compose.js; `workflow` reads it only in assertions.

**`apps/epaper-hub/test/deploy-config.test.js`** — owned by *compose*

CONTRACT CHANGE: only `compose` touches this file in Plan 5, and only in Task 1 - the repoRoot helper, lines 18/32, line 204's regex, the build-context assertions and the epaper-hub README assertion, all in the atomic commit. The `workflow` area's ten new deploy.yml assertions do NOT go here (the drafts had both areas appending); they go in apps/core-api/test/deploy-config.test.js. This makes the file's total deterministic at 14 and removes the 23-vs-24 miscount entirely.

**`apps/core-api/test/deploy-config.test.js`** — owned by *compose*

Created by `compose`, which writes the module header and the shared helpers (`readText` normalising CRLF, `composeText`, `servicesOf`, `workflowText`) and the first six tests. `workflow` appends top-level `test()` blocks at EOF only, one per deploy.yml task, re-reading the file inside each test body, and redeclares no helper. `nginx` and `backup` do NOT append here - they own their own suites and hand their deploy.yml assertions to `workflow`. `cutover` only reads.

**`apps/core-api/test/config.test.js`** — owned by *cutover*

DEDUPE: `compose` Task 6 and `cutover` Task 1 were the same edit. Delete it from `compose` entirely. `cutover` alone replaces the hand-copied COMPOSE_CORE_API_ENVIRONMENT_KEYS / COMPOSE_DEFAULTS literals at :368-408 with a parse via apps/core-api/testing/compose.js, and owns the resulting 25 -> 27 count. No other area touches this file.

**`apps/core-api/testing/compose.js`** — owned by *cutover*

Created by `cutover` (lives in testing/ because C13 restricts test/ to *.test.js). Any other area that needs to read the compose file structurally requires it read-only; nobody else edits it.

**`infra/README.md`** — owned by *cutover*

Append-only for everyone, one reserved `##` heading per area, never an edit to an existing line, and `cutover` runs last precisely so it can reconcile duplicate or now-false claims. Reserved headings: compose -> `## Core API runtime: two secrets files and core-net`; nginx -> `## Core API: Nginx for api.yeyintlwin.com`; backup -> `## core-db backups` (+ `### The restore drill`, `### Scenario A`, `### Scenario B`, `### Rotating database passwords`) and `## Before core-api's first production deploy`; cutover -> `## The client-IP chain`, `## Deploy window`, `## Cutover checklist`. `cutover` must NOT re-add its drafted `## core-api: the second secrets file` - that is compose's section; link to it.

**`apps/core-api/README.md`** — owned by *compose*

CONTRACT CHANGE: `compose` DOES edit it (the drafts declared it untouched). One doc-only fix in the secrets task - the create-platform-admin snippet at :132-136 must gain `EPAPER_ENV_FILE=../restaurant-order-system.env` beside `CORE_ENV_FILE`, or it cannot run. The 'Ships in a later plan of this phase' sentence stays. No other area edits this file; `cutover` links to its 'Rotating database passwords' section rather than duplicating it.

**`README.md`** — owned by *compose*

One sentence at line 126 (not 125): the single-env-file sentence becomes a two-file sentence naming ~/core-api.env and pointing at infra/README.md. No other area touches it.

**`apps/core-api/test/ci-contract.test.js`** — owned by *workflow*

Created by `workflow`'s CI-service task, three tests, no database. `cutover` does not create it (its finding correctly demanded it exist; `workflow` is where it lands) and refers to it only from the definition of done, quoting spec 12 BREAK 7 verbatim.

**`infra/nginx/api.conf`** — owned by *nginx*

Written and tested only by `nginx`. `workflow` adds the scp to /tmp and the `install -m0644 /tmp/api.conf /etc/nginx/conf.d/api.yeyintlwin.com.conf` line plus the snapshot/rollback, and asserts both as text; it never edits the conf file.

**`infra/nginx/core-api-proxy.conf`** — owned by *nginx*

Same as api.conf. `workflow` must also snapshot and restore THIS file on the nginx -t failure path (`cp -a /etc/nginx/snippets/core-api-proxy.conf /tmp/core-api-proxy.conf.bak`), which spec 9.5 omits; nginx hands that requirement to workflow rather than editing deploy.yml.

**`infra/backup-core-db.sh`** — owned by *backup*

Written, chmod'd (+x via `git add --chmod=+x`, since core.filemode=false on win32) and tested only by `backup`. `workflow` adds the scp into `config/` and the crontab line and asserts both as deploy.yml text.

**`infra/restore-drill.sh`** — owned by *backup*

PATH DECIDED: `infra/restore-drill.sh` in the repo, scp'd by `workflow` to `~/restaurant-order-system/config/restore-drill.sh` (the deploy's `find … ! -name config` spares that directory). Spec 9.7 writes it as `scripts/restore-drill.sh`; that path is superseded because it is a HOST script driving `docker compose`, which does not exist inside the image. `cutover`'s runbook and definition of done must use the config/ path, and `workflow` must add the scp line - without it the drill is never on the box.

**`.dockerignore`** — owned by *compose*

NO EDITS BY ANY AREA. `apps/*/.env` was added by Plan 1 Task 2 (75beae8) and is asserted by C12 in apps/core-api/test/source-structure.test.js:58. `compose` re-asserts it from the image side in the Dockerfile task only. Listed here so nobody re-adds a duplicate line.

**`.gitignore`** — owned by *compose*

NO EDITS BY ANY AREA. `apps/*/.env` is already line 2. Neither ~/core-api.env nor ~/restaurant-order-system.env is ever in the repository.

**`docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md`** — owned by *cutover*

The plan file itself. Every area ticks its own `- [ ]` checkboxes in the same commit as the task; only `cutover` writes the execution-log rows and the definition of done, and only its final MANUAL VERIFICATION task commits this file alone. Filename is now fixed - it follows the plan1 convention (`2026-07-29-core-api-phase1-plan1-foundation.md`), so no task may leave it as a guess.


## Accepted risks

Raised during review and deliberately not resolved here, each with the reason.

- Does `npm ci` work under `--prefix` with `--workspaces=false` on the first image build? Spec 9.3 sanctions falling back to `install --omit=dev --workspaces=false`. The compose area's Dockerfile task must build the image once locally before CI; if it falls back, the assertion changes with it and the reason goes in the execution log.
- Will the Lightsail box's installed Compose version accept `oom_score_adj`, `mem_limit`, `shm_size` and `stop_grace_period` as spec 9.1 writes them? `docker compose config --quiet` on the box is the only way to find out. A rejection is a cutover finding to record, not a licence to redesign the block.
- The sweep-expired crontab line is installed with no `apps/core-api/scripts/sweep-expired.js` behind it, so the 03:43 job logs `Cannot find module` into ~/backups/sweep.log nightly until Plan 2 ships the script. Shipped knowingly because the crontab is written once and `crontab -l | grep -q sweep-expired.js` is what stops AUDIT_RETENTION_DAYS configuring nothing. If that is unacceptable, defer BOTH the line and its grep - never only the grep.
- The `if: always()` artifact contains email addresses, IP addresses and scrypt hashes, readable by anyone with repo access, retained 14 days. Spec 9.5 accepts this for a private personal repo; nothing in Plan 5 changes it, and the upgrade path (a write-only bucket) stays open.
- Whether the CI postgres service container's superuser role (`postgres` on 5432) exposes behaviour differences from the developer's `core_api_owner` on 5433 across all 242 tests. The workflow area's local `core-ci-probe` step is the mitigation, but this is genuinely the first time those suites run under a maintenance role and something may surface only there.
- Whether `python`/PyYAML is present on the developer machine for the YAML parse step; if not, `npx --yes actionlint` is the fallback and needs network on first use. Confirm before the plan's first deploy.yml task rather than at cutover.
- Exactly which Compose version's `docker compose config --services` output the plan's `| sort` form was verified against on the box; only the win32 Docker Desktop behaviour was measured here.
- Whether `~/backups` should get its own retention gate independent of the 14-dump nightly trim and the new 14-dump pre-deploy trim, given the box's total disk and the 85% deploy gate. The two trims are specified; the headroom they leave has not been measured on the real instance.

---

## Part 1 — The compose move, the Dockerfile and the two secrets files

> **Read before the first task in this area.** These four tasks move the Compose file to the
> repository root, add `core-db` and `core-api` to it, and wire the core-api image into the deploy.
> **Every commit in this area leaves the repository deployable.** That is a deliberate property,
> not an accident: the task that declares `core-db` and `core-api` in Compose is the *same* commit
> that adds the `docker build` / `docker save` / `scp` / `docker load` / `CORE_API_IMAGE=` /
> `CORE_ENV_FILE=` pipeline to `.github/workflows/deploy.yml` and the `test -f ~/core-api.env`
> precondition beside the existing one at `:71`. Splitting them would leave a commit where every
> test is green and every deploy dies.
>
> **What a missing piece actually costs, stated correctly.** Compose fails at project *load*
> (an `env_file` it cannot resolve) or at image *pull* (a tag that is not on the box) — **before**
> it recreates anything. `epaper-hub` and `customer-order` keep running. The damage is subtler and
> worse to sit in: (a) production is frozen on the previous sha with a red CI, and (b) the box now
> holds a `docker-compose.yml` that **no** compose subcommand can load — not `up`, not `config`,
> not `exec` — so the operator's ssh-and-restart reflex is dead until `~/core-api.env` exists.
> The `test -f ~/core-api.env` guard is what turns that into a red deploy with a message instead.
>
> **Ordering inside the area is load-bearing.** The Dockerfile task comes *before* the Compose task
> because the Compose task's commit adds `docker build -f apps/core-api/Dockerfile …` to CI.
>
> **Out of scope, stated plainly.** `scripts/create-platform-admin.js` (spec §9.10) is **Plan 2** —
> it needs the `users` table, `lib/password.js` and an audit writer, none of which exist. Where the
> runbook references it, it says so. The migration-runner contract (spec §9.4) is **already
> implemented** in Plan 1's `apps/core-api/db/migrate.js`, and **the deploy does not invoke it** —
> `server.js` migrates at startup on a dedicated owner connection, closes that pool, then opens the
> runtime pool and listens, so a deploy step running `npm --prefix apps/core-api run migrate` would
> be a second runner racing the first for the same advisory lock. No task in this plan adds one.
> Local development (spec §9.9) is already done in `apps/core-api/README.md`; nothing here changes
> it.
>
> **Files this area does not own.** `.github/workflows/deploy.yml` belongs to the `workflow` area;
> this area makes exactly the two edits sanctioned in the file-ownership table and nothing else.
> `apps/core-api/test/config.test.js` and `apps/core-api/testing/compose.js` belong to `cutover`.
> `.dockerignore` and `.gitignore` are **already correct** and are edited by nobody.

---

### Task 1: Move the Compose file to the repository root

Spec §9.0. The settled text names two files; there are five, and the *test* is what breaks first.
The build context is the trap: a relative `build:` context resolves against the **compose file's**
directory, so moving the file silently repoints `.` from `apps/epaper-hub` to the repo root.
Production never notices (`--no-build`) and `docker compose config` still prints ok — but
`apps/epaper-hub/Dockerfile` copies `package*.json` at `:5` and `server.js` at `:8` relative to its
own directory, so a rooted context would copy the workspace `package.json` and then fail on
`COPY server.js`. `deploy-config.test.js:214` already pins the CI image build away from a root
context; this task pins the compose build the same way.

`apps/epaper-hub/README.md:26` is listed in the spec table **because no test covers that line.**
After this task one does.

**Files:**
- Move: `apps/epaper-hub/docker-compose.yml` → `docker-compose.yml` (repo root, via `git mv`)
- Modify: `.github/workflows/deploy.yml:49` (the `scp` source path — the first of this area's two sanctioned edits to that file)
- Modify: `apps/epaper-hub/README.md:20-27` (the `## Docker` block)
- Test: `apps/epaper-hub/test/deploy-config.test.js` (rewrite `:18`, `:32`, `:204`; append one test)

- [x] **Step 1: Write the failing test**

In `apps/epaper-hub/test/deploy-config.test.js`, insert this helper immediately after the
`const repoRoot = …` line at `:7`:

```js
// Spec 9.0: docker-compose.yml moved to the repository root. Reads normalise CRLF --
// this machine is win32, CI is ubuntu, and .gitattributes deliberately pins only
// *.sql and *.sh, so a `$`-anchored regex over raw bytes passes on one and fails on
// the other for reasons that have nothing to do with the rule being asserted.
function readCompose() {
  return fs
    .readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8")
    .replace(/\r\n/g, "\n");
}
```

Replace line `:18` (inside `"Docker Compose exposes app only on localhost for Nginx proxy"`):

```js
  const compose = readCompose();
```

and append these three assertions to the end of that same test, after
`assert.doesNotMatch(compose, /caddy:/);`:

```js
  // NOT `build: .`. A relative context resolves against the COMPOSE FILE's directory,
  // so this file's move to the repo root would silently repoint `.` at the root --
  // which copies the workspace package.json and then dies on `COPY server.js`.
  // `docker compose config` still prints ok, so nothing but this line catches it.
  assert.match(compose, /^    build:\n      context: apps\/epaper-hub$/m);
  assert.doesNotMatch(compose, /^\s+build: \.$/m);
  assert.doesNotMatch(compose, /^\s+context: \.$/m);
```

Replace line `:32` (inside `"Docker Compose starts customer ordering after a healthy e-paper hub"`):

```js
  const compose = readCompose();
```

Replace line `:204` (inside `"GitHub Actions deploys from GitHub-hosted runner over SSH"`):

```js
  // `\S+` for the key, then the SOURCE argument, then the opening quote of the
  // destination. NOT `[^\n]*docker-compose\.yml`: that is greedy and the source and
  // destination end in the same basename, so it matches on the DESTINATION alone and
  // stays green when the source is repointed at another file or dropped entirely.
  // Verified by mutation -- source -> infra/docker-compose.yml, -> README.md, and
  // source deleted all pass the loose form and fail this one.
  assert.match(workflow, /scp -i \S+ docker-compose\.yml "/);
  assert.doesNotMatch(workflow, /apps\/epaper-hub\/docker-compose\.yml/);
```

> **CORRECTED 2026-07-31, after Task 1 shipped.** The assertion above originally read
> `assert.match(workflow, /scp -i [^\n]*docker-compose\.yml/)`. An adversarial review of the
> commit proved it never pinned the scp *source*: `[^\n]*` is greedy and both ends of the line
> finish in `docker-compose.yml`, so the match landed on the destination. Repointing the source
> at `infra/docker-compose.yml`, at `README.md`, or deleting it outright all left the pair green.
> This is the **third** assertion in this plan that could not fail for the reason it was written
> for — after must-fix #2 (`--no-owner`) and Task 2 (`pg-native`). Two of the three were caught
> only by executing or mutating them, not by reading them.

Append this new test to the end of the file:

```js
test("the e-paper hub runbook builds from the repository root, where the compose file now lives", () => {
  // Spec 9.0 lists apps/epaper-hub/README.md:26 explicitly BECAUSE no test covered
  // it. This is that test.
  const hubReadme = fs
    .readFileSync(path.join(repoRoot, "apps", "epaper-hub", "README.md"), "utf8")
    .replace(/\r\n/g, "\n");

  // Deliberately not `$`-anchored: a later task in this plan appends the two service
  // names to this line, and that refinement must not turn this assertion red.
  assert.match(hubReadme, /^ {2}docker compose up -d --build/m);
  assert.doesNotMatch(hubReadme, /docker compose -f apps\/epaper-hub\/docker-compose\.yml/);
  assert.match(hubReadme, /docker-compose\.yml` lives at the repository root/);
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/epaper-hub/test/deploy-config.test.js`

Expected: FAIL, 4 of 14. `Docker Compose exposes app only on localhost for Nginx proxy` and
`Docker Compose starts customer ordering after a healthy e-paper hub` both die with
`Error: ENOENT: no such file or directory, open 'C:\Users\hwckv\OneDrive\Desktop\yeyintlwin\yeyintlwin-dev\restaurant-order-system\docker-compose.yml'`;
`GitHub Actions deploys from GitHub-hosted runner over SSH` fails with
`AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /apps\/epaper-hub\/docker-compose\.yml/`;
`the e-paper hub runbook builds from the repository root, where the compose file now lives`
fails with `The input did not match the regular expression /^ {2}docker compose up -d --build/m`.

- [x] **Step 3: Write the minimal implementation**

Move the file with Git so the history follows it. **Bash tool** (`git mv` is fine in either shell,
but keep the whole area in one shell):

```bash
git mv apps/epaper-hub/docker-compose.yml docker-compose.yml
```

Then rewrite `docker-compose.yml` (repo root) in full — the only change to its contents is the
`build:` block:

```yaml
services:
  epaper-hub:
    image: ${EPAPER_IMAGE:-epaper-hub}
    # NOT `build: .`. A relative build context resolves against the directory of THIS
    # file, which is now the repository root; apps/epaper-hub/Dockerfile copies
    # package*.json and server.js relative to its own directory, so a rooted context
    # would copy the workspace package.json and then fail on `COPY server.js`.
    # Production is unaffected (--no-build) and `docker compose config` still prints
    # ok, so only the test above sees this.
    build:
      context: apps/epaper-hub
    container_name: epaper-hub
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    env_file:
      - ${EPAPER_ENV_FILE:-.env}
    environment:
      SCREEN_STORE_FILE: /data/screens.json
    volumes:
      - epaper-data:/data
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5

  customer-order:
    image: ${CUSTOMER_ORDER_IMAGE:-customer-order}
    container_name: customer-order
    restart: unless-stopped
    ports:
      - "127.0.0.1:3100:3100"
    env_file:
      - ${EPAPER_ENV_FILE:-.env}
    environment:
      PORT: 3100
      EPAPER_HUB_URL: http://epaper-hub:3000
      ORDER_BASE_URL: https://order.yeyintlwin.com
      BUSINESS_TIME_ZONE: Asia/Tokyo
      BUSINESS_DAY_ROLLOVER_HOUR: 6
    depends_on:
      epaper-hub:
        condition: service_healthy

volumes:
  epaper-data:
```

In `.github/workflows/deploy.yml`, replace line `49`:

```diff
-          scp -i ~/.ssh/lightsail.pem apps/epaper-hub/docker-compose.yml "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:~/restaurant-order-system/docker-compose.yml"
+          scp -i ~/.ssh/lightsail.pem docker-compose.yml "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:~/restaurant-order-system/docker-compose.yml"
```

In `apps/epaper-hub/README.md`, replace the `## Docker` block at lines `20-27`:

```diff
 ## Docker
 
+`docker-compose.yml` lives at the repository root, not in this folder. Run Compose from the root.
+
 ```bash
 cd ../..
 docker build -f apps/customer-order/Dockerfile -t customer-order .
 EPAPER_ENV_FILE=/path/to/restaurant-order-system.env \
-  docker compose -f apps/epaper-hub/docker-compose.yml up -d --build
+  docker compose up -d --build
 ```
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/epaper-hub/test/deploy-config.test.js`  Expected: PASS (14 tests)

Then confirm nothing else in the repository still points at the old path. **Bash tool** — this is a
`git grep` with pathspec exclusions, which PowerShell parses differently:

```bash
git grep -n "apps/epaper-hub/docker-compose.yml" -- ':!.worktrees' ':!.superpowers' ':!docs/superpowers'
```

Expected output: nothing, exit status 1.

Optional, only if Docker Desktop is running — this is the check that would have caught a rooted
context, and `docker compose config` alone would not. **Bash tool:**

```bash
docker compose config | grep -A1 "^    build:"
```

Expected: a `context:` line ending in `apps\epaper-hub` (absolute path), **not** the repository root.

- [x] **Step 5: Commit**

```bash
git add docker-compose.yml .github/workflows/deploy.yml apps/epaper-hub/README.md apps/epaper-hub/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "build: move docker-compose.yml to the repo root, pinning the epaper-hub build context"
```

---

### Task 2: Write `apps/core-api/Dockerfile`

Spec §9.3. This comes **before** the Compose task because that task's commit adds
`docker build -f apps/core-api/Dockerfile …` to CI — reversing the order gives one commit where
every push to `main` fails at the build step.

Built from the **repo root** with an explicit `-f`, the same as `apps/customer-order/Dockerfile` —
same base image, same `--prefix … --workspaces=false` idiom, same `ENV`/`EXPOSE`/array-`CMD` shape.

**DEPARTURE from customer-order: `npm ci`, not `install`.** customer-order uses `install`
(`Dockerfile:8-9`) despite having a lockfile; `core-api` is the first app in this repository with a
real dependency tree, so `ci` failing loudly on a stale lockfile is the behaviour you want in a
release build. If `ci` misbehaves under `--prefix` on the first build, fall back to
`install --omit=dev --workspaces=false`, change the assertion to match, and record the reason in
the plan's execution log — spec §9.3 sanctions exactly that fallback.

`scripts/` must be in the image — `create-platform-admin.js` (Plan 2), `unlock-account.js` and
`set-password.js` all run via `docker compose exec`. `COPY apps/core-api` carries them, so nothing
extra is needed; the assertion below is what stops a later "optimisation" from copying only
`server.js` and the lib directories.

**`.dockerignore` already carries the `apps/*/.env` line** — it was added by Plan 1 Task 2 (commit
`75beae8`) and is asserted by C12 in `apps/core-api/test/source-structure.test.js:58`. This task
does **not** re-add it. It asserts it a second time, from the image side, because the core-api
build context being the repository root is precisely what makes that line load-bearing: without
it, a developer's `apps/core-api/.env` — now holding `DATABASE_URL` — would be baked into the
production image.

This task also **creates `apps/core-api/test/deploy-config.test.js`** with its module header and
the four shared helpers. That file is the Plan 5 deploy-assertion suite: the `workflow` area
appends top-level `test()` blocks at its end, one per `deploy.yml` task, re-reading the file inside
each test body and redeclaring none of these helpers. It is database-free, so it runs directly
under `node --test` with no `pretest`.

> **DEFECT FOUND ON EXECUTION 2026-07-31, fixed in the text below.** As first written, Step 1
> asserted `assert.doesNotMatch(dockerfile, /pg-native/)` while Step 3's Dockerfile carried the
> comment *"pg-native is never installed: it needs libpq and a C toolchain"* — so the task's own
> implementation failed its own assertion, and Step 4 could never reach PASS. This is the **same
> shape** as must-fix #2 from this plan's review (Task 12 forbidding `--no-owner` anywhere while
> its own comments said it): a rule about what the file *does* written as a rule about what the
> file *says*. The assertion is now scoped to instruction lines. Verified by mutation — with the
> comment present it passes, and appending a real `RUN npm --prefix apps/core-api install
> pg-native` still turns it red, so the narrowing did not weaken it.
>
> **When you write a `doesNotMatch` over a file that also documents itself, scope it to the lines
> that execute.** That is now twice in one plan.

**Files:**
- Create: `apps/core-api/Dockerfile`
- Create: `apps/core-api/test/deploy-config.test.js`

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/deploy-config.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// --- shared helpers ---------------------------------------------------------
// This file is the Plan 5 deploy-assertion suite. The workflow area appends its own
// top-level test() blocks BELOW, re-reading the files inside each test body and
// redeclaring none of these four helpers.
//
// Every read normalises CRLF. The developer machine is win32 and the CI runner is
// ubuntu, and .gitattributes deliberately pins only *.sql and *.sh, so a
// `$`-anchored regex against raw bytes passes on one and fails on the other for
// reasons that have nothing to do with the rule being asserted.
function readText(...segments) {
  return fs.readFileSync(path.join(...segments), "utf8").replace(/\r\n/g, "\n");
}

function composeText() {
  return readText(repoRoot, "docker-compose.yml");
}

function workflowText() {
  return readText(repoRoot, ".github", "workflows", "deploy.yml");
}

// Split the compose text into { serviceName: bodyText }. A regex over the whole file
// cannot tell "epaper-hub does NOT list CORE_ENV_FILE" from "the string appears
// somewhere in the file", and that difference is the entire point of spec 9.2.
function servicesOf(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("services:");
  assert.ok(start >= 0, "docker-compose.yml has no services: block");

  const bodies = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;                       // next top-level key
    const header = line.match(/^  ([a-z][a-z0-9-]*):\s*$/);
    if (header) {
      current = header[1];
      bodies[current] = [];
      continue;
    }
    if (current) bodies[current].push(line);
  }
  return Object.fromEntries(
    Object.entries(bodies).map(([name, body]) => [name, body.join("\n")])
  );
}

test("the core-api image installs from its own lockfile and ships its scripts", () => {
  const dockerfile = readText(appRoot, "Dockerfile");

  assert.match(dockerfile, /^FROM node:20-alpine$/m);
  assert.match(dockerfile, /^WORKDIR \/app$/m);

  // Built from the REPOSITORY ROOT with an explicit -f, exactly like customer-order.
  // This single COPY also carries scripts/, which create-platform-admin.js (Plan 2),
  // unlock-account.js and set-password.js need at `docker compose exec` time.
  assert.match(dockerfile, /^COPY apps\/core-api \.\/apps\/core-api$/m);
  assert.doesNotMatch(dockerfile, /^COPY apps\/core-api\/server\.js/m);

  // `ci`, not `install`: core-api is the first app here with a real dependency tree,
  // and failing loudly on a stale lockfile is what a release build should do.
  assert.match(dockerfile, /npm --prefix apps\/core-api ci --omit=dev --workspaces=false/);
  // npm ci cannot run without it.
  assert.ok(fs.existsSync(path.join(appRoot, "package-lock.json")), "apps/core-api/package-lock.json");

  assert.match(dockerfile, /^ENV NODE_ENV=production PORT=3200 HOST=0\.0\.0\.0 TZ=UTC$/m);
  assert.match(dockerfile, /^EXPOSE 3200$/m);
  assert.match(dockerfile, /^CMD \["node", "apps\/core-api\/server\.js"\]$/m);

  // pg-native needs libpq plus a C toolchain and fails instantly on the win32 dev
  // machine; the pure-JS driver is the only supported one. Scoped to INSTRUCTION
  // lines: the comment above the RUN names pg-native deliberately, to say why it is
  // absent, and a bare /pg-native/ would forbid the Dockerfile from explaining
  // itself -- the same defect the Plan 5 review found in Task 12's --no-owner rule.
  const instructions = dockerfile
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(instructions, /pg-native/);

  // The build context is the repository ROOT, which is what makes this line
  // load-bearing: without it a developer's apps/core-api/.env -- now holding
  // DATABASE_URL -- is baked into the production image. Added by Plan 1 Task 2 and
  // also asserted by C12; re-asserted here because this image is what it protects.
  const dockerignore = readText(repoRoot, ".dockerignore");
  assert.match(dockerignore, /^apps\/\*\/\.env$/m);
  assert.match(dockerignore, /^node_modules$/m);
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/deploy-config.test.js`

Expected: FAIL (1 test) with
`Error: ENOENT: no such file or directory, open 'C:\Users\hwckv\OneDrive\Desktop\yeyintlwin\yeyintlwin-dev\restaurant-order-system\apps\core-api\Dockerfile'`.

- [x] **Step 3: Write the minimal implementation**

Create `apps/core-api/Dockerfile`:

```dockerfile
# Built from the REPOSITORY ROOT with an explicit -f, the same as
# apps/customer-order/Dockerfile:
#
#   docker build -f apps/core-api/Dockerfile -t core-api:$SHA .
#
# A root context is also what makes .dockerignore's `apps/*/.env` line load-bearing:
# without it a developer's apps/core-api/.env -- which now holds DATABASE_URL -- is
# baked into the production image.
FROM node:20-alpine

WORKDIR /app

# One COPY, deliberately: it carries scripts/ as well as the source, and
# create-platform-admin.js (Plan 2), unlock-account.js and set-password.js all run
# through `docker compose exec` against this image.
COPY apps/core-api ./apps/core-api

# `ci`, not `install`. customer-order uses `install` despite having a lockfile;
# core-api is the first app here with a real dependency tree, so failing loudly on a
# stale lockfile is the behaviour a release build should have. --workspaces=false
# because the root package.json is not in this image and npm must not go looking for
# it. pg-native is never installed: it needs libpq and a C toolchain.
RUN npm --prefix apps/core-api ci --omit=dev --workspaces=false

# HOST=0.0.0.0 is correct INSIDE a container -- 127.0.0.1 there is unreachable from
# docker-proxy and the compose network. Confinement to loopback is the Compose port
# mapping's job (127.0.0.1:3200:3200), not this process's.
ENV NODE_ENV=production PORT=3200 HOST=0.0.0.0 TZ=UTC

EXPOSE 3200

CMD ["node", "apps/core-api/server.js"]
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: PASS (1 test)

Then, if Docker Desktop is running, build it once locally — this is the step that would surface an
`npm ci` problem under `--prefix` before CI does. **Bash tool:**

```bash
docker build -f apps/core-api/Dockerfile -t core-api:local .
```

Expected: the build completes, and the `RUN npm --prefix apps/core-api ci …` layer prints
`added <N> packages` with no `npm error`. Then confirm the scripts and the lockfile-installed
driver are both in the image. **Bash tool:**

```bash
docker run --rm core-api:local sh -c "ls apps/core-api/scripts && node -e \"require('/app/apps/core-api/node_modules/pg'); console.log('pg ok')\""
```

Expected output: `reset-database.js`, `setup-template-db.js`, then `pg ok`.

If `npm ci` fails under `--prefix`, change that one line to
`npm --prefix apps/core-api install --omit=dev --workspaces=false`, change the assertion to match,
and record the fallback in the plan's execution log.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/Dockerfile apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "feat(core-api): production Dockerfile built from the repo root with npm ci"
```

---

### Task 3: Declare `core-db` and `core-api` in Compose and wire the core-api image pipeline

Spec §9.1, §9.2 and the compose half of §9.5. **This is one task on purpose.** The moment
`core-db` appears with `env_file: ${CORE_ENV_FILE:-.env}`, the Compose file on the box cannot be
loaded unless the deploy exports `CORE_ENV_FILE` and `~/core-api.env` exists; the moment `core-api`
appears, it also needs `CORE_API_IMAGE` and a loaded image. Splitting any of that across commits
produces a repository whose tests are green and whose deploy is dead. So this commit carries all of
it: the two services, the build, the save, the scp, the load, both variables, and the precondition.

Four of `core-db`'s values exist only because of a specific failure: the **pinned major** (an
unpinned tag eventually pulls 17, which refuses to start against a `PGDATA` written by 16 and
presents as a total outage at 22:00), the **`-h 127.0.0.1` healthcheck** (during `initdb` the
entrypoint runs a temporary server on the unix socket only, so a socket `pg_isready` reports
healthy while TCP is still refused and Compose starts `core-api` against nothing), the
**`tcp_keepalives` trio** (the default idle is 2 *hours*, so a SIGKILLed `core-api` holding the
migration advisory lock would block every deploy for that long — 20 + 5×3 ≈ 35 s sits comfortably
inside `db/migrate.js`'s 60 s bounded retry), and the **absence of any `ports:` key**.

`core-api`'s container healthcheck calls **`/health`, not `/health/ready`** — nothing `depends_on`
core-api, so an unhealthy mark would restart nothing, and a transient database blip should not
produce a misleading container status. The *deploy gate* is what calls `/health/ready`.
`HOST: 0.0.0.0` is deliberate and is an explicit correction to the earlier
"HOST=127.0.0.1 whenever NODE_ENV=production" rule (§9.12): a process bound to `127.0.0.1`
**inside** a container is unreachable from docker-proxy and from the Compose network, so that rule
implemented literally yields a service that answers nothing. The "not exposed past Nginx" property
is delivered by the `127.0.0.1:3200:3200` mapping instead — the layer that can actually see the
thing being guarded, exactly as `infra/README.md:14` already describes for 3000 and 3100.

The third test in this task is the **reconciliation** assertion: it enumerates the services Compose
declares and, for each, proves the deploy sets the variable its `image:` and its `env_file:`
interpolate — and, for sha-tagged images, that a matching `docker load -i` exists. It goes red the
instant Compose declares a service the deploy cannot start.

**What this task does NOT add to `deploy.yml`** — all of it belongs to the `workflow` area:
the `concurrency` key, the Postgres CI service and the two core-api npm steps, the `export` block
that replaces `:86`, `docker volume create restaurant-order-system_core-db-data`, the migration
invocation, the pre-deploy dump, the nginx install/rollback, the health gate, the XFF and
`limit_req` probes, the backup-health block and the crontab.

**Files:**
- Modify: `docker-compose.yml` (top-level `networks:`, the `core-db` and `core-api` services, the `core-db-data` volume)
- Modify: `.github/workflows/deploy.yml` (`:33`, `:35`, `:51`, `:71`, `:77`, `:86`, `:88` — the second and last sanctioned edit from this area)
- Test: `apps/core-api/test/deploy-config.test.js` (append three tests)

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/deploy-config.test.js`:

```js
test("core-db is pinned to a major, publishes no host port, and reaps an orphaned advisory lock", () => {
  const text = composeText();

  assert.match(text, /^networks:\n  core-net:$/m);
  assert.match(text, /^  core-db:$/m);

  // An unpinned tag eventually pulls 17, which refuses to start against a PGDATA
  // written by 16 and presents as a total outage at 22:00.
  assert.match(text, /^    image: postgres:16-alpine$/m);
  assert.match(text, /^    container_name: core-db$/m);

  // NO `ports:` key at all -- not a loopback-only publish, which differs from a
  // public one by a single deletion. Docker installs published ports as DNAT rules
  // evaluated before ufw's filter chains, so a published port bypasses ufw. Nothing
  // needs one: core-api uses core-net, psql and pg_dump go through
  // `docker compose exec`. Asserting the string is absent from the WHOLE file is
  // stronger than asserting no mapping, and deliberately so.
  assert.doesNotMatch(text, /5432/);

  assert.match(text, /^      POSTGRES_USER: core_api_owner$/m);
  assert.match(text, /^      POSTGRES_DB: core$/m);
  assert.match(text, /^      POSTGRES_INITDB_ARGS: "--data-checksums --encoding=UTF8"$/m);
  assert.match(text, /^      PGDATA: \/var\/lib\/postgresql\/data\/pgdata$/m);

  assert.match(text, /max_connections=40/);
  assert.match(text, /shared_buffers=128MB/);
  assert.match(text, /effective_cache_size=384MB/);
  assert.match(text, /work_mem=4MB/);
  assert.match(text, /maintenance_work_mem=64MB/);
  // Phase 1's largest table holds a few dozen rows; each parallel worker is a memory
  // spike, and the OOM killer is the named top risk on this box.
  assert.match(text, /max_parallel_workers_per_gather=0/);
  assert.match(text, /timezone=UTC/);

  // The default keepalive idle is 2 HOURS, so a SIGKILLed core-api holding the
  // migration lock blocks every deploy for that long. 20 + 5*3 = ~35 s, inside the
  // runner's 60 s bounded retry.
  assert.match(text, /tcp_keepalives_idle=20/);
  assert.match(text, /tcp_keepalives_interval=5/);
  assert.match(text, /tcp_keepalives_count=3/);

  // -h 127.0.0.1 IS LOAD-BEARING: during initdb the entrypoint runs a temporary
  // server on the unix socket ONLY, so a socket pg_isready reports healthy while TCP
  // is still refused and compose starts core-api against nothing.
  assert.match(text, /pg_isready -U core_api_owner -d core -h 127\.0\.0\.1 \|\| exit 1/);
  assert.match(text, /^      start_period: 30s$/m);

  assert.match(text, /^    stop_grace_period: 60s$/m);  // checkpoint instead of SIGKILL at 10 s
  assert.match(text, /^    shm_size: 128mb$/m);
  assert.match(text, /^    oom_score_adj: -500$/m);     // bias the kernel AWAY from the data

  assert.match(text, /core-db-data:\/var\/lib\/postgresql\/data/);
  assert.match(text, /^volumes:\n  epaper-data:\n  core-db-data:$/m);
});

test("core-api joins both networks, publishes only on loopback, and health-checks /health", () => {
  const text = composeText();

  assert.match(text, /^  core-api:$/m);
  assert.match(text, /^    image: \$\{CORE_API_IMAGE:-core-api\}$/m);
  assert.match(text, /^    container_name: core-api$/m);
  assert.match(text, /^    networks: \[core-net, default\]$/m);

  // The "not exposed past Nginx" property lives HERE, not in HOST: a process bound
  // to 127.0.0.1 inside a container is unreachable from docker-proxy and the compose
  // network, so HOST must be 0.0.0.0 and the mapping is what confines it.
  assert.match(text, /127\.0\.0\.1:3200:3200/);
  assert.match(text, /^      HOST: 0\.0\.0\.0$/m);

  assert.match(text, /^      PORT: 3200$/m);
  assert.match(text, /^      API_PUBLIC_ORIGIN: https:\/\/api\.yeyintlwin\.com$/m);
  assert.match(text, /^      TERMINAL_ALLOWED_ORIGINS: ""$/m);   // Phase 1: no CORS headers at all
  assert.match(text, /^      TRUSTED_PROXY_HOPS: 1$/m);
  assert.match(text, /^      SESSION_IDLE_SECONDS: 28800$/m);
  assert.match(text, /^      SESSION_ABSOLUTE_SECONDS: 604800$/m);
  assert.match(text, /^      SCRYPT_SLOTS: 2$/m);
  assert.match(text, /^      DB_POOL_MAX: 8$/m);

  assert.match(text, /depends_on:\n      core-db:\n        condition: service_healthy/);

  // /health, NOT /health/ready. Nothing depends_on core-api, so an unhealthy mark
  // would restart nothing, and a transient DB blip should not produce a misleading
  // container status. The DEPLOY GATE is what calls /health/ready.
  assert.match(text, /wget --no-verbose --tries=1 --spider http:\/\/localhost:3200\/health \|\| exit 1/);
  assert.doesNotMatch(text, /localhost:3200\/health\/ready/);
  assert.match(text, /^      start_period: 60s$/m);

  assert.match(text, /^    mem_limit: 512m$/m);
});

test("every service the compose file declares is one the deploy can actually start", () => {
  // Collapse the Actions expression first: `EPAPER_IMAGE=epaper-hub:${{ github.sha }}`
  // carries two spaces of its own, so whitespace tokenisation is wrong without this.
  const flat = workflowText().replace(/\$\{\{ github\.sha \}\}/g, "SHA");
  const services = servicesOf(composeText());

  assert.deepEqual(
    Object.keys(services).sort(),
    ["core-api", "core-db", "customer-order", "epaper-hub"]
  );

  for (const [name, body] of Object.entries(services)) {
    // Every service interpolates its env_file, and the deploy must export that
    // variable -- Compose validates EVERY service's env_file on EVERY subcommand, so
    // one unresolvable path makes `up`, `config` and `exec` all fail at project load.
    const envFileVar = body.match(/^    env_file:\n      - \$\{([A-Z_]+):-\.env\}$/m);
    assert.ok(envFileVar, `${name}: no interpolated env_file`);
    assert.match(flat, new RegExp(`${envFileVar[1]}=\\.\\./[a-z-]+\\.env`), `${name} env_file`);

    // Only the three built services interpolate an image; core-db pins a literal tag.
    const imageVar = body.match(/^    image: \$\{([A-Z_]+):-/m);
    if (!imageVar) {
      assert.match(body, /^    image: postgres:16-alpine$/m, name);
      continue;
    }
    const assignment = flat.match(new RegExp(`${imageVar[1]}=(\\S+)`));
    assert.ok(assignment, `${name}: deploy.yml never sets ${imageVar[1]}`);
    if (assignment[1].endsWith(":SHA")) {
      // A sha-tagged image exists on the box only because the deploy put it there:
      // there is no registry in this pipeline, so `up` would fail at image PULL.
      const imageName = assignment[1].slice(0, -":SHA".length);
      assert.match(flat, new RegExp(`docker build [^\\n]*-t ${imageName}:SHA`), name);
      assert.match(flat, new RegExp(`docker load -i /tmp/[^\\n]*${imageName}[^\\n]*\\.tgz`), name);
    }
  }

  // The two env paths must never collapse into one another.
  assert.match(flat, /CORE_ENV_FILE=\.\.\/core-api\.env/);
  assert.match(flat, /EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env/);
  assert.doesNotMatch(flat, /CORE_ENV_FILE=\.\.\/restaurant-order-system\.env/);
  assert.doesNotMatch(flat, /EPAPER_ENV_FILE=\.\.\/core-api\.env/);

  // Both files live OUTSIDE the deploy folder, which :84 wipes on every push.
  assert.match(flat, /find ~\/restaurant-order-system -mindepth 1 -maxdepth 1/);

  // The precondition beside the existing one. Without it a missing ~/core-api.env
  // leaves a compose file on the box that NO subcommand can load -- up, config and
  // exec all die at project load -- so the ssh-and-restart reflex is dead too.
  assert.match(flat, /test -f ~\/restaurant-order-system\.env/);
  assert.match(flat, /test -f ~\/core-api\.env \|\| \{ echo 'MISSING ~\/core-api\.env/);

  // The runner's /tmp is not swept between jobs and the box's certainly is not.
  // Deliberately loose: the workflow area may fold these into /tmp/*-image*.tgz.
  assert.match(flat, /rm -f \/tmp\/[^\n]*image[^\n]*\.tgz/);
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/deploy-config.test.js`

Expected: FAIL, 3 of 4.
`core-db is pinned to a major, publishes no host port, and reaps an orphaned advisory lock` fails
with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^networks:\n  core-net:$/m`;
`core-api joins both networks, publishes only on loopback, and health-checks /health` fails with
`The input did not match the regular expression /^  core-api:$/m`;
`every service the compose file declares is one the deploy can actually start` fails with
`AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` and the actual value
`[ 'customer-order', 'epaper-hub' ]`.

- [x] **Step 3: Write the minimal implementation**

Rewrite `docker-compose.yml` (repo root) in full:

```yaml
# The repository-root Compose file (spec 9.0). .github/workflows/deploy.yml copies it
# to ~/restaurant-order-system/docker-compose.yml on every push.
networks:
  core-net:

services:
  core-db:
    # Pinned to a MAJOR: an unpinned tag eventually pulls 17, which refuses to start
    # against a PGDATA written by 16 and presents as a total outage at 22:00.
    image: postgres:16-alpine
    container_name: core-db
    restart: unless-stopped
    # NOT on the default network (spec 9.2). epaper-hub is internet-facing and
    # authenticates on req.query.api_key; core_api_owner reachable from it is
    # `COPY ... TO PROGRAM`, i.e. a shell inside this container.
    networks: [core-net]
    # NO `ports:` KEY AT ALL -- not even a loopback-only publish, which differs from a
    # public one by a single deletion. Docker installs published ports as DNAT rules
    # in the nat table, evaluated BEFORE ufw's filter chains, so a published port
    # bypasses ufw. Nothing needs one: core-api reaches this over core-net, and
    # psql/pg_dump go through `docker compose exec`.
    env_file:
      - ${CORE_ENV_FILE:-.env}
    environment:
      POSTGRES_USER: core_api_owner
      POSTGRES_DB: core
      POSTGRES_INITDB_ARGS: "--data-checksums --encoding=UTF8"
      PGDATA: /var/lib/postgresql/data/pgdata
      TZ: UTC
    command:
      - postgres
      - -c
      - max_connections=40
      - -c
      - shared_buffers=128MB
      - -c
      - effective_cache_size=384MB
      - -c
      - work_mem=4MB
      - -c
      - maintenance_work_mem=64MB
      # Phase 1's largest table holds a few dozen rows; each parallel worker is a
      # memory spike, and the OOM killer is the named top risk on this box.
      - -c
      - max_parallel_workers_per_gather=0
      - -c
      - timezone=UTC
      # ADVISORY-LOCK ORPHAN FIX: the default keepalive idle is 2 hours, so a
      # SIGKILLed core-api holding the migration lock blocks every deploy for that
      # long. 20 + 5*3 = ~35 s, comfortably inside the runner's 60 s bounded retry.
      - -c
      - tcp_keepalives_idle=20
      - -c
      - tcp_keepalives_interval=5
      - -c
      - tcp_keepalives_count=3
    volumes:
      - core-db-data:/var/lib/postgresql/data
    healthcheck:
      # -h 127.0.0.1 IS LOAD-BEARING: during initdb the entrypoint runs a temporary
      # server on the unix socket only, so a socket pg_isready reports healthy while
      # TCP is still refused and Compose starts core-api against nothing.
      test: ["CMD-SHELL", "pg_isready -U core_api_owner -d core -h 127.0.0.1 || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s
    # Let Postgres checkpoint instead of being SIGKILLed after the default 10 s.
    stop_grace_period: 60s
    shm_size: 128mb
    # Bias the kernel AWAY from the process holding the data.
    oom_score_adj: -500

  core-api:
    image: ${CORE_API_IMAGE:-core-api}
    container_name: core-api
    restart: unless-stopped
    networks: [core-net, default]
    ports:
      # The "not exposed past Nginx" property is delivered HERE, not by HOST: a
      # process bound to 127.0.0.1 INSIDE a container is unreachable from
      # docker-proxy and from the Compose network, so HOST is 0.0.0.0 by design.
      - "127.0.0.1:3200:3200"
    env_file:
      - ${CORE_ENV_FILE:-.env}
    environment:
      PORT: 3200
      HOST: 0.0.0.0
      TZ: UTC
      API_PUBLIC_ORIGIN: https://api.yeyintlwin.com
      # Empty means no CORS headers are emitted at all -- the Phase-1 default; the
      # OPTIONS responder ships inert.
      TERMINAL_ALLOWED_ORIGINS: ""
      TRUSTED_PROXY_HOPS: 1
      SESSION_IDLE_SECONDS: 28800
      SESSION_ABSOLUTE_SECONDS: 604800
      PAIRING_CODE_TTL_SECONDS: 900
      TERMINAL_TOKEN_TTL_SECONDS: 7776000
      LOGIN_RATE_PER_MINUTE: 30
      LOGIN_TIME_BUDGET_MS: 400
      SCRYPT_SLOTS: 2
      PAIR_RATE_PER_MINUTE: 20
      ADMIN_MINT_RATE_PER_10MIN: 20
      PAIRING_MINT_RATE_PER_10MIN: 30
      PASSWORD_ABUSE_THRESHOLD: 5
      ROTATE_RATE_PER_HOUR: 5
      AUDIT_RETENTION_DAYS: 365
      DB_POOL_MAX: 8
    depends_on:
      core-db:
        condition: service_healthy
    healthcheck:
      # /health, NOT /health/ready. Nothing depends_on core-api, so an unhealthy mark
      # would restart nothing, and a transient database blip should not produce a
      # misleading container status. The DEPLOY GATE is what calls /health/ready.
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3200/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 60s
    mem_limit: 512m

  epaper-hub:
    image: ${EPAPER_IMAGE:-epaper-hub}
    # NOT `build: .`. A relative build context resolves against the directory of THIS
    # file, which is now the repository root; apps/epaper-hub/Dockerfile copies
    # package*.json and server.js relative to its own directory, so a rooted context
    # would copy the workspace package.json and then fail on `COPY server.js`.
    # Production is unaffected (--no-build) and `docker compose config` still prints
    # ok, so only the test sees this.
    build:
      context: apps/epaper-hub
    container_name: epaper-hub
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    env_file:
      - ${EPAPER_ENV_FILE:-.env}
    environment:
      SCREEN_STORE_FILE: /data/screens.json
    volumes:
      - epaper-data:/data
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5

  customer-order:
    image: ${CUSTOMER_ORDER_IMAGE:-customer-order}
    container_name: customer-order
    restart: unless-stopped
    ports:
      - "127.0.0.1:3100:3100"
    env_file:
      - ${EPAPER_ENV_FILE:-.env}
    environment:
      PORT: 3100
      EPAPER_HUB_URL: http://epaper-hub:3000
      ORDER_BASE_URL: https://order.yeyintlwin.com
      BUSINESS_TIME_ZONE: Asia/Tokyo
      BUSINESS_DAY_ROLLOVER_HOUR: 6
    depends_on:
      epaper-hub:
        condition: service_healthy

volumes:
  epaper-data:
  core-db-data:
```

In `.github/workflows/deploy.yml`, make six edits. **Build images**, after `:33` and after `:35`:

```diff
           docker build -t epaper-hub:${{ github.sha }} apps/epaper-hub
           docker build -f apps/customer-order/Dockerfile -t customer-order:${{ github.sha }} .
+          docker build -f apps/core-api/Dockerfile -t core-api:${{ github.sha }} .
           docker save epaper-hub:${{ github.sha }} | gzip > /tmp/epaper-hub-image.tgz
           docker save customer-order:${{ github.sha }} | gzip > /tmp/customer-order-image.tgz
+          # Sha in the tarball NAME, not just the tag: two concurrent deploys share one
+          # /tmp on the runner and one on the box, and a fixed path lets push B's image
+          # overwrite the one push A has not loaded yet.
+          docker save core-api:${{ github.sha }} | gzip > /tmp/core-api-image-${{ github.sha }}.tgz
```

**Upload app**, after `:51`:

```diff
           scp -i ~/.ssh/lightsail.pem /tmp/customer-order-image.tgz "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:/tmp/customer-order-image.tgz"
+          scp -i ~/.ssh/lightsail.pem /tmp/core-api-image-${{ github.sha }}.tgz "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:/tmp/core-api-image-${{ github.sha }}.tgz"
```

**Deploy heredoc**, after `:71`:

```diff
           test -f ~/restaurant-order-system.env
+          # Without this the compose file that lands on the box cannot be LOADED by any
+          # subcommand -- up, config and exec all fail at project load -- so the
+          # operator's ssh-and-restart reflex is dead too. Fail here, with a message.
+          test -f ~/core-api.env || { echo 'MISSING ~/core-api.env for user '"$(whoami)"' -- see infra/README.md'; exit 1; }
```

After `:77`:

```diff
           docker load -i /tmp/epaper-hub-image.tgz
           docker load -i /tmp/customer-order-image.tgz
+          docker load -i /tmp/core-api-image-${{ github.sha }}.tgz
```

Replace `:86`:

```diff
-          EPAPER_IMAGE=epaper-hub:${{ github.sha }} CUSTOMER_ORDER_IMAGE=customer-order:${{ github.sha }} EPAPER_ENV_FILE=../restaurant-order-system.env docker compose up -d --no-build
+          EPAPER_IMAGE=epaper-hub:${{ github.sha }} CUSTOMER_ORDER_IMAGE=customer-order:${{ github.sha }} CORE_API_IMAGE=core-api:${{ github.sha }} EPAPER_ENV_FILE=../restaurant-order-system.env CORE_ENV_FILE=../core-api.env docker compose up -d --no-build
```

Replace `:88`:

```diff
-          rm -f /tmp/epaper-hub-image.tgz /tmp/customer-order-image.tgz
+          rm -f /tmp/epaper-hub-image.tgz /tmp/customer-order-image.tgz /tmp/core-api-image-${{ github.sha }}.tgz
```

> The `workflow` area later replaces `:86` wholesale with the spec's `export` block. Both of this
> task's variables survive that rewrite: the assertions match `CORE_API_IMAGE=core-api:${{ github.sha }}`
> and `CORE_ENV_FILE=../core-api.env` wherever they appear, and the `rm -f` assertion is written
> loosely enough to keep matching when it becomes `/tmp/*-image*.tgz`.

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: PASS (4 tests)

Then confirm the epaper-hub suite still agrees (its `:211-212` assertions read the same `:86` line):

Run: `node --test apps/epaper-hub/test/deploy-config.test.js`  Expected: PASS (14 tests)

Then confirm the file is still valid YAML that Compose can resolve. This needs no Docker daemon and
no secrets, because both env variables point at an empty file. **Bash tool** — the `VAR=value cmd`
prefix form is a parse error in PowerShell, which is this machine's primary shell. `| sort` because
Compose does not guarantee service ordering:

```bash
: > /tmp/empty.env
CORE_ENV_FILE=/tmp/empty.env EPAPER_ENV_FILE=/tmp/empty.env docker compose config --services | sort
```

Expected output, one per line, alphabetically:

```
core-api
core-db
customer-order
epaper-hub
```

If Docker Desktop is not running, skip it and record that it was skipped.

**MANUAL VERIFICATION — runs ONCE, on the Lightsail box, BEFORE this commit is pushed.**
This is spec §9.11 step 4. It is not a test and nothing automates it: there is no way to create a
mode-600 file in the operator's home directory from a unit test. Run it, then push.

1. SSH to the box:

   ```
   ssh -i ~/.ssh/lightsail.pem <LIGHTSAIL_USER>@<LIGHTSAIL_HOST>
   ```

2. Generate both passwords and write the file in one heredoc, so neither password is ever typed and
   the two that must agree cannot disagree. `tr -d '/+='` strips the base64 characters that would
   otherwise need percent-encoding inside a DSN:

   ```
   umask 077
   OWNER_PW="$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-32)"
   APP_PW="$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-32)"
   cat > ~/core-api.env <<EOF
   POSTGRES_PASSWORD=$OWNER_PW
   DATABASE_MIGRATION_URL=postgres://core_api_owner:$OWNER_PW@core-db:5432/core
   DATABASE_URL=postgres://core_api_app:$APP_PW@core-db:5432/core
   EOF
   unset OWNER_PW APP_PW
   chmod 600 ~/core-api.env
   ```

   Expected output: nothing at all.

3. Confirm the mode, and that the other secrets file was not touched:

   ```
   ls -l ~/core-api.env ~/restaurant-order-system.env
   ```

   Expected: two lines; the `core-api.env` line begins `-rw-------` and the
   `restaurant-order-system.env` line is unchanged from before this step.

4. Confirm the file has exactly three lines and that none of the three variables leaked into the
   shared file:

   ```
   wc -l < ~/core-api.env
   grep -c -E '^(POSTGRES_PASSWORD|DATABASE_URL|DATABASE_MIGRATION_URL)=' ~/restaurant-order-system.env
   ```

   Expected: `3`, then `0` (with exit status 1 from `grep`). If the second command prints anything
   other than `0`, the whole point of §9.2 is already lost — delete those lines from
   `~/restaurant-order-system.env` before deploying.

5. **After** this commit's deploy has run (not now — the new Compose file is not on the box yet),
   confirm Compose resolves both env files. `--quiet` is not optional; see the warning in
   `infra/README.md`:

   ```
   cd ~/restaurant-order-system && CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose config --quiet
   ```

   Expected: no output, exit status 0.

- [x] **Step 5: Commit**

```bash
git add docker-compose.yml .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "feat(deploy): add core-db and core-api to compose and ship the core-api image"
```

---

### Task 4: Isolate the two secrets files and `core-net`, and write the operator runbook

Spec §9.2, and the reason it is **not deferrable**: today every service shares one `env_file`.
That file now holds a Postgres **superuser** DSN, and `epaper-hub` is internet-facing with the
`req.query.api_key` (`apps/epaper-hub/server.js:89`) + `morgan("combined")` (`:32`) pattern. Any
code-execution or SSRF bug there would read `DATABASE_MIGRATION_URL` and reach `core-db` as
`core_api_owner` — which is `COPY ... TO PROGRAM`, i.e. a shell inside the database container, plus
every tenant's rows and every scrypt hash. Before Phase 1 the worst outcome of an epaper-hub
compromise was twelve e-paper screens.

The structural test spec §9.2 proposes ("no `environment:` block names `POSTGRES_PASSWORD`") cannot
see this, because the leak is via `env_file:`. So the sweep below splits the Compose text into
per-service bodies and pins **all four services in both directions**: who lists `CORE_ENV_FILE`,
who joins `core-net`, and who joins `default`. A one-sided regex such as
`/networks: \[[^\]]*core-net/` would pass happily for `networks: [core-net, default]` on `core-db`,
which is the exact defect this section exists to prevent.

`oom_score_adj: 500` lands on the three restartable app containers for the same reason `core-db`
got `-500`: on a 1 GB box the OOM killer is the named top risk, and it should reach for a container
that can be restarted rather than the one holding the data.

The documentation half fixes a defect that would otherwise bite on the first runbook command:
**Compose validates every service's `env_file` on every subcommand**, so a `docker compose exec`
that supplies only `CORE_ENV_FILE` fails at project load with an error about the *other* env file.
Every single-line compose invocation in the docs therefore carries **both** variables, and the test
enforces that as a per-line rule rather than a fixture match.

**Files:**
- Modify: `docker-compose.yml` (`oom_score_adj: 500` on `core-api`, `epaper-hub` and `customer-order`)
- Modify: `infra/README.md` (append the reserved section `## Core API runtime: two secrets files and core-net`)
- Modify: `README.md` (line `126`, the single-env-file sentence)
- Modify: `apps/core-api/README.md` (line `138`, the create-platform-admin snippet)
- Modify: `apps/epaper-hub/README.md` (the `## Docker` block gains `CORE_ENV_FILE`)
- Test: `apps/core-api/test/deploy-config.test.js` (append two tests)

- [x] **Step 1: Write the failing test**

Append to `apps/core-api/test/deploy-config.test.js`:

```js
test("only core-db and core-api see the Postgres secrets file and the core network", () => {
  const services = servicesOf(composeText());

  // Pin core-db from its own side first, exactly, so `[core-net, default]` cannot
  // slip past a substring match.
  assert.match(services["core-db"], /^    networks: \[core-net\]$/m);
  assert.doesNotMatch(services["core-db"], /networks:.*default/);

  // epaper-hub is internet-facing and authenticates on req.query.api_key. Sharing an
  // env_file or a network with core-db would turn any code-execution or SSRF bug
  // there into `COPY ... TO PROGRAM` as core_api_owner -- a shell in the database
  // container, every tenant row, every scrypt hash.
  for (const [name, body] of Object.entries(services)) {
    const core = name === "core-db" || name === "core-api";
    assert.equal(/\$\{CORE_ENV_FILE:-\.env\}/.test(body), core, `${name} env_file`);
    assert.equal(/^    networks: \[[^\]]*\bcore-net\b/m.test(body), core, `${name} core-net`);
    // core-api is the ONLY service on both. epaper-hub and customer-order declare no
    // networks key at all, so they are on default implicitly -- which is correct.
    assert.equal(
      /^    networks: \[[^\]]*\bdefault\b/m.test(body),
      name === "core-api",
      `${name} default`
    );
  }

  assert.match(services["epaper-hub"], /\$\{EPAPER_ENV_FILE:-\.env\}/);
  assert.match(services["customer-order"], /\$\{EPAPER_ENV_FILE:-\.env\}/);
  assert.doesNotMatch(services["core-db"], /EPAPER_ENV_FILE/);
  assert.doesNotMatch(services["core-api"], /EPAPER_ENV_FILE/);

  // The OOM killer is the named top risk on this box: point it at the three
  // restartable app containers and away from the one holding the data.
  assert.match(services["core-db"], /^    oom_score_adj: -500$/m);
  for (const name of ["core-api", "epaper-hub", "customer-order"]) {
    assert.match(services[name], /^    oom_score_adj: 500$/m, name);
  }
});

test("the operator docs name the second secrets file and why core-db publishes no port", () => {
  const infra = readText(repoRoot, "infra", "README.md");
  const rootReadme = readText(repoRoot, "README.md");
  const hubReadme = readText(repoRoot, "apps", "epaper-hub", "README.md");
  const coreReadme = readText(repoRoot, "apps", "core-api", "README.md");

  assert.match(infra, /^## Core API runtime: two secrets files and core-net$/m);
  assert.match(infra, /~\/core-api\.env/);
  assert.match(infra, /mode `600`/);
  assert.match(infra, /CORE_ENV_FILE=\.\.\/core-api\.env/);
  assert.match(infra, /POSTGRES_PASSWORD/);
  assert.match(infra, /DATABASE_MIGRATION_URL/);
  assert.match(infra, /DATABASE_URL/);
  assert.match(infra, /COPY \.\.\. TO PROGRAM/);
  assert.match(infra, /core-net/);
  assert.match(infra, /api\.yeyintlwin\.com/);
  assert.match(infra, /127\.0\.0\.1:3200/);

  // The ufw fact infra/README.md does not currently record, and this phase must add.
  assert.match(infra, /DNAT/);
  assert.match(infra, /bypasses ufw/);
  assert.match(infra, /no `ports:` key at all/);

  // `docker compose config` INTERPOLATES env_file contents into its output. A bare
  // invocation on the box prints POSTGRES_PASSWORD and both DSNs in cleartext.
  assert.match(infra, /Never run `docker compose config` on this box without `--quiet` or `--services`/);

  // And nobody is told to put the database secrets in the shared file.
  assert.doesNotMatch(infra, /POSTGRES_PASSWORD[^\n]*restaurant-order-system\.env/);
  assert.doesNotMatch(rootReadme, /POSTGRES_PASSWORD[^\n]*restaurant-order-system\.env/);

  assert.match(rootReadme, /~\/core-api\.env/);
  assert.match(hubReadme, /^CORE_ENV_FILE=\/path\/to\/core-api\.env \\$/m);

  // Plan 2 owns the script itself; the runbook line must at least be RUNNABLE when it
  // arrives. Compose validates EVERY service's env_file on EVERY subcommand, so a
  // one-variable `docker compose exec` dies at project load complaining about the
  // OTHER file. This is a per-line rule, so it cannot pass by matching a fixture.
  for (const [label, document] of [
    ["infra/README.md", infra],
    ["apps/core-api/README.md", coreReadme],
    ["apps/epaper-hub/README.md", hubReadme],
    ["README.md", rootReadme]
  ]) {
    for (const line of document.split("\n")) {
      if (line.includes("docker compose") && line.includes("CORE_ENV_FILE=")) {
        assert.match(line, /EPAPER_ENV_FILE=/, `${label}: ${line}`);
      }
    }
  }

  // Plan 2, said plainly, so nobody goes looking for the script in this plan.
  assert.match(coreReadme, /Ships in a later plan of this phase/);
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/deploy-config.test.js`

Expected: FAIL, 2 of 6.
`only core-db and core-api see the Postgres secrets file and the core network` fails with
`AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^    oom_score_adj: 500$/m`
and the message `core-api`;
`the operator docs name the second secrets file and why core-db publishes no port` fails with
`The input did not match the regular expression /^## Core API runtime: two secrets files and core-net$/m`.

- [x] **Step 3: Write the minimal implementation**

In `docker-compose.yml`, add `oom_score_adj: 500` to the three app services. After `core-api`'s
`mem_limit: 512m`:

```diff
       start_period: 60s
     mem_limit: 512m
+    # The OOM killer is the named top risk on a 1 GB box: bias it toward the
+    # restartable app containers and away from core-db, which holds the data.
+    oom_score_adj: 500
 
   epaper-hub:
```

At the end of `epaper-hub`:

```diff
     healthcheck:
       test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1"]
       interval: 10s
       timeout: 5s
       retries: 5
+    oom_score_adj: 500
 
   customer-order:
```

At the end of `customer-order`:

```diff
     depends_on:
       epaper-hub:
         condition: service_healthy
+    oom_score_adj: 500
 
 volumes:
```

In `README.md`, replace line `126`:

```diff
-The environment file remains outside that folder at `~/restaurant-order-system.env`.
+The environment files remain outside that folder: `~/restaurant-order-system.env` for `epaper-hub`
+and `customer-order`, and `~/core-api.env` for `core-db` and `core-api`. They are separate on
+purpose — see `infra/README.md`, "Core API runtime: two secrets files and core-net".
```

In `apps/core-api/README.md`, replace line `138` inside the "Bootstrapping the first platform
administrator" snippet. The `*Ships in a later plan of this phase*` sentence above it stays exactly
as it is — the script itself is Plan 2:

```diff
 cd ~/restaurant-order-system
-CORE_ENV_FILE=../core-api.env docker compose exec core-api \
+CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec core-api \
   node apps/core-api/scripts/create-platform-admin.js you@example.com
```

In `apps/epaper-hub/README.md`, extend the `## Docker` block:

```diff
-`docker-compose.yml` lives at the repository root, not in this folder. Run Compose from the root.
+`docker-compose.yml` lives at the repository root, not in this folder. It also declares `core-db`
+and `core-api`, which read a **second** secrets file. Compose validates every service's `env_file`
+on every subcommand, so both variables must be supplied even when you name only these two
+services. Run Compose from the root.
 
 ```bash
 cd ../..
 docker build -f apps/customer-order/Dockerfile -t customer-order .
 EPAPER_ENV_FILE=/path/to/restaurant-order-system.env \
+CORE_ENV_FILE=/path/to/core-api.env \
-  docker compose up -d --build
+  docker compose up -d --build epaper-hub customer-order
 ```
```

Append to `infra/README.md`:

```markdown
## Core API runtime: two secrets files and core-net

- Core API: `https://api.yeyintlwin.com`, published by Docker at `127.0.0.1:3200`; Nginx terminates HTTPS.
- Database: `core-db` (`postgres:16-alpine`), reachable **only** over the Compose network `core-net`.

`docker-compose.yml` lives at the repository root and is copied to
`~/restaurant-order-system/docker-compose.yml` by the deploy.

### Two secrets files, not one

| File | Read by | Holds |
| --- | --- | --- |
| `~/restaurant-order-system.env` | `epaper-hub`, `customer-order` | `EPAPER_API_KEY`, `SHOP_ID`, `CHECKOUT_API_KEY`, … |
| `~/core-api.env` | `core-db`, `core-api` | `POSTGRES_PASSWORD`, `DATABASE_MIGRATION_URL`, `DATABASE_URL` |

Both are mode `600`, owned by the deploy user, and both stay **outside** the deploy folder —
`deploy.yml` deletes everything in `~/restaurant-order-system` except `docker-compose.yml` and
`config/` on every push. The deploy passes them as `EPAPER_ENV_FILE=../restaurant-order-system.env`
and `CORE_ENV_FILE=../core-api.env`; Compose reads them as `${EPAPER_ENV_FILE:-.env}` and
`${CORE_ENV_FILE:-.env}`. The deploy also refuses to continue when `~/core-api.env` is missing,
because a compose file whose `env_file` cannot be resolved is one that **no** subcommand can load —
not `up`, not `config`, not `exec`.

The split is not tidiness. `epaper-hub` is internet-facing, authenticates with `req.query.api_key`
and logs every request through `morgan("combined")`. If it shared an env file with `core-db`, any
code-execution or SSRF bug in it would read `DATABASE_MIGRATION_URL` and connect to `core-db` as
`core_api_owner` — which is `COPY ... TO PROGRAM`, i.e. a shell inside the database container, plus
every tenant's rows and every scrypt hash. Before this, the worst outcome of an epaper-hub
compromise was twelve e-paper screens. `core-net` is the second half of the same control: only
`core-db` and `core-api` join it, and `core-db` joins nothing else.

Create `~/core-api.env` **before** core-api's first production deploy:

```dotenv
POSTGRES_PASSWORD=<24+ chars; avoid / + = so the DSN needs no escaping>
DATABASE_MIGRATION_URL=postgres://core_api_owner:<the same password>@core-db:5432/core
DATABASE_URL=postgres://core_api_app:<a second password>@core-db:5432/core
```

`POSTGRES_PASSWORD` must be byte-identical to the password inside `DATABASE_MIGRATION_URL`;
`core-api` refuses to listen if they differ, which is exactly how "somebody edited one line and not
the other" is caught. Rotation is `apps/core-api/README.md`, "Rotating database passwords".

### `core-db` publishes no host port

`core-db` has **no `ports:` key at all** — not a loopback-only publish, which differs from a public
one by a single deletion. **Docker installs published ports as DNAT rules in the `nat` table,
evaluated before ufw's filter chains, so a published port bypasses ufw: it stays reachable from the
internet even when `ufw status` says the port is denied.** Nothing needs one — `core-api` reaches
the database over `core-net`, and `psql`/`pg_dump` go through `docker compose exec`. It is also
what makes the bootstrap design safe: `DATABASE_URL` is exploitable only from inside the host.

Every compose subcommand needs **both** env variables, because Compose validates every service's
`env_file` on every invocation — not just the services you name:

```sh
cd ~/restaurant-order-system && CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec core-db psql -U core_api_owner -d core
```

**Never run `docker compose config` on this box without `--quiet` or `--services`** — Compose
interpolates env_file contents into its output, so a bare `docker compose config` prints
POSTGRES_PASSWORD and both DSNs in cleartext, to your terminal and into your shell's scrollback.
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: PASS (6 tests)

Then confirm the documentation edits did not trip the existing doc suites — the epaper-hub file
asserts on `README.md`, `infra/README.md` and `apps/epaper-hub/README.md` in five separate tests:

Run: `node --test apps/epaper-hub/test/deploy-config.test.js`  Expected: PASS (14 tests)

- [x] **Step 5: Commit**

```bash
git add docker-compose.yml infra/README.md README.md apps/core-api/README.md apps/epaper-hub/README.md apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "feat(deploy): isolate core-db and core-api on core-net with their own secrets file"
```

---

### Area gate

Run this once when all four tasks are ticked. It is the database-free set — every suite this area
touches, and nothing that needs Postgres:

```bash
node --test apps/core-api/test/config.test.js apps/core-api/test/deploy-config.test.js apps/core-api/test/source-structure.test.js apps/epaper-hub/test/deploy-config.test.js
```

Expected: PASS, with `apps/core-api/test/deploy-config.test.js` contributing 6 tests and
`apps/epaper-hub/test/deploy-config.test.js` contributing 14.

Run `npm test` only where Postgres is available; `apps/core-api`'s `pretest` requires it and no
test in this area does. When you do run it, it covers all four test packages
(`packages/epaper-hub-sdk`, `apps/epaper-hub`, `apps/customer-order`, `apps/core-api`) — note that
the root `workspaces` key is `apps/*`, which is seven directories, not four.

After this area, `apps/core-api/test/deploy-config.test.js` holds exactly six tests and the four
shared helpers. The `workflow` area appends its own top-level `test()` blocks at the end of that
file, one per `deploy.yml` task; `nginx`, `backup` and `cutover` own their own suites.

---

## Part 2 — `infra/nginx/` and the client-IP chain

### Task 5: `infra/nginx/core-api-proxy.conf` — the snippet that carries the X-Forwarded-For chain

Spec §9.6. `proxy_pass` and `proxy_set_header` are `location`-scope directives, so
everything a proxying location needs lives in one snippet that each location
`include`s. **The `X-Forwarded-For` line is the line `TRUSTED_PROXY_HOPS=1`
depends on** — `$proxy_add_x_forwarded_for` is the client's incoming
`X-Forwarded-For` with `$remote_addr` appended **on the right**, so core-api
counting one entry from the right always reads the address Nginx itself saw. A
client that sends `X-Forwarded-For: 1.2.3.4` produces `1.2.3.4, <real ip>` and
the real IP still wins.

This file is created before `api.conf` on purpose: `api.conf` is the file that
`include`s it, and the include-count guard in the last structural task is only
meaningful once the snippet is known to carry exactly one `proxy_pass`.

**Files:**
- Create: `infra/nginx/core-api-proxy.conf`
- Test: `apps/core-api/test/nginx-config.test.js` (create)

- [x] **Step 1: Write the failing test**

Create `apps/core-api/test/nginx-config.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// Same CRLF normalisation as test/source-structure.test.js. The developer is on
// win32 and CI runs on ubuntu-latest, so a `$`-anchored regex over raw bytes
// passes on one machine and fails on the other for reasons that have nothing to
// do with the rule being asserted.
function readText(...segments) {
  return fs.readFileSync(path.join(...segments), "utf8").replace(/\r\n/g, "\n");
}

// nginx `#` comments are documentation, and these two files deliberately NAME
// the directives they forbid ("NO real_ip_header here", "no proxy_buffering off
// on purpose"). Stripping comments before asserting is what stops a warning
// comment from satisfying the very match it warns about. The same problem bites
// on the box, where `nginx -T` prints comments verbatim -- every on-box grep in
// infra/README.md carries `grep -vE '^[[:space:]]*#'` for this reason.
function stripComments(text) {
  return text.replace(/^[ \t]*#.*$/gm, "").replace(/[ \t]+#.*$/gm, "");
}

function apiConf() {
  return stripComments(readText(repoRoot, "infra", "nginx", "api.conf"));
}

function proxySnippet() {
  return stripComments(readText(repoRoot, "infra", "nginx", "core-api-proxy.conf"));
}

test("the proxy snippet sets the X-Forwarded-For header TRUSTED_PROXY_HOPS=1 depends on", () => {
  const snippet = proxySnippet();

  // `keepalive 16` in the upstream is inert without both of these: nginx opens
  // a new connection per request and the keepalive pool never fills.
  assert.match(snippet, /^proxy_http_version 1\.1;$/m);
  assert.match(snippet, /^proxy_set_header Connection\s+"";$/m);

  assert.match(snippet, /^proxy_set_header Host\s+\$host;$/m);
  assert.match(snippet, /^proxy_set_header X-Forwarded-Proto\s+\$scheme;$/m);
  assert.match(snippet, /^proxy_set_header X-Forwarded-Host\s+\$host;$/m);

  // $proxy_add_x_forwarded_for = the client's incoming XFF with $remote_addr
  // appended ON THE RIGHT. That is precisely why counting one entry from the
  // right (TRUSTED_PROXY_HOPS=1) yields the address nginx actually saw.
  assert.match(snippet, /^proxy_set_header X-Forwarded-For\s+\$proxy_add_x_forwarded_for;$/m);

  // Silent breaker 4 (spec 9.6): `X-Forwarded-For $remote_addr` produces the
  // correct answer at hops=1 and DISCARDS the chain, so the day a second proxy
  // is added there is nothing left to count and no error to notice.
  assert.doesNotMatch(snippet, /X-Forwarded-For\s+\$remote_addr/);

  assert.match(snippet, /^proxy_connect_timeout 2s;$/m);
  assert.match(snippet, /^proxy_read_timeout\s+30s;$/m);
  assert.match(snippet, /^proxy_send_timeout\s+30s;$/m);

  // EXACTLY one proxy_pass, and it names the upstream group rather than
  // 127.0.0.1:3200 directly -- a direct address bypasses both `keepalive 16`
  // and `max_fails=0`, which is the whole reason the upstream block exists.
  assert.equal((snippet.match(/^[ \t]*proxy_pass\s/gm) || []).length, 1);
  assert.match(snippet, /^proxy_pass http:\/\/core_api;$/m);

  // Deferred to the Phase-4 SSE route on purpose (spec 9.6). Turning buffering
  // off globally makes every JSON response stream byte-by-byte through a worker.
  assert.doesNotMatch(snippet, /proxy_buffering\s+off/);
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/nginx-config.test.js`

Expected: FAIL with `Error: ENOENT: no such file or directory, open 'C:\Users\hwckv\OneDrive\Desktop\yeyintlwin\yeyintlwin-dev\restaurant-order-system\infra\nginx\core-api-proxy.conf'`

- [x] **Step 3: Write the minimal implementation**

Create `infra/nginx/core-api-proxy.conf`:

```nginx
# core-api-proxy.conf -- installed by the deploy to
#   /etc/nginx/snippets/core-api-proxy.conf
#
# INCLUDE THIS FROM EVERY location IN api.conf THAT FORWARDS TO core-api, and
# from nowhere else. proxy_pass and proxy_set_header are location-scope
# directives, so including this at server{} or http{} scope fails nginx -t with
#   "proxy_pass" directive is not allowed here
#
# The X-Forwarded-For line below is THE line TRUSTED_PROXY_HOPS=1 depends on.
# $proxy_add_x_forwarded_for is the client's incoming X-Forwarded-For with
# $remote_addr appended ON THE RIGHT, so core-api counting one entry from the
# right always reads the address nginx itself saw: a client sending
# "X-Forwarded-For: 1.2.3.4" produces "1.2.3.4, <real ip>" and the real IP wins.
#
# A location that forwards WITHOUT this include sets no X-Forwarded-For at all,
# so nginx passes the client's own header through untouched and a one-from-the-
# right read returns whatever the attacker wrote. That failure is silent in both
# directions, which is why apps/core-api/test/nginx-config.test.js pins the
# number of includes and forbids a bare proxy_pass in api.conf.
#
# Never spell a full directive form inside a comment in this file or in
# api.conf: the deploy proves the install with `nginx -T | grep`, nginx -T
# prints comments verbatim, and a comment that matches the grep would report a
# snippet that never installed as installed.

proxy_http_version 1.1;
proxy_set_header Connection        "";
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

# 2s to open the socket: core-api is a container on this same host, so anything
# slower than that is down rather than busy, and a short connect timeout is what
# turns a recreate into a blip instead of a stall. 30s to read is far longer
# than any Phase-1 handler and still short enough that a wedged upstream frees
# the worker.
proxy_connect_timeout 2s;
proxy_read_timeout   30s;
proxy_send_timeout   30s;

# No "proxy_buffering off" here on purpose (spec 9.6). It belongs to the Phase-4
# SSE route and nowhere else; disabling buffering for everything makes every
# JSON response stream byte-by-byte through the worker.
proxy_pass http://core_api;
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/nginx-config.test.js`  Expected: PASS (1 test)

- [x] **Step 5: Commit**

```bash
git add infra/nginx/core-api-proxy.conf apps/core-api/test/nginx-config.test.js
git commit -m "feat(infra): nginx proxy snippet that builds the X-Forwarded-For chain"
```

---

### Task 6: `infra/nginx/api.conf` — the http{}-scope rate-limit zones, the single-server upstream and port 80

Spec §9.6, three reasons in one file:

**`limit_req_zone` is an `http{}`-scope-only directive.** Ubuntu's stock
`/etc/nginx/nginx.conf` carries `include /etc/nginx/conf.d/*.conf;` **inside**
its `http{}` block, so installing this file to `conf.d/` makes the three zones
legal with **zero edits to `nginx.conf`** — there is no hand-edited system file
on the box to lose on a package reinstall. Put the same three lines inside a
`server{}` block and `nginx -t` fails with `"limit_req_zone" directive is not
allowed here`.

**`max_fails=0` on the one upstream server.** With exactly one server in the
group `proxy_next_upstream` can never retry — there is no next server — so the
default `max_fails=3` buys nothing and costs an outage: after a
`docker compose up -d` recreate, three refused connections mark the only server
down for `fail_timeout`, and nginx returns **502 without even attempting a
connection, for seconds after core-api is already listening and healthy**.

The port-80 block is written now because `certbot` renews over HTTP-01: a
blanket `return 301` with no ACME exception breaks renewal in sixty days, long
after anybody would connect the two events.

**Files:**
- Create: `infra/nginx/api.conf`
- Test: `apps/core-api/test/nginx-config.test.js` (append)

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/nginx-config.test.js`:

```js
// Returns the text between the braces of `location <selector> {`, brace-matched
// so a nested block cannot truncate it. The selector is matched as a whole
// token: a naive indexOf("= /health") finds "= /health/ready" too, and the two
// blocks assert opposite things.
function locationBody(text, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const opener = new RegExp(`location\\s+${escaped}\\s*\\{`);
  const match = opener.exec(text);
  assert.ok(match, `no location block for '${selector}' in api.conf`);

  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index);
    }
  }
  assert.fail(`unbalanced braces in location '${selector}'`);
}

test("api.conf declares the three rate-limit zones at http{} scope and a single-server upstream", () => {
  const conf = apiConf();

  assert.match(conf, /^limit_req_zone \$binary_remote_addr zone=core_login:1m rate=10r\/m;$/m);
  assert.match(conf, /^limit_req_zone \$binary_remote_addr zone=core_pair:1m\s+rate=20r\/m;$/m);
  assert.match(conf, /^limit_req_zone \$binary_remote_addr zone=core_api:5m\s+rate=20r\/s;$/m);

  // Pinned by COLUMN, not just by presence. limit_req_zone is an http{}-scope
  // directive and Ubuntu includes conf.d/*.conf inside http{} -- indent one of
  // these into a server{} block and nginx -t fails outright with
  // '"limit_req_zone" directive is not allowed here', which the deploy treats
  // as fatal. That is the whole reason this file installs to conf.d/.
  const zoneLines = conf.split("\n").filter((line) => line.includes("limit_req_zone"));
  assert.equal(zoneLines.length, 3);
  for (const line of zoneLines) {
    assert.equal(line, line.trimStart(), "limit_req_zone must sit at http{} scope, unindented");
  }

  assert.match(conf, /^upstream core_api \{$/m);
  assert.match(conf, /^[ \t]+server 127\.0\.0\.1:3200 max_fails=0;$/m);
  assert.equal((conf.match(/^[ \t]+server \d/gm) || []).length, 1);

  // With one server proxy_next_upstream can never retry, while the default
  // max_fails=3 makes nginx STOP attempting connections for fail_timeout after
  // a recreate -- returning 502 AFTER core-api is listening and healthy.
  assert.doesNotMatch(conf, /max_fails=[1-9]/);

  assert.match(conf, /^[ \t]+keepalive 16;$/m);
});

test("api.conf redirects port 80 and keeps the ACME challenge path reachable", () => {
  const conf = apiConf();

  assert.match(conf, /^[ \t]*listen 80;$/m);
  assert.match(conf, /^[ \t]*listen \[::\]:80;$/m);
  assert.match(conf, /^[ \t]*server_name api\.yeyintlwin\.com;$/m);

  // certbot renews over HTTP-01. A blanket 301 with no exception here breaks
  // renewal in sixty days, and the certificate expiring takes the API down.
  assert.match(conf, /location \/\.well-known\/acme-challenge\/ \{ root \/var\/www\/html; \}/);
  assert.match(conf, /location \/ \{ return 301 https:\/\/\$host\$request_uri; \}/);

  // BOTH server blocks own a `location /` once the TLS block lands, and this
  // one is written first, so a whole-file select must resolve to the redirect.
  // Pinning it here is what stops the catch-all's rate-limit assertions -- the
  // ones the next task exists to make -- from silently grading this block
  // instead. That is why they select from tlsServer(conf), never from the file.
  assert.match(locationBody(conf, "/"), /^\s*return 301 https:\/\/\$host\$request_uri;\s*$/);
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/nginx-config.test.js`

Expected: FAIL — **two** failing tests (`# fail 2`), both with
`Error: ENOENT: no such file or directory, open 'C:\Users\hwckv\OneDrive\Desktop\yeyintlwin\yeyintlwin-dev\restaurant-order-system\infra\nginx\api.conf'`.
The snippet test from the previous task stays green.

- [x] **Step 3: Write the minimal implementation**

Create `infra/nginx/api.conf` (the TLS server block is added by the next task):

```nginx
# ---------------------------------------------------------------------------
# api.yeyintlwin.com -- apps/core-api, published by Compose on 127.0.0.1:3200.
#
# Installed by .github/workflows/deploy.yml to
#   /etc/nginx/conf.d/api.yeyintlwin.com.conf
# and deliberately NOT to sites-available/. Ubuntu's stock /etc/nginx/nginx.conf
# carries `include /etc/nginx/conf.d/*.conf;` INSIDE its http{} block, and
# limit_req_zone is an http{}-scope-only directive: put the three lines below in
# a server{} block and nginx -t fails with
#   "limit_req_zone" directive is not allowed here
# Installing into conf.d is what makes them legal with ZERO edits to nginx.conf,
# so there is no hand-edited system file to lose on a package reinstall.
#
# ONE-TIME PREREQUISITE ORDER (spec 9.11), and it is not negotiable:
#   1. DNS A record  api.yeyintlwin.com -> the Lightsail instance
#   2. sudo certbot certonly --nginx -d api.yeyintlwin.com
#   3. only then push, so the deploy installs this file
# ssl_certificate is read at PARSE time, so with no certificate on disk nginx -t
# fails with `cannot load certificate ".../fullchain.pem"`, the deploy rolls
# BOTH files back and exits 1 -- and the deploy is the only thing that installs
# them.
#
# Comments in this file never spell a full directive form. The deploy proves the
# install with `nginx -T | grep`, and nginx -T prints comments verbatim.
# ---------------------------------------------------------------------------

limit_req_zone $binary_remote_addr zone=core_login:1m rate=10r/m;
limit_req_zone $binary_remote_addr zone=core_pair:1m  rate=20r/m;
limit_req_zone $binary_remote_addr zone=core_api:5m   rate=20r/s;

upstream core_api {
    # max_fails=0 ON PURPOSE. There is exactly one server in this group, so
    # proxy_next_upstream can never retry -- there is no next server to try.
    # The default max_fails=3 therefore buys nothing and costs an outage: after
    # `docker compose up -d` recreates the container, three refused connections
    # mark the only server down for fail_timeout and nginx returns 502 WITHOUT
    # attempting a connection, for seconds after core-api is already listening
    # and answering /health.
    server 127.0.0.1:3200 max_fails=0;

    # Requires proxy_http_version 1.1 and an emptied Connection header, both of
    # which live in core-api-proxy.conf.
    keepalive 16;
}

server {
    listen 80;
    listen [::]:80;
    server_name api.yeyintlwin.com;

    # certbot renews over HTTP-01, so this path must stay reachable on port 80.
    # A blanket redirect breaks renewal sixty days from now, which is far enough
    # away that nobody connects the outage to this line.
    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / { return 301 https://$host$request_uri; }
}
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/nginx-config.test.js`  Expected: PASS (3 tests)

- [x] **Step 5: Commit**

```bash
git add infra/nginx/api.conf apps/core-api/test/nginx-config.test.js
git commit -m "feat(infra): nginx rate-limit zones, single-server upstream and the acme-safe port 80 block"
```

---

### Task 7: the TLS server block — no HTTP/2, the /health split, and the four proxying locations

Three spec §9.6 reasons land in this one block.

**No HTTP/2, in either form.** `http2 on;` needs nginx >= 1.25.1 and the box
runs **1.24.0**, where it is an unknown directive and **`nginx -t` fails
outright** — and the deploy treats a failed `nginx -t` as fatal, so it would
abort the cutover. The deprecated `listen 443 ssl http2` form would load, but it
is a **per-socket** option and Ubuntu parses `conf.d/` before `sites-enabled/`,
so this file's listen line is the first to touch `0.0.0.0:443` and its options
would apply to every other vhost there. On this box that is **seven** others,
**three of which proxy WebSocket upgrades** (`airpaste-api`, `n8n`,
`myanmyanlearn`) — and nginx does not implement RFC 8441. Nothing in Phase 1
needs HTTP/2, so the token is omitted and a test forbids it.

**`GET /health` is proxied but loopback-only; `/health/ready` returns 404
publicly.** The deploy gate curls `/health` through the real TLS chain with
`--resolve` from the box itself, and `curl -fsS` exits 22 on any 4xx — so a hard
404 on `/health` would abort **every** deploy, after the migration has already
applied. An earlier draft of this design returned 404 for both and would have
done exactly that; the settled spec corrects it. Readiness names the database
and the migration ledger, so it is never exposed publicly.

`allow`/`deny` match on `$remote_addr`, which is the second reason the next
task's `real_ip` guard matters: `set_real_ip_from` would make `allow 127.0.0.1`
honour a **forged** header and turn the loopback-only `/health` into a public one.

**Files:**
- Modify: `infra/nginx/api.conf` (append the 443 server block)
- Test: `apps/core-api/test/nginx-config.test.js` (append)

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/nginx-config.test.js`:

```js
// Slices the TLS server block out of api.conf: find `listen 443 ssl;`,
// walk BACK to the `server {` that opens the block it sits in, then brace-match
// forward. Every assertion below selects from this slice rather than from the
// file, because both server blocks own a `location /` and a whole-file select
// finds the port-80 redirect first -- which would grade the redirect against
// the catch-all's rate-limit rules and pass while asserting nothing.
function tlsServer(text) {
  const listenIndex = text.indexOf("listen 443 ssl;");
  assert.ok(listenIndex !== -1, "api.conf has no `listen 443 ssl;` line");

  const opener = /server\s*\{/g;
  let start = -1;
  for (let match = opener.exec(text); match && match.index < listenIndex; match = opener.exec(text)) {
    start = match.index + match[0].length;
  }
  assert.ok(start !== -1, "no `server {` opens the block holding `listen 443 ssl;`");

  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index);
    }
  }
  assert.fail("unbalanced braces in the TLS server block");
}

test("the TLS server block enables no HTTP/2 in either form", () => {
  const conf = apiConf();

  assert.match(conf, /^[ \t]*listen 443 ssl;$/m);
  assert.match(conf, /^[ \t]*listen \[::\]:443 ssl;$/m);

  // `http2 on;` needs nginx >= 1.25.1. Ubuntu 22.04 ships 1.18 and 24.04 ships
  // 1.24, where it is an unknown directive and nginx -t FAILS -- which the
  // deploy treats as fatal, so this single line would abort the cutover.
  assert.doesNotMatch(conf, /^[ \t]*http2\s+(?:on|off);/m);

  // Both server blocks name the vhost: the port-80 redirect from the previous
  // task and this one. A count of 1 means this block was appended to the wrong
  // file, or the redirect block was replaced instead of extended.
  assert.equal((conf.match(/server_name api\.yeyintlwin\.com;/g) || []).length, 2);

  assert.match(conf, /^[ \t]*ssl_certificate\s+\/etc\/letsencrypt\/live\/api\.yeyintlwin\.com\/fullchain\.pem;$/m);
  assert.match(conf, /^[ \t]*ssl_certificate_key \/etc\/letsencrypt\/live\/api\.yeyintlwin\.com\/privkey\.pem;$/m);

  // No Phase-1 body is legitimately large, and a 5 MB body is otherwise a free
  // way to hold one of only SCRYPT_SLOTS=2 open.
  assert.match(conf, /^[ \t]*client_max_body_size\s+64k;$/m);
  assert.match(conf, /^[ \t]*client_body_timeout\s+10s;$/m);
  assert.match(conf, /^[ \t]*client_header_timeout 10s;$/m);

  assert.match(conf, /add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;/);
});

test("/health is proxied loopback-only and /health/ready is never reachable publicly", () => {
  const tls = tlsServer(apiConf());

  const health = locationBody(tls, "= /health");
  // A hard 404 here would abort EVERY deploy. The gate runs
  //   curl -fsS --resolve api.yeyintlwin.com:443:127.0.0.1 https://.../health
  // through the real TLS chain, and curl -fsS exits 22 on 4xx -- after the
  // migration has already applied. The spec corrects an earlier draft that
  // returned 404 for both paths for exactly this reason.
  assert.match(health, /allow 127\.0\.0\.1;/);
  assert.match(health, /allow ::1;/);
  assert.match(health, /deny all;/);
  assert.match(health, /include \/etc\/nginx\/snippets\/core-api-proxy\.conf;/);
  assert.doesNotMatch(health, /return 404/);

  // Readiness names the database and the migration ledger. Never public.
  const ready = locationBody(tls, "= /health/ready");
  assert.match(ready, /return 404;/);
  assert.doesNotMatch(ready, /include|proxy_pass/);
});

test("the two credential routes are rate limited at the network layer and answer 429", () => {
  const tls = tlsServer(apiConf());

  // The network half of the login limiter. The application half
  // (LOGIN_RATE_PER_MINUTE, PASSWORD_ABUSE_THRESHOLD) still runs; this one
  // sheds the flood before it can occupy a scrypt slot at all.
  const login = locationBody(tls, "= /api/admin/auth/login");
  assert.match(login, /limit_req zone=core_login burst=5 nodelay;/);
  assert.match(login, /limit_req_status 429;/);
  assert.match(login, /include \/etc\/nginx\/snippets\/core-api-proxy\.conf;/);

  const pair = locationBody(tls, "= /api/terminal/pair");
  assert.match(pair, /limit_req zone=core_pair burst=5 nodelay;/);
  assert.match(pair, /limit_req_status 429;/);
  assert.match(pair, /include \/etc\/nginx\/snippets\/core-api-proxy\.conf;/);

  // Selected from the TLS slice, never from the file: the port-80 redirect owns
  // a `location /` too and it is written first.
  const catchAll = locationBody(tls, "/");
  assert.match(catchAll, /limit_req zone=core_api burst=40 nodelay;/);
  assert.match(catchAll, /include \/etc\/nginx\/snippets\/core-api-proxy\.conf;/);

  // NO limit_req_status here on purpose -- see the comment in api.conf. The
  // catch-all sheds with nginx's default 503, and 503 vs 429 is the difference
  // between "the whole API is being flooded" and "you specifically are going
  // too fast" in the access log.
  assert.doesNotMatch(catchAll, /limit_req_status/);
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/nginx-config.test.js`

Expected: FAIL — **three** failing tests (`# fail 3`), the first three tests still
green. The messages, in order:

1. `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^[ \t]*listen 443 ssl;$/m`
2. ``AssertionError [ERR_ASSERTION]: api.conf has no `listen 443 ssl;` line``
3. ``AssertionError [ERR_ASSERTION]: api.conf has no `listen 443 ssl;` line``

- [x] **Step 3: Write the minimal implementation**

Append verbatim to the end of `infra/nginx/api.conf`:

```nginx

server {
    # NO `http2` TOKEN, AND NO `http2 on;` DIRECTIVE. Decided 2026-07-31 against
    # the real box, not in the abstract.
    #
    # `http2 on;` is not an option here at all: it needs nginx >= 1.25.1 and this
    # box runs 1.24.0, where it is an unknown directive and nginx -t FAILS. The
    # deploy treats that as fatal, rolls both files back and exits 1, so that one
    # line would abort the cutover.
    #
    # The old-style `listen 443 ssl http2` form would load, but it REACHES PAST
    # THIS VHOST: it is a PER-SOCKET option, and Ubuntu's nginx.conf parses
    # conf.d/ BEFORE sites-enabled/, so this would be the first listen line to
    # touch 0.0.0.0:443 and its options would win for every other vhost on it.
    # That is SEVEN other sites on this box -- airpaste-api, n8n, myanmyanlearn,
    # epaper-hub, order, inkwire, lopaka and the apex -- none of which enable
    # http2 today, and three of which (airpaste-api, n8n, myanmyanlearn) proxy
    # WebSocket upgrades. nginx does not implement RFC 8441, so WebSockets over
    # HTTP/2 are not available; browsers normally fall back to an HTTP/1.1 ALPN
    # connection for the handshake, but that is an untested protocol change to
    # unrelated production services bought for no Phase-1 benefit.
    #
    # Nothing in Phase 1 needs HTTP/2. If a later phase does, enable it on the
    # socket deliberately and re-test those three WebSocket sites first.
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name api.yeyintlwin.com;

    # Read at PARSE time. The certificate must already exist: DNS A record,
    # then certbot, then the deploy installs this file. See the header.
    ssl_certificate     /etc/letsencrypt/live/api.yeyintlwin.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yeyintlwin.com/privkey.pem;

    # No Phase-1 request body is legitimately large. A 5 MB body is otherwise a
    # free way to hold one of only SCRYPT_SLOTS=2 open for as long as it takes
    # to send, which is a denial of service that costs the attacker nothing.
    client_max_body_size  64k;
    client_body_timeout   10s;
    client_header_timeout 10s;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # NO real_ip_header AND NO set_real_ip_from ANYWHERE IN THIS FILE.
    # Either one rewrites $remote_addr BEFORE the forwarded-for chain is built,
    # so a forged header gets appended to itself and core-api's one-from-the-
    # right read returns the attacker's own value -- a total bypass with no
    # error and no log line. The same directives would also make the
    # `allow 127.0.0.1` below honour a forged header, turning the loopback-only
    # /health into a public one. Asserted in
    # apps/core-api/test/nginx-config.test.js.

    # /health is PROXIED but loopback-only. The deploy gate curls it through
    # the real TLS chain with --resolve from the box itself, so a hard 404 here
    # would abort EVERY deploy at `curl -fsS` (exit 22) -- after the migration
    # has already applied. From the internet this answers 403.
    location = /health {
        allow 127.0.0.1;
        allow ::1;
        deny all;
        include /etc/nginx/snippets/core-api-proxy.conf;
    }

    # Readiness names the database and the migration ledger. Never public, and
    # nothing off-box needs it: the container healthcheck calls /health.
    location = /health/ready { return 404; }

    # The NETWORK half of the login limiter. The application half
    # (LOGIN_RATE_PER_MINUTE, PASSWORD_ABUSE_THRESHOLD) still runs inside
    # core-api; this one sheds the flood before it can occupy a scrypt slot.
    location = /api/admin/auth/login {
        limit_req zone=core_login burst=5 nodelay;
        limit_req_status 429;
        include /etc/nginx/snippets/core-api-proxy.conf;
    }

    location = /api/terminal/pair {
        limit_req zone=core_pair burst=5 nodelay;
        limit_req_status 429;
        include /etc/nginx/snippets/core-api-proxy.conf;
    }

    # No limit_req_status here, so the catch-all sheds with nginx's default 503
    # rather than 429. That is deliberate: 429 on the two credential routes
    # means "you specifically are going too fast", while 503 on everything else
    # means "the whole API is being flooded", and the two want different
    # responses from whoever is reading the access log.
    location / {
        limit_req zone=core_api burst=40 nodelay;
        include /etc/nginx/snippets/core-api-proxy.conf;
    }
}
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/nginx-config.test.js`  Expected: PASS (6 tests)

- [x] **Step 5: Commit**

```bash
git add infra/nginx/api.conf apps/core-api/test/nginx-config.test.js
git commit -m "feat(infra): tls server block with loopback-only /health and per-route rate limits"
```

---

### Task 8: the two mechanically checkable XFF breakers — no `real_ip`, and no proxying without the snippet

Spec §9.6 names four ways `TRUSTED_PROXY_HOPS=1` breaks silently. Two of them
are structural, so they get structural tests rather than a paragraph nobody
rereads:

1. **`real_ip_header` / `set_real_ip_from` in this block** rewrites
   `$remote_addr` *before* `$proxy_add_x_forwarded_for` is evaluated — total
   bypass, and it also makes `allow 127.0.0.1` on `/health` honour a forged
   header. → assert neither directive appears in either file.
2. **A `location` that `proxy_pass`es without including the snippet** sets no
   `X-Forwarded-For` at all, so nginx forwards the client's own header untouched
   and a one-from-the-right read returns the attacker's value. → assert the
   include appears exactly four times **and** that `api.conf` never carries the
   word `proxy_pass` at all. Those two together are the whole rule: every
   forward goes through the snippet, and the snippet is the only file with a
   `proxy_pass`.

The other two cannot be checked from a file and live in the runbook task:
(3) adding a proxy in front without changing the number — every entry shifts one
place and a single attacker locks out every account on the platform; and
(4) `proxy_set_header X-Forwarded-For $remote_addr`, which is correct at hops=1
and throws the chain away. Breaker 4 is already asserted against the snippet by
the first task in this area.

**Files:**
- Test: `apps/core-api/test/nginx-config.test.js` (append) — no nginx file changes

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/nginx-config.test.js`:

```js
test("no real_ip directive can rewrite $remote_addr before the XFF chain is built", () => {
  // Silent breaker 1. real_ip_header / set_real_ip_from rewrite $remote_addr
  // BEFORE $proxy_add_x_forwarded_for is evaluated, so a forged header is
  // appended to itself and core-api's one-from-the-right read returns the
  // attacker's value. No error, no log line, nothing to notice. The same
  // directives also make `allow 127.0.0.1` on /health honour a forged header,
  // which publishes the readiness surface the 404 above exists to hide.
  for (const [label, text] of [["api.conf", apiConf()], ["core-api-proxy.conf", proxySnippet()]]) {
    assert.doesNotMatch(text, /\breal_ip_header\b/, `${label} must not carry real_ip_header`);
    assert.doesNotMatch(text, /\bset_real_ip_from\b/, `${label} must not carry set_real_ip_from`);
    assert.doesNotMatch(text, /\breal_ip_recursive\b/, `${label} must not carry real_ip_recursive`);
  }
});

test("every location that forwards to core-api does so through the proxy snippet", () => {
  const conf = apiConf();
  const INCLUDE_LINE = "include /etc/nginx/snippets/core-api-proxy.conf;";

  const includeCount = conf.split(INCLUDE_LINE).length - 1;

  // Four proxying locations today: /health, the login route, the pairing route
  // and the catch-all. When Phase 4 adds the SSE location this number changes
  // WITH it -- which is the point: the number is what makes whoever adds a
  // location open this file and read the paragraph above.
  assert.equal(includeCount, 4, "api.conf must include the proxy snippet from all four proxying locations");

  // Silent breaker 2, stated as the thing that is actually true: the snippet is
  // the ONLY file in infra/nginx/ that proxies. A location added later with a
  // bare `proxy_pass http://core_api;` and no include would set no
  // X-Forwarded-For at all and pass the client's own header straight through --
  // and it is caught here whatever brace style it is written in.
  assert.doesNotMatch(conf, /proxy_pass/, "api.conf must never proxy_pass directly");
});
```

- [x] **Step 2: Run the test and watch it fail**

These two are guard-rails against a **future** edit, so against the files as
committed by the previous task they pass on the first run. Run them anyway and
confirm they are green before Step 4 proves they bite:

Run: `node --test apps/core-api/test/nginx-config.test.js`

Expected: PASS (8 tests) — and if either of the two new tests fails here, stop:
one of the previous two tasks was transcribed wrong.

- [x] **Step 3: Write the minimal implementation**

None. Neither nginx file changes: this task adds only the two structural guards.
`infra/nginx/api.conf` and `infra/nginx/core-api-proxy.conf` are correct as
committed by the previous task, and Step 4 is what demonstrates that the guards
are not passing vacuously.

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/nginx-config.test.js`  Expected: PASS (8 tests)

Then **prove each guard bites**, from the repository root. Both mutations are
reverted by `git checkout` on the last line, so nothing broken can be committed:

```bash
# Guard 2: a location that proxies without the snippet.
printf '\nserver {\n    location /api/v2/ { proxy_pass http://core_api; }\n}\n' >> infra/nginx/api.conf
node --test apps/core-api/test/nginx-config.test.js
git checkout -- infra/nginx/api.conf
```

Expected: FAIL, exactly one test —
`AssertionError [ERR_ASSERTION]: api.conf must never proxy_pass directly`.
(The include count is still 4, so it is the `doesNotMatch` that fires, and it
fires on the single-line `location … { proxy_pass … }` form the spec itself
uses.)

```bash
# Guard 1: real_ip in the TLS block.
printf '\nset_real_ip_from 127.0.0.1;\nreal_ip_header X-Forwarded-For;\n' >> infra/nginx/api.conf
node --test apps/core-api/test/nginx-config.test.js
git checkout -- infra/nginx/api.conf
```

Expected: FAIL, exactly one test —
`AssertionError [ERR_ASSERTION]: api.conf must not carry real_ip_header`.

Confirm the file is back:

```bash
git status --porcelain infra/nginx/api.conf
```

Expected output: empty.

- [x] **Step 5: Commit**

```bash
git add apps/core-api/test/nginx-config.test.js
git commit -m "test(infra): guard the two structural ways TRUSTED_PROXY_HOPS=1 breaks silently"
```

---

### Task 9: the runbook — `TRUSTED_PROXY_HOPS=1`, the four silent breakers, and DNS → certbot → deploy

Spec §9.6 says the four breakers are "all for `infra/README.md`", and §9.11 puts
the prerequisite ordering first in the cutover list. Two of the four are now
asserted by tests; all four belong in the file an operator opens at 02:00, along
with the one ordering that cannot be recovered from on the box: **the deploy is
the only thing that installs `api.conf`, and `nginx -t` cannot pass before the
certificate exists.**

This task appends one clearly bounded section to `infra/README.md` — everything
under the reserved heading `## Core API: Nginx for api.yeyintlwin.com` — and
touches no existing line of that file.

**Files:**
- Modify: `infra/README.md` (append one section; no existing line changes)
- Test: `apps/core-api/test/nginx-config.test.js` (append)

- [x] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/nginx-config.test.js`:

```js
test("infra/README.md documents the install targets, the hop count and its four silent breakers", () => {
  const readme = readText(repoRoot, "infra", "README.md");

  // Where each file goes, and why conf.d rather than sites-available.
  assert.match(readme, /\/etc\/nginx\/conf\.d\/api\.yeyintlwin\.com\.conf/);
  assert.match(readme, /\/etc\/nginx\/snippets\/core-api-proxy\.conf/);
  assert.match(readme, /limit_req_zone/);
  assert.match(readme, /http\{\}/);

  // Same shape as the 3000 / 3100 sentence this file already carries.
  assert.match(readme, /127\.0\.0\.1:3200/);

  // The rollback restores BOTH files. Snapshotting only the vhost leaves a bad
  // snippet on disk, the rollback's own nginx -t fails, and the box is left
  // holding a config it cannot load.
  assert.match(readme, /core-api-proxy\.conf\.bak/);

  // The http2 token is a per-socket option, so adding it here would change
  // HTTP/2 for all seven other vhosts sharing :443. The runbook records why it
  // is deliberately absent.
  assert.match(readme, /per-socket/i);
  assert.match(readme, /protocol options redefined/);

  // The hop count and the variable it derives from.
  assert.match(readme, /TRUSTED_PROXY_HOPS=1/);
  assert.match(readme, /\$proxy_add_x_forwarded_for/);

  // All four silent breakers, each named where an operator will search for it.
  assert.match(readme, /set_real_ip_from/);
  assert.match(readme, /real_ip_header/);
  assert.match(readme, /without the include/i);
  assert.match(readme, /adding a proxy in front/i);
  assert.match(readme, /X-Forwarded-For \$remote_addr/);

  // Prerequisite ordering: nginx -t cannot pass before the certificate exists,
  // and the deploy is the only thing that installs the file.
  assert.match(readme, /A record/i);
  assert.match(readme, /certbot certonly --nginx -d api\.yeyintlwin\.com/);
  assert.match(readme, /nginx -t/);

  // Every on-box grep strips comments first: nginx -T prints them verbatim and
  // api.conf deliberately names the directives it forbids.
  assert.match(readme, /nginx -T \| grep -vE/);

  // The health split, so nobody "fixes" the 200 on /health.
  assert.match(readme, /\/health\/ready/);
  assert.match(readme, /\bcurl -fsS\b/);
});
```

- [x] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/nginx-config.test.js`

Expected: FAIL with
`AssertionError [ERR_ASSERTION]: The input did not match the regular expression /\/etc\/nginx\/conf\.d\/api\.yeyintlwin\.com\.conf/`

- [x] **Step 3: Write the minimal implementation**

Append to the end of `infra/README.md`, changing no existing line:

```markdown
## Core API: Nginx for api.yeyintlwin.com

`apps/core-api` is published by Compose on `127.0.0.1:3200` — never on a public
interface — and Nginx terminates HTTPS for `api.yeyintlwin.com`, the same shape
the hub (`127.0.0.1:3000`) and customer ordering (`127.0.0.1:3100`) already use.
Two files in `infra/nginx/` are the whole of it, and the deploy installs both:

| Repo file | Installed to | Why there |
| --- | --- | --- |
| `infra/nginx/api.conf` | `/etc/nginx/conf.d/api.yeyintlwin.com.conf` | `limit_req_zone` is an `http{}`-scope-only directive, and Ubuntu's stock `nginx.conf` carries `include /etc/nginx/conf.d/*.conf;` inside `http{}`. In a `server{}` block `nginx -t` fails with `"limit_req_zone" directive is not allowed here`. Installing to `conf.d/` needs **zero edits to `nginx.conf`**, so there is no hand-edited system file to lose on a package reinstall. |
| `infra/nginx/core-api-proxy.conf` | `/etc/nginx/snippets/core-api-proxy.conf` | `proxy_pass` and `proxy_set_header` are `location`-scope, so every proxying `location` `include`s this snippet. Including it at `server{}` scope fails `nginx -t`. |

Both are scp'd to `/tmp` on the box and installed from there, never into
`~/restaurant-order-system/`: the deploy's
`find ~/restaurant-order-system -mindepth 1 -maxdepth 1 ! -name docker-compose.yml ! -name config -exec rm -rf {} +`
would delete anything else in that folder before `docker compose up -d`.

The deploy snapshots **both** installed files — `/tmp/api.conf.bak` and
`/tmp/core-api-proxy.conf.bak` — installs both, runs `nginx -t`, and **restores
both and exits 1 if the test fails**, before it ever reloads. Snapshotting only
the vhost would not be a rollback: a bad snippet survives it, the rollback's own
`nginx -t` fails too, and the box is left holding a config it cannot load.
Installing first and validating second is the same defect one step earlier — the
running Nginx keeps its in-memory config, so nothing looks wrong until certbot's
renew hook or a reboot reloads it, days later, taking `order.yeyintlwin.com` and
`epaper-hub.yeyintlwin.com` down with it.

### One-time prerequisite order — not negotiable

1. DNS A record: `api.yeyintlwin.com` → the Lightsail instance.
2. `sudo certbot certonly --nginx -d api.yeyintlwin.com`
3. Only then push, so the deploy installs `api.conf`.

`ssl_certificate` is read at **parse** time. With no certificate on disk,
`nginx -t` fails with
`cannot load certificate "/etc/letsencrypt/live/api.yeyintlwin.com/fullchain.pem"`,
the deploy restores both files and exits 1 — and the deploy is the only thing
that installs them, so there is nothing half-installed to repair by hand.

`certbot` renews over HTTP-01, which is why the port-80 block keeps
`/.well-known/acme-challenge/` reachable instead of redirecting everything.

### `api.conf` enables no HTTP/2, on purpose — it is a per-socket option

`api.conf` uses a plain `listen 443 ssl;`. Neither HTTP/2 form is used, and both
exclusions are deliberate.

`http2 on;` is not available: it needs nginx >= 1.25.1 and this box runs
**1.24.0**, where it is an unknown directive and `nginx -t` fails outright —
which the deploy treats as fatal, so that one line would abort the cutover.

The deprecated `listen 443 ssl http2;` form *would* load, but it reaches past
this vhost. `ssl http2` on a listen line is a **per-socket** option, and
Ubuntu's `nginx.conf` parses `conf.d/` *before* `sites-enabled/`, so this file's
listen line is the first to touch `0.0.0.0:443` and its options would apply to
**every** vhost sharing that socket. On this box that is seven others —
`airpaste-api`, `n8n`, `myanmyanlearn`, `epaper-hub`, `order`, `inkwire`,
`lopaka` and the apex — none of which enable HTTP/2 today, and **three of which
proxy WebSocket upgrades** (`airpaste-api`, `n8n`, `myanmyanlearn`). nginx does
not implement RFC 8441, so WebSockets over HTTP/2 are unavailable; browsers
normally fall back to an HTTP/1.1 ALPN connection for the handshake, but that is
an untested protocol change to unrelated production services bought for no
Phase-1 benefit.

If you ever add the token back you will see `nginx -t` say so exactly once:

```
nginx: [warn] protocol options redefined for 0.0.0.0:443
```

That warning is a decision, not noise. Nothing in Phase 1 needs HTTP/2. If a
later phase does, enable it on the socket deliberately and re-test those three
WebSocket sites first.
### `/health` is loopback-only, `/health/ready` is 404

`GET /health` is proxied but wrapped in `allow 127.0.0.1; allow ::1; deny all;`,
because the deploy gate curls it through the real TLS chain with `--resolve`
from the box itself and `curl -fsS` exits 22 on any 4xx. Returning 404 there
would abort **every** deploy, after the migration had already applied. From the
internet it answers 403. `/health/ready` returns 404 unconditionally: it names
the database and the migration ledger, and nothing off-box needs it — the
container healthcheck calls `/health`.

### `TRUSTED_PROXY_HOPS=1`, and the four ways it breaks silently

`core-api-proxy.conf` sets the forwarded-for header to
`$proxy_add_x_forwarded_for`. That variable is the client's incoming
`X-Forwarded-For` with `$remote_addr` appended **on the right**, so counting
**one** entry from the right yields the address Nginx actually saw. A client
sending `X-Forwarded-For: 1.2.3.4` produces `1.2.3.4, <real ip>` and the real IP
still wins. That is why the value is `1`, and it is correct only for the
topology described here: one Nginx, on the same host, in front of core-api.

Four ways this breaks with no error and no log line:

1. **`real_ip_header` or `set_real_ip_from` added to this server block.** Either
   rewrites `$remote_addr` *before* the forwarded-for chain is built, so a
   forged header is appended to itself and the one-from-the-right read returns
   the attacker's value — a total bypass. The same directives make
   `allow 127.0.0.1` on `/health` honour a forged header too, publishing the
   surface the 403 exists to hide. *Checked:*
   `apps/core-api/test/nginx-config.test.js` asserts neither directive appears
   in either file.
2. **A `location` that proxies without the include.** Written without the
   snippet, it sets no `X-Forwarded-For` at all, so Nginx forwards the client's
   own header untouched. *Checked:* the same test pins the include count at four
   and asserts `api.conf` never carries `proxy_pass` at all — the snippet is the
   only file in `infra/nginx/` allowed to proxy.
3. **Adding a proxy in front (a CDN, a load balancer) without changing the
   number.** Every entry shifts one place to the left, the value read becomes
   attacker-controlled, and one attacker can lock out every account on the
   platform through the login limiter. Nothing can check this from a file:
   change `TRUSTED_PROXY_HOPS` in the same commit that adds the proxy, and
   re-run the deploy's XFF probe.
4. **`proxy_set_header X-Forwarded-For $remote_addr`.** It produces the right
   answer today at `hops=1` and discards the chain, so the day breaker 3
   happens there is nothing left to count. *Checked:* the snippet test asserts
   this form does not appear.

Code side: when `X-Forwarded-For` is absent, has fewer than
`TRUSTED_PROXY_HOPS` entries, or the selected entry fails `net.isIP()`, core-api
treats the derivation as untrusted — the rate-limit bucket collapses to a single
shared `"unknown"` key (strictest, fail-closed), `source_ip` is written NULL
(fail-soft), and it logs at error level on **every** occurrence. A burst of
those lines means the topology and the number disagree.

### Verify the proxy on the box

`nginx -T` prints every configuration file verbatim, comments included, and
`api.conf` deliberately **names the directives it forbids** — so every grep
below strips comment lines first, or it matches the warning instead of the
directive and can never report a clean result. `nginx -T` dumps each file
exactly once no matter how many times it is included, which is why the second
count is 1 and not 4.

```sh
sudo nginx -t
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -c 'limit_req_zone .*zone=core_'                    # expect 3
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -cE 'proxy_set_header +X-Forwarded-For +\$proxy_add_x_forwarded_for'    # expect 1
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -E 'real_ip_header|set_real_ip_from|real_ip_recursive' || echo NONE
curl -s -o /dev/null -w '%{http_code}\n' -m 5 \
  --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health   # expect 200
```

`nginx -T` proves the directives are **loaded**. It does not prove a server block
matches `api.yeyintlwin.com`, that the certificate serves, or that `limit_req`
fires — which is what the `--resolve` curl and the deploy's burst probe are for.
```

- [x] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/nginx-config.test.js`  Expected: PASS (9 tests)

Then confirm the existing `infra/README.md` assertions still hold — that file is
already covered by the epaper-hub deploy-config suite, which asserts things this
section must not contradict:

```bash
node --test apps/epaper-hub/test/deploy-config.test.js
```

Expected: PASS, `# fail 0`.

And the core-api deploy-config suite, which Task 4 taught to reject any `docker compose`
line in `infra/README.md` that names `CORE_ENV_FILE` without `EPAPER_ENV_FILE`. Any task
that appends to this file has to re-run it or it finds out two tasks later:

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

Finally, prove that the runbook's own XFF grep can match the file it is about to be run
against. `core-api-proxy.conf` is column-aligned, so a single-space pattern silently
matches nothing and the cutover check reports a broken chain on a healthy box:

```bash
grep -cE 'proxy_set_header +X-Forwarded-For +\$proxy_add_x_forwarded_for' infra/nginx/core-api-proxy.conf
```

Expected: `1`.

- [x] **Step 5: Commit**

```bash
git add infra/README.md apps/core-api/test/nginx-config.test.js
git commit -m "docs(infra): nginx install targets, the certbot ordering and the four XFF breakers"
```

---

### Task 10: MANUAL VERIFICATION — install and prove the proxy at cutover

**This task has no Steps 1–4, and it is not a test.** Nothing below runs on a
developer machine or in CI: it needs the Lightsail host, a real certificate and a
running core-api. It runs **once, at cutover**, after the deploy has installed
both files. `nginx -t` and the two `nginx -T | grep` proofs also run on every
deploy from inside the workflow heredoc; this block is what a human does the
first time, plus the checks that can only be made from **off** the box.

Run steps 1–7 from an SSH session on the instance, and steps 8–9 from a laptop
on the public internet. **Step 10 is last on purpose** — it deliberately
exhausts the `core_login` bucket for its source address, so anything that needs
to reach core-api from that address must already have run.

**Preconditions this area does not own.** Nothing here can pass until the
`workflow` area's deploy task installs the two files. That task must carry these
lines and assert each of them as workflow text in
`apps/core-api/test/deploy-config.test.js` — this is the verbatim required list
handed over from `infra/nginx/`:

```sh
scp -i ~/.ssh/lightsail.pem infra/nginx/api.conf            …:/tmp/api.conf
scp -i ~/.ssh/lightsail.pem infra/nginx/core-api-proxy.conf …:/tmp/core-api-proxy.conf

sudo cp -a /etc/nginx/conf.d/api.yeyintlwin.com.conf /tmp/api.conf.bak            2>/dev/null || :
sudo cp -a /etc/nginx/snippets/core-api-proxy.conf   /tmp/core-api-proxy.conf.bak 2>/dev/null || :
sudo install -m0644    /tmp/api.conf            /etc/nginx/conf.d/api.yeyintlwin.com.conf
sudo install -m0644 -D /tmp/core-api-proxy.conf /etc/nginx/snippets/core-api-proxy.conf
if ! sudo nginx -t; then
  if [ -f /tmp/api.conf.bak ]; then sudo cp -a /tmp/api.conf.bak /etc/nginx/conf.d/api.yeyintlwin.com.conf
  else sudo rm -f /etc/nginx/conf.d/api.yeyintlwin.com.conf; fi
  if [ -f /tmp/core-api-proxy.conf.bak ]; then sudo cp -a /tmp/core-api-proxy.conf.bak /etc/nginx/snippets/core-api-proxy.conf
  else sudo rm -f /etc/nginx/snippets/core-api-proxy.conf; fi
  sudo nginx -t
  exit 1
fi
sudo systemctl reload nginx
```

The second snapshot and its restore branch are an **addition** to spec §9.5,
which snapshots only the vhost: without them a bad snippet survives the
rollback, the rollback's own `nginx -t` fails, and the box is left holding a
config it cannot load.

**Files:**
- No source files. This task ticks its own boxes and commits the plan file.

- [ ] **1. The certificate exists before anything else.**

```sh
sudo test -f /etc/letsencrypt/live/api.yeyintlwin.com/fullchain.pem && echo CERT-OK
```

Expected output: `CERT-OK`. If it prints nothing, stop: run
`sudo certbot certonly --nginx -d api.yeyintlwin.com` first, and confirm the DNS
A record resolves to this instance before that. `nginx -t` cannot pass without
the certificate, and the deploy will restore both files and exit 1.

- [ ] **2. Both files are installed, with the right modes.**

```sh
ls -l /etc/nginx/conf.d/api.yeyintlwin.com.conf /etc/nginx/snippets/core-api-proxy.conf
```

Expected: both listed, both `-rw-r--r--` (mode 0644), owned by `root`.

- [ ] **3. The configuration is valid — and this file has not silently changed HTTP/2 for the other two vhosts.**

```sh
sudo nginx -t 2>&1 | tee /tmp/nginx-t.out
grep -i 'protocol options redefined' /tmp/nginx-t.out && echo 'STOP: this file is changing HTTP/2 for the OTHER vhosts on :443'
```

Expected: `/tmp/nginx-t.out` ends with, exactly:

```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

and the `grep` prints **nothing** and exits 1.

Two different warn lines can appear above those, and they are not the same
thing. `nginx: [warn] the "listen ... http2" directive is deprecated` (nginx >=
1.25.1) is expected and correct — `nginx -t` still exits 0, and the deprecated
form is the only one that also loads on the 1.18 and 1.24 builds Ubuntu 22.04
and 24.04 ship. `nginx: [warn] protocol options redefined for 0.0.0.0:443` is
the STOP: `ssl http2` is a **per-socket** option and `conf.d/` is parsed before
`sites-enabled/`, so this file's listen line is now setting HTTP/2 for
`order.yeyintlwin.com` and `epaper-hub.yeyintlwin.com` too. Decide deliberately:
accept HTTP/2 on all three, or drop the `http2` token from both listen lines in
`infra/nginx/api.conf` and from the two matching assertions in
`apps/core-api/test/nginx-config.test.js`. Nothing in Phase 1 needs HTTP/2.

- [ ] **4. Record the nginx version**, so the `http2` choice has evidence behind it.

```sh
nginx -v
```

Expected: `nginx version: nginx/1.18.0 (Ubuntu)` or `nginx/1.24.0 (Ubuntu)`.
Anything >= 1.25.1 is fine too; the listen-line form still loads.

- [ ] **5. The zones and the header are actually in the loaded config.**

Every grep strips comment lines first: `nginx -T` prints comments verbatim and
`api.conf` deliberately names the directives it forbids, so an unfiltered grep
matches the warning rather than the directive.

```sh
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -c 'limit_req_zone .*zone=core_'
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -cE 'proxy_set_header +X-Forwarded-For +\$proxy_add_x_forwarded_for'
```

Expected output: `3`, then `1` — one, not four, because `nginx -T` dumps each
file exactly once however many times it is included. A `0` on the second means
the snippet did not install and **every** derived client IP is about to be
attacker-controlled.

- [ ] **6. No `real_ip` directive reached the loaded config** — including from
      any other file already in `conf.d/`.

```sh
sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -E 'real_ip_header|set_real_ip_from|real_ip_recursive' || echo NONE
```

Expected output: `NONE`. Without the comment filter this check can never print
`NONE`: `api.conf` carries the line
`# NO real_ip_header AND NO set_real_ip_from ANYWHERE IN THIS FILE.` and the
grep matches its own warning.

- [ ] **7. `/health` answers 200 from loopback, through the real TLS chain.**
      This is the exact call the deploy gate makes.

```sh
curl -s -o /dev/null -w '%{http_code}\n' -m 5 \
  --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health
```

Expected output: `200`. A `404` here means the health split was inverted, and
every future deploy will abort at `curl -fsS` with exit 22 **after** the
migration has applied.

- [ ] **8. From a laptop, off the box: `/health` is 403 and `/health/ready` is 404.**

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://api.yeyintlwin.com/health
curl -s -o /dev/null -w '%{http_code}\n' https://api.yeyintlwin.com/health/ready
```

Expected output: `403`, then `404`. A `200` on either means `allow`/`deny` is
matching a forged address — go back to step 6.

- [ ] **9. From a laptop: port 80 redirects and keeps its ACME exception.**

```sh
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://api.yeyintlwin.com/anything
curl -s -o /dev/null -w '%{http_code}\n' http://api.yeyintlwin.com/.well-known/acme-challenge/probe
```

Expected output: `301 https://api.yeyintlwin.com/anything`, then `404` — a 404
served by `root /var/www/html` for a challenge file that does not exist, which is
what proves the location is **not** being swallowed by the redirect. A `301` on
the second line breaks certificate renewal sixty days from now.

- [ ] **10. LAST: `limit_req` fires on the login route.** This exhausts the
      `core_login` bucket for the source address, so nothing that needs to reach
      core-api from here may run after it.

```sh
for n in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code} ' -m 3 \
    --resolve api.yeyintlwin.com:443:127.0.0.1 \
    -X POST https://api.yeyintlwin.com/api/admin/auth/login \
    -H 'Content-Type: application/json' --data-binary '{}'
done; echo
```

Expected output: six `404`s, then fourteen `429`s —
`404 404 404 404 404 404 429 429 429 429 429 429 429 429 429 429 429 429 429 429`.

The `404`s are correct: `rate=10r/m` with `burst=5 nodelay` lets `1 + 5 = 6`
requests through, and in Plan 5 **core-api has no `/api/admin/auth/login` route
at all** — it arrives in Plan 2 — so those six reach the service and its router
tail answers 404. The signal being read here is **404 versus 429**: 404 means
the request reached core-api, 429 means Nginx shed it. If **all twenty** are
`404`, `limit_req` is not firing and the network half of the login limiter is
not installed. If any code is `503`, the request was matched by the catch-all
rather than the exact-match login location — check the `location =` prefix.

- [ ] **11. Wait one minute before the next push.** The deploy's XFF probe posts
      to the same login route from this same address, and while the `core_login`
      bucket is empty Nginx sheds it. That is not a silent failure — the probe
      writes no audit row, spec §9.5's `test -n "$probe"` fires and the deploy
      exits 1 with
      `XFF probe wrote no audit row - it never reached core-api` — but it is a
      red deploy caused by this verification block rather than by the code, and
      one minute of waiting avoids diagnosing it twice.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "docs: record the api.yeyintlwin.com nginx cutover verification"
```

---

## Part 3 — Backup, restore and the drill

This area ships three things and nothing else: the nightly logical backup, the restore
drill that proves a dump is actually restorable, and the literal restore runbook. It
does **not** own the pre-deploy dump (§9.5 step 1), the nginx work, the health gate, the
XFF probe or the `concurrency:` key.

**This area writes no change to `.github/workflows/deploy.yml`.** The deploy lines the
nightly and the drill need are handed to the `workflow` area verbatim, in the handoff
block below, together with the assertions `workflow` must add to
`apps/core-api/test/deploy-config.test.js`. Nothing in this area's own test file reads
`deploy.yml`.

Three scope boundaries, stated so nobody re-derives them:

- **`scripts/create-platform-admin.js` is Plan 2.** It needs the `users` table, `lib/password.js`
  and an audit writer, none of which exist. The runbook below references it exactly once, in
  Scenario B, and says plainly that it arrives in Plan 2.
- **`scripts/sweep-expired.js` is Plan 2.** This area installs only the *backup* crontab line.
  The `grep -Fv -e 'sweep-expired.js'` filter is written now so Plan 2 can append its `printf`
  line and its `crontab -l | grep -q sweep-expired.js` proof into the same block without a
  second `crontab /tmp/ct.$$` call. Until then `AUDIT_RETENTION_DAYS` configures nothing, which
  `infra/README.md` records.
- **The migration runner is already built.** Plan 1's `apps/core-api/db/migrate.js` implements
  the §9.4 contract. The drill *invokes* it (`--check`) rather than re-deriving checksums in SQL,
  because a re-derivation is a second source of truth that drifts from the runner on the first
  refactor. `apps/core-api/README.md` already carries local development (§9.9); this area adds
  the **production** half to `infra/README.md`.

Two paths are decided and must not be re-litigated:

- **`infra/restore-drill.sh`, not `apps/core-api/scripts/restore-drill.sh`.** Spec §9.7 writes it
  as `scripts/restore-drill.sh`; that path is superseded because it is a **host** script — it
  drives `docker compose`, which does not exist inside the image. It is scp'd to
  `~/restaurant-order-system/config/restore-drill.sh`, the one directory
  `deploy.yml`'s `find … ! -name config -exec rm -rf {} +` spares. `cutover`'s runbook and
  definition of done use the `config/` path.
- **`apps/core-api/test/backup-restore.test.js`, not `apps/core-api/test/deploy-config.test.js`.**
  The latter is created by `compose` and appended to only by `workflow`. Backup and restore are a
  self-contained concern with no database, so they run on the win32 dev machine and on
  `ubuntu-latest` unchanged. C13 in `source-structure.test.js` requires `test/` to hold only
  `*.test.js`, which this satisfies; `test/` is excluded from the source walker, so C1–C9 are
  unaffected.

Expected counts for `node --test apps/core-api/test/backup-restore.test.js` in isolation:
**3, 5, 8, 11, 12** after the five tasks below.

---

### Handoff to the `workflow` area — the deploy.yml lines this area requires

**`workflow` implements every line in this block and asserts it. This area writes none of it.**
Without these lines the nightly is never on the box, the drill is never on the box, and a
silent nightly is never a red build. Sequence: `workflow`'s deploy task may land before or
after this area's tasks — nothing here blocks on it — but the MANUAL VERIFICATION blocks in
Tasks 1 and 5 cannot run until it has.

### (a) `Upload app` step — replace the `:48` mkdir, add two scp lines

`scp` does not create intermediate directories, and `~/backups` is where the nightly writes.

```yaml
          ssh -i ~/.ssh/lightsail.pem "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}" 'mkdir -p ~/restaurant-order-system/config ~/backups && chmod 700 ~/backups'
          scp -i ~/.ssh/lightsail.pem infra/backup-core-db.sh "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:~/restaurant-order-system/config/backup-core-db.sh"
          scp -i ~/.ssh/lightsail.pem infra/restore-drill.sh "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:~/restaurant-order-system/config/restore-drill.sh"
```

Both scripts go under `config/` because `deploy.yml:84`'s
`find ~/restaurant-order-system -mindepth 1 -maxdepth 1 ! -name docker-compose.yml ! -name config -exec rm -rf {} +`
deletes anything else in that folder. A script scp'd "alongside the compose file" is erased
before the crontab entry ever runs it, and a presence-only assertion stays green.

### (b) The legacy config migration at `:72-74` — must change in the SAME commit as (a)

This is a live defect the moment (a) lands. Today the branch reads:

```sh
          if [ -d ~/epaper-emulator/config ] && [ ! -d ~/restaurant-order-system/config ]; then
            mv ~/epaper-emulator/config ~/restaurant-order-system/config
          fi
          rm -rf ~/epaper-emulator
```

The `Upload app` step runs before the `Deploy on Lightsail` step, so once (a) always creates
`~/restaurant-order-system/config`, `[ ! -d … ]` is permanently false: the `mv` becomes dead
code sitting directly above the `rm -rf`, which is then the only thing that touches the source.
And even if the guard were reached, `mv` into an existing directory would produce
`config/config`. Make it content-aware and copy rather than move:

```sh
          if [ -d ~/epaper-emulator/config ] && [ -z "$(ls -A ~/restaurant-order-system/config 2>/dev/null)" ]; then
            cp -a ~/epaper-emulator/config/. ~/restaurant-order-system/config/
          fi
          rm -rf ~/epaper-emulator
```

**The `rm -rf ~/epaper-emulator` is safe to keep, and here is why:** by the time it runs the old
stack has been `docker compose down`ed (`:58-61`); `~/epaper-emulator.env` and
`~/epaper-emulator/.env` have already been promoted to `~/restaurant-order-system.env`
(`:62-70`); `config/` has just been copied if it had anything to give; and the screen data
lives in the named Docker volume `epaper-emulator_epaper-data` under `/var/lib/docker`, not in
that directory — it is migrated separately at `:79-83`, *after* the `rm -rf`. Nothing unique to
the old directory survives the copy.

### (c) The backup-health block, in the heredoc, before the cron block

`set -euo pipefail` is already in force at `:57`.

```sh
          # ---- BACKUP HEALTH: make silence a red build ----
          # LAST_OK is the nightly's ONLY failure signal: `set -eu` exits the script early, its
          # output goes to ~/backups/backup.log which nobody reads, and cron's MAILTO goes to a
          # local mailbox on a box with no MTA.
          # CRON_INSTALLED_AT is the bootstrap marker. Gating on `[ -f LAST_OK ]` alone made the
          # ONE failure this gate exists to catch -- the nightly never having succeeded even
          # once -- silent forever, because a missing LAST_OK simply skipped the check.
          rm -f "$HOME"/backups/*.part
          if [ -f "$HOME/backups/CRON_INSTALLED_AT" ] \
             && ! find "$HOME/backups/CRON_INSTALLED_AT" -mtime -2 2>/dev/null | grep -q .; then
            find "$HOME/backups/LAST_OK" -mtime -2 2>/dev/null | grep -q . \
              || { echo 'no successful core-db nightly in 48h'; exit 1; }
          fi
          df -P "$HOME" | awk 'NR==2 && $5+0 > 85 { print "disk " $5 " full"; exit 1 }'
```

### (d) The cron block, last in the heredoc, plus the bootstrap marker

```sh
          # ---- CRON, LAST, AND FAILURE-PROOF ----
          # `crontab -l | grep -Fv … | crontab -` exits 1 under set -e on a box with NO crontab
          # (crontab -l exits 1, grep on empty input exits 1, pipefail propagates), aborting the
          # deploy with an EMPTY error message before the service ever starts -- and on Vixie
          # cron the empty stdin also wipes any crontab that did exist.
          { crontab -l 2>/dev/null || true; } | { grep -Fv -e 'backup-core-db.sh' -e 'sweep-expired.js' || true; } > /tmp/ct.$$
          printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n17 3 * * * %s/restaurant-order-system/config/backup-core-db.sh >> %s/backups/backup.log 2>&1\n' "$HOME" "$HOME" >> /tmp/ct.$$
          crontab /tmp/ct.$$ && rm -f /tmp/ct.$$
          crontab -l | grep -q backup-core-db.sh
          # Bootstrap marker, written ONCE. Touching it on every deploy would keep it
          # permanently fresh on a repository that deploys daily, and the 48-hour gate above
          # would then never fire.
          [ -f "$HOME/backups/CRON_INSTALLED_AT" ] || touch "$HOME/backups/CRON_INSTALLED_AT"
```

`scripts/sweep-expired.js` is Plan 2; the `grep -Fv` filter already reserves its slot.

### (e) The assertions `workflow` adds to `apps/core-api/test/deploy-config.test.js` — **not as a new top-level block**

**Do not paste this as one `test()` block.** Every assertion below belongs to a task that
already has its own test block asserting the line in question, and a second copy at EOF
would assert the same text twice and inflate the file's registration count. Fold each one
into the test of the task that implements it:

| Assertions | Fold into |
| --- | --- |
| the `mkdir`/`scp` assertions, and the four legacy-config-migration assertions | **Task 18**'s test |
| `rm -f "$HOME"/backups/*.part`, both `CRON_INSTALLED_AT` assertions, the `LAST_OK -mtime -2` assertion, `no successful core-db nightly in 48h`, and the `doesNotMatch` on the old `&& [ -f LAST_OK ]` shape | **Task 23**'s test |
| the `df -P` assertion, and the volume-name-drift block (`composeText()` → `restaurant-order-system_<name>` → `docker volume create` / `docker volume inspect`) — those two literals ship in that task | **Task 19**'s test |
| the crontab assertions and the `CRON_INSTALLED_AT` touch | **Task 24**'s test |

The registration count stays at 15. Read `yaml` below as whatever the host test block already
calls `workflowText()`'s result.

```js
  const yaml = workflowText();

  // scp creates no intermediate directories, and ~/backups is where the nightly writes.
  assert.match(yaml, /mkdir -p ~\/restaurant-order-system\/config ~\/backups && chmod 700 ~\/backups/);

  // config/ is the ONE directory `find … ! -name config -exec rm -rf {} +` preserves. A
  // script scp'd "alongside the compose file" is erased before the crontab entry runs it.
  assert.match(yaml, /scp -i [^\n]*infra\/backup-core-db\.sh[^\n]*restaurant-order-system\/config\/backup-core-db\.sh/);
  assert.match(yaml, /scp -i [^\n]*infra\/restore-drill\.sh[^\n]*restaurant-order-system\/config\/restore-drill\.sh/);

  // Once the mkdir above always creates config/, `[ ! -d … ]` is permanently false: the mv
  // becomes dead code directly above `rm -rf ~/epaper-emulator`, and mv into an existing
  // directory would produce config/config anyway.
  assert.match(yaml, /\[ -z "\$\(ls -A ~\/restaurant-order-system\/config 2>\/dev\/null\)" \]/);
  assert.match(yaml, /cp -a ~\/epaper-emulator\/config\/\. ~\/restaurant-order-system\/config\//);
  assert.doesNotMatch(yaml, /\[ ! -d ~\/restaurant-order-system\/config \]/);
  assert.doesNotMatch(yaml, /mv ~\/epaper-emulator\/config ~\/restaurant-order-system\/config/);

  // Leftovers from a failed nightly, swept every deploy so a stale .part can never be
  // mistaken for a dump.
  assert.match(yaml, /rm -f "\$HOME"\/backups\/\*\.part/);

  // The bootstrap marker, and the fact that it is written ONCE. Touched on every deploy it
  // would stay permanently fresh and the 48-hour gate would never fire.
  assert.match(yaml, /\[ -f "\$HOME\/backups\/CRON_INSTALLED_AT" \] \|\| touch "\$HOME\/backups\/CRON_INSTALLED_AT"/);
  assert.match(yaml, /find "\$HOME\/backups\/CRON_INSTALLED_AT" -mtime -2/);
  assert.match(yaml, /find "\$HOME\/backups\/LAST_OK" -mtime -2/);
  assert.match(yaml, /no successful core-db nightly in 48h/);
  // The old shape made a missing LAST_OK skip the check, i.e. silent forever.
  assert.doesNotMatch(yaml, /&& \[ -f "\$HOME\/backups\/LAST_OK" \]/);

  // A dump that cannot be written is the same outage as a dump never taken.
  assert.match(yaml, /df -P "\$HOME" \| awk 'NR==2 && \$5\+0 > 85/);

  // The crontab entry is what turns a shipped file into a nightly.
  assert.match(yaml, /17 3 \* \* \* %s\/restaurant-order-system\/config\/backup-core-db\.sh/);
  assert.match(yaml, /crontab -l \| grep -q backup-core-db\.sh/);

  // The volume literal in deploy.yml must not drift from docker-compose.yml's declaration:
  // docker names it <project>_<declared volume>, and the project is the deploy directory.
  const compose = composeText();
  const volumesAt = compose.indexOf("\nvolumes:\n");
  assert.notEqual(volumesAt, -1, "docker-compose.yml has no top-level volumes: block");
  const declared = (compose.slice(volumesAt).match(/^ {2}([a-z0-9_-]+):$/gm) || [])
    .map((line) => line.trim().replace(":", ""));
  const coreVolume = declared.find((name) => name.includes("core-db"));
  assert.ok(coreVolume, `docker-compose.yml declares no core-db volume; found ${declared.join(", ")}`);
  const full = `restaurant-order-system_${coreVolume}`;
  assert.ok(yaml.includes(`docker volume create ${full}`), `deploy.yml does not create ${full}`);
  assert.ok(yaml.includes(`docker volume inspect ${full}`), `deploy.yml does not inspect ${full}`);
```

---

### Task 11: `infra/backup-core-db.sh` — the nightly, with the `.part` discipline

Spec §9.7. Four properties carry the whole design, and each has a reason:

- **`.part` first, rename last.** A truncated dump must never replace a good one and must never
  count toward retention.
- **A full read, not just `pg_restore --list`.** `pg_dump -Fc` writes the TOC **first**, so
  `--list` is satisfied by the first few kilobytes: a dump truncated at 80% by a full disk
  passes it. `pg_restore --data-only -f /dev/null` decompresses every data block, which is the
  only check that actually reaches the end of the file.
- **`docker compose exec -T`.** Without `-T` docker allocates a TTY and CRLF translation
  silently corrupts the binary custom-format dump.
- **`LAST_OK` is the only failure signal this script has.** `set -eu` exits early, output goes to
  a log nobody reads, and cron's `MAILTO` goes to a local mailbox on a box with no MTA.

**Files:**
- Create: `infra/backup-core-db.sh`
- Test: `apps/core-api/test/backup-restore.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/backup-restore.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// Every read normalises CRLF. The developer machine is win32 and CI is ubuntu, so a
// `$`-anchored regex against raw bytes passes on one and fails on the other for
// reasons that have nothing to do with the rule being asserted.
function readText(...segments) {
  return fs.readFileSync(path.join(...segments), "utf8").replace(/\r\n/g, "\n");
}

// In a backup script ORDER is the property, not presence. "verify, then rename, then
// mark" written in any other order still contains every line a presence check looks for,
// and ships a truncated dump under a good name with LAST_OK saying it went fine.
function positionsOf(source, needles) {
  return needles.map((needle) => {
    const at = source.indexOf(needle);
    assert.notEqual(at, -1, `not found in the script: ${needle}`);
    return at;
  });
}

function assertAscending(source, needles) {
  const positions = positionsOf(source, needles);
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      positions[i - 1] < positions[i],
      `out of order: "${needles[i - 1]}" must come before "${needles[i]}"`
    );
  }
}

// The -T rule applies to lines that EXECUTE docker, not to comments and not to the
// operator hints the drill echoes on failure -- those name a deliberately TTY-attached
// `docker compose exec core-db … psql` for a human to paste, and must survive.
function executableDockerLines(script) {
  return script.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("echo")) return false;
    return trimmed.includes("docker compose exec");
  });
}

const backup = () => readText(repoRoot, "infra", "backup-core-db.sh");

test("the nightly is POSIX sh, exits on error, and reads the second secrets file", () => {
  const script = backup();

  // cron runs it through /bin/sh, which on Ubuntu is dash. A bashism here fails at
  // 03:17 with nobody watching.
  assert.match(script, /^#!\/bin\/sh$/m);
  assert.doesNotMatch(script, /^#!.*bash/m);
  assert.doesNotMatch(script, /\[\[/);
  assert.match(script, /^set -eu$/m);

  assert.match(script, /^cd "\$HOME\/restaurant-order-system"$/m);
  // Without this, compose cannot resolve ${CORE_ENV_FILE:-.env}: the deploy folder has
  // no .env, so every docker compose call fails before it ever reaches Postgres.
  assert.match(script, /^export CORE_ENV_FILE=\.\.\/core-api\.env$/m);
  // And BOTH are required. compose interpolates every env_file in the project, not
  // only the service being addressed, so a missing EPAPER_ENV_FILE fails at project
  // load -- before Postgres is reached, with no LAST_OK written and nothing to see
  // until the backup-health gate has been silent for weeks.
  assert.match(script, /^export EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env$/m);

  assert.match(script, /mkdir -p "\$HOME\/backups"/);
  assert.match(script, /chmod 700 "\$HOME\/backups"/);
});

test("the nightly reads the whole dump before it takes its real name, and marks LAST_OK only after", () => {
  const script = backup();

  // `exec -T` is load-bearing: without it docker allocates a TTY and CRLF translation
  // silently corrupts the binary custom-format dump.
  assert.match(script, /docker compose exec -T core-db/);
  for (const line of executableDockerLines(script)) {
    assert.match(line, /docker compose exec -T\b/, `docker compose exec without -T: ${line.trim()}`);
  }
  assert.match(script, /pg_dump -U core_api_owner -d core -Fc/);
  assert.doesNotMatch(script, /--no-owner|pg_dumpall/);

  // pg_dump -Fc writes the TOC FIRST, so `--list` is satisfied by the first few
  // kilobytes: a dump truncated at 80% by a full disk passes it. The data-only read
  // decompresses every block, so it is the check that reaches the end of the file.
  assertAscending(script, [
    '> "$out.part"',
    'test -s "$out.part"',
    "pg_restore --list",
    "pg_restore --data-only -f /dev/null",
    'mv "$out.part" "$out"',
    'touch "$HOME/backups/LAST_OK"'
  ]);

  // The retention glob ends in .dump precisely so a leftover .part can never count
  // toward the fourteen kept nightlies.
  assert.match(script, /ls -1t "\$HOME"\/backups\/nightly-\*\.dump/);
  assert.match(script, /tail -n \+15/);
  assert.match(script, /chmod 600 "\$out"/);
});

test("the nightly keeps the password inside the container and is committed executable", () => {
  const script = backup();

  // SINGLE quotes: the expansion happens in the shell INSIDE core-db, so the password
  // reaches no host process list and no cron log. Double quotes would make the HOST
  // expand it -- to an empty string, because ~/core-api.env is never sourced here.
  assert.match(script, /'PGPASSWORD="\$POSTGRES_PASSWORD" pg_dump/);
  assert.doesNotMatch(script, /"PGPASSWORD=/);
  assert.doesNotMatch(script, /\$\([^)]*POSTGRES_PASSWORD/);

  // git on win32 runs with core.filemode=false, so `chmod +x` does not stick. The mode
  // in the INDEX is what ubuntu-latest checks out and what scp copies to the host, and
  // cron cannot run a 644 file.
  const listed = spawnSync("git", ["ls-files", "-s", "infra/backup-core-db.sh"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(
    listed.stdout,
    /^100755 /,
    "infra/backup-core-db.sh is not executable in git's index: git add --chmod=+x it"
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/backup-restore.test.js`

Expected: FAIL with `Error: ENOENT: no such file or directory, open 'C:\Users\hwckv\OneDrive\Desktop\yeyintlwin\yeyintlwin-dev\restaurant-order-system\infra\backup-core-db.sh'` — all three tests, thrown from `backup()`.

- [ ] **Step 3: Write the minimal implementation**

Create `infra/backup-core-db.sh`:

```sh
#!/bin/sh
# Nightly logical backup of core-db. The deploy scp's this to
# ~/restaurant-order-system/config/backup-core-db.sh -- config/ is the one directory
# deploy.yml's `find ... -exec rm -rf {} +` preserves -- and installs the 03:17 UTC
# crontab entry that runs it.
#
# POSIX sh on purpose: cron runs it through /bin/sh, which on Ubuntu is dash.
set -eu
# No `set -o pipefail`: dash does not have it, and the retention pipeline's `ls`
# legitimately exits non-zero on the first night, when no nightly exists yet.

cd "$HOME/restaurant-order-system"
# The compose file interpolates ${CORE_ENV_FILE:-.env} and the deploy folder has no
# .env, so without this export every docker compose call below fails to resolve
# env_file before it ever reaches Postgres.
export CORE_ENV_FILE=../core-api.env
export EPAPER_ENV_FILE=../restaurant-order-system.env

mkdir -p "$HOME/backups"; chmod 700 "$HOME/backups"
ts="$(date -u +%Y%m%dT%H%M%SZ)"; out="$HOME/backups/nightly-$ts.dump"

# `exec -T` IS LOAD-BEARING: without it docker allocates a TTY and CRLF translation
# silently corrupts the binary custom-format dump.
# The single quotes are load-bearing too: PGPASSWORD is expanded by the shell INSIDE
# core-db, so the password appears in no host process list and no cron log.
docker compose exec -T core-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d core -Fc' > "$out.part"
test -s "$out.part"

# Two-stage verification, because an OOM kill or a full disk mid-dump produces a
# truncated file that pg_dump exits 0 on often enough to matter.
#   --list reads only the TOC, which pg_dump -Fc writes FIRST. It is the cheap "is this
#   an archive at all" check, and it PASSES on a dump truncated at 80%.
docker compose exec -T core-db pg_restore --list < "$out.part" > /dev/null
#   --data-only -f /dev/null decompresses every data block and writes the SQL nowhere,
#   so it is the only check that actually reaches the end of the file. It costs one
#   full decompression pass; that is the price of knowing the dump is complete.
docker compose exec -T core-db pg_restore --data-only -f /dev/null < "$out.part" > /dev/null

# Only now does the file take its real name. That is the whole .part discipline: a
# truncated dump never replaces a good one, and never counts toward the retention
# trim below -- whose glob ends in .dump precisely so a .part cannot match it.
# A failed run leaves its .part behind; the deploy's `rm -f ~/backups/*.part` sweeps it.
mv "$out.part" "$out"; chmod 600 "$out"
ls -1t "$HOME"/backups/nightly-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f

# LAST_OK means "a dump completed AND was read end to end". It is the ONLY failure
# signal this script has: set -eu exits early, output goes to a log nobody reads, and
# cron's MAILTO goes to a local mailbox on a box with no MTA. The deploy fails the build
# when this marker is stale -- see the backup-health block in deploy.yml.
touch "$HOME/backups/LAST_OK"
```

Then set the executable bit **in git's index**, because on win32 `core.filemode=false`
means `chmod +x` does not stick, and the index mode is what `ubuntu-latest` checks out and
`scp` copies to the host. This is part of the implementation, not of the commit ceremony:

```bash
git add --chmod=+x infra/backup-core-db.sh
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/backup-restore.test.js`  Expected: PASS (3 tests)

`.gitattributes` already carries `*.sh text eol=lf` (Plan 1, Task 2, commit `75beae8`), so the
file checks out on the host with LF endings; a CRLF checkout fails on its first line with the
unhelpful `\r: command not found`. Confirm:

```bash
git check-attr text eol -- infra/backup-core-db.sh
```

Expected output: `infra/backup-core-db.sh: text: set` and `infra/backup-core-db.sh: eol: lf`.

**MANUAL VERIFICATION — runs once, on the Lightsail host, at cutover. This is not a test and
nothing in CI performs it.** It requires the `workflow` handoff (a) to have shipped, so
`config/backup-core-db.sh` and `~/backups` exist. Do it after the first successful deploy,
before trusting cron.

1. `cd ~/restaurant-order-system && ./config/backup-core-db.sh`
   Expected: **no output at all**.
2. `echo $?`
   Expected: `0`
3. `ls -l ~/backups`
   Expected: one `nightly-<ts>.dump` at mode `-rw-------`, one zero-byte `LAST_OK`, and
   **no** `*.part`.
4. `docker compose exec -T core-db pg_restore --list < ~/backups/nightly-<ts>.dump | head -5`
   Expected: a `;` comment header naming `dbname: core` and `core_api_owner`, then TOC lines.
5. Prove the full read actually bites — this is the whole reason the nightly does not stop at
   `--list`, and no source-text test can establish it:
   ```sh
   good="$(ls -1t ~/backups/nightly-*.dump | head -1)"
   head -c "$(( $(wc -c < "$good") * 8 / 10 ))" "$good" > /tmp/truncated.dump
   docker compose exec -T core-db pg_restore --list < /tmp/truncated.dump > /dev/null; echo "list exit=$?"
   docker compose exec -T core-db pg_restore --data-only -f /dev/null < /tmp/truncated.dump > /dev/null; echo "read exit=$?"
   ```
   Expected: `list exit=0` — the TOC is intact in the first kilobytes, so `--list` is happy
   with an 80%-truncated file — then `pg_restore: error: could not read from input file: end of
   file` and `read exit=1`. The ordering test in Step 1 is what proves `touch LAST_OK` comes
   after both checks; `set -eu` is what makes an earlier failure stop the script.
6. `rm -f /tmp/truncated.dump && ls -l ~/backups`
   Expected: the good `nightly-<ts>.dump` from step 3 is still there, unchanged, and there is
   still no `*.part`.

- [ ] **Step 5: Commit**

```bash
git add --chmod=+x infra/backup-core-db.sh
git add apps/core-api/test/backup-restore.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "feat(infra): nightly core-db backup with .part discipline and a LAST_OK marker"
```

---

### Task 12: `infra/restore-drill.sh` — restore the newest nightly into a scratch database

Spec §9.7. A backup nobody has restored is not a recovery plan. The drill restores into
`core_restore_check`, proves it is not the wrong dump, asserts the ledger against the
**running image**, prints row counts and drops the scratch database. This task builds the
restore, the free-space gate, the non-vacuity check and the ledger assertion; the next task
adds the schema-invariant assertions.

Three design points that are not obvious:

- **It gates on free space before it restores.** It doubles the data footprint plus WAL inside
  the same cluster production is serving from, on the one Lightsail instance where spec §9.1
  names the OOM killer as the top risk.
- **The non-vacuity check runs BEFORE the ledger check.** `migrate.js --check` would reject an
  empty or wrong dump first, with `pending migration(s) never applied: 0001_init.sql`, which
  reads like version skew rather than "you restored the wrong file".
- **It takes an optional dump path.** The normal invocation is no argument (newest nightly).
  The argument exists for deploy #2 onward, when a `pre-deploy-<ts>.dump` is worth drilling.
  Deploy #1's pre-deploy dump is **not** a valid target: the volume is created a few lines
  above the volume gate and the dump is taken before `docker compose up -d --no-build` has ever
  migrated, so it is a dump of a freshly initialised, empty `core`.

It lives in `infra/`, not `apps/core-api/scripts/`, because it is a host script: it drives
`docker compose`, which does not exist inside the image.

**Files:**
- Create: `infra/restore-drill.sh`
- Test: `apps/core-api/test/backup-restore.test.js` (append)
- Referenced, not edited: the scp of this file into `config/` is handoff item (a) to `workflow`.

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/backup-restore.test.js`:

```js
const drill = () => readText(repoRoot, "infra", "restore-drill.sh");

test("the drill restores into a scratch database and can never touch core", () => {
  const script = drill();

  assert.match(script, /^#!\/bin\/sh$/m);
  assert.doesNotMatch(script, /^#!.*bash/m);
  assert.match(script, /^set -eu$/m);
  assert.match(script, /^DRILL_DB=core_restore_check$/m);

  // Both env files, for the same reason the nightly needs both: compose interpolates
  // every env_file in the project at load time, so one missing variable fails the
  // drill before it reaches Postgres -- and a drill that never runs looks exactly
  // like a drill that passes.
  assert.match(script, /^export CORE_ENV_FILE=\.\.\/core-api\.env$/m);
  assert.match(script, /^export EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env$/m);

  // The one assertion that matters most: no line may drop anything but the scratch
  // database. A typo here is not a failed drill, it is the outage the drill exists to
  // rehearse for.
  for (const line of script.split("\n")) {
    if (!/DROP DATABASE/.test(line)) continue;
    assert.match(
      line,
      /\$DRILL_DB|core_restore_check/,
      `a DROP DATABASE that is not the scratch database: ${line.trim()}`
    );
  }
  assert.doesNotMatch(script, /-d\s+"?core"?(?![-_\w])/);

  // template0, so nothing that may have been added to template1 can make a restore look
  // cleaner than it is.
  assert.match(script, /CREATE DATABASE \$DRILL_DB OWNER core_api_owner TEMPLATE template0/);

  // All-or-nothing, and WITHOUT --no-owner: the owner/app split is the point of this
  // schema and --no-owner collapses it. This is the only place that split is ever proved
  // to survive a restore.
  assert.match(script, /pg_restore -U core_api_owner -d "\$1" --exit-on-error --single-transaction/);
  assert.doesNotMatch(script, /pg_restore[^\n]*--no-owner/);

  // Same two container-side disciplines as the nightly. The -T rule is scoped to lines
  // that execute docker: the failure hint the drill echoes names a deliberately
  // TTY-attached psql for a human to paste, and must survive.
  for (const line of executableDockerLines(script)) {
    assert.match(line, /docker compose exec -T\b/, `docker compose exec without -T: ${line.trim()}`);
  }
  assert.match(script, /'PGPASSWORD="\$POSTGRES_PASSWORD"/);
  assert.doesNotMatch(script, /"PGPASSWORD=/);
  assert.doesNotMatch(script, /\$\([^)]*POSTGRES_PASSWORD/);

  // An optional dump argument. The normal case is no argument at all.
  assert.match(script, /if \[ "\$#" -ge 1 \]; then/);
  assert.match(script, /ls -1t "\$HOME"\/backups\/nightly-\*\.dump/);
});

test("the drill refuses without headroom, rejects the wrong dump, then checks the ledger with the production runner", () => {
  const script = drill();

  // It doubles the data footprint plus WAL inside the cluster production is serving
  // from, on the one instance where spec 9.1 names the OOM killer as the top risk.
  assert.match(script, /restore-drill: refusing, need \$need bytes free, have \$have/);
  assert.match(script, /need="\$\(\(size \* 3\)\)"/);
  assert.match(script, /\[ "\$used" -ge 70 \]/);
  // The gate must come before anything is created or restored.
  assertAscending(script, [
    "restore-drill: refusing",
    "CREATE DATABASE $DRILL_DB",
    "pg_restore -U core_api_owner"
  ]);

  // A dump of an EMPTY or of the WRONG database restores perfectly cleanly. This check
  // must come BEFORE the ledger check: migrate.js --check would reject such a dump first
  // with "pending migration(s) never applied", which reads like version skew rather than
  // "you restored the wrong file".
  assertAscending(script, [
    "expected at least 11",
    "schema_migrations is empty",
    "node apps/core-api/db/migrate.js --check"
  ]);
  assert.match(script, /to_regclass\('public\.schema_migrations'\)/);

  // db/migrate.js --check recomputes each file's CRLF-normalised digest exactly the way
  // the applied rows were written. A second implementation in SQL would drift from the
  // runner on the first refactor and then disagree during an incident.
  assert.match(script, /node apps\/core-api\/db\/migrate\.js --check/);
  // Pointed at the scratch database by rewriting ONLY the DSN's path, so config.js's
  // unconditional POSTGRES_PASSWORD == DATABASE_MIGRATION_URL password check still holds.
  assert.match(script, /u\.pathname = "\/" \+ process\.env\.DRILL_DB/);

  // Row counts via a real count(*) per table. n_live_tup reads 0 everywhere on a freshly
  // restored database that has never been ANALYZEd -- which is the exact failure this
  // drill exists to notice, reported as success.
  assert.match(script, /query_to_xml/);
  assert.doesNotMatch(script, /n_live_tup/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/backup-restore.test.js`

Expected: FAIL with `Error: ENOENT: no such file or directory, open 'C:\Users\hwckv\OneDrive\Desktop\yeyintlwin\yeyintlwin-dev\restaurant-order-system\infra\restore-drill.sh'` — the two new tests; the first three still pass.

- [ ] **Step 3: Write the minimal implementation**

Create `infra/restore-drill.sh`:

```sh
#!/bin/sh
# Restore drill. Restores a dump into a SCRATCH database, proves it is not the wrong
# dump, proves the ledger matches the running image, prints row counts, and drops it.
#
#   ./config/restore-drill.sh                                 # newest nightly (normal)
#   ./config/restore-drill.sh ~/backups/pre-deploy-<ts>.dump   # deploy #2 onward only
#
# A backup nobody has restored is not a recovery plan. Run it ONCE BY HAND before the
# first core-api deploy is trusted, then monthly. It rehearses steps 1, 3, 4, 5 and 6 of
# the Scenario A runbook in infra/README.md under a scratch database name, so the
# rehearsal costs no downtime.
#
# IT RESTORES INTO THE CLUSTER PRODUCTION IS SERVING FROM. There is one Lightsail
# instance and spec 9.1 names the OOM killer as the top risk, so this doubles the data
# footprint plus WAL inside that same cluster. Run it outside service hours. The
# free-space gate below refuses when there is not room to do it safely.
set -eu

cd "$HOME/restaurant-order-system"
export CORE_ENV_FILE=../core-api.env
export EPAPER_ENV_FILE=../restaurant-order-system.env

DRILL_DB=core_restore_check
created=0

# psql inside core-db as the owner. Single quotes: PGPASSWORD is expanded by the shell
# INSIDE the container, so the password reaches no host process list. `sh -c '...' sh "$@"`
# passes this function's arguments through as $1, $2, ... without a second round of
# quoting. No `exec` before psql: a variable assignment prefixing a special built-in has
# shell-dependent export semantics, and a simple command's does not.
psql_drill() {
  docker compose exec -T core-db sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U core_api_owner "$@"' sh "$@"
}

# On success the scratch database is dropped. On FAILURE it is deliberately left in place:
# an operator who has just watched a restore fail needs to look inside it, and re-running
# the drill only reproduces the same failure.
on_exit() {
  status=$?
  if [ "$status" -eq 0 ]; then
    psql_drill -q -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;" > /dev/null
    echo "restore-drill: PASS - $DRILL_DB dropped"
  elif [ "$created" -eq 1 ]; then
    echo "restore-drill: FAIL (exit $status). $DRILL_DB was LEFT IN PLACE for inspection."
    echo "  inspect: docker compose exec core-db sh -c 'PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U core_api_owner -d $DRILL_DB'"
    echo "  drop:    docker compose exec -T core-db sh -c 'PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U core_api_owner -d postgres -c \"DROP DATABASE IF EXISTS $DRILL_DB;\"'"
  else
    echo "restore-drill: FAIL (exit $status) before the scratch database was created."
  fi
}
trap on_exit EXIT

if [ "$#" -ge 1 ]; then
  dump="$1"
else
  dump="$(ls -1t "$HOME"/backups/nightly-*.dump 2>/dev/null | head -n 1 || true)"
fi
if [ -z "$dump" ]; then
  echo "restore-drill: no $HOME/backups/nightly-*.dump yet."
  echo "  Run ./config/backup-core-db.sh first, or name a dump:"
  echo "  ./config/restore-drill.sh ~/backups/pre-deploy-<ts>.dump"
  exit 1
fi
test -r "$dump"

echo "restore-drill: dump    $dump"
echo "restore-drill: bytes   $(wc -c < "$dump" | tr -d '[:space:]')"

# 1. FREE-SPACE GATE, before anything is created or restored. $HOME and /var/lib/docker
#    are both on / on a stock Lightsail instance, so / is the filesystem that matters.
#    `df -Pk` is explicit about 1K blocks: plain `df -P` reports 512-byte blocks when
#    POSIXLY_CORRECT is set, which would silently double the apparent headroom.
size="$(wc -c < "$dump" | tr -d '[:space:]')"
need="$((size * 3))"
have="$(df -Pk / | awk 'NR==2 { printf "%d", $4 * 1024 }')"
used="$(df -Pk / | awk 'NR==2 { sub(/%/, "", $5); print $5 + 0 }')"
if [ "$have" -lt "$need" ] || [ "$used" -ge 70 ]; then
  echo "restore-drill: refusing, need $need bytes free, have $have (disk ${used}% used, limit 70%)"
  exit 1
fi
echo "restore-drill: free    $have bytes, disk ${used}% used"

# 2. Prove the file is an archive at all before touching the cluster. This reads the TOC
#    only; the restore in step 4 is the full read, so nothing is gained by decompressing
#    the whole file twice here.
docker compose exec -T core-db pg_restore --list < "$dump" > /dev/null

# 3. A fresh scratch database from template0, so nothing that may have been added to
#    template1 can make the restore look cleaner than it is.
psql_drill -q -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;"
psql_drill -d postgres -c "CREATE DATABASE $DRILL_DB OWNER core_api_owner TEMPLATE template0;"
created=1

# 4. Restore all-or-nothing, and deliberately WITHOUT --no-owner: the owner/app split is
#    the point of this schema, and this is the only place it is ever proved to survive a
#    restore. The runbook's Scenario A omits --no-owner for exactly the same reason.
docker compose exec -T core-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U core_api_owner -d "$1" --exit-on-error --single-transaction' \
  sh "$DRILL_DB" < "$dump"

# 5. NOT THE WRONG DUMP. A dump of an EMPTY or of the WRONG database restores perfectly
#    cleanly and every step above reports success. This runs BEFORE the ledger check on
#    purpose: migrate.js --check would reject such a dump first, with "pending
#    migration(s) never applied", which reads like version skew rather than "you
#    restored the wrong file".
tables="$(psql_drill -tAq -d "$DRILL_DB" -c \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'" \
  | tr -d '[:space:]')"
if [ "$tables" -lt 11 ]; then
  echo "restore-drill: only $tables base tables restored; expected at least 11"
  exit 1
fi
present="$(psql_drill -tAq -d "$DRILL_DB" -c \
  "SELECT to_regclass('public.schema_migrations') IS NOT NULL" | tr -d '[:space:]')"
if [ "$present" != "t" ]; then
  echo "restore-drill: no schema_migrations table; this dump is not a core dump"
  exit 1
fi
ledger="$(psql_drill -tAq -d "$DRILL_DB" -c "SELECT count(*) FROM schema_migrations" | tr -d '[:space:]')"
if [ "$ledger" -lt 1 ]; then
  echo "restore-drill: schema_migrations is empty"
  exit 1
fi

# 6. The ledger must match the RUNNING IMAGE -- this is runbook step 6, the one everybody
#    gets wrong, done by machine. Reuses the production runner in --check mode rather than
#    re-deriving digests in SQL, so the drill cannot disagree with the runner during an
#    incident. Only the DSN's path is rewritten, so config.js's unconditional
#    POSTGRES_PASSWORD == DATABASE_MIGRATION_URL password check still holds, as does the
#    production "username must be core_api_owner" assertion.
#
#    Two side effects, both deliberate and both harmless: --check applies no migration, and
#    the runner's role bootstrap re-issues ALTER ROLE core_api_app with the password already
#    in DATABASE_URL -- the same statement it issues on every boot. Its advisory lock is
#    taken in core_restore_check, and advisory locks are scoped to a database, so the drill
#    cannot block a deploy migrating core.
#
#    A file in the image with no ledger row exits 1 with "pending migration(s) never
#    applied": the dump is OLDER than the image. A row with no file only warns: that is the
#    rolled-back-image shape, and it is a real recovery path.
docker compose exec -T -e DRILL_DB="$DRILL_DB" core-api sh -c \
  'export DATABASE_MIGRATION_URL="$(node -e "$0")"; exec node apps/core-api/db/migrate.js --check' \
  'const u = new URL(process.env.DATABASE_MIGRATION_URL); u.pathname = "/" + process.env.DRILL_DB; process.stdout.write(u.toString());'

# 7. (schema-invariant assertions are inserted here by the next task)

# 8. Row counts. query_to_xml runs a real count(*) per table, so this self-maintains as
#    Plan 2 adds tables. n_live_tup would read 0 everywhere on a freshly restored database
#    that has never been ANALYZEd -- reporting an empty restore as a healthy one.
psql_drill -d "$DRILL_DB" -c "
  SELECT c.relname AS table_name,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname),
                             false, true, '')))[1]::text::bigint AS rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY 1;"
```

Then set the executable bit in git's index, for the same `core.filemode=false` reason as the
nightly:

```bash
git add --chmod=+x infra/restore-drill.sh
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/backup-restore.test.js`  Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add --chmod=+x infra/restore-drill.sh
git add apps/core-api/test/backup-restore.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "feat(infra): restore drill - scratch restore, free-space gate, ledger checked by the runner itself"
```

---

### Task 13: The drill's schema-invariant assertions, kept in step with `schema-invariants.test.js`

Spec §9.7: the drill "runs the schema-invariants assertions against it". **It mirrors them; it
cannot reuse them.** `apps/core-api/test/schema-invariants.test.js` gets its connection from
`cloneTemplate(__filename)`, which builds a template *by running the migrations* — pointing it
at a restored dump is not possible, and running it as-is would assert things about
`migrations/`, not about the dump. So the rules are restated as SQL that raises on violation,
and a source-text cross-check fails when the two lists drift.

Mirrored: **S1** (tenant column), **S3** (the four anchors), **S4** (credential digests),
**S5** (`updated_at` triggers), **S7** (no plaintext-shaped columns) — plus **the owner/app
GRANT split, which the node suite deliberately does not assert**: `0001_init.sql:508-517`'s
grant block is guarded on `pg_roles` so a single-role dev database applies the file unchanged,
so asserting grants there would fail on every dev machine. On the Lightsail cluster both roles
exist, which makes the drill the only place that property is ever checked — and it is exactly
what a `--no-owner` restore silently collapses.

Not mirrored, on purpose: **S6** is what `migrate.js --check` already did in step 6 with the
runner's own digests, and **S2/S2b**'s composite-FK rule carries a thirteen-entry exception list
that would become a second source of truth and rot.

**Files:**
- Modify: `infra/restore-drill.sh` (replace the step-7 placeholder)
- Test: `apps/core-api/test/backup-restore.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/backup-restore.test.js`:

```js
// The exception lists in schema-invariants.test.js are the source of truth. Extracting them
// by regex is the same technique source-structure.test.js uses (pure fs + regex, no parser),
// and every extractor asserts it MATCHED, because an extractor that silently returns [] makes
// every loop below pass vacuously.
function arrayLiteral(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `${name} is no longer a plain array literal in schema-invariants.test.js`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0);
}

function objectKeys(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(match, `${name} is no longer a plain object literal in schema-invariants.test.js`);
  return (match[1].match(/^\s*([a-z0-9_]+):/gm) || []).map((line) => line.trim().replace(":", ""));
}

test("the exception-list extractors fail loudly rather than vacuously", () => {
  assert.deepEqual(arrayLiteral('const X = ["a", "b"];', "X"), ["a", "b"]);
  assert.deepEqual(objectKeys("const Y = {\n  a_b: [1],\n  c_d: [2]\n};", "Y"), ["a_b", "c_d"]);
  assert.throws(() => arrayLiteral('const X = ["a"];', "MISSING"), /MISSING/);
  assert.throws(() => objectKeys("const Y = {};", "MISSING"), /MISSING/);
});

test("the drill mirrors S1, S3, S4, S5 and S7 with the same exception lists", () => {
  const invariants = readText(appRoot, "test", "schema-invariants.test.js");
  const script = drill();

  const tenantExceptions = arrayLiteral(invariants, "TENANT_COLUMN_EXCEPTIONS");
  assert.equal(tenantExceptions.length, 5, "S1's exception list changed shape");
  for (const table of tenantExceptions) {
    assert.ok(script.includes(`'${table}'`), `S1 exception ${table} is missing from the drill`);
  }

  const anchors = objectKeys(invariants, "ANCHORS");
  assert.equal(anchors.length, 4, "S3's anchor list changed shape");
  for (const anchor of anchors) {
    assert.ok(script.includes(`'${anchor}'`), `S3 anchor ${anchor} is missing from the drill`);
  }

  const textHashes = arrayLiteral(invariants, "TEXT_HASH_EXCEPTIONS");
  assert.equal(textHashes.length, 1, "S4's exception list changed shape");
  for (const column of textHashes) {
    assert.ok(script.includes(column), `S4 exception ${column} is missing from the drill`);
  }

  const plaintext = arrayLiteral(invariants, "PLAINTEXT_COLUMN_NAMES");
  assert.equal(plaintext.length, 5, "S7's column list changed shape");
  for (const column of plaintext) {
    assert.ok(script.includes(`'${column}'`), `S7 name ${column} is missing from the drill`);
  }

  assert.match(script, /set_updated_at\(\)/);
  for (const invariant of ["S1:", "S3:", "S4:", "S5:", "S7:"]) {
    assert.ok(script.includes(invariant), `the drill raises no ${invariant} message`);
  }
});

test("the drill declares what it does not mirror, and asserts the grants the node suite cannot", () => {
  const script = drill();

  // An omission that is written down is a decision; an omission that is not is a hole.
  assert.match(script, /^# NOT MIRRORED: S2, S2b, S6\./m);

  // 0001's grant block is guarded on pg_roles so a single-role dev database applies it
  // unchanged, which is why schema-invariants.test.js cannot assert grants at all. Both
  // roles exist on the production cluster, so this is the only place the owner/app split
  // is ever verified -- and it is precisely what --no-owner would collapse.
  assert.match(script, /has_table_privilege\('core_api_app'/);
  assert.match(script, /pg_get_userbyid\(c\.relowner\) <> 'core_api_owner'/);
  assert.match(script, /a --no-owner restore looks exactly like this/);

  // The heredoc delimiter must stay QUOTED, or the shell expands $$ to its own PID and
  // every DO block becomes a syntax error.
  assert.match(script, /<<'SQL'/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/backup-restore.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: S1 exception audit_events is missing from the drill`, and the third new test failing on `The input did not match the regular expression /^# NOT MIRRORED: S2, S2b, S6\./m`. The first new test (the extractor self-check) passes immediately; the five earlier tests still pass.

- [ ] **Step 3: Write the minimal implementation**

In `infra/restore-drill.sh`, replace the line
`# 7. (schema-invariant assertions are inserted here by the next task)` with:

```sh
# 7. The schema-invariant assertions, MIRRORED. apps/core-api/test/schema-invariants.test.js
#    cannot be aimed at this database: it takes its connection from cloneTemplate(__filename),
#    which builds a template by RUNNING the migrations -- that tests migrations/, not a
#    restored dump. So the rules are restated here as SQL that raises on violation, and
#    apps/core-api/test/backup-restore.test.js fails if the two exception lists ever drift.
#
# NOT MIRRORED: S2, S2b, S6. S6 is what step 6 above already did, with the runner's own
#    digests. S2/S2b's composite-FK rule carries a thirteen-entry exception list that would
#    become a second source of truth and rot. Mirrored here: S1, S3, S4, S5, S7 -- plus the
#    owner/app GRANT split, which the node suite deliberately does NOT assert because
#    0001_init.sql's grant block is guarded on pg_roles so a single-role dev database applies
#    it unchanged. Both roles exist here, so this is the only place that split is ever proved.
docker compose exec -T core-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U core_api_owner -d "$1" -f -' \
  sh "$DRILL_DB" <<'SQL'
-- S1. Every base table carries company_id uuid NOT NULL, or is one of the five named
-- exceptions -- each of which has its own positive assertion in the node suite.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname NOT IN ('audit_events', 'companies', 'schema_migrations', 'user_sessions', 'users')
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
          AND a.attnotnull AND format_type(a.atttypid, a.atttypmod) = 'uuid');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'S1: tables without company_id uuid NOT NULL: %', bad;
  END IF;
END $$;

-- S3. The four composite anchors, by name, with exact ordered column lists. Postgres
-- refuses a composite FK without a matching UNIQUE, so the assertion with teeth is the
-- reverse one: a dropped anchor leaves the next table unable to declare one.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(x.name, ', ' ORDER BY x.name) INTO bad
    FROM (VALUES
      ('users_id_company_key',            'id,company_id'),
      ('shops_id_company_key',            'id,company_id'),
      ('shop_tables_id_shop_company_key', 'id,shop_id,company_id'),
      ('terminals_id_shop_company_key',   'id,shop_id,company_id')
    ) AS x(name, cols)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint con
      WHERE con.conname = x.name AND con.contype = 'u'
        AND (SELECT string_agg(att.attname::text, ',' ORDER BY u.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum) = x.cols);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'S3: missing or reshaped anchors: %', bad;
  END IF;
END $$;

-- S4. Every %_hash column is bytea with an octet_length = 32 CHECK, except
-- users.password_hash, which stores a PHC-style scrypt string by design.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(t.tbl || '.' || t.col, ', ' ORDER BY t.tbl || '.' || t.col) INTO bad
    FROM (
      SELECT c.relname AS tbl, a.attname AS col,
             format_type(a.atttypid, a.atttypmod) AS typ,
             COALESCE(string_agg(pg_get_constraintdef(con.oid), ' '), '') AS checks
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_constraint con
          ON con.conrelid = c.oid AND con.contype = 'c' AND a.attnum = ANY (con.conkey)
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname LIKE '%\_hash'
       GROUP BY c.relname, a.attname, a.atttypid, a.atttypmod) t
   WHERE CASE WHEN t.tbl || '.' || t.col = 'users.password_hash'
              THEN t.typ <> 'text' OR position('''scrypt$%''' in t.checks) = 0
              ELSE t.typ <> 'bytea' OR position('octet_length(' || t.col || ') = 32' in t.checks) = 0
         END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'S4: hash columns with the wrong shape: %', bad;
  END IF;
END $$;

-- S5. Every table with updated_at has a non-internal BEFORE UPDATE set_updated_at() trigger.
-- Conditional on the column, so the rule self-maintains. The function is matched without
-- the EXECUTE FUNCTION prefix because pg_get_triggerdef schema-qualifies the name whenever
-- public is not in the connection's search_path.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'updated_at' AND NOT a.attisdropped)
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
          AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE ON %'
          AND pg_get_triggerdef(t.oid) LIKE '%set_updated_at()%');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'S5: tables with updated_at but no set_updated_at() trigger: %', bad;
  END IF;
END $$;

-- S7. Exact names only: password_hash and token_hash are the shapes this schema wants, and
-- a substring rule would forbid them.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname || '.' || a.attname) INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND a.attname IN ('password', 'token', 'code', 'secret', 'session_id');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'S7: plaintext-shaped columns: %', bad;
  END IF;
END $$;

-- GRANTS. Not in the node suite by design, and therefore only ever checked here.
DO $$
DECLARE bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_api_app') THEN
    RAISE EXCEPTION 'GRANTS: role core_api_app does not exist - see infra/README.md, Scenario B';
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND NOT has_table_privilege('core_api_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'GRANTS: core_api_app is missing DML on: %', bad;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND pg_get_userbyid(c.relowner) <> 'core_api_owner';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'GRANTS: tables not owned by core_api_owner (a --no-owner restore looks exactly like this): %', bad;
  END IF;
END $$;
SQL
```

The heredoc delimiter is quoted (`<<'SQL'`), so the shell expands nothing inside it — which is
what lets `$$` stay dollar-quoting rather than becoming the shell's PID.

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/backup-restore.test.js`  Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add infra/restore-drill.sh apps/core-api/test/backup-restore.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "feat(infra): mirror the schema invariants into the restore drill, plus the grant split"
```

---

### Task 14: `infra/README.md` — the restore runbook, literal and paste-safe

Spec §9.8. Every quote in the runbook is a real `'`; it is written to be pasted into an ssh
session by somebody who is having a bad day, so it goes in the operations README rather than
staying in the spec. The same section states plainly what the backup does and does not protect
— the honest answer is narrower than "we have backups" implies, and the time to learn that is
not during an incident. Spec §12's final checklist line greps this file for `ALTER ROLE`, which
the rotation recipe below satisfies.

**Files:**
- Modify: `infra/README.md` (append; this area's reserved headings are `## core-db backups`
  with `### The restore drill`, `### Scenario A`, `### Scenario B` and
  `### Rotating database passwords`)
- Test: `apps/core-api/test/backup-restore.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/backup-restore.test.js`:

```js
const infraReadme = () => readText(repoRoot, "infra", "README.md");

// infra/README.md is append-only and shared by four areas of this plan. Counting a psql
// invocation across the WHOLE document sees five, not three: Scenario B's CREATE ROLE and
// the rotation recipe's ALTER ROLE use the same invocation. Anchor to the slice.
function section(document, startHeading, endHeading) {
  const start = document.indexOf(startHeading);
  assert.notEqual(start, -1, `missing heading: ${startHeading}`);
  const end = document.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(end, -1, `missing heading: ${endHeading}`);
  return document.slice(start, end);
}

function countOccurrences(source, needle) {
  let count = 0;
  let at = source.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = source.indexOf(needle, at + needle.length);
  }
  return count;
}

test("the restore runbook stops the writer, proves the dump, and drops in three psql calls", () => {
  const doc = infraReadme();
  const scenarioA = section(doc, "### Scenario A", "### Scenario B");

  // Step 0. Restore into a live writer and you get a database half old and half new.
  assert.match(scenarioA, /docker compose stop core-api/);
  // Step 1. Prove the dump is readable BEFORE destroying anything.
  assert.match(scenarioA, /pg_restore --list < ~\/backups\/pre-deploy-<ts>\.dump/);
  // Step 2. Step 3 is irreversible, so dump the broken state too.
  assert.match(scenarioA, /before-restore-\$\(date -u \+%Y%m%dT%H%M%SZ\)\.dump/);

  // Step 3. THREE separate -c invocations, in this order. Chaining a terminate ahead of a
  // DROP in one psql call means ON_ERROR_STOP aborts halfway, leaving the app stopped and
  // the restore not started. ALLOW_CONNECTIONS goes FIRST so nothing can reconnect between
  // the terminate and the drop.
  assert.equal(
    countOccurrences(scenarioA, "psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1"),
    3,
    "the drop sequence must be three separate psql invocations"
  );
  assertAscending(scenarioA, [
    "ALTER DATABASE core WITH ALLOW_CONNECTIONS false;",
    "SELECT pg_terminate_backend(pid)",
    "DROP DATABASE IF EXISTS core;"
  ]);
  const invocations = scenarioA.split("docker compose exec -T").slice(1);
  for (const statement of [
    "ALTER DATABASE core WITH ALLOW_CONNECTIONS false;",
    "SELECT pg_terminate_backend(pid)",
    "DROP DATABASE IF EXISTS core;"
  ]) {
    assert.equal(
      invocations.filter((chunk) => chunk.includes(statement)).length,
      1,
      `"${statement}" must appear in exactly one docker compose exec -T invocation`
    );
  }

  // Step 4. All-or-nothing, and NOT --no-owner.
  assert.match(scenarioA, /pg_restore -U core_api_owner -d core [\s\S]{0,80}--exit-on-error --single-transaction/);
  assert.doesNotMatch(doc, /pg_restore[^\n]*--no-owner/);

  // Step 5/6. Verify before starting the app, and read the ledger against the image.
  assert.match(scenarioA, /SELECT filename, applied_at FROM schema_migrations ORDER BY filename;/);
  assert.match(doc, /curl -fsS http:\/\/127\.0\.0\.1:3200\/health\/ready/);

  // Spec 12 forbids rehearsing this verbatim: step 3 drops the production database.
  assert.match(scenarioA, /Never rehearse Scenario A verbatim/);
  assert.match(scenarioA, /core_scenario_a/);
});

test("the runbook covers a fresh instance and the password-rotation ordering", () => {
  const doc = infraReadme();

  // Scenario B: the dump carries grants referencing core_api_app but not the role itself.
  assert.match(doc, /CREATE ROLE core_api_app LOGIN NOINHERIT PASSWORD/);
  assert.match(doc, /role core_api_app does not exist/);
  // create-platform-admin.js is Plan 2 and the runbook must not pretend otherwise.
  assert.match(doc, /create-platform-admin\.js[\s\S]{0,200}Plan 2/);

  // POSTGRES_PASSWORD is read by initdb ONLY, so editing it changes nothing on an existing
  // cluster. ALTER ROLE first, env file second. Spec 12's last checklist line greps for it.
  assert.match(doc, /ALTER ROLE core_api_owner PASSWORD/);
  assert.match(doc, /only when it creates the data directory/i);
  assert.match(doc, /DATABASE_MIGRATION_URL/);
  assert.match(doc, /apps\/core-api\/README\.md/);
});

test("the docs state what the backup does and does not protect, and how the gate behaves", () => {
  const doc = infraReadme();

  assert.match(doc, /bad migration/i);
  // The nightlies live on the instance they protect.
  assert.match(doc, /instance[\s\S]{0,120}last deploy/i);
  // No WAL archive: the recovery point is the last nightly, not the last transaction.
  assert.match(doc, /point-in-time|PITR/i);
  assert.match(doc, /Phase 3/);
  // The artifact is the only off-box copy, and it is readable by anyone with repo access.
  assert.match(doc, /scrypt hashes/);
  assert.match(doc, /data-checksums/);

  // The gate is NOT "every deploy fails on a 48-hour-old marker": before CRON_INSTALLED_AT
  // is itself 48 hours old the nightly has legitimately had no chance to run.
  assert.match(doc, /CRON_INSTALLED_AT/);
  assert.doesNotMatch(doc, /Every deploy fails the build if that marker is more than 48 hours\s*\n?\s*old/);

  // The drill runs inside the production cluster, so it is a service-hours decision.
  assert.match(doc, /same cluster production is serving from/i);
  assert.match(doc, /outside service hours/);

  // Deploy #1's pre-deploy dump is a dump of an empty core and cannot be drilled.
  assert.match(doc, /deploy #1[\s\S]{0,240}empty/i);

  assert.match(doc, /AUDIT_RETENTION_DAYS[\s\S]{0,120}Plan 2/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/backup-restore.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: missing heading: ### Scenario A` from `section()`, plus the other two new tests failing on `The input did not match the regular expression /CREATE ROLE core_api_app LOGIN NOINHERIT PASSWORD/` and `/bad migration/i`. The eight earlier tests still pass.

- [ ] **Step 3: Write the minimal implementation**

Append to `infra/README.md`:

````markdown
## core-db backups

`config/backup-core-db.sh` runs at **03:17 UTC** from the deploy user's crontab, installed by
`deploy.yml`. It writes `~/backups/nightly-<ts>.dump` (custom format, mode 600), keeps **14**,
and touches `~/backups/LAST_OK` only after the dump has been read end to end.

Verification is two-stage, and the second stage is the one that matters. `pg_dump -Fc` writes
the table of contents **first**, so `pg_restore --list` is satisfied by the first few kilobytes:
a dump truncated at 80% by a full disk passes it. `pg_restore --data-only -f /dev/null`
decompresses every data block and writes the SQL nowhere, so it is the only check that actually
reaches the end of the file.

`LAST_OK` is the nightly's **only** failure signal — `set -eu` exits the script early, its
output goes to `~/backups/backup.log` which nobody reads, and cron's `MAILTO` goes to a local
mailbox on a box with no MTA. The deploy therefore checks it, but not from day one: when it
first installs the crontab line it writes a bootstrap marker `~/backups/CRON_INSTALLED_AT`, and
only once **that** marker is more than 48 hours old does a missing or stale `LAST_OK` fail the
build. Before then the gate is deliberately quiet, because the nightly has legitimately had no
chance to run. If a deploy prints `no successful core-db nightly in 48h`, read `backup.log` from
the bottom; the usual causes are a full disk and an OOM-killed `pg_dump`.

The deploy also takes a **pre-deploy dump** (`~/backups/pre-deploy-<ts>.dump`) before every
migration, gated on the *volume* rather than on a running container, and uploads it as a GitHub
Actions artifact with 14-day retention. **Deploy #1's pre-deploy dump is a dump of an empty
`core`** — the volume is created moments earlier and the dump is taken before the service has
ever migrated — so it is not a useful drill target and `migrate.js --check` will correctly
reject it. From deploy #2 onward it is the dump Scenario A restores.

**What this protects, and what it does not:**

| Failure | Covered? |
| --- | --- |
| Bad migration, bad `DELETE`, logical corruption | **Yes** — the pre-deploy dump plus up to 14 nightlies |
| Volume deleted, filesystem corruption | **Yes**, back to the last nightly: up to 24 hours of loss |
| Instance lost | **Only back to the last deploy.** The nightlies live on the instance they protect; the pre-deploy artifact is the sole off-box copy |
| Point-in-time recovery | **No.** There is no WAL archive. The recovery point is the last nightly, not the last transaction. Deferred to Phase 3 by decision |

Said out loud: the uploaded artifact contains **email addresses, IP addresses and scrypt
hashes**, readable by anyone with access to this repository. For a private personal repo that
is an acceptable trade against having no off-box copy at all; the upgrade path is a write-only
bucket.

The cheapest complement is a checkbox, not code: enable **Lightsail automatic instance
snapshots**, understanding that a snapshot is crash-consistent, not logical. The cluster is
initialised with `--data-checksums`, which is what makes a corrupt restored page loud instead of
silent.

`AUDIT_RETENTION_DAYS` configures nothing until `scripts/sweep-expired.js` ships in **Plan 2**;
`audit_events` grows without trimming until then, and the deploy installs only the backup
crontab line.

### The restore drill

```sh
cd ~/restaurant-order-system
./config/restore-drill.sh                                 # newest nightly -- the normal case
./config/restore-drill.sh ~/backups/pre-deploy-<ts>.dump  # a specific dump, deploy #2 onward
```

It restores into `core_restore_check`, refuses to start without headroom, proves the dump is not
an empty or wrong one, asserts the migration ledger against the running image using the
production runner in `--check` mode, mirrors the schema invariants, prints a row count per table
and drops the scratch database. On failure it leaves the scratch database in place and prints
the commands to inspect and drop it. **It never touches `core`.**

It restores into the **same cluster production is serving from** — there is one instance — so it
doubles the data footprint plus WAL alongside live traffic. Run it **outside service hours**,
for the same reason the deploy window exists. It refuses outright unless at least three times
the dump size is free on `/` and the disk is under 70% used, printing
`restore-drill: refusing, need <n> bytes free, have <m>`.

Run it **once by hand before the first core-api deploy is trusted**, then monthly. A backup
nobody has restored is not a recovery plan.

### Scenario A — roll back a bad migration

Every quote below is a real `'`. Paste it as written.

> **Never rehearse Scenario A verbatim on the box — step 3 drops the production database.**
> To rehearse, substitute `core_scenario_a` for `core` in steps 3–5 and leave a dated receipt
> at `~/backups/SCENARIO_A_REHEARSED`. `config/restore-drill.sh` already rehearses steps 1, 3,
> 4, 5 and 6 against a scratch database, which is why running it costs no downtime.

```sh
cd ~/restaurant-order-system
export CORE_ENV_FILE=../core-api.env
export EPAPER_ENV_FILE=../restaurant-order-system.env

# 0. STOP THE WRITER FIRST, or you get a database half old and half new.
docker compose stop core-api

# 1. Prove the dump is READABLE before destroying anything.
ls -la ~/backups
docker compose exec -T core-db pg_restore --list < ~/backups/pre-deploy-<ts>.dump | head -30

# 2. Dump the CURRENT (broken) state anyway. Step 3 is irreversible.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d core -Fc' \
  > ~/backups/before-restore-$(date -u +%Y%m%dT%H%M%SZ).dump

# 3. Lock out reconnects, terminate, then drop. THREE separate -c invocations: chaining a
#    terminate ahead of a DROP in one psql call means ON_ERROR_STOP aborts halfway, leaving
#    the app stopped and the restore not started. ALLOW_CONNECTIONS goes FIRST so nothing --
#    including a `restart: unless-stopped` container -- can reconnect between the terminate
#    and the drop.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "ALTER DATABASE core WITH ALLOW_CONNECTIONS false;"'
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '"'"'core'"'"' AND pid <> pg_backend_pid();"'
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS core;" -c "CREATE DATABASE core OWNER core_api_owner;"'

# 4. Restore, all-or-nothing. Do NOT pass --no-owner: the owner/app split is the point of
#    this schema and --no-owner collapses it.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U core_api_owner -d core \
  --exit-on-error --single-transaction' < ~/backups/pre-deploy-<ts>.dump

# 5. VERIFY BEFORE STARTING THE APP.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d core \
  -c "SELECT filename, applied_at FROM schema_migrations ORDER BY filename;" \
  -c "SELECT role, status, count(*) FROM users GROUP BY 1,2 ORDER BY 1,2;"'
```

The freshly created `core` allows connections by default, so nothing needs undoing from step 3.

**Step 6 is the one everybody gets wrong.** Read that ledger against the migrations in the
running image:

- Dump **older** than the image (a file on disk with no row): the runner will **re-apply** it on
  the next start. If that migration is what broke you, you have restored nothing — roll the
  image back in the same operation with
  `CORE_API_IMAGE=core-api:<previous-sha> docker compose up -d core-api`.
- Dump **newer** than the image (a row with no file): the runner logs a WARNING and starts. That
  is deliberate, and this is the moment the decision earns its keep.

Then `docker compose up -d core-api`, `docker compose logs -f --tail 100 core-api`, and
`curl -fsS http://127.0.0.1:3200/health/ready`.

### Scenario B — a fresh instance

The dump contains grants referencing `core_api_app` but **not the role itself**. Skipping this
step yields a wall of *"role core_api_app does not exist"* and, with `--single-transaction`, a
full rollback — loud, which is correct.

```sh
docker compose up -d core-db     # initdb creates core_api_owner from POSTGRES_PASSWORD
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE core_api_app LOGIN NOINHERIT PASSWORD '"'"'<the password inside DATABASE_URL>'"'"';"'
```

Then run Scenario A from step 4.

If there is **no dump at all** — a genuinely new deployment — the database is empty and the first
platform administrator is created with `apps/core-api/scripts/create-platform-admin.js`. **That
script ships in Plan 2.** Until it does, a fresh instance has no way to create the first user,
which is one more reason the pre-deploy artifact matters.

### Rotating database passwords

The *why* is in `apps/core-api/README.md`, "Rotating database passwords". The order below is not
negotiable, because **`POSTGRES_PASSWORD` is read by the image only when it creates the data
directory** — editing it afterwards changes nothing, and an operator who does only that will
believe the credential rotated for months.

```sh
# 1. Change the role in the RUNNING cluster first.
docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE core_api_owner PASSWORD '"'"'<new>'"'"';"'

# 2. Then edit ~/core-api.env in BOTH places, in one edit: POSTGRES_PASSWORD and the password
#    inside DATABASE_MIGRATION_URL. core-api refuses to listen if they disagree -- that check
#    exists precisely to catch "somebody edited one line and not the other".
chmod 600 ~/core-api.env

# 3. Restart.
cd ~/restaurant-order-system && CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose up -d
```

The **app** password needs none of this: edit `DATABASE_URL` and redeploy, because the migration
runner issues `ALTER ROLE core_api_app … PASSWORD` on every boot.

If startup dies with `DATABASE_MIGRATION_URL was rejected by the server (28P01)`, the secrets
file was rotated and the cluster was not. Go back to step 1.
````

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/backup-restore.test.js`  Expected: PASS (11 tests)

`infra/README.md` is also asserted by the epaper-hub suite — `deploy-config.test.js:170` reads it
directly and `:114-135` forbids `?table=` and `table_number` anywhere in it — so that suite must
stay green:

Run: `node --test apps/epaper-hub/test/deploy-config.test.js`  Expected: PASS (14 tests)

And the core-api suite, whose `infra/README.md` rule from Task 4 this task's appended
`docker compose` lines have to satisfy:

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add infra/README.md apps/core-api/test/backup-restore.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "docs(infra): the core-db restore runbook, scenario B, and password-rotation order"
```

---

### Task 15: Run the drill by hand — the gate this area does not ship without

Spec §9.7 (*"Run it once by hand before Phase 1 ships"*) and §9.11 step 9 (*"Do not skip it
because it is the day everything worked — that is exactly when it is cheap"*). No test can do
this: it needs a real dump, a real cluster and a real restore. What **is** testable is that the
requirement is written down where the operator will look, so this task adds the pre-cutover
checklist to `infra/README.md` and asserts it, then states the manual run.

**This area is not finished until the MANUAL VERIFICATION block below has been performed and its
checklist box in `infra/README.md` is ticked in a commit.**

**Files:**
- Modify: `infra/README.md` (append; reserved heading `## Before core-api's first production deploy`)
- Test: `apps/core-api/test/backup-restore.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/core-api/test/backup-restore.test.js`:

```js
test("infra/README.md carries the pre-cutover checklist, drill included", () => {
  const doc = infraReadme();

  assert.match(doc, /^## Before core-api's first production deploy$/m);
  for (const item of [
    /- \[[ x]\] `~\/core-api\.env` exists/,
    /- \[[ x]\] `~\/backups` exists at mode 700/,
    /- \[[ x]\] `config\/backup-core-db\.sh` has been run by hand/,
    /- \[[ x]\] \*\*`config\/restore-drill\.sh` has been run by hand once, with NO argument/,
    /- \[[ x]\] Scenario A rehearsed against `core_scenario_a`/,
    /- \[[ x]\] `crontab -l \| grep -q backup-core-db\.sh` exits 0/
  ]) {
    assert.match(doc, item);
  }

  // The order is the point: the drill needs a nightly, and deploy #1's pre-deploy dump is
  // a dump of an empty core that migrate.js --check correctly rejects.
  assertAscending(doc, [
    "`config/backup-core-db.sh` has been run by hand",
    "`config/restore-drill.sh` has been run by hand once, with NO argument"
  ]);

  // The drill is the gate, not a nice-to-have, and the README says so in words an operator
  // reading it at 02:00 cannot talk themselves out of.
  assert.match(doc, /not finished until this box is ticked/i);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/backup-restore.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^## Before core-api's first production deploy$/m`. The eleven earlier tests still pass.

- [ ] **Step 3: Write the minimal implementation**

Append to `infra/README.md`:

```markdown
## Before core-api's first production deploy

Tick these on the box, in this order. They are host state, not repository state, so nothing in
CI can check them for you.

- [ ] `~/core-api.env` exists at mode 600 with `POSTGRES_PASSWORD`, `DATABASE_MIGRATION_URL` and
      `DATABASE_URL`, and `~/restaurant-order-system.env` is untouched
- [ ] `~/backups` exists at mode 700
- [ ] `config/backup-core-db.sh` has been run by hand once and left one `nightly-*.dump` at mode
      600, a `LAST_OK`, and no `*.part`
- [ ] **`config/restore-drill.sh` has been run by hand once, with NO argument — against that
      nightly — and exited 0.** Not against deploy #1's `pre-deploy-*.dump`: that is a dump of an
      empty `core` taken before the service had ever migrated, and the drill will correctly
      reject it. This work is not finished until this box is ticked. Do not skip it because it
      is the day everything worked — that is exactly when it is cheap
- [ ] Scenario A rehearsed against `core_scenario_a`, never against `core`, with a dated receipt
      at `~/backups/SCENARIO_A_REHEARSED`
- [ ] `crontab -l | grep -q backup-core-db.sh` exits 0
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/backup-restore.test.js`  Expected: PASS (12 tests)

Then every suite this area touches, from the repository root — including the core-api
deploy-config suite, whose Task 4 rule governs the `docker compose` lines this task
appends to `infra/README.md`:

Run: `node --test apps/core-api/test/backup-restore.test.js apps/epaper-hub/test/deploy-config.test.js apps/core-api/test/deploy-config.test.js`
Expected: PASS (12 + 14 + 6 = 32 tests), `# fail 0`

**Do not use `npm test` here.** `apps/core-api`'s `pretest` no-ops without
`CORE_API_TEST_DATABASE_URL`, but the database-backed suites then fail rather than skip — at
HEAD today the core-api suite reports 242 tests with 16 failing and 37 cancelled on a machine
with no Postgres. That is unrelated to this area and would bury its result. Run the two files
above; run `npm test` only on a machine with the local Postgres from
`apps/core-api/README.md`, "Local Postgres".

**MANUAL VERIFICATION — runs once, on the Lightsail host, at cutover. This is not a test, and
nothing in CI performs it.** It requires the `workflow` handoff (a) to have shipped, and it runs
**after the first successful core-api deploy**, not against that deploy's pre-deploy dump.

1. Take a real nightly by hand, because the drill needs one and deploy #1's pre-deploy dump is a
   dump of an empty `core`:
   ```sh
   cd ~/restaurant-order-system
   ./config/backup-core-db.sh; echo "exit=$?"
   ls -1t ~/backups/nightly-*.dump | head -1
   ```
   Expected: no output from the script, `exit=0`, and one path, e.g.
   `/home/ubuntu/backups/nightly-20260731T120000Z.dump`.
2. `./config/restore-drill.sh`
   Expected, in this order:
   ```
   restore-drill: dump    /home/ubuntu/backups/nightly-<ts>.dump
   restore-drill: bytes   <a number in the tens of thousands, not 0 and not a few hundred>
   restore-drill: free    <a large number> bytes, disk <n>% used
   CREATE DATABASE
   migration 0001_init.sql sha256:<12 hex chars> already applied
   migrations: 0 applied, 1 already applied (check mode, nothing was applied)
   DO
   DO
   DO
   DO
   DO
   DO
        table_name      | rows
   ---------------------+------
    audit_events        |    0
    companies           |    0
    ...
    schema_migrations   |    1
   restore-drill: PASS - core_restore_check dropped
   ```
   `users | 0` before the Plan-2 bootstrap CLI exists is normal, not a failure.
3. `echo $?`
   Expected: `0`
4. Prove the drill is not vacuous — a drill that passes on anything proves nothing. Restore an
   **empty** database through it:
   ```sh
   docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d postgres -Fc' > /tmp/empty.dump
   ./config/restore-drill.sh /tmp/empty.dump; echo "exit=$?"
   ```
   Expected: `restore-drill: only 0 base tables restored; expected at least 11`, then
   `restore-drill: FAIL (exit 1). core_restore_check was LEFT IN PLACE for inspection.` followed
   by the two printed commands, and `exit=1`. This is the message that must fire — not
   `pending migration(s) never applied` — which is why the table count runs ahead of the ledger
   check.
5. Drop the leftover with the `drop:` command the drill printed, then `rm -f /tmp/empty.dump`.
6. `docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U core_api_owner -d postgres -tAc "SELECT datname FROM pg_database WHERE datname LIKE '"'"'core%'"'"'"'`
   Expected: `core` only. No `core_restore_check`.
7. `curl -fsS http://127.0.0.1:3200/health/ready`
   Expected: the readiness body, HTTP 200 — the drill left production untouched.
8. `crontab -l | grep -q backup-core-db.sh; echo "cron=$?"` and `ls -l ~/backups/CRON_INSTALLED_AT`
   Expected: `cron=0`, and one zero-byte marker dated at the first deploy.
9. Tick the drill box and the backup box in `infra/README.md`, commit and push.

- [ ] **Step 5: Commit**

```bash
git add infra/README.md apps/core-api/test/backup-restore.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "docs(infra): pre-cutover checklist - the restore drill is the gate"
```

---

## Part 4 — `.github/workflows/deploy.yml`

### Task 16: Serialise production deploys, pin `*.yml` to LF, and parse the workflow as YAML

Spec §9.5 opens with the concurrency key and calls it **a blocker, not hardening**. `.github/workflows/deploy.yml` has no `concurrency:` key today, so two pushes run two jobs against one host, one project directory, one set of fixed `/tmp/*.tgz` paths and one set of fixed `container_name:` values. Push B's scp overwrites the image A has not loaded; A's `find … -exec rm -rf {} +` runs while B is still scp-ing; both run `docker compose up -d` with different `CORE_API_IMAGE` values; whichever core-api wins the advisory lock migrates and the other exits 1 and is restarted into an already-migrated database. If the survivor is A, the runner's reconciliation finds a row with no file, logs a WARNING and starts — **production runs sha A's code against sha B's schema, both builds green, `/health/ready` 200**. `cancel-in-progress: false` specifically: cancelling mid-`ssh` heredoc kills the local SSH client without stopping the remote shell, which is exactly how you orphan the migration advisory lock.

This is the first deploy.yml task in the area on purpose. Every later task widens the deploy; none of them is safe to run twice at once.

Two other things land here because they are the same class of problem — a file that reads correctly and behaves differently.

**`*.yml text eol=lf`.** `.gitattributes` pins only `*.sql` and `*.sh`. `deploy.yml` carries an `ssh … <<'EOF'` heredoc whose body **is the remote shell's stdin**: checked out with CRLF, every line of that script arrives on the Lightsail box with a trailing `\r` — the exact failure `*.sh text eol=lf` exists to prevent, one indirection further away. This repository's `core.autocrlf` is `false` today and the file is LF, so the attribute produces no diff now; it is insurance against the next clone.

**Parse the workflow as YAML, not only as text.** Every assertion in this area is a regex over file text. A regex cannot see an indentation slip, and an indentation slip yields `Invalid workflow file` — after which **GitHub runs nothing at all: no tests, no deploy, and no red X on the commit**. So each deploy.yml task's Step 4 also parses the file. **If a text assertion fails, the fix is the YAML, never the regex.**

**Prerequisite:** `apps/core-api/test/deploy-config.test.js` must already exist — the compose area creates it with the module header (`node:assert/strict`, `node:fs`, `node:path`, `node:test`) and the shared helpers `readText` (CRLF-normalising), `composeText`, `servicesOf` and `workflowText`, plus its own first six tests. This area only ever appends top-level `test()` blocks at the end of that file and redeclares no helper.

**Files:**
- Modify: `.github/workflows/deploy.yml` (insert nine lines between `branches: [main]` and `jobs:`)
- Modify: `.gitattributes` (append one commented rule)
- Modify: `apps/core-api/test/source-structure.test.js` (one line added inside the existing C12 test)
- Test: `apps/core-api/test/deploy-config.test.js` (append)

- [ ] **Step 1: Write the failing test**

In `apps/core-api/test/source-structure.test.js`, inside the existing `C12` test, replace the line that currently reads:

```js
  assert.match(attributes, /^\*\.sh text eol=lf$/m);
```

with:

```js
  assert.match(attributes, /^\*\.sh text eol=lf$/m);

  // .github/workflows/deploy.yml carries an `ssh … <<'EOF'` heredoc whose body IS the
  // remote shell's stdin, so a CRLF checkout ships \r on every line of that script.
  assert.match(attributes, /^\*\.yml text eol=lf$/m);
```

Then append to the end of `apps/core-api/test/deploy-config.test.js`:

```js
test("deploy workflow serialises production deploys with a concurrency group", () => {
  const workflow = workflowText();

  // Two simultaneous deploys share one host, one project directory, one set of
  // container_name: values and one set of fixed /tmp paths. Spec 9.5 calls this a
  // blocker, not hardening.
  assert.match(workflow, /^concurrency:$/m);
  assert.match(workflow, /^  group: deploy-production$/m);

  // cancel-in-progress: false SPECIFICALLY. Cancelling mid-ssh kills the LOCAL SSH
  // client and leaves the remote shell running, which is how the migration advisory
  // lock gets orphaned.
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/);

  // Workflow level, not job level: a job-level key would not serialise across runs.
  const concurrencyAt = workflow.indexOf("\nconcurrency:");
  const jobsAt = workflow.indexOf("\njobs:");
  assert.ok(
    concurrencyAt > -1 && jobsAt > -1 && concurrencyAt < jobsAt,
    "concurrency: must be declared at workflow level, above jobs:",
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-name-pattern="C12" apps/core-api/test/source-structure.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^\*\.yml text eol=lf$/m` and `# fail 1`.

Run: `node --test --test-name-pattern="serialises production deploys" apps/core-api/test/deploy-config.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^concurrency:$/m. Input:` followed by the workflow text, and `# fail 1`.

- [ ] **Step 3: Write the minimal implementation**

Append to `.gitattributes`:

```gitattributes

# .github/workflows/deploy.yml carries an `ssh … <<'EOF'` heredoc whose body IS the
# remote shell's stdin. Checked out with CRLF, every line of that script reaches the
# Lightsail box with a trailing \r -- the same failure `*.sh text eol=lf` prevents,
# one indirection away. It is also what makes the `^`/`$`-anchored deploy-config
# assertions mean the same thing on win32 and on ubuntu-latest.
*.yml text eol=lf
```

In `.github/workflows/deploy.yml`, replace lines 1–8, which currently read:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
```

with:

```yaml
name: Deploy

on:
  push:
    branches: [main]

# One host, one project directory, one set of container_name: values, one set of fixed
# /tmp paths. Two pushes deploying at once end with production running sha A's code
# against sha B's schema and both builds green (spec 9.5). cancel-in-progress: false
# because cancelling in the middle of the ssh heredoc kills the LOCAL SSH client
# without stopping the remote shell, which orphans the migration advisory lock.
concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy:
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-name-pattern="serialises production deploys" apps/core-api/test/deploy-config.test.js`  Expected: PASS (1 test — `# pass 1`, `# fail 0`)

Run: `node --test --test-name-pattern="C12" apps/core-api/test/source-structure.test.js`  Expected: PASS (1 test)

Now parse the file as YAML. A text assertion cannot see an indentation slip, and an invalid workflow makes GitHub run **nothing** — no tests, no deploy, no red X:

Run: `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy.yml')); assert d['concurrency']['group']=='deploy-production'; assert d['concurrency']['cancel-in-progress'] is False; print(len(d['jobs']['deploy']['steps']),'steps')"`  Expected: `12 steps`, no traceback

If python or PyYAML is unavailable, run: `npx --yes actionlint`  Expected: no output

The standing form of that command also carries `assert 'postgres' in d['jobs']['deploy']['services']`. It is omitted **here only** because the service block does not exist until the next task; the full command, with that clause, is the Step 4 of the CI-service task and of this area's final task. Do not delete the clause from those — deferring it by one commit is fine, dropping it is not.

Finally confirm the new attribute did not renormalise anything (this repository is `core.autocrlf=false` and already LF, so it should not):

Run: `git status --porcelain`  Expected: only the four files this task touched

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml .gitattributes apps/core-api/test/source-structure.test.js apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "ci: serialise production deploys with a concurrency group and pin yml to lf"
```

---

### Task 17: Run the core-api suite in CI against a Postgres service container

Spec §8.9. `apps/core-api`'s suite clones a template database per test file; without a real Postgres in the job it cannot run at all. The service goes in the **existing `deploy` job** rather than a separate `test.yml`, because `deploy.yml` is currently both the test gate and the deployer, and splitting them lets a push deploy without tests unless a `needs:` edge is wired.

This task also creates `apps/core-api/test/ci-contract.test.js`, which the spec names by filename in §8.1, §9.12 and §12 BREAK 7 — verbatim: *"delete the `services: postgres:` block from .github/workflows/deploy.yml; ONLY test/ci-contract.test.js reports 'not ok'"*. It is a pure, database-free suite, so it still runs under `CORE_API_SKIP_DB_TESTS=1`, which §12 also requires.

Step 4 reproduces the CI database **locally, before the first push**. This is the first time those 242 tests ever run as a superuser maintenance role on port 5432 rather than as `core_api_owner` on 5433, and a failure there is a failure you want on your own machine rather than in a run that also deploys.

**Files:**
- Modify: `.github/workflows/deploy.yml` (job-level `services:` block; two new steps after the customer-order steps)
- Create: `apps/core-api/test/ci-contract.test.js`
- Test: `apps/core-api/test/ci-contract.test.js` (the file is both)

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/ci-contract.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// apps/core-api/test/ -> apps/core-api/ -> apps/ -> repository root
const repoRoot = path.join(__dirname, "..", "..", "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "deploy.yml");

// Every read normalises CRLF, the same rule as source-structure.test.js's readText().
// These are `^`/`$`-anchored assertions against a .yml file; .gitattributes pins the
// extension as the belt, and this is the braces.
function readWorkflow() {
  return fs.readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");
}

test("CI runs the core-api suite against a real Postgres service container", () => {
  const workflow = readWorkflow();

  // Spec 8.9: a job-level service container in the EXISTING deploy job. A separate
  // test.yml would let a push deploy without tests unless a needs: edge were wired.
  assert.match(workflow, /^    services:$/m);
  assert.match(workflow, /^      postgres:$/m);

  // Pinned to the same literal tag the production compose file uses. An unpinned tag
  // eventually pulls a major the schema was never applied against.
  assert.match(workflow, /image: postgres:16-alpine/);

  // -h 127.0.0.1 for the same reason as production: during initdb the entrypoint runs
  // a temporary server on the unix socket only, so a socket pg_isready reports healthy
  // while TCP is still refused and the first client connection is refused.
  assert.match(workflow, /--health-cmd "pg_isready -U postgres -h 127\.0\.0\.1"/);

  assert.match(workflow, /npm --prefix apps\/core-api ci/);
  assert.match(workflow, /npm --prefix apps\/core-api test/);

  // The MAINTENANCE database the harness connects to in order to create the template
  // and the per-file clones -- never the database under test.
  assert.match(
    workflow,
    /CORE_API_TEST_DATABASE_URL: postgres:\/\/postgres:postgres@127\.0\.0\.1:5432\/postgres/,
  );
});

test("CI never sets the database-test escape hatch", () => {
  const workflow = readWorkflow();

  // CORE_API_SKIP_DB_TESTS=1 is the one deliberate hatch for a laptop with no Postgres,
  // and it produces VISIBLE TAP skips there. Set in CI it would turn the schema and
  // choke-point suites into a green no-op, which is the single failure this file exists
  // to prevent.
  assert.doesNotMatch(workflow, /CORE_API_SKIP_DB_TESTS/);
});

test("the core-api test step runs after the other suites and before the image build", () => {
  const workflow = readWorkflow();

  const customerAt = workflow.indexOf("npm --prefix apps/customer-order test");
  const coreAt = workflow.indexOf("npm --prefix apps/core-api test");
  const buildAt = workflow.indexOf("name: Build images");

  assert.ok(customerAt > -1 && coreAt > customerAt, "core-api steps must follow customer-order");
  assert.ok(buildAt > -1 && coreAt < buildAt, "core-api tests must run before Build images");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/ci-contract.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^    services:$/m.` and `# fail 3` — all three fail, because there is no `services:` block, no `CORE_API_SKIP_DB_TESTS` string either way is irrelevant to test 2 (it passes) … in practice `# fail 2`, tests 1 and 3, since `npm --prefix apps/core-api test` is absent so `indexOf` returns `-1`. Either way the run is red and test 1 is the first failure.

- [ ] **Step 3: Write the minimal implementation**

In `.github/workflows/deploy.yml`, replace the two lines that currently read:

```yaml
    runs-on: ubuntu-latest
    steps:
```

with:

```yaml
    runs-on: ubuntu-latest

    # apps/core-api's suite clones a template database per test file, so it cannot run
    # at all without a real Postgres in the job. This goes in the EXISTING deploy job,
    # not a separate test.yml: deploy.yml is both the test gate and the deployer, and
    # splitting them lets a push deploy without tests unless a needs: edge is wired
    # (spec 8.9).
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        # -h 127.0.0.1 for the same reason as production: during initdb the entrypoint
        # runs a temporary server on the unix socket only, so a socket pg_isready
        # reports healthy while TCP is still refused.
        options: >-
          --health-cmd "pg_isready -U postgres -h 127.0.0.1"
          --health-interval 5s --health-timeout 5s --health-retries 10

    steps:
```

Then replace the line that currently reads:

```yaml
      - run: npm --prefix apps/customer-order test
```

with:

```yaml
      - run: npm --prefix apps/customer-order test

      - run: npm --prefix apps/core-api ci

      - run: npm --prefix apps/core-api test
        env:
          # The MAINTENANCE database the harness connects to in order to create the
          # template and the per-file clones -- never the database under test. CI runs
          # as `postgres`, which config.js permits because the core_api_owner username
          # rule is production-only.
          CORE_API_TEST_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/postgres
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/ci-contract.test.js`  Expected: PASS (3 tests — `# pass 3`, `# fail 0`)

Parse the workflow as YAML, now in its full standing form:

Run: `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy.yml')); assert d['concurrency']['group']=='deploy-production'; assert d['concurrency']['cancel-in-progress'] is False; assert 'postgres' in d['jobs']['deploy']['services']; print(len(d['jobs']['deploy']['steps']),'steps')"`  Expected: `14 steps`, no traceback. Fallback if PyYAML is unavailable: `npx --yes actionlint`, expected no output

Prove the new file is legal under Plan 1's hygiene rule C13 (`test/` holds only `*.test.js`):

Run: `node --test apps/core-api/test/source-structure.test.js`  Expected: `# fail 0`

**Now reproduce the CI database locally, before the first push.** These 242 tests have never run as a superuser maintenance role on port 5432:

```bash
docker run -d --name core-ci-probe -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:16-alpine
CORE_API_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm --prefix apps/core-api test
docker rm -f core-ci-probe
```

PowerShell equivalent for the middle line: `$env:CORE_API_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/postgres"; npm --prefix apps/core-api test`

Expected: `# fail 0` **with nonzero pass counts in the database-backed suites** — `schema-invariants`, `migrate`, `db-index`, `db-health`, `fixtures-two-tenant`, `testing-database-clone` and `scripts`. That is the pass condition: a run where those report zero tests is the skip path, not a green suite. (There is no `tenant-isolation.test.js` yet; that suite arrives with Plan 2's repositories.)

Then prove the skip hatch still works and this new file is unaffected by it:

Run: `CORE_API_SKIP_DB_TESTS=1 npm --prefix apps/core-api test` (PowerShell: `$env:CORE_API_SKIP_DB_TESTS="1"; npm --prefix apps/core-api test`)  Expected: `# fail 0` with a nonzero skip count, and `ci-contract` reported as **run**, not skipped

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml apps/core-api/test/ci-contract.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "ci: run the core-api suite against a postgres service container"
```

---

### Task 18: Upload the nginx configs and both infra scripts, and create `config/` and `~/backups`

Spec §9.5's upload block. Two placements are load-bearing and neither is obvious.

**`api.conf` and `core-api-proxy.conf` go to `/tmp`, not to `~/restaurant-order-system/`.** The `find ~/restaurant-order-system -mindepth 1 -maxdepth 1 ! -name docker-compose.yml ! -name config -exec rm -rf {} +` at `:84` deletes anything else in that directory — a file scp'd "alongside the compose file" is erased before `docker compose up -d`, the workflow-text assertion stays green, and the network half of the rate limiting silently never ships.

**`backup-core-db.sh` and `restore-drill.sh` go under `config/`,** the one directory that `find` preserves. `restore-drill.sh` in particular: spec §9.7 writes it as `scripts/restore-drill.sh`, and that path is superseded. It is a **host** script driving `docker compose`, which does not exist inside the image, so it has to live on the box — and without this scp line the restore drill is never on the box at all.

`~/backups` is created 0700 here, before block 1 ever writes a dump into it.

**Prerequisites, all from other areas.** The compose area's Task 1 (`git mv` to a root `docker-compose.yml`, and the `:49` scp source path) must have landed. The nginx area must have created `infra/nginx/api.conf` and `infra/nginx/core-api-proxy.conf`; the backup area must have created `infra/backup-core-db.sh` and `infra/restore-drill.sh`. The `fs.existsSync` assertions below are exactly what turns "a scp of a file no area ever wrote" from a red deploy into a red `node --test`.

**The legacy config migration at `:72-74` must change in this same commit.** The `mkdir -p
~/restaurant-order-system/config` above runs in the `Upload app` step, which runs *before*
`Deploy on Lightsail`. So from the moment this task lands, `[ ! -d
~/restaurant-order-system/config ]` is permanently false, the `mv` below it is dead code, and
the only line left touching the source is `rm -rf ~/epaper-emulator` — which deletes the
legacy config **unmigrated**. Making the guard content-aware and copying instead of moving
also removes the `config/config` nesting the `mv` would produce if the guard were ever
reached. This is not a separate concern that can wait for a later task: the commit that adds
the `mkdir` is the commit that creates the defect.

**Files:**
- Modify: `.github/workflows/deploy.yml` (the `Upload app` step, and the legacy config
  migration at `:72-74`)
- Test: `apps/core-api/test/deploy-config.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/deploy-config.test.js`:

```js
test("deploy workflow uploads the nginx configs and both infra scripts", () => {
  const workflow = workflowText();
  const root = path.join(__dirname, "..", "..", "..");

  // ~/backups must exist and be 0700 before block 1 writes the first pre-deploy dump
  // into it, and config/ is the one directory the deploy's find preserves.
  assert.match(
    workflow,
    /mkdir -p ~\/restaurant-order-system\/config ~\/backups && chmod 700 ~\/backups/,
  );

  // The mkdir above runs in Upload app, BEFORE Deploy on Lightsail, so `[ ! -d
  // ~/restaurant-order-system/config ]` is false from this commit onward: the mv is
  // dead code and `rm -rf ~/epaper-emulator` becomes the only line touching the legacy
  // config. Content-aware, and a copy -- `mv` into an existing directory would also
  // produce config/config.
  assert.match(workflow, /\[ -z "\$\(ls -A ~\/restaurant-order-system\/config 2>\/dev\/null\)" \]/);
  assert.match(workflow, /cp -a ~\/epaper-emulator\/config\/\. ~\/restaurant-order-system\/config\//);
  assert.doesNotMatch(workflow, /\[ ! -d ~\/restaurant-order-system\/config \]/);
  assert.doesNotMatch(workflow, /mv ~\/epaper-emulator\/config ~\/restaurant-order-system\/config/);

  // Nginx files land in /tmp. The find in the deploy heredoc deletes everything in
  // ~/restaurant-order-system that is not docker-compose.yml or config/, so a file
  // scp'd "alongside the compose file" is erased before docker compose up -d while
  // every text assertion here would still be green.
  assert.match(workflow, /scp -i [^\n]*infra\/nginx\/api\.conf [^\n]*:\/tmp\/api\.conf"/);
  assert.match(
    workflow,
    /scp -i [^\n]*infra\/nginx\/core-api-proxy\.conf [^\n]*:\/tmp\/core-api-proxy\.conf"/,
  );
  assert.doesNotMatch(
    workflow,
    /scp -i [^\n]*api\.conf [^\n]*:~\/restaurant-order-system\/api\.conf/,
  );

  // Both host scripts go under config/. restore-drill.sh drives `docker compose`, so
  // it cannot live inside the image -- spec 9.7's scripts/ path is superseded, and
  // without this line the drill is never on the box.
  assert.match(
    workflow,
    /scp -i [^\n]*infra\/backup-core-db\.sh [^\n]*:~\/restaurant-order-system\/config\/backup-core-db\.sh"/,
  );
  assert.match(
    workflow,
    /scp -i [^\n]*infra\/restore-drill\.sh [^\n]*:~\/restaurant-order-system\/config\/restore-drill\.sh"/,
  );

  // Every scp SOURCE that is a tracked repository file must exist, or the deploy dies
  // on the box for a reason node --test could have caught. The image tarballs are
  // build outputs and are deliberately not in this list.
  for (const source of [
    "docker-compose.yml",
    "infra/nginx/api.conf",
    "infra/nginx/core-api-proxy.conf",
    "infra/backup-core-db.sh",
    "infra/restore-drill.sh",
  ]) {
    assert.ok(
      fs.existsSync(path.join(root, source)),
      `${source} is scp'd by the Upload app step but does not exist in the working tree`,
    );
  }
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-name-pattern="uploads the nginx configs" apps/core-api/test/deploy-config.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /mkdir -p ~\/restaurant-order-system\/config ~\/backups && chmod 700 ~\/backups/.`

- [ ] **Step 3: Write the minimal implementation**

In `.github/workflows/deploy.yml`, replace the `Upload app` step with the following. **Two lines here belong to the compose area and are already present when this task runs** — the `scp … docker-compose.yml` line (its Task 1) and the `scp … /tmp/core-api-image-${{ github.sha }}.tgz` line (its core-api service task). They are shown for context; do not retype them differently, and do not add them if they are absent — run compose's tasks first.

```yaml
      - name: Upload app
        run: |
          set -euo pipefail
          # config/ is the one directory the deploy's `find` preserves, and ~/backups
          # must exist at mode 0700 before block 1 writes the first dump into it.
          ssh -i ~/.ssh/lightsail.pem "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}" 'mkdir -p ~/restaurant-order-system/config ~/backups && chmod 700 ~/backups'
          scp -i ~/.ssh/lightsail.pem docker-compose.yml "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:~/restaurant-order-system/docker-compose.yml"
          # api.conf and core-api-proxy.conf go to /tmp, NOT alongside the compose file:
          # `find … ! -name docker-compose.yml ! -name config -exec rm -rf {} +` erases
          # everything else in that directory, so the network half of the rate limiting
          # would silently never ship while every text assertion stayed green.
          scp -i ~/.ssh/lightsail.pem infra/nginx/api.conf "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:/tmp/api.conf"
          scp -i ~/.ssh/lightsail.pem infra/nginx/core-api-proxy.conf "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:/tmp/core-api-proxy.conf"
          # Both host scripts live under config/. restore-drill.sh drives `docker
          # compose`, which does not exist inside the image -- that is why spec 9.7's
          # scripts/ path is superseded by config/ here.
          scp -i ~/.ssh/lightsail.pem infra/backup-core-db.sh "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:~/restaurant-order-system/config/backup-core-db.sh"
          scp -i ~/.ssh/lightsail.pem infra/restore-drill.sh "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:~/restaurant-order-system/config/restore-drill.sh"
          scp -i ~/.ssh/lightsail.pem /tmp/epaper-hub-image.tgz "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:/tmp/epaper-hub-image.tgz"
          scp -i ~/.ssh/lightsail.pem /tmp/customer-order-image.tgz "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:/tmp/customer-order-image.tgz"
          scp -i ~/.ssh/lightsail.pem /tmp/core-api-image-${{ github.sha }}.tgz "${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}:/tmp/"
```

**Then, in the same commit,** fix the legacy config migration inside the `Deploy on
Lightsail` heredoc. Replace the three lines at `:72-74`:

```sh
          if [ -d ~/epaper-emulator/config ] && [ ! -d ~/restaurant-order-system/config ]; then
            mv ~/epaper-emulator/config ~/restaurant-order-system/config
          fi
```

with:

```sh
          # Upload app has already created config/, so `[ ! -d … ]` would be permanently
          # false and the rm -rf below would take the legacy config with it. Test for
          # EMPTY, not absent, and copy -- mv into an existing directory makes
          # config/config.
          if [ -d ~/epaper-emulator/config ] && [ -z "$(ls -A ~/restaurant-order-system/config 2>/dev/null)" ]; then
            cp -a ~/epaper-emulator/config/. ~/restaurant-order-system/config/
          fi
```

Leave the `rm -rf ~/epaper-emulator` on the following line alone. It is safe: by then the
old stack is `docker compose down`ed (`:58-61`), `~/epaper-emulator.env` and
`~/epaper-emulator/.env` are already promoted to `~/restaurant-order-system.env`
(`:62-70`), `config/` has just been copied if it had anything to give, and the screen data
lives in the named volume `epaper-emulator_epaper-data` under `/var/lib/docker` — migrated
separately at `:79-83`, *after* the `rm -rf`.

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-name-pattern="uploads the nginx configs" apps/core-api/test/deploy-config.test.js`  Expected: PASS (1 test)

Run: `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy.yml')); assert 'postgres' in d['jobs']['deploy']['services']; print(len(d['jobs']['deploy']['steps']),'steps')"`  Expected: `14 steps`, no traceback

Then the whole suite, as a regression check only:

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "ci: upload the nginx configs and both infra scripts to the box"
```

---

### Task 19: Abort on a full disk, prune the tarballs, then take the pre-deploy dump

Spec §9.5 heredoc block 1, plus two placements the spec text gets wrong by omission.

**The 85% disk gate goes at the TOP of the heredoc, not in block 6.** A full disk is the most common cause of a truncated dump. Sitting in block 6 it fires *after* the migration has applied, the images have loaded and the containers have restarted — it reports the problem at the only point where nothing can be done about it. At the top it aborts before anything changes.

**Delete each run's tarballs the moment they are in the image store.** Three images at roughly 100–200 MB, and the core-api tarball name carries the sha, so without this the box accumulates one new tarball per deploy until the disk gate above starts aborting deploys for a reason that has nothing to do with the database. The glob `/tmp/core-api-image-*.tgz` deliberately sweeps earlier runs' leftovers too.

**The dump gate is `docker volume inspect`, never `docker compose ps --quiet core-db`.** `ps` is true only when core-db is *running*, so it cannot distinguish "does not exist yet" (a legitimate skip) from "exists and is down" (backup mandatory) — and the deploy most likely to need the dump is exactly the one that would silently skip it.

**`exec -T` on every dump.** Without it docker allocates a TTY and CRLF translation silently corrupts the binary custom-format dump. The corruption is not visible until the restore.

**`</dev/null` on every `docker compose exec -T`** that is not already reading a file. The heredoc arrives on the box as the remote shell's **stdin**; `exec -T` attaches stdin and will consume the rest of the script, truncating the deploy at an arbitrary line with no error.

**`LAST_PRE_DEPLOY` records the sha alongside the filename.** `ln -sfn` alone leaves a stale `latest-pre-deploy.dump` to be uploaded under *this* commit's artifact name. The final task reads that marker and nothing else.

One honest observation, recorded rather than worked around: `docker volume create restaurant-order-system_core-db-data` is idempotent and runs a few lines **above** the gate, so from the first deploy onward the gate is true and a dump is always taken. On the very first deploy that dumps a freshly initialised, empty `core`, which succeeds in a few seconds. The gate is kept as specified because inspecting *the volume* rather than *a running container* is the distinction that matters and is what still holds if the `create` ever moves. What it does **not** license is inferring "this run took a dump" from the volume's existence — see the final task.

**Files:**
- Modify: `.github/workflows/deploy.yml` (the `Deploy on Lightsail` heredoc)
- Test: `apps/core-api/test/deploy-config.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/deploy-config.test.js`:

```js
test("deploy heredoc gates on disk, prunes tarballs and takes a pre-deploy dump", () => {
  const workflow = workflowText();

  // A full disk is the most common cause of a truncated dump. In block 6 this fires
  // AFTER the migration applied; at the top of the heredoc it aborts before anything
  // on the box has changed.
  assert.match(workflow, /df -P "\$HOME" \| awk 'NR==2 && \$5\+0 > 85 \{ print "disk " \$5 " full"; exit 1 \}'/);
  const dfAt = workflow.indexOf('df -P "$HOME"');
  const loadAt = workflow.indexOf("docker load -i /tmp/epaper-hub-image.tgz");
  assert.ok(dfAt > -1 && loadAt > dfAt, "the disk gate must run before the first docker load");

  // One tarball per deploy, kept forever, is what eventually trips the gate above for
  // a reason that has nothing to do with the database.
  assert.match(
    workflow,
    /rm -f \/tmp\/core-api-image-\*\.tgz \/tmp\/epaper-hub-image\.tgz \/tmp\/customer-order-image\.tgz/,
  );
  const pruneAt = workflow.indexOf("rm -f /tmp/core-api-image-*.tgz");
  assert.ok(pruneAt > loadAt, "the tarballs are deleted only once they are in the image store");

  assert.match(workflow, /docker volume create restaurant-order-system_core-db-data/);

  // The exports must be exports, not a one-line prefix: every later `docker compose`
  // call in the heredoc has to agree about CORE_ENV_FILE. Compose's two variables must
  // survive the rewrite verbatim.
  assert.match(workflow, /export EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env/);
  assert.match(workflow, /export CORE_ENV_FILE=\.\.\/core-api\.env/);
  assert.match(workflow, /export CORE_API_IMAGE=core-api:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /export CUSTOMER_ORDER_IMAGE=customer-order:\$\{\{ github\.sha \}\}/);

  // `docker compose ps --quiet core-db` is true only when core-db is RUNNING, so it
  // cannot tell "does not exist yet" from "exists and is down" -- and the deploy most
  // likely to need the dump is the one that would silently skip it.
  assert.match(
    workflow,
    /if docker volume inspect restaurant-order-system_core-db-data >\/dev\/null 2>&1; then/,
  );
  assert.doesNotMatch(workflow, /docker compose ps --quiet core-db/);

  // exec -T on every dump: a TTY translates CRLF and silently corrupts a binary
  // custom-format dump, which is not visible until the restore.
  assert.match(
    workflow,
    /docker compose exec -T core-db sh -c 'PGPASSWORD="\$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d core -Fc'/,
  );
  assert.doesNotMatch(workflow, /docker compose exec core-db[^\n]*pg_dump/);

  // The heredoc IS the remote shell's stdin; an exec -T with stdin attached eats the
  // rest of it and truncates the deploy at an arbitrary line with no error.
  assert.match(workflow, /pg_isready -U core_api_owner -d core -h 127\.0\.0\.1 <\/dev\/null/);

  // Size, then structure -- an OOM kill or a full disk mid-dump yields a truncated file
  // that pg_dump exits 0 on often enough to matter.
  assert.match(workflow, /test -s ~\/backups\/pre-deploy-"\$ts"\.dump/);
  assert.match(workflow, /pg_restore --list < ~\/backups\/pre-deploy-"\$ts"\.dump/);
  assert.match(workflow, /chmod 600 ~\/backups\/pre-deploy-"\$ts"\.dump/);

  // The sha in LAST_PRE_DEPLOY is what lets the artifact step refuse a stale dump.
  assert.match(
    workflow,
    /printf '%s %s\\n' "\$\{\{ github\.sha \}\}" "pre-deploy-\$ts\.dump" > ~\/backups\/LAST_PRE_DEPLOY/,
  );
  assert.match(workflow, /ln -sfn ~\/backups\/pre-deploy-"\$ts"\.dump ~\/backups\/latest-pre-deploy\.dump/);

  // Retention: one pre-deploy dump per deploy, forever, is the other new disk consumer.
  assert.match(
    workflow,
    /ls -1t "\$HOME"\/backups\/pre-deploy-\*\.dump 2>\/dev\/null \| tail -n \+15 \| xargs -r rm -f/,
  );

  // The volume literal in deploy.yml must not drift from docker-compose.yml's
  // declaration. Docker names the volume <project>_<declared name>, and the project is
  // the deploy directory -- so renaming the volume in compose alone would leave this
  // deploy creating and inspecting a volume nothing else uses, and the dump gate would
  // silently skip on every deploy. Both literals ship in THIS task, which is why the
  // check lives here.
  const compose = composeText();
  const volumesAt = compose.indexOf("\nvolumes:\n");
  assert.notEqual(volumesAt, -1, "docker-compose.yml has no top-level volumes: block");
  const declared = (compose.slice(volumesAt).match(/^ {2}([a-z0-9_-]+):$/gm) || [])
    .map((line) => line.trim().replace(":", ""));
  const coreVolume = declared.find((name) => name.includes("core-db"));
  assert.ok(coreVolume, `docker-compose.yml declares no core-db volume; found ${declared.join(", ")}`);
  const full = `restaurant-order-system_${coreVolume}`;
  assert.ok(workflow.includes(`docker volume create ${full}`), `deploy.yml does not create ${full}`);
  assert.ok(workflow.includes(`docker volume inspect ${full}`), `deploy.yml does not inspect ${full}`);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-name-pattern="gates on disk, prunes tarballs" apps/core-api/test/deploy-config.test.js`

Expected: FAIL with ``AssertionError [ERR_ASSERTION]: The input did not match the regular expression /df -P "\$HOME" \| awk 'NR==2 && \$5\+0 > 85 \{ print "disk " \$5 " full"; exit 1 \}'/.``

- [ ] **Step 3: Write the minimal implementation**

Three edits inside the `Deploy on Lightsail` heredoc.

**(a)** Replace the first line of the heredoc body, which currently reads:

```yaml
          set -euo pipefail
          if [ -f ~/epaper-emulator/docker-compose.yml ]; then
```

with:

```yaml
          set -euo pipefail
          # A full disk is the most common cause of a truncated dump, and 85% on a
          # Lightsail instance is already late. This is at the TOP of the heredoc on
          # purpose: in block 6 it would fire after the migration had already applied,
          # which reports the problem exactly where nothing can be done about it.
          df -P "$HOME" | awk 'NR==2 && $5+0 > 85 { print "disk " $5 " full"; exit 1 }'
          if [ -f ~/epaper-emulator/docker-compose.yml ]; then
```

**(b)** Replace the three lines that currently read (the `docker load -i /tmp/core-api-image-…` line belongs to the compose area and is already present — do not add it again):

```yaml
          docker load -i /tmp/epaper-hub-image.tgz
          docker load -i /tmp/customer-order-image.tgz
          docker load -i /tmp/core-api-image-${{ github.sha }}.tgz
          docker volume create restaurant-order-system_epaper-data
```

with:

```yaml
          docker load -i /tmp/epaper-hub-image.tgz
          docker load -i /tmp/customer-order-image.tgz
          docker load -i /tmp/core-api-image-${{ github.sha }}.tgz
          # Delete this run's tarballs the moment they are in the image store. Three
          # images at ~100-200 MB each, and the core-api name carries the sha, so
          # without this the box gains one tarball per deploy until the 85% gate above
          # starts aborting deploys for a reason unrelated to the database. The glob
          # sweeps earlier runs' leftovers too.
          rm -f /tmp/core-api-image-*.tgz /tmp/epaper-hub-image.tgz /tmp/customer-order-image.tgz
          docker volume create restaurant-order-system_epaper-data
          docker volume create restaurant-order-system_core-db-data
```

**(c)** Replace the whole one-line `docker compose up` prefix at the end of the heredoc — after the compose area's task it reads something like `EPAPER_IMAGE=epaper-hub:${{ github.sha }} CUSTOMER_ORDER_IMAGE=customer-order:${{ github.sha }} CORE_API_IMAGE=core-api:${{ github.sha }} EPAPER_ENV_FILE=../restaurant-order-system.env CORE_ENV_FILE=../core-api.env docker compose up -d --no-build`, on one line — with:

```yaml
          export EPAPER_ENV_FILE=../restaurant-order-system.env
          export CORE_ENV_FILE=../core-api.env
          export EPAPER_ENV_FILE=../restaurant-order-system.env
          export EPAPER_IMAGE=epaper-hub:${{ github.sha }}
          export CUSTOMER_ORDER_IMAGE=customer-order:${{ github.sha }}
          export CORE_API_IMAGE=core-api:${{ github.sha }}

          # ---- 1. PRE-DEPLOY DUMP. Gated on the VOLUME, not on a running container. ----
          # `docker compose ps --quiet core-db` is true only when core-db is RUNNING, so
          # it cannot distinguish "does not exist yet" (legitimate skip) from "exists and
          # is down" (backup mandatory) -- and the deploy most likely to need the dump is
          # the one that silently skips it.
          # Every `exec -T` below carries </dev/null: this heredoc IS the remote shell's
          # stdin, and an exec with stdin attached consumes the rest of the deploy script.
          if docker volume inspect restaurant-order-system_core-db-data >/dev/null 2>&1; then
            docker compose up -d core-db
            for i in $(seq 1 30); do docker compose exec -T core-db pg_isready -U core_api_owner -d core -h 127.0.0.1 </dev/null && break; sleep 2; done
            ts="$(date -u +%Y%m%dT%H%M%SZ)"
            # `exec -T` IS LOAD-BEARING: without it docker allocates a TTY and CRLF
            # translation silently corrupts the binary custom-format dump.
            docker compose exec -T core-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U core_api_owner -d core -Fc' </dev/null \
              > ~/backups/pre-deploy-"$ts".dump
            test -s ~/backups/pre-deploy-"$ts".dump
            # Structural verification: an OOM kill or a full disk mid-dump produces a
            # truncated file that pg_dump exits 0 on often enough to matter.
            docker compose exec -T core-db pg_restore --list < ~/backups/pre-deploy-"$ts".dump > /dev/null
            chmod 600 ~/backups/pre-deploy-"$ts".dump
            # The sha, not the symlink, is what the artifact step trusts: ln -sfn alone
            # leaves a STALE latest-pre-deploy.dump to be uploaded under this commit's
            # artifact name.
            printf '%s %s\n' "${{ github.sha }}" "pre-deploy-$ts.dump" > ~/backups/LAST_PRE_DEPLOY
            ln -sfn ~/backups/pre-deploy-"$ts".dump ~/backups/latest-pre-deploy.dump
            # Keep 14. This prune runs immediately after the dump it just wrote, so the
            # glob always matches at least one file and `ls` cannot fail the pipeline
            # under `set -o pipefail`.
            ls -1t "$HOME"/backups/pre-deploy-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
          fi

          docker compose up -d --no-build
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-name-pattern="gates on disk, prunes tarballs" apps/core-api/test/deploy-config.test.js`  Expected: PASS (1 test)

Run: `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy.yml')); assert 'postgres' in d['jobs']['deploy']['services']; print(len(d['jobs']['deploy']['steps']),'steps')"`  Expected: `14 steps`, no traceback

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

**MANUAL VERIFICATION — runs once, at cutover, on the Lightsail host. This is not a test.**

1. After the first successful deploy: `ls -la ~/backups`
   Expected: a `pre-deploy-<ts>.dump` at mode `-rw-------`, a `latest-pre-deploy.dump` symlink pointing at it, and `LAST_PRE_DEPLOY`. **The first deploy does produce a dump** — `docker volume create` runs above the gate, so the gate is true and the dump is of a freshly initialised, empty `core`.
2. `cat ~/backups/LAST_PRE_DEPLOY`
   Expected: one line, `<the sha you just deployed> pre-deploy-<ts>.dump`.
3. `ls /tmp/*-image*.tgz`
   Expected: `No such file or directory`. Anything listed means the prune line is not running and the box will fill up one deploy at a time.
4. `cd ~/restaurant-order-system && CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec -T core-db pg_restore --list < ~/backups/latest-pre-deploy.dump | head -5`
   Expected: a `;`-prefixed TOC header naming `core`, exit 0. A truncated dump errors here.
5. The restore drill: `~/restaurant-order-system/config/restore-drill.sh`
   Expected: it restores into `core_restore_check`, asserts `schema_migrations` matches the image, prints row counts, drops the scratch database, exit 0. Do it on the day everything worked — that is when it is cheap.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "ci: gate on disk, prune image tarballs and take a volume-gated pre-deploy dump"
```

---

### Task 20: Install nginx with a two-file snapshot, validate, roll back, then reload

Spec §9.5 heredoc block 2. The order is snapshot → install → validate → roll back → reload, and it is *not* install-then-validate. Installing first and validating second leaves a broken file latent on disk when `nginx -t` fails: the running nginx keeps its in-memory config so nothing looks wrong, and the box goes down the next time certbot's renew hook or a reboot reloads it — taking `order.yeyintlwin.com` and `epaper-hub.yeyintlwin.com` with it, days later, with no deploy anywhere near the failure.

The second `sudo nginx -t` inside the rollback branch is not redundant: it proves the box is left *loadable* before the deploy exits 1.

**Two things the spec omits, both handed over by the nginx area.**

**`core-api-proxy.conf` is snapshotted and restored too.** Spec §9.5 rolls back only `api.conf`. The snippet is installed in the same breath and is equally capable of failing `nginx -t`; rolling back half of a two-file change leaves the box in a state neither version produced.

**The stale `.bak` files are removed first.** Without that, a `.bak` left by an earlier run survives, and `[ -f /tmp/api.conf.bak ]` stops meaning "this run snapshotted a file that existed" — the rollback branch would restore a config from an unrelated deploy. They are removed with `sudo` because `sudo cp -a` writes them owned by root, which is also why the block 7 cleanup does not try to `rm` them as the deploy user.

**And the two `nginx -T` proofs are rewritten.** As spec §9.5 writes them they abort **every deploy, after nginx has already reloaded**. Two separate defects: §9.6's `api.conf` is column-aligned (`proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for`, three spaces) while §9.5's grep pattern has one, so the pattern never matches; and `sudo nginx -T | grep -q` closes the pipe on first match, so once the config dump exceeds the 64 KB pipe buffer `nginx -T` takes SIGPIPE and `pipefail` propagates it. Capture once into a variable, match whitespace-tolerantly with `grep -E … +`, and give each a diagnostic.

**Dependency:** the nginx area must have created `infra/nginx/api.conf` and `infra/nginx/core-api-proxy.conf`, and the certificate for `api.yeyintlwin.com` must already exist (§9.11 step 2) or `nginx -t` fails on a missing `ssl_certificate`.

**Files:**
- Modify: `.github/workflows/deploy.yml` (the `Deploy on Lightsail` heredoc)
- Test: `apps/core-api/test/deploy-config.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/deploy-config.test.js`:

```js
test("deploy heredoc installs nginx with a two-file snapshot, validate and rollback", () => {
  const workflow = workflowText();

  // Order is the whole point. Install-then-validate leaves a broken file on disk that
  // only bites days later, when certbot's renew hook or a reboot reloads nginx.
  const staleAt = workflow.indexOf("sudo rm -f /tmp/api.conf.bak /tmp/core-api-proxy.conf.bak");
  const snapshotAt = workflow.indexOf("/tmp/api.conf.bak 2>/dev/null");
  const installAt = workflow.indexOf("sudo install -m0644 /tmp/api.conf");
  const validateAt = workflow.indexOf("if ! sudo nginx -t; then");
  const reloadAt = workflow.indexOf("sudo systemctl reload nginx");
  const proofAt = workflow.indexOf("nginx_dump=$(sudo nginx -T");

  assert.ok(staleAt > -1, "the stale .bak files must be removed before this run snapshots");
  assert.ok(snapshotAt > staleAt, "the snapshot must follow the stale-bak removal");
  assert.ok(installAt > snapshotAt, "the snapshot must be taken before the install");
  assert.ok(validateAt > installAt, "nginx -t must run after the install");
  assert.ok(reloadAt > validateAt, "the reload must come only after a passing nginx -t");
  assert.ok(proofAt > reloadAt, "the directive proofs read the config nginx actually loaded");

  // BOTH files are snapshotted and BOTH are restored. Rolling back half of a two-file
  // change leaves the box in a state neither version produced.
  assert.match(
    workflow,
    /sudo cp -a \/etc\/nginx\/snippets\/core-api-proxy\.conf \/tmp\/core-api-proxy\.conf\.bak 2>\/dev\/null \|\| :/,
  );
  assert.match(
    workflow,
    /sudo cp -a \/tmp\/api\.conf\.bak \/etc\/nginx\/conf\.d\/api\.yeyintlwin\.com\.conf/,
  );
  assert.match(
    workflow,
    /sudo cp -a \/tmp\/core-api-proxy\.conf\.bak \/etc\/nginx\/snippets\/core-api-proxy\.conf/,
  );
  assert.match(workflow, /sudo rm -f \/etc\/nginx\/conf\.d\/api\.yeyintlwin\.com\.conf/);
  assert.match(workflow, /sudo rm -f \/etc\/nginx\/snippets\/core-api-proxy\.conf/);
  assert.match(
    workflow,
    /sudo install -m0644 -D \/tmp\/core-api-proxy\.conf \/etc\/nginx\/snippets\/core-api-proxy\.conf/,
  );

  // The two directives TRUSTED_PROXY_HOPS=1 and the login rate limit depend on.
  // Captured ONCE: `sudo nginx -T | grep -q` closes the pipe on first match, and once
  // the config dump exceeds the 64 KB pipe buffer nginx -T takes SIGPIPE and pipefail
  // aborts the deploy AFTER the reload has already happened.
  assert.match(workflow, /nginx_dump=\$\(sudo nginx -T 2>\/dev\/null\)/);
  assert.doesNotMatch(workflow, /sudo nginx -T \| grep/);

  // Whitespace-tolerant: spec 9.6's file is column-aligned with three spaces and spec
  // 9.5's grep pattern has one, so the literal pattern never matches anything.
  assert.match(
    workflow,
    /printf '%s\\n' "\$nginx_dump" \| grep -Eq 'limit_req_zone \+\[\^;\]\*zone=core_login' \|\| \{ echo/,
  );
  assert.match(
    workflow,
    /printf '%s\\n' "\$nginx_dump" \| grep -Eq 'proxy_set_header \+X-Forwarded-For \+\\\$proxy_add_x_forwarded_for' \|\| \{ echo/,
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-name-pattern="installs nginx with a two-file snapshot" apps/core-api/test/deploy-config.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: the stale .bak files must be removed before this run snapshots`

- [ ] **Step 3: Write the minimal implementation**

In `.github/workflows/deploy.yml`, inside the `Deploy on Lightsail` heredoc, replace the single line that currently reads:

```yaml
          docker compose up -d --no-build
```

with:

```yaml
          # ---- 2. NGINX: snapshot, install, validate, ROLL BACK on failure, then reload ----
          # Installing first and validating second leaves a broken file latent on disk
          # when nginx -t fails: the running nginx keeps its in-memory config so nothing
          # looks wrong, and the box goes down the next time certbot's renew hook or a
          # reboot reloads it -- taking order.yeyintlwin.com and epaper-hub.yeyintlwin.com
          # with it, days later, with no deploy anywhere near the failure.
          # Remove last run's snapshots FIRST, so `[ -f … .bak ]` means "this run
          # snapshotted a file that existed" and the rollback cannot restore a config
          # from an unrelated deploy. sudo, because `sudo cp -a` writes them as root.
          sudo rm -f /tmp/api.conf.bak /tmp/core-api-proxy.conf.bak
          sudo cp -a /etc/nginx/conf.d/api.yeyintlwin.com.conf /tmp/api.conf.bak 2>/dev/null || :
          sudo cp -a /etc/nginx/snippets/core-api-proxy.conf /tmp/core-api-proxy.conf.bak 2>/dev/null || :
          sudo install -m0644 /tmp/api.conf               /etc/nginx/conf.d/api.yeyintlwin.com.conf
          sudo install -m0644 -D /tmp/core-api-proxy.conf /etc/nginx/snippets/core-api-proxy.conf
          if ! sudo nginx -t; then
            # BOTH files roll back. The snippet is installed in the same breath and is
            # equally able to fail nginx -t; restoring only api.conf leaves the box in a
            # state neither version produced.
            if [ -f /tmp/api.conf.bak ]; then sudo cp -a /tmp/api.conf.bak /etc/nginx/conf.d/api.yeyintlwin.com.conf
            else sudo rm -f /etc/nginx/conf.d/api.yeyintlwin.com.conf; fi
            if [ -f /tmp/core-api-proxy.conf.bak ]; then sudo cp -a /tmp/core-api-proxy.conf.bak /etc/nginx/snippets/core-api-proxy.conf
            else sudo rm -f /etc/nginx/snippets/core-api-proxy.conf; fi
            sudo nginx -t          # prove the box is left loadable
            exit 1
          fi
          sudo systemctl reload nginx
          # Capture ONCE. `sudo nginx -T | grep -q` closes the pipe on the first match,
          # so as soon as the config dump exceeds the 64 KB pipe buffer nginx -T takes
          # SIGPIPE and pipefail aborts the deploy -- after the reload has already
          # happened. The patterns are whitespace-tolerant because api.conf is
          # column-aligned and the literal single-space pattern never matches.
          nginx_dump=$(sudo nginx -T 2>/dev/null)
          printf '%s\n' "$nginx_dump" | grep -Eq 'limit_req_zone +[^;]*zone=core_login' || { echo 'nginx: limit_req_zone core_login is not loaded'; exit 1; }
          printf '%s\n' "$nginx_dump" | grep -Eq 'proxy_set_header +X-Forwarded-For +\$proxy_add_x_forwarded_for' || { echo 'nginx: X-Forwarded-For is not set from $proxy_add_x_forwarded_for - the hop count is meaningless'; exit 1; }

          docker compose up -d --no-build
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-name-pattern="installs nginx with a two-file snapshot" apps/core-api/test/deploy-config.test.js`  Expected: PASS (1 test)

Run: `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy.yml')); assert 'postgres' in d['jobs']['deploy']['services']; print(len(d['jobs']['deploy']['steps']),'steps')"`  Expected: `14 steps`, no traceback

Then prove the two grep patterns actually match the files this step installs, before they ever reach the box:

```bash
grep -Eq 'limit_req_zone +[^;]*zone=core_login' infra/nginx/api.conf && echo 'core_login ok'
grep -Eq 'proxy_set_header +X-Forwarded-For +\$proxy_add_x_forwarded_for' infra/nginx/core-api-proxy.conf && echo 'xff ok'
```

Expected: `core_login ok` and `xff ok`. If either prints nothing, the deploy would have reloaded nginx and *then* aborted — fix the pattern or the conf now.

**MANUAL VERIFICATION — runs once, at cutover, on the Lightsail host. This is not a test.**

1. Confirm the deploy user can do the three privileged things without a password prompt (a prompt hangs the ssh heredoc forever): `sudo -n install -m0644 /dev/null /tmp/sudo-probe && sudo -n nginx -t && sudo -n systemctl reload nginx`
   Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`, exit 0, no password prompt.
2. Exercise the rollback branch deliberately — this is the only way to see it work: `sudo cp -a /etc/nginx/conf.d/api.yeyintlwin.com.conf /root/api.good`, then `printf 'this is not nginx syntax\n' | sudo tee /tmp/api.conf >/dev/null`, then push a no-op commit.
   Expected: the deploy fails at `nginx -t`, the second `nginx -t` in the rollback branch prints `test is successful`, and `sudo diff /etc/nginx/conf.d/api.yeyintlwin.com.conf /root/api.good` reports no difference. A real push restores the file afterwards.
3. `sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -E 'real_ip_header|set_real_ip_from|real_ip_recursive' || echo NONE`
   Expected: `0`. Either directive rewrites `$remote_addr` before `$proxy_add_x_forwarded_for` is evaluated, which is a total bypass of the hop count.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "ci: install nginx with a two-file rollback and prove both directives loaded"
```

---

### Task 21: Gate the deploy on `/health/ready`, then on the real TLS chain

Spec §9.5 heredoc block 3. Two curls, checking different things. The loopback `/health/ready` gate (45 × 2 s = 90 s) proves the container migrated, opened its runtime pool and is ready. The `--resolve` curl through `https://api.yeyintlwin.com/health` proves what `nginx -T` cannot: that a server block actually matches that host name, that the certificate serves, and that the request reaches core-api through the real chain.

Note the asymmetry the spec settles deliberately: the **container healthcheck** calls `/health` (nothing depends on core-api, so an unhealthy mark would restart nothing and a transient DB blip should not produce a misleading status), while the **deploy gate** calls `/health/ready`.

The gate carries the no-auto-rollback statement as a comment, because by the time it runs the migration has already applied — rolling the image back leaves the schema *ahead* of the image, which the runner treats as a warning, so the old container starts and looks healthy against a schema it does not know. That is a real recovery path and a human decision. Keeping the one-line command in the file means nobody has to find it under pressure.

**Files:**
- Modify: `.github/workflows/deploy.yml` (the `Deploy on Lightsail` heredoc)
- Test: `apps/core-api/test/deploy-config.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/deploy-config.test.js`:

```js
test("deploy heredoc gates on /health/ready and then on the real TLS chain", () => {
  const workflow = workflowText();

  // 45 iterations x 2 s = the 90 s the spec settles on.
  assert.match(workflow, /while \[ "\$i" -lt 45 \]; do/);

  // The DEPLOY gate reads /health/ready; the container healthcheck deliberately reads
  // /health, because nothing depends on core-api and an unhealthy mark would restart
  // nothing.
  assert.match(workflow, /curl -fsS -m 3 http:\/\/127\.0\.0\.1:3200\/health\/ready/);

  // A failed gate must print why, or the only artefact of a bad deploy is a red tick.
  assert.match(workflow, /docker compose logs --tail 200 core-api/);
  assert.match(workflow, /docker compose logs --tail 50 core-db/);

  // nginx -T proves the DIRECTIVES are loaded. It does not prove a server block matches
  // api.yeyintlwin.com, that the certificate serves, or that the request reaches
  // core-api.
  assert.match(
    workflow,
    /curl -fsS -m 5 --resolve api\.yeyintlwin\.com:443:127\.0\.0\.1 https:\/\/api\.yeyintlwin\.com\/health >/,
  );

  const upAt = workflow.indexOf("docker compose up -d --no-build");
  const gateAt = workflow.indexOf("http://127.0.0.1:3200/health/ready");
  assert.ok(upAt > -1 && gateAt > upAt, "the health gate must run after docker compose up");

  // The gate does not roll back, and the runbook line is carried in the file on purpose
  // so nobody has to find it under pressure.
  assert.match(workflow, /THIS GATE DOES NOT AUTO-ROLL-BACK/);
  assert.match(workflow, /CORE_API_IMAGE=core-api:<previous-sha> docker compose up -d core-api/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-name-pattern="gates on /health/ready" apps/core-api/test/deploy-config.test.js`

Expected: FAIL with ``AssertionError [ERR_ASSERTION]: The input did not match the regular expression /while \[ "\$i" -lt 45 \]; do/.``

- [ ] **Step 3: Write the minimal implementation**

In `.github/workflows/deploy.yml`, inside the `Deploy on Lightsail` heredoc, replace the single line that currently reads:

```yaml
          docker compose up -d --no-build
```

with:

```yaml
          docker compose up -d --no-build

          # ---- 3. HEALTH GATE, 90 s, THROUGH THE REAL CHAIN ----
          ok=0; i=0
          while [ "$i" -lt 45 ]; do
            if curl -fsS -m 3 http://127.0.0.1:3200/health/ready >/dev/null 2>&1; then ok=1; break; fi
            i=$((i+1)); sleep 2
          done
          [ "$ok" -eq 1 ] || { docker compose logs --tail 200 core-api || true; docker compose logs --tail 50 core-db || true; exit 1; }

          # nginx -T proves the DIRECTIVES are loaded. It does not prove a server block
          # matches api.yeyintlwin.com, that the certificate serves, or that the request
          # reaches core-api at all.
          curl -fsS -m 5 --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health >/dev/null

          # THIS GATE DOES NOT AUTO-ROLL-BACK. By the time it runs the migration has
          # applied, so rolling the image back leaves the schema AHEAD of the image --
          # which the runner treats as a WARNING, not an error, so the old container
          # starts and looks healthy against a schema it does not know. That is a real
          # recovery path and a human decision:
          #   cd ~/restaurant-order-system && export CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env
          #   CORE_API_IMAGE=core-api:<previous-sha> docker compose up -d core-api
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-name-pattern="gates on /health/ready" apps/core-api/test/deploy-config.test.js`  Expected: PASS (1 test)

Run: `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy.yml')); assert 'postgres' in d['jobs']['deploy']['services']; print(len(d['jobs']['deploy']['steps']),'steps')"`  Expected: `14 steps`, no traceback

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

**MANUAL VERIFICATION — runs once, at cutover, on the Lightsail host. This is not a test.**

1. `curl -fsS -m 5 --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health`
   Expected: HTTP 200 and a JSON body, exit 0. A `curl: (22)` here means the `location = /health` block is missing or denying loopback — and it would abort every deploy *after* the migration had applied.
2. `curl -s -o /dev/null -w '%{http_code}\n' --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health/ready`
   Expected: `404`. Readiness is never exposed publicly.
3. Prove the 60 s bounded lock retry recovers an orphaned migration: while core-api holds the advisory lock, `docker kill core-api`, then re-run the deploy.
   Expected: the deploy succeeds inside the 90 s gate with no manual `pg_terminate_backend` — which is what `tcp_keepalives_idle=20` on core-db buys.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "ci: gate the deploy on /health/ready and on the real TLS chain"
```

---

### Task 22: Probe the login path before exhausting the `limit_req` bucket

Spec §9.5 heredoc blocks 4 and 5. **The ordering is the entire point.** Run the burst first and it exhausts the `core_login` bucket for the runner's source address; nginx then sheds the login probe, it never reaches core-api, and every assertion after it passes vacuously. Blocks 4 and 5 exist in that order for that reason, and nothing that needs to reach core-api from this address may run after block 5.

**The honest problem, and the decision.** Spec §9.5's block 4 asserts that an `audit_events` row exists and that its `source_ip` is neither the forged address nor null. **Plan 1 ships no `POST /api/admin/auth/login` route, no `lib/client-ip.js` and no audit writer** — the `audit_events` table exists (`0001_init.sql`) but nothing writes to it. Shipping the spec's block verbatim today means `test -n "$probe"` fails on every deploy, so the only way to make it green would be `|| true`, which is exactly the vacuous probe the spec warns about.

**Decision: the forgeability assertion moves to Plan 2. Plan 5 ships a reduced probe, in the correct slot, with the request byte-identical to the one Plan 2 will assert on, that cannot pass vacuously.** Hence the retitle: this is a **login-path routing probe**, not an XFF probe. What it proves today:

- the login path resolves through the real TLS chain and nginx's `location = /api/admin/auth/login` includes the proxy snippet;
- **core-api itself answered** — its 404 tail returns `application/json` with `{"error":{"code":"not_found",…}}`, where an nginx-level 404 returns `text/html` and a dead upstream returns nginx's 502 page. A `|| true`-swallowed curl proves none of this;
- `TRUSTED_PROXY_HOPS` is `1` **in the running process**, read from `/proc/1/environ`. `docker compose exec -T core-api printenv TRUSTED_PROXY_HOPS` would not do: `printenv` in an `exec` session reports the environment compose composes *now*, from the compose file this same deploy just uploaded, so it agrees with itself even when the container PID 1 is still carrying an older environment.

What it cannot prove today: that a client-sent `X-Forwarded-For` is not honoured. Nothing in this block exercises the client-IP derivation, so **nothing here can fail because the hop count produces the wrong address** — only because the variable itself is not `1`. A `PLAN 2:` marker in the file carries the exact assertion to restore, and the test asserts the marker is present so it cannot be quietly forgotten.

**And the 404 expectation is made to break in CI, not on the box.** The moment Plan 2 registers `POST /api/admin/auth/login`, the real response becomes 401 and the deploy turns red at 22:00 *after* the migration has applied. The test below reads `apps/core-api/http/routes/` and fails the moment that route appears, with the Plan 2 instruction in the message.

The `limit_req` burst needs none of this and ships in full today: nginx applies `limit_req` before proxying, so the 429s appear whether or not the route exists.

**Files:**
- Modify: `.github/workflows/deploy.yml` (the `Deploy on Lightsail` heredoc)
- Test: `apps/core-api/test/deploy-config.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/deploy-config.test.js`:

```js
test("deploy heredoc probes the login path before it exhausts the limit_req bucket", () => {
  const workflow = workflowText();

  const probeAt = workflow.indexOf("xff-probe@invalid.test");
  const burstAt = workflow.indexOf("deploy-probe@invalid.test");
  assert.ok(probeAt > -1, "the login-path probe is missing");
  assert.ok(burstAt > -1, "the limit_req burst probe is missing");
  // Run the burst first and it exhausts the core_login bucket for this source address:
  // nginx then sheds the probe, it never reaches core-api, and every assertion below is
  // vacuous.
  assert.ok(probeAt < burstAt, "the login-path probe must run BEFORE the limit_req burst");

  // The probe asserts on the RESPONSE. A `curl -fsS … || true` proves nothing at all.
  assert.match(workflow, /-H 'X-Forwarded-For: 203\.0\.113\.99'/);
  assert.match(workflow, /test "\$probe_status" = "404"/);
  assert.match(workflow, /grep -q '"code":"not_found"' \/tmp\/xff-probe\.body/);
  assert.doesNotMatch(workflow, /xff-probe@invalid\.test[^\n]*\|\| true/);

  // Read the RUNNING PROCESS, not the project files. `docker compose exec -T core-api
  // printenv TRUSTED_PROXY_HOPS` echoes back the compose file this same deploy uploaded,
  // so it agrees with itself while PID 1 still carries an older environment.
  assert.match(workflow, /tr "\\0" "\\n" < \/proc\/1\/environ/);
  assert.match(workflow, /sed -n 's\/\^TRUSTED_PROXY_HOPS=\/\/p'/);
  assert.match(workflow, /test "\$hops" = "1" \|\| \{ echo "core-api PID 1 has TRUSTED_PROXY_HOPS/);
  assert.doesNotMatch(workflow, /printenv TRUSTED_PROXY_HOPS/);

  // The forgeability half needs Plan 2's auth route and audit writer. The marker is what
  // stops it from being forgotten, and it has a defined removal trigger.
  assert.match(workflow, /PLAN 2: restore the full forgeability assertion here/);
  assert.match(workflow, /detail->>'email' = 'xff-probe@invalid\.test'/);

  // The burst itself ships in full today: nginx applies limit_req before proxying, so
  // the 429s appear whether or not the route exists.
  assert.match(workflow, /for n in \$\(seq 1 20\)/);
  assert.match(workflow, /echo "\$codes" \| grep -q 429/);

  // The 404 expectation must break HERE, in CI, and not at 22:00 on the box after the
  // migration has already applied.
  const routesDir = path.join(__dirname, "..", "http", "routes");
  for (const entry of fs.readdirSync(routesDir)) {
    if (!entry.endsWith(".js")) continue;
    const source = fs
      .readFileSync(path.join(routesDir, entry), "utf8")
      .replace(/\r\n/g, "\n");
    assert.ok(
      !source.includes('"/api/admin/auth/login"'),
      `http/routes/${entry} registers /api/admin/auth/login, so the deploy's block 4 probe now gets 401 and aborts the deploy AFTER the migration applied. In the same commit that registers the route: change block 4's expected status from 404 to 401, restore the audit_events forgeability assertion, delete the PLAN 2 marker.`,
    );
  }
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-name-pattern="probes the login path before" apps/core-api/test/deploy-config.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: the login-path probe is missing`

- [ ] **Step 3: Write the minimal implementation**

In `.github/workflows/deploy.yml`, inside the `Deploy on Lightsail` heredoc, insert the following immediately after the no-auto-rollback comment block — that is, after the `#   CORE_API_IMAGE=core-api:<previous-sha> docker compose up -d core-api` line:

```yaml

          # ---- 4. LOGIN-PATH ROUTING PROBE (the XFF assertion arrives in Plan 2) ----
          # THIS MUST RUN BEFORE THE limit_req BURST IN BLOCK 5. Run after it and the
          # burst has already exhausted the core_login bucket for this source address,
          # so nginx sheds the probe, it never reaches core-api, and every assertion
          # below passes vacuously.
          #
          # What this proves TODAY: the login path resolves through the real TLS chain,
          # nginx's `location = /api/admin/auth/login` includes the proxy snippet, and
          # CORE-API ITSELF answered -- its 404 tail returns application/json
          # {"error":{"code":"not_found",...}}, where an nginx-level 404 returns
          # text/html and a dead upstream returns nginx's own 502 page.
          #
          # What it CANNOT prove: that a client-sent X-Forwarded-For is not honoured.
          # Nothing here exercises the client-IP derivation -- Plan 1 ships no login
          # route, no lib/client-ip.js and no audit writer -- so NOTHING IN THIS BLOCK
          # CAN FAIL BECAUSE THE HOP COUNT PRODUCES THE WRONG ADDRESS. It can only fail
          # because the variable itself is not 1. The behavioural assertion is Plan 2's.
          probe_status=$(curl -s -o /tmp/xff-probe.body -w '%{http_code}' -m 5 \
            --resolve api.yeyintlwin.com:443:127.0.0.1 \
            -X POST https://api.yeyintlwin.com/api/admin/auth/login \
            -H 'Origin: https://api.yeyintlwin.com' -H 'Content-Type: application/json' \
            -H 'X-Forwarded-For: 203.0.113.99' \
            --data-binary '{"email":"xff-probe@invalid.test","password":"x"}' </dev/null)
          test "$probe_status" = "404" || { echo "login probe: expected 404 from core-api, got $probe_status"; cat /tmp/xff-probe.body; exit 1; }
          grep -q '"code":"not_found"' /tmp/xff-probe.body || { echo 'login probe: that 404 did not come from core-api'; cat /tmp/xff-probe.body; exit 1; }
          rm -f /tmp/xff-probe.body
          # Read the RUNNING PROCESS, not the project files: `docker compose exec -T
          # core-api printenv TRUSTED_PROXY_HOPS` reports the environment compose builds
          # NOW, from the compose file this same deploy just uploaded, so it agrees with
          # itself even when PID 1 is still carrying an older environment.
          hops=$(docker compose exec -T core-api sh -c 'tr "\0" "\n" < /proc/1/environ' </dev/null | sed -n 's/^TRUSTED_PROXY_HOPS=//p' | tr -d '\r')
          test "$hops" = "1" || { echo "core-api PID 1 has TRUSTED_PROXY_HOPS='$hops', expected 1"; exit 1; }
          # PLAN 2: restore the full forgeability assertion here, in THIS position, the
          # moment POST /api/admin/auth/login and the audit writer exist. Change the 404
          # expectation above to 401, delete this marker, and run through the container:
          #   SELECT coalesce(host(source_ip), 'null') FROM audit_events
          #    WHERE detail->>'email' = 'xff-probe@invalid.test' ORDER BY id DESC LIMIT 1
          # Select THIS probe's row by its address, never by recency -- a shed request
          # writes nothing and the burst's own row would satisfy both tests. Assert all
          # three: the row EXISTS, source_ip is not 203.0.113.99 (forgeable), and it is
          # not null (derivation collapsed to the shared bucket). Spec 9.5 block 4
          # carries the exact psql invocation with its shell quoting.

          # ---- 5. limit_req PROBE. Deliberately exhausts the core_login bucket, so
          # nothing that depends on reaching core-api from this address may run after it.
          codes=$(for n in $(seq 1 20); do curl -s -o /dev/null -w '%{http_code} ' -m 3 \
            --resolve api.yeyintlwin.com:443:127.0.0.1 -X POST https://api.yeyintlwin.com/api/admin/auth/login \
            -H 'Origin: https://api.yeyintlwin.com' -H 'Content-Type: application/json' \
            --data-binary '{"email":"deploy-probe@invalid.test","password":"x"}' </dev/null; done)
          echo "$codes" | grep -q 429 || { echo 'nginx limit_req is not firing on the login route'; exit 1; }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-name-pattern="probes the login path before" apps/core-api/test/deploy-config.test.js`  Expected: PASS (1 test)

Run: `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy.yml')); assert 'postgres' in d['jobs']['deploy']['services']; print(len(d['jobs']['deploy']['steps']),'steps')"`  Expected: `14 steps`, no traceback

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

**MANUAL VERIFICATION — runs once, at cutover, on the Lightsail host. This is not a test.**

1. Read the deploy log for this run and confirm both probes ran, and in which order.
   Expected: the `xff-probe@invalid.test` curl appears **above** the twenty `deploy-probe@invalid.test` curls, and neither printed a failure message.
2. On the box, before any burst from that address: `curl -s -o /tmp/p.body -w '%{http_code}\n' --resolve api.yeyintlwin.com:443:127.0.0.1 -X POST https://api.yeyintlwin.com/api/admin/auth/login -H 'Content-Type: application/json' --data-binary '{"email":"manual@invalid.test","password":"x"}'; cat /tmp/p.body`
   Expected: `404` and `{"error":{"code":"not_found","message":"…","requestId":"…"}}`. `text/html` means nginx answered and the proxy snippet is not included; `502` means core-api is not reachable on 127.0.0.1:3200.
3. `cd ~/restaurant-order-system && CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec -T core-api sh -c 'tr "\0" "\n" < /proc/1/environ' </dev/null | grep TRUSTED_PROXY_HOPS`
   Expected: `TRUSTED_PROXY_HOPS=1`.
4. `sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -E 'real_ip_header|set_real_ip_from|real_ip_recursive' || echo NONE`
   Expected: `0`, and in `api.yeyintlwin.com.conf` `count(proxy_pass)` equals `count(include .*core-api-proxy.conf)`. Either divergence silently defeats the hop count.
5. **Deferred to Plan 2, and it is the assertion that matters:** with auth and the audit writer shipped, the probe row selected by `detail->>'email' = 'xff-probe@invalid.test'` must exist and its `source_ip` must be neither `203.0.113.99` nor NULL. It belongs in Plan 2's cutover checklist, not this one.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "ci: probe the login path before the limit_req burst, reduced until plan 2"
```

---

### Task 23: Make a silent backup failure a red build

Spec §9.5 heredoc block 6. The nightly's only failure signal is `LAST_OK`: `set -eu` exits the script early, its output goes to a log nobody reads, and cron's `MAILTO` goes to a local mailbox on a box with no MTA. So the deploy is where silence gets converted into a red build.

`LAST_OK` means specifically *"a dump completed **and** passed `pg_restore --list`"*, which is why the check is `-mtime -2` on that file rather than on the newest `nightly-*.dump` — a truncated dump left behind by an OOM kill would satisfy the latter.

The `.part` sweep belongs here: a truncated dump never replaces a good one and never counts toward retention, and the leftovers should not accumulate. The 85% disk gate that spec §9.5 puts in this block is **not** here — it moved to the top of the heredoc, in the pre-deploy dump task, so a full disk aborts before anything changes rather than after the migration applied. This task asserts that it stayed there.

**Files:**
- Modify: `.github/workflows/deploy.yml` (the `Deploy on Lightsail` heredoc)
- Test: `apps/core-api/test/deploy-config.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/deploy-config.test.js`:

```js
test("deploy heredoc makes a silent backup failure a red build", () => {
  const workflow = workflowText();

  // A truncated dump never replaces a good one and never counts toward retention; the
  // leftovers are swept here so they cannot accumulate.
  assert.match(workflow, /rm -f "\$HOME"\/backups\/\*\.part/);

  // LAST_OK means "a dump completed AND passed pg_restore --list" -- checking the
  // newest nightly-*.dump instead would be satisfied by a truncated file.
  assert.match(workflow, /find "\$HOME\/backups\/LAST_OK" -mtime -2 2>\/dev\/null \| grep -q \./);
  assert.match(workflow, /no successful core-db nightly in 48h/);

  // Gated on the BOOTSTRAP MARKER, not on LAST_OK's existence. `&& [ -f LAST_OK ]`
  // makes the one failure this gate exists to catch -- the nightly never having
  // succeeded even once -- silent forever, because a missing LAST_OK simply skips the
  // check. CRON_INSTALLED_AT is written once, when the deploy first installs the
  // crontab, so the gate stays quiet only while the nightly has legitimately had no
  // chance to run.
  assert.match(workflow, /find "\$HOME\/backups\/CRON_INSTALLED_AT" -mtime -2/);
  assert.doesNotMatch(workflow, /&& \[ -f "\$HOME\/backups\/LAST_OK" \]/);

  // The disk gate lives at the TOP of the heredoc, not here: in this position it fires
  // after the migration has already applied.
  const dfAt = workflow.indexOf('df -P "$HOME"');
  const sweepAt = workflow.indexOf('rm -f "$HOME"/backups/*.part');
  assert.ok(dfAt > -1 && sweepAt > dfAt, "the disk gate must stay above the backup-health block");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-name-pattern="makes a silent backup failure a red build" apps/core-api/test/deploy-config.test.js`

Expected: FAIL with ``AssertionError [ERR_ASSERTION]: The input did not match the regular expression /rm -f "\$HOME"\/backups\/\*\.part/.``

- [ ] **Step 3: Write the minimal implementation**

In `.github/workflows/deploy.yml`, inside the `Deploy on Lightsail` heredoc, insert the following immediately after the block 5 line `echo "$codes" | grep -q 429 || { echo 'nginx limit_req is not firing on the login route'; exit 1; }`:

```yaml

          # ---- 6. BACKUP HEALTH: make silence a red build ----
          # The nightly's ONLY failure signal is LAST_OK. `set -eu` exits it early, its
          # output goes to a log nobody reads, and cron's MAILTO goes to a local mailbox
          # on a box with no MTA -- so the deploy is where that silence is converted into
          # a red build. LAST_OK means "a dump completed AND passed pg_restore --list";
          # checking the newest nightly-*.dump instead would be satisfied by a truncated
          # file. The 85% disk gate that spec 9.5 puts in this block is at the TOP of the
          # heredoc instead, so a full disk aborts before anything on the box changes.
          rm -f "$HOME"/backups/*.part
          # Gated on the BOOTSTRAP MARKER, never on `[ -f LAST_OK ]`. A missing LAST_OK
          # is precisely the failure worth catching -- the nightly has never once
          # succeeded -- and gating on its existence makes that case skip the check and
          # stay green forever. CRON_INSTALLED_AT is written once, by the cron block
          # below, so this gate is quiet only for the first 48 hours after cron was
          # first installed, when the nightly has legitimately had no chance to run.
          if [ -f "$HOME/backups/CRON_INSTALLED_AT" ] \
             && ! find "$HOME/backups/CRON_INSTALLED_AT" -mtime -2 2>/dev/null | grep -q .; then
            find "$HOME/backups/LAST_OK" -mtime -2 2>/dev/null | grep -q . \
              || { echo 'no successful core-db nightly in 48h'; exit 1; }
          fi
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-name-pattern="makes a silent backup failure a red build" apps/core-api/test/deploy-config.test.js`  Expected: PASS (1 test)

Run: `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy.yml')); assert 'postgres' in d['jobs']['deploy']['services']; print(len(d['jobs']['deploy']['steps']),'steps')"`  Expected: `14 steps`, no traceback

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

**MANUAL VERIFICATION — runs once, at cutover, on the Lightsail host. This is not a test.**

1. Run the nightly by hand once so `LAST_OK` exists before the 48-hour window can ever be evaluated: `~/restaurant-order-system/config/backup-core-db.sh; echo "exit=$?"; ls -la ~/backups`
   Expected: `exit=0`, a `nightly-<ts>.dump` at mode `-rw-------`, no `*.part` left behind, and a fresh `LAST_OK`.
2. Prove the check bites: `touch -d '3 days ago' ~/backups/LAST_OK`, then push a no-op commit.
   Expected: the deploy fails with `no successful core-db nightly in 48h`. Then `touch ~/backups/LAST_OK` and push again. **Until `CRON_INSTALLED_AT` is 48 hours old this check is inert by design** — the nightly has not yet had a chance to run, and step 1 is what closes that window early. Note this fires whether or not `LAST_OK` exists: a nightly that has never once succeeded is the case the marker exists to catch.
3. `df -P "$HOME" | awk 'NR==2 {print $5}'`
   Expected: comfortably under 85%. Record the figure in `infra/README.md` alongside `free -m`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "ci: fail the deploy on a stale core-db nightly"
```

---

### Task 24: Install cron last, in a form that survives a box with no crontab

Spec §9.5 heredoc block 7, and it is the single most dangerous line in the deploy. The obvious form, `crontab -l | grep -Fv … | crontab -`, fails in two ways at once on a box that has **no crontab yet** — which is exactly the state of the box on the first Phase 1 deploy:

- `crontab -l` exits 1, `grep` on empty input exits 1, `pipefail` propagates, and `set -e` aborts the deploy with an **empty error message**, before the service ever starts;
- on Vixie cron, `| crontab -` with empty stdin **wipes any crontab that did exist**.

The fix is three-part: each stage gets its own `|| true` inside its own brace group, the result is written to a file, and the crontab is installed **from that file** rather than from a pipe.

**One deviation from the spec text, with reason.** The spec's `grep -Fv` list strips the two job lines but not the `PATH=` line that the very next `printf` re-appends — so the crontab would grow by one `PATH=` line on every single deploy, forever. The exact `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` string is added to the strip list. Nothing else on the box writes that exact string.

Both scripts are `chmod 700`'d here because `scp` does not reliably carry the executable bit, and cron would fail with `Permission denied`.

**Accepted debt, stated plainly and logged as debt.** `apps/core-api/scripts/sweep-expired.js` does not exist in Plan 1. Both crontab lines are installed now anyway, because the crontab is written once and the assertion `crontab -l | grep -q sweep-expired.js` is the thing that stops `AUDIT_RETENTION_DAYS` from configuring nothing. **The line and its grep ship together or neither ships** — installing the line without the grep is the one combination that must never happen, because it produces a crontab nobody is checking. The consequence, which nobody should discover by surprise: until the plan that ships `sweep-expired.js` lands, the 03:43 job exits non-zero into `~/backups/sweep.log` every night with `Cannot find module`. Visible, bounded, non-destructive, and checked in the manual verification below.

**Scope note.** Spec §9.10's `scripts/create-platform-admin.js` is **not** written by this plan and is not referenced by any line in this task. It needs the `users` table, `lib/password.js` and an audit writer — **it arrives in Plan 2**.

**Files:**
- Modify: `.github/workflows/deploy.yml` (the `Deploy on Lightsail` heredoc)
- Test: `apps/core-api/test/deploy-config.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/deploy-config.test.js`:

```js
test("deploy heredoc installs cron in a way that survives a box with no crontab", () => {
  const workflow = workflowText();

  // On a box with NO crontab: crontab -l exits 1, grep on empty input exits 1, pipefail
  // propagates, and set -e aborts the deploy with an EMPTY message before the service
  // starts. On Vixie cron `| crontab -` with empty stdin also wipes whatever crontab did
  // exist.
  assert.match(
    workflow,
    /\{ crontab -l 2>\/dev\/null \|\| true; \} \| \{ grep -Fv [^\n]*\|\| true; \} > \/tmp\/ct\.\$\$/,
  );
  assert.doesNotMatch(workflow, /crontab -l \| grep -Fv/);
  assert.doesNotMatch(workflow, /\| crontab -$/m);
  assert.match(workflow, /crontab \/tmp\/ct\.\$\$ && rm -f \/tmp\/ct\.\$\$/);

  // Rewriting the crontab every deploy must be idempotent. The PATH line is re-appended
  // by the printf below, so the EXACT string has to be in the strip list or the crontab
  // grows by one line per deploy, forever.
  assert.match(
    workflow,
    /grep -Fv -e 'backup-core-db\.sh' -e 'sweep-expired\.js' -e 'PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'/,
  );

  assert.match(workflow, /17 3 \* \* \* %s\/restaurant-order-system\/config\/backup-core-db\.sh/);
  assert.match(
    workflow,
    /43 3 \* \* \* cd %s\/restaurant-order-system && CORE_ENV_FILE=\.\.\/core-api\.env EPAPER_ENV_FILE=\.\.\/restaurant-order-system\.env docker compose exec -T core-api node apps\/core-api\/scripts\/sweep-expired\.js/,
  );

  // Both proofs. AUDIT_RETENTION_DAYS configures nothing unless the sweep is installed,
  // and the line without its grep is the one combination that must never ship.
  assert.match(workflow, /crontab -l \| grep -q backup-core-db\.sh/);
  assert.match(workflow, /crontab -l \| grep -q sweep-expired\.js/);

  // The bootstrap marker block 6 gates on. Written ONCE -- touching it every deploy
  // would keep it permanently fresh on a repo that deploys daily and the 48-hour
  // backup-health gate would never fire. Nothing else in the deploy writes this file,
  // so if this line is missing the gate in Task 23 is inert forever.
  assert.match(
    workflow,
    /\[ -f "\$HOME\/backups\/CRON_INSTALLED_AT" \] \|\| touch "\$HOME\/backups\/CRON_INSTALLED_AT"/,
  );

  // scp does not reliably carry the executable bit; cron would fail with
  // "Permission denied" and restore-drill.sh would refuse to run by hand.
  assert.match(
    workflow,
    /chmod 700 ~\/restaurant-order-system\/config\/backup-core-db\.sh ~\/restaurant-order-system\/config\/restore-drill\.sh/,
  );

  // Cron is LAST, after the health gate and the probes.
  const gateAt = workflow.indexOf("http://127.0.0.1:3200/health/ready");
  const cronAt = workflow.indexOf("crontab /tmp/ct.$$");
  assert.ok(gateAt > -1 && cronAt > gateAt, "cron must be installed after the health gate");

  // The tarballs are already gone -- they are deleted straight after docker load, so the
  // final cleanup is the two nginx files and nothing else.
  assert.match(workflow, /rm -f \/tmp\/api\.conf \/tmp\/core-api-proxy\.conf/);
  assert.doesNotMatch(workflow, /rm -f \/tmp\/\*-image\*\.tgz/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-name-pattern="installs cron in a way that survives" apps/core-api/test/deploy-config.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /\{ crontab -l 2>\/dev\/null \|\| true; \} \| \{ grep -Fv [^\n]*\|\| true; \} > \/tmp\/ct\.\$\$/.`

- [ ] **Step 3: Write the minimal implementation**

In `.github/workflows/deploy.yml`, inside the `Deploy on Lightsail` heredoc, replace the last two lines of the heredoc body, which currently read:

```yaml
          docker image prune -f
          rm -f /tmp/epaper-hub-image.tgz /tmp/customer-order-image.tgz
```

with:

```yaml

          # ---- 7. CRON, LAST, AND FAILURE-PROOF ----
          # `crontab -l | grep -Fv … | crontab -` exits 1 under set -e on a box with NO
          # crontab (crontab -l exits 1, grep on empty input exits 1, pipefail
          # propagates), aborting the deploy with an EMPTY error message BEFORE the
          # service ever starts -- and on Vixie cron the empty stdin also wipes any
          # crontab that did exist. So: each stage gets its own `|| true` in its own
          # brace group, and the crontab is installed from a FILE.
          # The exact PATH string is in the strip list because the printf re-appends it;
          # leaving it out grows the crontab by one line on every deploy, forever.
          # scp does not reliably carry the executable bit, hence the chmod.
          chmod 700 ~/restaurant-order-system/config/backup-core-db.sh ~/restaurant-order-system/config/restore-drill.sh
          { crontab -l 2>/dev/null || true; } | { grep -Fv -e 'backup-core-db.sh' -e 'sweep-expired.js' -e 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' || true; } > /tmp/ct.$$
          printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n17 3 * * * %s/restaurant-order-system/config/backup-core-db.sh >> %s/backups/backup.log 2>&1\n43 3 * * * cd %s/restaurant-order-system && CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env docker compose exec -T core-api node apps/core-api/scripts/sweep-expired.js >> %s/backups/sweep.log 2>&1\n' "$HOME" "$HOME" "$HOME" "$HOME" >> /tmp/ct.$$
          crontab /tmp/ct.$$ && rm -f /tmp/ct.$$
          crontab -l | grep -q backup-core-db.sh
          # AUDIT_RETENTION_DAYS configures nothing unless the sweep is actually
          # installed, so the sweep line and THIS grep ship together or neither ships.
          # ACCEPTED DEBT: apps/core-api/scripts/sweep-expired.js does not exist yet, so
          # the 03:43 job logs "Cannot find module" into ~/backups/sweep.log nightly
          # until the plan that ships it lands. Visible, bounded, non-destructive.
          crontab -l | grep -q sweep-expired.js
          # Bootstrap marker for block 6's backup-health gate, written ONCE. Block 6 stays
          # quiet until this file is 48 hours old, which is the window in which the
          # nightly has legitimately had no chance to run. Touching it on every deploy
          # would keep it permanently fresh on a repository that deploys daily, and the
          # gate would then never fire at all.
          [ -f "$HOME/backups/CRON_INSTALLED_AT" ] || touch "$HOME/backups/CRON_INSTALLED_AT"

          docker image prune -f
          # The image tarballs are already gone: they are deleted immediately after
          # `docker load`, not here, so a failed deploy does not leave them on the disk.
          rm -f /tmp/api.conf /tmp/core-api-proxy.conf
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-name-pattern="installs cron in a way that survives" apps/core-api/test/deploy-config.test.js`  Expected: PASS (1 test)

Run: `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy.yml')); assert 'postgres' in d['jobs']['deploy']['services']; print(len(d['jobs']['deploy']['steps']),'steps')"`  Expected: `14 steps`, no traceback

Then prove the pipeline is safe against the failure it is written for, locally, without touching any real crontab (Git Bash or WSL):

```bash
set -euo pipefail
{ false 2>/dev/null || true; } | { grep -Fv -e 'backup-core-db.sh' || true; } > /tmp/ct.probe
echo "survived with exit=$?"
```

Expected: `survived with exit=0`, and `/tmp/ct.probe` is an empty file. Removing either `|| true` reproduces the silent abort.

**MANUAL VERIFICATION — runs once, at cutover, on the Lightsail host. This is not a test.**

1. On a box with **no** user crontab (`crontab -l` prints `no crontab for <user>` and exits 1), run a full deploy.
   Expected: the deploy completes; `crontab -l | grep -q backup-core-db.sh; echo $?` prints `0` and `crontab -l | grep -q sweep-expired.js; echo $?` prints `0`.
2. Deploy a second time, then `crontab -l | grep -c PATH=`
   Expected: `1`. Any other number means the strip list and the `printf` disagree.
3. `ls -l ~/restaurant-order-system/config/`
   Expected: `backup-core-db.sh` and `restore-drill.sh`, both at mode `-rwx------`.
4. The morning after the first night: `tail -5 ~/backups/backup.log` and `tail -5 ~/backups/sweep.log`
   Expected: `backup.log` quiet with a fresh `LAST_OK`; `sweep.log` showing `Cannot find module '/app/apps/core-api/scripts/sweep-expired.js'` — the accepted debt above, and the signal that clears the moment that script ships.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "ci: install the backup and sweep crontab without wiping a bare box"
```

---

### Task 25: Upload the pre-deploy dump, and never a stale one

Spec §9.5's closing paragraph. A final `if: always()` step reads `~/backups/LAST_PRE_DEPLOY`, refuses a dump that does not belong to this commit, scp's that exact file to the runner, and uploads it with `retention-days: 14`.

**The marker is the only evidence, and the volume is not.** `docker volume create restaurant-order-system_core-db-data` runs unconditionally above block 1's gate, so the volume exists after the first *attempt* whether or not a dump was ever written — a run that died in the nginx block leaves the volume present and no marker for this sha. So the volume is not consulted at all here; `LAST_PRE_DEPLOY` is read **non-fatally**: empty means the run failed before block 1, which is information, not a second failure to report.

**The sha mismatch hard-fails only when the deploy itself succeeded.** `latest-pre-deploy.dump` and the marker both survive a deploy that died before the dump, so on a *failed* run an older sha in the marker is the expected reading and turning it into a second red X buries the real failure. On a *successful* run block 1 must have rewritten the marker, so an older sha there means the dump on the box is not this schema's — and uploading it under this commit's artifact name would produce an artifact that silently belongs to a different schema.

**Say the exposure out loud.** That artifact contains email addresses, IP addresses and scrypt hashes, readable by anyone with repository access. For a private personal repository that is an accepted trade against having *no* off-box copy at all — the nightlies live on the instance they protect, so "instance lost" otherwise means "back to the last deploy" with nothing to restore from. The upgrade path is a write-only bucket; `retention-days: 14` is the trigger decision on how long those names live here.

One guard the spec does not spell out, and `if: always()` needs it: the run may have died **before** `Install SSH key`, in which case `~/.ssh/lightsail.pem` does not exist and the step would fail with an unrelated error attributed to the wrong thing.

This is the last deploy.yml task in the area, so its Step 4 is also the area's gate.

**Files:**
- Modify: `.github/workflows/deploy.yml` (two new steps at the end of the job)
- Test: `apps/core-api/test/deploy-config.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/deploy-config.test.js`:

```js
test("deploy uploads the pre-deploy dump, and never a stale one", () => {
  const workflow = workflowText();

  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4/);
  assert.match(workflow, /retention-days: 14/);
  assert.match(workflow, /if-no-files-found: error/);

  // if: always() runs after failures too. A run that died before "Install SSH key" has
  // no key, and that is not this step's failure to report.
  assert.match(workflow, /test -f ~\/\.ssh\/lightsail\.pem/);

  // The MARKER is the evidence, not the volume: `docker volume create` runs
  // unconditionally above block 1's gate, so the volume exists after the first ATTEMPT
  // whether or not a dump was ever written.
  assert.match(workflow, /cat ~\/backups\/LAST_PRE_DEPLOY/);
  assert.match(workflow, /no pre-deploy dump recorded - the run failed before block 1/);
  assert.doesNotMatch(workflow, /"\$remote" 'docker volume inspect/);

  // Hard-fail on a stale sha only when the deploy itself succeeded. On a failed run an
  // older sha is the expected reading, and a second red X would bury the real failure.
  assert.match(workflow, /if \[ "\$\{\{ job\.status \}\}" = "success" \]; then/);
  assert.match(workflow, /refusing to upload a stale dump/);
  assert.match(workflow, /the deploy failed before block 1 rewrote the marker - nothing to upload/);

  // The exposure is named in the file, not only in the spec.
  assert.match(workflow, /scrypt hashes/);

  // Registration count, not a pass count. Compose writes the header, the shared helpers
  // and the first six tests; this area appends exactly one top-level test per deploy.yml
  // task. A different number means a test was nested inside another test(), where
  // node --test still runs it but --test-name-pattern cannot select it.
  const suite = fs
    .readFileSync(path.join(__dirname, "deploy-config.test.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const registered = (suite.match(/^test\(/gm) || []).length;
  assert.equal(
    registered,
    15,
    `apps/core-api/test/deploy-config.test.js registers ${registered} top-level tests, expected 15 (compose's six plus nine deploy.yml tasks)`,
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-name-pattern="uploads the pre-deploy dump, and never a stale one" apps/core-api/test/deploy-config.test.js`

Expected: FAIL with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /if: always\(\)/.`

- [ ] **Step 3: Write the minimal implementation**

In `.github/workflows/deploy.yml`, append the following two steps at the end of the job — after the `Deploy on Lightsail` step, at the same indentation as `- name: Deploy on Lightsail`:

```yaml

      # THE ARTIFACT CONTAINS PRODUCTION DATA: email addresses, IP addresses and scrypt
      # hashes, readable by anyone with repository access. For a private personal
      # repository that is an accepted trade against having NO off-box copy at all --
      # the nightlies live on the very instance they protect. Upgrade path: a write-only
      # bucket. retention-days: 14 is the trigger decision on how long those names live
      # here.
      - name: Fetch the pre-deploy dump
        if: always()
        id: predeploy
        run: |
          set -euo pipefail
          # This step runs after failures too. A run that died before "Install SSH key"
          # has no key, and that is not this step's failure to report.
          test -f ~/.ssh/lightsail.pem || { echo 'no ssh key: the run failed before Install SSH key'; exit 0; }
          remote="${{ secrets.LIGHTSAIL_USER }}@${{ secrets.LIGHTSAIL_HOST }}"
          # The MARKER is the evidence, never the volume: `docker volume create` runs
          # unconditionally above block 1's gate, so the volume exists after the first
          # ATTEMPT whether or not a dump was written.
          record=$(ssh -i ~/.ssh/lightsail.pem "$remote" 'cat ~/backups/LAST_PRE_DEPLOY 2>/dev/null || true')
          if [ -z "$record" ]; then
            echo 'no pre-deploy dump recorded - the run failed before block 1'
            exit 0
          fi
          recorded_sha=${record%% *}
          dump_name=${record##* }
          if [ "$recorded_sha" != "${{ github.sha }}" ]; then
            echo "LAST_PRE_DEPLOY records $recorded_sha, not ${{ github.sha }}"
            if [ "${{ job.status }}" = "success" ]; then
              # The deploy succeeded, so block 1 must have rewritten the marker. An older
              # sha here means the dump on the box is not this schema's, and uploading it
              # under this commit's artifact name is worse than no artifact at all.
              echo "refusing to upload a stale dump under this commit's artifact name"
              exit 1
            fi
            echo 'the deploy failed before block 1 rewrote the marker - nothing to upload'
            exit 0
          fi
          scp -i ~/.ssh/lightsail.pem "$remote:~/backups/$dump_name" "/tmp/$dump_name"
          echo "dump_name=$dump_name" >> "$GITHUB_OUTPUT"

      - name: Upload the pre-deploy dump
        if: always() && steps.predeploy.outputs.dump_name != ''
        uses: actions/upload-artifact@v4
        with:
          name: pre-deploy-dump-${{ github.sha }}
          path: /tmp/${{ steps.predeploy.outputs.dump_name }}
          retention-days: 14
          if-no-files-found: error
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-name-pattern="uploads the pre-deploy dump, and never a stale one" apps/core-api/test/deploy-config.test.js`  Expected: PASS (1 test)

Parse the workflow as YAML one final time. **If a text assertion above ever fails, the fix is the YAML, never the regex** — an indentation slip yields `Invalid workflow file`, and GitHub then runs nothing at all: no tests, no deploy, and no red X on the commit:

Run: `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy.yml')); assert d['concurrency']['group']=='deploy-production'; assert d['concurrency']['cancel-in-progress'] is False; assert 'postgres' in d['jobs']['deploy']['services']; print(len(d['jobs']['deploy']['steps']),'steps')"`  Expected: `16 steps`, no traceback. Fallback if PyYAML is unavailable: `npx --yes actionlint`, expected no output

Confirm the ssh heredoc is still terminated — a `run: |` block that swallowed its `EOF` is valid YAML and a dead deploy:

Run: `node -e "const s=require('node:fs').readFileSync('.github/workflows/deploy.yml','utf8').replace(/\r\n/g,'\n'); if(!/\n          EOF\n/.test(s)) throw new Error('the ssh heredoc is not terminated'); console.log('heredoc ok');"`  Expected: `heredoc ok`

Then the two suites and the repository, as regression checks:

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

Run: `node --test apps/core-api/test/ci-contract.test.js`  Expected: `# fail 0`

Run: `npm test`  Expected: green across all suites, including `apps/core-api`. **If core-api is red for a missing `CORE_API_TEST_DATABASE_URL`, start the container — do NOT set `CORE_API_SKIP_DB_TESTS`.** The container is `docker run -d --name core-ci-probe -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:16-alpine` with `CORE_API_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres`, exactly as in the CI-service task; the skip variable would turn the database-backed suites into a green no-op on the run that ships the pipeline.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml apps/core-api/test/deploy-config.test.js docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
git commit -m "ci: upload the pre-deploy dump and refuse a stale one"
```

**MANUAL VERIFICATION — runs once, at cutover. This is not a test.**

1. First deploy on a box with no `core-db` volume.
   Expected: the job is green **and there is an artifact** `pre-deploy-dump-<sha>`. `docker volume create` runs above block 1's gate, so the gate is true even on the first deploy and the dump it takes is of a freshly initialised, empty `core`. Its size is small — a few tens of KB — and that is correct, not a failure.
2. Second deploy.
   Expected: an artifact of larger, non-zero size, and `cat ~/backups/LAST_PRE_DEPLOY` on the box records that same sha.
3. Prove the staleness refusal bites on a **successful** run: on the box, `printf 'deadbeef pre-deploy-x.dump\n' > ~/backups/LAST_PRE_DEPLOY`, then push a no-op commit, and let the deploy succeed.
   Expected: the job fails at `Fetch the pre-deploy dump` with `LAST_PRE_DEPLOY records deadbeef, not <sha>` followed by `refusing to upload a stale dump under this commit's artifact name`. The next real deploy rewrites the marker and clears it.
4. Prove it does **not** bite on a failed run: leave a stale marker, then break the deploy early (for example feed nginx an invalid `/tmp/api.conf` as in the nginx task) and push.
   Expected: the job is red for the nginx failure, and `Fetch the pre-deploy dump` is green with `the deploy failed before block 1 rewrote the marker - nothing to upload`.
5. Download the artifact and confirm it is what you think it is: `docker compose exec -T core-db pg_restore --list < pre-deploy-<ts>.dump | head -5`
   Expected: a readable TOC. An artifact nobody has ever opened is not a recovery plan.

---

## Part 5 — Environment contract, cutover and the definition of done

### Task 26: Parse the real `docker-compose.yml` instead of the copied literal

Plan 1 Task 8 pinned `config.js`'s `DEFAULTS` table to the core-api `environment:`
block and marked the seam in the test itself: *"docker-compose.yml is Plan 5. Until it
lands, these two literals ARE the contract… When the compose file arrives, replace them
with a parse of the real file; the assertions below do not change."* The file exists now,
so the literal is a **second place to edit** — precisely the drift the pin exists to
catch. Closing the seam is this task.

Spec §9.12 is what the assertions defend: the Compose entries are *documentation* and
`config.js` holds the load-bearing values, so a developer running `node server.js` with
only a `.env` file gets production-identical behaviour. That is only true while something
fails when the two disagree.

> **Ordering.** This area runs last, so the repo-root `docker-compose.yml` already exists
> and already carries `core-api` and `core-db` as spec §9.1 writes them. The module below
> reads that file at load time and cannot be faked.

**Files:**
- Create: `apps/core-api/testing/compose.js`
- Modify: `apps/core-api/test/config.test.js`
- Test: `apps/core-api/test/config.test.js`

- [ ] **Step 1: Write the failing test**

Three edits to `apps/core-api/test/config.test.js`.

**(a)** Insert after line 4 (`const { startupConfiguration, ConfigurationError, DEFAULTS } = require("../config");`):

```js
const { composeEnvironment, composeText, COMPOSE_PATH } = require("../testing/compose");
```

**(b)** Replace the block that begins `// --- the Compose contract ---` and ends with the
closing `};` of `NOT_DEFAULTED_IN_CODE` (lines 368–408 before edit (a), 369–409 after it)
with:

```js
// --- the Compose contract ---------------------------------------------------
// Plan 1 reproduced the core-api `environment:` block here as a literal, because
// docker-compose.yml did not exist yet. It exists now, so a literal would be a
// SECOND place to edit -- exactly the drift these assertions exist to catch. The
// table below is read from the real file the deploy scp's to the box.

const COMPOSE_CORE_API = composeEnvironment("core-api");
const COMPOSE_CORE_API_ENVIRONMENT_KEYS = Object.keys(COMPOSE_CORE_API);

// The three keys Compose sets that config.js deliberately does NOT default, each
// with the reason stated so the exclusion is a decision rather than a hole.
const NOT_DEFAULTED_IN_CODE = {
  TZ: "a process concern (log timestamps, now(), psql output); config.js exposes no field",
  API_PUBLIC_ORIGIN: "required with no default: a default would let a misconfigured box accept logins for the wrong origin",
  TRUSTED_PROXY_HOPS: "required under NODE_ENV=production; the development default is 0, deliberately not Compose's 1"
};

// Everything Compose sets that config.js is expected to default: the file's own
// block minus the three stated exclusions. Values stay RAW STRINGS -- "3200", not
// 3200 -- which is why DEFAULTS stores strings.
const COMPOSE_DEFAULTS = Object.fromEntries(
  Object.entries(COMPOSE_CORE_API).filter(([name]) => !(name in NOT_DEFAULTED_IN_CODE))
);
```

**(c)** Replace the whole of the existing test
`"the Compose keys config.js does not default are a stated, closed list"` with the
version below, then append the two new tests after it. (The other three tests in the
Compose-contract block — `defaults every knob…`, `the defaults table is what config.js
actually applies`, `every defaulted variable has a config field…` — are **not** edited;
they now compare against the real file without a character changing.)

```js
test("the Compose keys config.js does not default are a stated, closed list", () => {
  // Compared against config.js's own DEFAULTS, never against COMPOSE_DEFAULTS,
  // which is derived from this very exclusion list and would agree with itself
  // whatever either file said.
  assert.deepEqual(
    [...Object.keys(DEFAULTS), ...Object.keys(NOT_DEFAULTED_IN_CODE)].sort(),
    [...COMPOSE_CORE_API_ENVIRONMENT_KEYS].sort()
  );
  for (const [variable, reason] of Object.entries(NOT_DEFAULTED_IN_CODE)) {
    assert.ok(
      Object.hasOwn(COMPOSE_CORE_API, variable),
      `${variable} is excluded from DEFAULTS but docker-compose.yml no longer sets it`
    );
    assert.ok(reason.length > 0, `${variable} needs a stated reason`);
  }
});

test("the compose reader reads the real file and cannot pass by returning nothing", () => {
  // An empty parse would make every deepEqual above compare two empty objects and
  // the whole contract would go quiet. This is the test that keeps it loud.
  assert.ok(COMPOSE_PATH.endsWith("docker-compose.yml"));
  assert.match(composeText(), /^services:$/m);
  assert.ok(
    COMPOSE_CORE_API_ENVIRONMENT_KEYS.length >= 20,
    `parsed only ${COMPOSE_CORE_API_ENVIRONMENT_KEYS.length} core-api environment keys`
  );

  // Quote stripping, inline-comment stripping, and the empty value -- which is the
  // one legitimate value a broken parser also produces.
  assert.ok(Object.hasOwn(COMPOSE_CORE_API, "TERMINAL_ALLOWED_ORIGINS"));
  assert.equal(COMPOSE_CORE_API.TERMINAL_ALLOWED_ORIGINS, "");
  assert.equal(COMPOSE_CORE_API.TZ, "UTC");
  assert.equal(COMPOSE_CORE_API.API_PUBLIC_ORIGIN, "https://api.yeyintlwin.com");
  assert.equal(COMPOSE_CORE_API.TRUSTED_PROXY_HOPS, "1");

  assert.throws(() => composeEnvironment("core-apiii"), /declares no service "core-apiii"/);
});

test("the compose core-db role and database match the DSNs config.js demands in production", () => {
  // POSTGRES_USER is what initdb creates; the production username rule is what
  // refuses to listen. The two files are edited by different hands months apart,
  // and when they disagree the box fails at 28P01 in the middle of a deploy.
  const database = composeEnvironment("core-db");
  assert.equal(database.POSTGRES_USER, "core_api_owner");
  assert.equal(database.POSTGRES_DB, "core");
  assert.equal(database.TZ, "UTC");

  const config = startupConfiguration(PRODUCTION_ENV);
  assert.match(config.databaseMigrationUrl, new RegExp(`^postgres://${database.POSTGRES_USER}:`));
  assert.match(config.databaseUrl, /^postgres:\/\/core_api_app:/);
  assert.ok(config.databaseMigrationUrl.endsWith(`/${database.POSTGRES_DB}`));
  assert.ok(config.databaseUrl.endsWith(`/${database.POSTGRES_DB}`));
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/config.test.js`

Expected: FAIL — the suite does not load at all:

```
Error: Cannot find module '../testing/compose'
Require stack:
- .../apps/core-api/test/config.test.js
    code: 'MODULE_NOT_FOUND'
# fail 1
```

- [ ] **Step 3: Write the minimal implementation**

Create `apps/core-api/testing/compose.js`:

```js
"use strict";

// Reads the REAL docker-compose.yml so tests assert on the file the deploy scp's to
// the box rather than on a copy of it. Deliberately a hand-written reader and not a
// YAML dependency: apps/core-api declares exactly express and pg, and
// test/source-structure.test.js pins that list. The only two shapes this file has to
// understand are the ones the compose file uses -- blocks nested by indentation, and
// `KEY: value` scalar mappings.
//
// It lives in testing/, not test/: test/ holds only *.test.js (C13), and the
// source-structure walker excludes testing/.

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const COMPOSE_PATH = path.join(REPO_ROOT, "docker-compose.yml");

// CRLF normalised: the development machine is win32 and CI is ubuntu, so an
// anchored regex against raw bytes passes on one and fails on the other.
function composeText() {
  return fs.readFileSync(COMPOSE_PATH, "utf8").replace(/\r\n/g, "\n");
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// Blank and comment-only lines never open, close, or belong to a block.
function isSkippable(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

// Every line indented deeper than lines[start], stopping at the first line that is not.
function childLines(lines, start) {
  const base = indentOf(lines[start]);
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isSkippable(lines[index])) continue;
    if (indentOf(lines[index]) <= base) break;
    block.push(lines[index]);
  }
  return block;
}

function keyIndex(lines, key, where) {
  const pattern = new RegExp(`^\\s*${key}:(\\s|$)`);
  const index = lines.findIndex((line) => !isSkippable(line) && pattern.test(line));
  if (index === -1) throw new Error(`docker-compose.yml has no "${key}:" key ${where}`);
  return index;
}

// The lines of one service block, e.g. serviceLines("core-api").
function serviceLines(service, text = composeText()) {
  const lines = text.split("\n");
  const services = childLines(lines, keyIndex(lines, "services", "at the top level"));
  // Matched at the services' own indentation only: `core-db:` also appears inside
  // core-api's `depends_on:` block, two levels deeper.
  const top = Math.min(...services.map(indentOf));
  const pattern = new RegExp(`^\\s*${service}:\\s*(#.*)?$`);
  const start = services.findIndex((line) => indentOf(line) === top && pattern.test(line));
  if (start === -1) throw new Error(`docker-compose.yml declares no service "${service}"`);
  return childLines(services, start);
}

// Strips one layer of surrounding quotes and a trailing ` # comment`, and returns the
// RAW STRING -- "3200", never 3200. config.js's DEFAULTS stores raw strings for
// exactly this comparison.
function scalarOf(raw) {
  if (/^["']/.test(raw)) {
    const end = raw.indexOf(raw[0], 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  const comment = raw.indexOf(" #");
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

// The `environment:` mapping of one service, as { NAME: "raw string" }.
function composeEnvironment(service, text = composeText()) {
  const lines = serviceLines(service, text);
  const entries = {};
  for (const line of childLines(lines, keyIndex(lines, "environment", `in service "${service}"`))) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!match) throw new Error(`unparsable environment line in "${service}": ${line}`);
    entries[match[1]] = scalarOf(match[2].trim());
  }
  return entries;
}

module.exports = {
  COMPOSE_PATH,
  composeText,
  composeEnvironment,
  serviceLines,
  childLines,
  scalarOf
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/config.test.js`  Expected: PASS (27 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/core-api/testing/compose.js apps/core-api/test/config.test.js
git commit -m "test(core-api): pin the config defaults to the real docker-compose.yml"
```

---

### Task 27: The client-IP chain, and the three secrets that never enter the repository

Spec §9.12. Three secrets and `API_PUBLIC_ORIGIN` have **no code default**; absent, the
server refuses to listen. `config.js` already enforces that, and the compose area has
already written the operator-facing recipe for `~/core-api.env` under
**Core API runtime: two secrets files and core-net**. This task does the two things that
section does not: it writes down the client-IP chain that `TRUSTED_PROXY_HOPS=1` depends
on, and it puts a test around the promise that the three secrets are in no file the
repository ships.

Spec §9.6: a wrong hop count fails **silently in both directions** — too low and one
attacker locks out every account on the platform, too high and every request collapses
into one shared bucket. That is why the four ways to break it are written down rather
than remembered.

**Files:**
- Create: `apps/core-api/test/operations-docs.test.js`
- Modify: `infra/README.md` (append one section)
- Test: `apps/core-api/test/operations-docs.test.js`

- [ ] **Step 1: Write the failing test**

Create `apps/core-api/test/operations-docs.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { composeText } = require("../testing/compose");

const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// CRLF normalised: the development machine is win32 and CI is ubuntu, so an
// anchored regex against raw bytes passes on one and fails on the other.
function readText(...segments) {
  return fs.readFileSync(path.join(...segments), "utf8").replace(/\r\n/g, "\n");
}

// The text from one `## ` heading up to the next. infra/README.md is appended to by
// four areas, so an assertion about one section must not be satisfiable by a
// sentence somebody else wrote three sections away.
function sectionSlice(readme, heading) {
  const start = readme.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `infra/README.md has no "${heading}" section`);
  const rest = readme.slice(start + 1);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

test("infra/README.md carries the client-IP chain and links to the secrets file", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const chain = sectionSlice(readme, "## The client-IP chain");

  // Spec 12 greps infra/README.md for this string by name.
  assert.match(chain, /TRUSTED_PROXY_HOPS/);
  assert.match(chain, /\$proxy_add_x_forwarded_for/);
  assert.match(chain, /count one from the right/i);

  // core-db publishes no host port: Docker's published ports install DNAT rules
  // that bypass ufw, so `5432:5432` would put the database on the internet.
  assert.match(chain, /bypass ufw/i);

  // The secrets file is documented ONCE, by the compose area. This section links
  // to it; a second copy is a second thing to edit.
  assert.match(readme, /Core API runtime: two secrets files and core-net/);
  assert.match(readme, /~\/core-api\.env/);
  assert.doesNotMatch(readme, /^## core-api: the second secrets file$/m);
});

test("the client-IP section names the four silent breakers and the probe's real status", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const chain = sectionSlice(readme, "## The client-IP chain");

  assert.match(chain, /set_real_ip_from/);
  assert.match(chain, /real_ip_header/);
  assert.match(chain, /core-api-proxy\.conf/);
  assert.match(chain, /\$remote_addr/);

  // Present tense only. The pipeline checks the four DIRECTIVES at the config
  // layer; the behavioural forged-XFF probe of spec 9.5 step 4 selects an
  // audit_events row written by POST /api/admin/auth/login, and neither the route
  // nor the writer exists before Plan 2. The `Plan 2` match is what keeps this
  // sentence from going stale once Plan 2 ships it.
  assert.match(chain, /sudo nginx -T/);
  assert.match(chain, /Plan 2/);
  assert.doesNotMatch(chain, /runs a forged-XFF probe as a gate/);
});

test("the three secrets live only in ~/core-api.env, never in a file the repository ships", () => {
  const compose = composeText();
  const workflow = readText(repoRoot, ".github", "workflows", "deploy.yml");

  // A value in compose or in the workflow is a value in git history for ever.
  // `(^|[^A-Z_])` so CORE_API_TEST_DATABASE_URL -- a legitimate CI value pointing at
  // a throwaway localhost cluster -- does not match DATABASE_URL.
  for (const secret of ["POSTGRES_PASSWORD", "DATABASE_MIGRATION_URL", "DATABASE_URL"]) {
    assert.doesNotMatch(
      compose,
      new RegExp(`(^|[^A-Z_])${secret}\\s*:`, "m"),
      `docker-compose.yml must not set ${secret}; it comes from env_file`
    );
  }

  // BAN THE WRITE, NOT THE WORD. deploy.yml names ~/core-api.env legitimately three
  // times -- the `test -f` precondition, `export CORE_ENV_FILE=`, and the crontab
  // printf that installs the sweep line -- and none of those writes a secret. What
  // must never appear is a REDIRECTION INTO the file: it is created once, by hand,
  // at mode 600.
  const WRITES_THE_SECRETS_FILE = /(?:>|>>|tee)\s*["']?(?:~|\$HOME)\/core-api\.env/;
  // Positive control, written as a concatenation so a repo-wide grep for the banned
  // string does not hit the test that enforces the ban. Without this the rule could
  // pass because the regex is wrong rather than because the workflow is clean.
  assert.match("cat > " + "~/core-api.env", WRITES_THE_SECRETS_FILE);
  assert.doesNotMatch(workflow, WRITES_THE_SECRETS_FILE);

  // And no owner or app DSN anywhere in the workflow. `-U core_api_owner` in the
  // dump and psql calls is fine; `core_api_owner:<password>@` is not.
  assert.doesNotMatch(workflow, /core_api_(?:owner|app):[^@\s]+@/);

  // ...but both must reference the file that does carry them.
  assert.match(compose, /\$\{CORE_ENV_FILE:-\.env\}/);
  assert.match(workflow, /CORE_ENV_FILE=\.\.\/core-api\.env/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

First prove the two preconditions this area depends on. Both are satisfied already if
the areas ran in order; the guard exists so that an out-of-order run says so instead of
producing a confusing stack:

Run: `test -f docker-compose.yml && grep -q 'CORE_ENV_FILE=../core-api.env' .github/workflows/deploy.yml || echo 'STOP: run the compose and workflow areas first'`

Expected: no output. If it prints `STOP: run the compose and workflow areas first`, stop
here — the third test below cannot fail for the right reason.

Run: `node --test apps/core-api/test/operations-docs.test.js`

Expected: FAIL, `# fail 2`, with these exact messages:

1. `infra/README.md carries the client-IP chain and links to the secrets file` —
   `AssertionError [ERR_ASSERTION]: infra/README.md has no "## The client-IP chain" section`
2. `the client-IP section names the four silent breakers and the probe's real status` —
   the same message, from the same `sectionSlice` call.
3. `the three secrets live only in ~/core-api.env, never in a file the repository ships`
   — **passes**, because the compose and workflow areas have already landed. If the
   guard above printed `STOP` and you ran anyway, this one fails third with a stack, not
   an assertion: `Error: ENOENT: no such file or directory, open '…\docker-compose.yml'`
   thrown out of `composeText()` in `testing/compose.js`.

- [ ] **Step 3: Write the minimal implementation**

Append to the end of `infra/README.md`:

````markdown

## The client-IP chain

Nginx terminates TLS for `api.yeyintlwin.com` and proxies to `127.0.0.1:3200` with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`, which appends the address
Nginx actually saw to the **right** of whatever the client sent. `TRUSTED_PROXY_HOPS=1`
therefore means **count one from the right**, and a client forging its own
`X-Forwarded-For: 1.2.3.4` produces `1.2.3.4, <real ip>` and still loses. That derived
address is the key for the login rate-limit buckets and the value written to
`audit_events.source_ip`.

A wrong number fails **silently in both directions** — too low and one attacker locks out
every account on the platform, too high and every request collapses into one shared
bucket. Four ways to break it:

1. `set_real_ip_from` or `real_ip_header` anywhere in the server block: `$remote_addr` is
   rewritten *before* `$proxy_add_x_forwarded_for` is evaluated. Total bypass. Neither
   directive may appear.
2. A `location` that `proxy_pass`es without including `core-api-proxy.conf`: that route
   adds no `X-Forwarded-For` at all.
3. Putting another proxy or a CDN in front without raising the number: every entry
   shifts by one.
4. `proxy_set_header X-Forwarded-For $remote_addr`: correct at one hop, and it throws the
   chain away.

**What the pipeline actually proves today.** The deploy asserts the four directives at
the **config layer** — `sudo nginx -T | grep -q 'proxy_set_header X-Forwarded-For
\$proxy_add_x_forwarded_for'`, and a matching test asserts `set_real_ip_from` and
`real_ip_header` appear nowhere. That is a check on the file, not on behaviour. The
behavioural probe from spec §9.5 step 4 — POST a login carrying
`X-Forwarded-For: 203.0.113.99` and read the `audit_events` row back by
`detail->>'email'` — selects a row written by `POST /api/admin/auth/login`, and neither
that route nor any writer for that table exists yet. It is the first thing **Plan 2**
adds to the deploy heredoc. **Until it lands, nothing in the pipeline proves the derived
address is unforgeable**; the file is checked, the behaviour is not.

**Live topology, updated whenever it changes:** browser → Nginx (same host) →
`127.0.0.1:3200`. One hop. `TRUSTED_PROXY_HOPS=1`.

`core-db` publishes **no** host port at all. Docker's published ports install DNAT rules
that **bypass ufw** on Ubuntu, so `5432:5432` would put the database on the internet, and
`127.0.0.1:5432:5432` differs from it by one deletion. Nothing needs it: `core-api`
reaches the database over `core-net`, and every runbook command goes through
`docker compose exec`.

The three secrets that make any of this reachable — `POSTGRES_PASSWORD`,
`DATABASE_MIGRATION_URL` and `DATABASE_URL` — live in `~/core-api.env` and nowhere else.
Creating it, its mode, and why it is a second file rather than a shared one are in
**Core API runtime: two secrets files and core-net** above; this section does not repeat
the recipe, because a second copy is a second thing to edit.
````

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/operations-docs.test.js`  Expected: PASS (3 tests)

This task appends to `infra/README.md`, so the Task 4 rule applies — a `docker compose`
line naming `CORE_ENV_FILE` must also name `EPAPER_ENV_FILE`:

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add infra/README.md apps/core-api/test/operations-docs.test.js
git commit -m "docs(infra): the client-IP chain, and a test that the secrets ship nowhere"
```

---

### Task 28: The deploy window and the cutover order in `infra/README.md`

Spec §9.5 records a consequence that predates this phase and gets worse in it: **every
push already recreates `epaper-hub` and `customer-order`** with a fresh `${{ github.sha }}`
tag, which resets all twelve e-paper displays to `Welcome` and drops every in-memory
order session. Plan 5 does not introduce that — it **lengthens the window** by putting a
migration and a 90-second health gate in front of it. The spec's instruction is literal:
put that sentence in `infra/README.md`.

The same section carries spec §9.11's cutover order, because the order is the content:
`certbot` before the first push, because the deploy's `nginx -t` fails without the
certificate and it fails *after* the migration has already applied.

**Files:**
- Modify: `apps/core-api/test/operations-docs.test.js` (append)
- Modify: `infra/README.md` (append two sections)
- Test: `apps/core-api/test/operations-docs.test.js`

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/operations-docs.test.js`:

```js
test("infra/README.md warns that every push resets the dining room", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const window = sectionSlice(readme, "## Deploy window");

  // Spec 9.5. Phase 1 does not introduce this; it lengthens the window by putting a
  // migration in front of it, which is the whole reason the sentence has to be here.
  assert.match(window, /resets all twelve e-paper displays to `Welcome`/);
  assert.match(window, /in-memory order session/i);
  assert.match(window, /lengthens the window/);

  // Spec 12 greps infra/README.md for both of these strings by name.
  assert.match(window, /outside service hours/);
  assert.match(window, /business_date/);

  // deploy.yml:84 preserves docker-compose.yml AND config/. Stating it as "empties
  // the folder" is how the two infra scripts end up installed somewhere the find
  // deletes, with the workflow-text assertion still green.
  assert.match(window, /! -name docker-compose\.yml ! -name config/);
  assert.match(window, /config\/backup-core-db\.sh/);
  assert.doesNotMatch(readme, /empties that (?:directory|folder) on every push/);
});

test("infra/README.md carries the cutover order, certbot before the first push", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const cutover = sectionSlice(readme, "## Cutover checklist");

  // A needle that is absent returns -1, which compares "less than" everything and
  // would make every ordering assertion below pass vacuously.
  const step = (needle) => {
    const index = cutover.indexOf(needle);
    assert.notEqual(index, -1, `the cutover list never mentions "${needle}"`);
    return index;
  };

  assert.ok(step("DNS") < step("certbot"), "DNS must come before certbot");
  assert.ok(step("certbot") < step("core-api.env"), "certbot must come before the secrets file");
  assert.ok(step("core-api.env") < step("Push"), "the secrets file must exist before the first push");
  assert.ok(step("Push") < step("restore drill"), "the restore drill runs after the first deploy");

  assert.match(cutover, /vm\.swappiness=10/);
  assert.match(cutover, /systemctl reload nginx/);

  // PATH PINNED. The drill is a HOST script driving `docker compose`, so it cannot
  // live inside the image; the deploy scp's it into config/, which the find spares.
  assert.match(cutover, /~\/restaurant-order-system\/config\/restore-drill\.sh/);

  // create-platform-admin.js needs the users table, lib/password.js and the audit
  // writer. None exist yet, so the bootstrap step must say which plan brings them
  // rather than sending an operator to a script that is not there.
  assert.match(cutover, /Plan 2/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/operations-docs.test.js`

Expected: FAIL, `# fail 2`, with:

1. `infra/README.md warns that every push resets the dining room` —
   `AssertionError [ERR_ASSERTION]: infra/README.md has no "## Deploy window" section`
2. `infra/README.md carries the cutover order, certbot before the first push` —
   `AssertionError [ERR_ASSERTION]: infra/README.md has no "## Cutover checklist" section`

The three tests from the previous task still pass.

- [ ] **Step 3: Write the minimal implementation**

Append to the end of `infra/README.md`:

````markdown

## Deploy window

Every push to `main` rebuilds `epaper-hub` and `customer-order` with a fresh
`${{ github.sha }}` tag and recreates both containers, which **resets all twelve e-paper
displays to `Welcome`** and drops every in-memory order session. A table mid-order at
that moment loses its cart and has to rescan.

This is not new with core-api, but core-api **lengthens the window**: a database
migration now runs before anything starts, and the deploy will not proceed until
`/health/ready` answers, which the gate allows up to 90 seconds. **Deploy outside service
hours.** There is no way to shorten it in this phase short of not deploying.

**What a push destroys on disk, and what it spares.** Before Compose is invoked the
deploy runs

```sh
find ~/restaurant-order-system -mindepth 1 -maxdepth 1 ! -name docker-compose.yml ! -name config -exec rm -rf {} +
```

so everything directly inside `~/restaurant-order-system` is deleted **except**
`docker-compose.yml` and `config/`. That is exactly why the two host scripts are
installed as `config/backup-core-db.sh` and `config/restore-drill.sh`, and why the Nginx
files are scp'd to `/tmp` and then `install`ed into `/etc/nginx` rather than dropped
"next to the compose file". And it is the real reason `~/core-api.env` sits one directory
**up**, outside the deploy folder entirely: a bad edit to that `find` can never reach it.

`business_date` is the related trap for whoever reads the numbers afterwards. It is
computed from the shop's `time_zone` and `business_day_rollover_hour` and **stored at
write time, never recomputed**. Correcting a shop's timezone later is the right thing to
do, and yesterday's rows keep their original bucket — that is correct accounting, not a
bug. Every such change writes a `shop.updated` audit row, so it stays attributable.

## Cutover checklist

Once, before the first core-api deploy. The exact commands and their expected output are
in the Plan 5 deployment plan under **MANUAL VERIFICATION — cutover**; the order below is
not negotiable.

1. DNS `A` record for `api.yeyintlwin.com` → the Lightsail instance.
2. `sudo certbot certonly --nginx -d api.yeyintlwin.com`. The deploy's `nginx -t` fails
   without the certificate, and it fails *after* the migration has already applied.
3. Host prerequisites: 2 GB swap and `vm.swappiness=10`; paste `free -m` and
   `docker stats --no-stream` into the baseline block below; confirm the deploy user has
   passwordless `sudo` for `install`, `nginx -t` and `systemctl reload nginx`. A password
   prompt there hangs the deploy until it times out.
4. Create `~/core-api.env` at mode 600 — see **Core API runtime: two secrets files and
   core-net** — and confirm `~/restaurant-order-system.env` is untouched.
5. Merge the compose move as ONE commit, outside service hours; it recreates every
   container.
6. Push, and watch the health gate. On failure, `docker compose logs core-api`: the
   migration runner prints the file, both digests and its verdict.
7. Bootstrap the first platform administrator — **Plan 2**.
   `apps/core-api/scripts/create-platform-admin.js` needs the `users` table,
   `lib/password.js` and the audit writer, none of which exist yet. Until then core-api
   serves `/health` and `/health/ready` and nothing else, so there is no login to verify.
   The runbook entry is already in `apps/core-api/README.md`.
8. Record the live client-IP topology in **The client-IP chain** above. The behavioural
   forged-XFF probe needs the login route and an audit writer, so it arrives with Plan 2;
   today the check is at the config layer (`sudo nginx -T`).
9. Run `~/restaurant-order-system/config/restore-drill.sh` against the first dump you
   have. On the very first deploy there is none — the pre-deploy dump is gated on the
   `core-db` volume, which did not exist yet — so the first dump appears either at
   03:17 UTC that night (the nightly) or on the second push (that push's pre-deploy
   dump), whichever comes first. Do not skip it because it is the day everything worked;
   that is exactly when a restore drill is cheap.

**Host baseline, recorded at cutover:**

```text
free -m                  : (paste here)
docker stats --no-stream : (paste here)
```
````

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/operations-docs.test.js`  Expected: PASS (5 tests)

This task appends to `infra/README.md`, so the Task 4 rule applies:

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add infra/README.md apps/core-api/test/operations-docs.test.js
git commit -m "docs(infra): the deploy window, business_date forward-only, and the cutover order"
```

---

### Task 29: Reconcile the four areas' sections into one runbook

`infra/README.md` is now written by four areas that each describe a piece of the same
pipeline. This area runs last precisely so that somebody reads all of it together, and
three claims are easy to over-state: what the XFF check proves, what a missing nightly
does, and what the deploy's `find` deletes. This task adds the cross-section guards, pins
the restore drill's path at both ends so the runbook and the shipping file cannot
disagree, and closes spec §12's documentation greps.

**Files:**
- Modify: `apps/core-api/test/operations-docs.test.js` (append)
- Modify: `infra/README.md` (append one `###` subsection under `## Cutover checklist`)
- Test: `apps/core-api/test/operations-docs.test.js`

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/core-api/test/operations-docs.test.js`:

```js
test("no section of infra/README.md over-states what the pipeline proves", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const reconciliation = sectionSlice(readme, "## Cutover checklist");

  // 1. The XFF check. Config layer today; the behavioural probe is Plan 2. Spec 9.12
  //    words it as "the deploy runs a forged-XFF probe as a gate", which is true of
  //    the finished phase and false of this one, so it is the phrase most likely to
  //    be copied in. Replacement sentence, if this fires:
  //    "The deploy asserts the four directives at the config layer with `sudo nginx
  //    -T`; the behavioural forged-XFF probe of spec 9.5 step 4 arrives with Plan 2."
  assert.doesNotMatch(readme, /runs a forged-XFF probe as a gate/);

  // 2. The backup-health gate. It is gated on the BOOTSTRAP MARKER, not on LAST_OK's
  //    existence -- gating on `[ -f LAST_OK ]` would make a nightly that has never
  //    once succeeded green forever. So the honest sentence is about the marker's age,
  //    and it is quiet only for the first 48 hours after cron was installed.
  //    Replacement sentence, if the doesNotMatch fires: "A missing nightly turns the
  //    deploy red only once `~/backups/CRON_INSTALLED_AT` is itself more than 48 hours
  //    old; before then the nightly has had no chance to run."
  assert.match(
    reconciliation,
    /only once `~\/backups\/CRON_INSTALLED_AT` is itself more than 48 hours old/,
  );
  assert.doesNotMatch(readme, /any deploy with no nightly in 48 hours fails/i);

  // 3. The find. It preserves docker-compose.yml and config/.
  assert.doesNotMatch(readme, /deletes everything in ~\/restaurant-order-system\b(?![^\n]*except)/);
});

test("the restore drill's runbook path and the shipping script agree", () => {
  const readme = readText(repoRoot, "infra", "README.md");
  const workflow = readText(repoRoot, ".github", "workflows", "deploy.yml");

  // Both ends, so the runbook cannot name a path nothing installs. Spec 9.7 writes it
  // as scripts/restore-drill.sh; that path is superseded because the drill is a HOST
  // script driving `docker compose`, which does not exist inside the image.
  assert.ok(
    fs.existsSync(path.join(repoRoot, "infra", "restore-drill.sh")),
    "infra/restore-drill.sh is the file the deploy scp's into config/"
  );
  assert.match(readme, /config\/restore-drill\.sh/);
  assert.match(workflow, /infra\/restore-drill\.sh/);
  assert.match(workflow, /config\/restore-drill\.sh/);
});

test("spec 12's documentation greps pass", () => {
  const infra = readText(repoRoot, "infra", "README.md");
  const core = readText(repoRoot, "apps", "core-api", "README.md");

  // The exact six strings spec 12's final item greps for, asserted here so the
  // failure is a named test rather than a shell one-liner nobody runs.
  assert.match(infra, /TRUSTED_PROXY_HOPS/);
  assert.match(infra, /ALTER ROLE/);
  assert.match(infra, /business_date/);
  assert.match(infra, /outside service hours/);
  assert.match(core, /create-platform-admin/);
  assert.match(core, /CORE_API_TEST_DATABASE_URL/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test apps/core-api/test/operations-docs.test.js`

Expected: FAIL, `# fail 1`, in `no section of infra/README.md over-states what the
pipeline proves` with
``AssertionError [ERR_ASSERTION]: The input did not match the regular expression /only once `~\/backups\/CRON_INSTALLED_AT` is itself more than 48 hours old/``.

The other two new tests pass: `infra/restore-drill.sh` and both workflow lines were
landed by the backup and workflow areas, and `ALTER ROLE` is already in the backup
area's *Rotating database passwords* subsection. If either of those two fails instead,
the corresponding area did not finish — fix that before continuing, not this file.

- [ ] **Step 3: Write the minimal implementation**

Append to the end of `infra/README.md` — it lands inside `## Cutover checklist`, which is
the last section in the file:

````markdown

### What this pipeline proves, and what it does not

Four sections above were written by four different pieces of work. Three claims are easy
to over-state, so they are stated once, here, correctly.

| Claim | What is actually true today |
| --- | --- |
| The deploy proves `X-Forwarded-For` is unforgeable | It does not. It asserts the four **directives** with `sudo nginx -T`, which is a check on the config file. The behavioural probe — POST a login with `X-Forwarded-For: 203.0.113.99` and read the `audit_events` row back — needs the login route and the audit writer, and arrives with **Plan 2**. |
| A missing nightly backup turns the deploy red | Only once `~/backups/CRON_INSTALLED_AT` is itself more than 48 hours old. That marker is written once, when the deploy first installs the crontab. Before then the gate is deliberately quiet, because the nightly has legitimately had no chance to run. From then on, a missing **or** stale `LAST_OK` fails the deploy — including the case where the nightly has never once succeeded. |
| The deploy wipes `~/restaurant-order-system` | It deletes everything directly inside it **except** `docker-compose.yml` and `config/`. That is why `config/backup-core-db.sh` and `config/restore-drill.sh` survive, and why the Nginx files go via `/tmp`. |

Two credentials, two mechanisms, and mixing them up is what the startup equality check
exists to catch: the **app** password rotates by itself, because the migration runner
issues `ALTER ROLE core_api_app LOGIN PASSWORD …` on every boot, so editing `DATABASE_URL`
and redeploying is a complete rotation; the **owner** password does not, because `initdb`
reads `POSTGRES_PASSWORD` once, when the volume is created. The ordered procedure is in
*Rotating database passwords* above and in `apps/core-api/README.md`.
````

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test apps/core-api/test/operations-docs.test.js`  Expected: PASS (8 tests)

This task rewrites `infra/README.md` rows, so the Task 4 rule applies:

Run: `node --test apps/core-api/test/deploy-config.test.js`  Expected: `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add infra/README.md apps/core-api/test/operations-docs.test.js
git commit -m "docs(infra): reconcile the four runbook sections and pin the drill's path"
```

---

### Task 30: MANUAL VERIFICATION — cutover (spec §9.11), then close the plan

**The nine steps below are not tests, and nothing in this plan re-runs them.** They run
**once**, in this order, at cutover. Eight of the nine touch DNS, a certificate
authority, the host's kernel settings, or the production database, so no assertion in
this repository can stand in for them. Tick them here as you go; Step 10 is the commit
that closes the plan.

- [ ] **1. DNS.** From the development machine:

  ```sh
  dig +short api.yeyintlwin.com
  ```

  Expect exactly the Lightsail instance's static IP, on one line. Empty output means the
  record has not propagated, and step 2 will fail its HTTP-01 challenge with
  `Some challenges have failed`.

- [ ] **2. Certificate.** On the box:

  ```sh
  sudo certbot certonly --nginx -d api.yeyintlwin.com
  sudo ls -l /etc/letsencrypt/live/api.yeyintlwin.com/fullchain.pem
  ```

  Expect `Successfully received certificate.` and a `fullchain.pem` symlink. This is step
  2 and not step 7 because the deploy's `sudo nginx -t` fails without the certificate,
  and by then the migration has already applied.

- [ ] **3. Host prerequisites.** On the box:

  ```sh
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
  sudo sysctl -p /etc/sysctl.d/99-swappiness.conf
  free -m
  docker stats --no-stream
  sudo -n install -m0644 /dev/null /tmp/sudo-probe && echo INSTALL_OK
  sudo -n nginx -t && echo NGINX_T_OK
  sudo -n systemctl reload nginx && echo RELOAD_OK
  ```

  Expect `vm.swappiness = 10`, a `Swap:` row in `free -m` totalling ~2048, and the three
  `*_OK` lines. A password prompt instead of `INSTALL_OK` means the deploy hangs on its
  first `sudo` and times out — fix sudoers before pushing. Paste `free -m` and
  `docker stats --no-stream` into the host-baseline block in `infra/README.md`.

- [ ] **4. The secrets file.** On the box, exactly the recipe in `infra/README.md`
  (*Core API runtime: two secrets files and core-net*), then:

  ```sh
  ls -l ~/core-api.env ~/restaurant-order-system.env
  grep -c . ~/core-api.env
  ```

  Expect `-rw------- 1 <user> <user>` on `~/core-api.env`, `3` non-empty lines, and
  `~/restaurant-order-system.env` unchanged — same mode, same mtime as before this
  session.

- [ ] **5. The atomic commit, outside service hours.** From the repository root on the
  development machine:

  ```sh
  git show --stat HEAD
  git status --porcelain
  ```

  Expect an empty `git status`, and ONE commit whose stat lists all five files of the
  compose move (spec §9.0): `docker-compose.yml` (new),
  `apps/epaper-hub/docker-compose.yml` (deleted), `.github/workflows/deploy.yml`,
  `apps/epaper-hub/README.md` and `apps/epaper-hub/test/deploy-config.test.js`. Split
  across two commits, `main` is briefly a state where the workflow scp's a path that does
  not exist.

- [ ] **6. Push, and watch the gate.**

  ```sh
  git push origin main
  gh run watch
  ```

  Expect the `Deploy` job to reach the health-gate step and the run to finish green. On
  failure, on the box:

  ```sh
  cd ~/restaurant-order-system && export CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env
  docker compose logs --tail 200 core-api
  docker compose logs --tail 50 core-db
  ```

  The migration runner prints the filename, both digests and its verdict; that line is
  the diagnosis.

  **The final artifact step, on this first run.** It reads `~/backups/LAST_PRE_DEPLOY`,
  which does not exist yet — the pre-deploy dump is gated on the `core-db` volume, and on
  the first push there is no volume. With the workflow area's non-fatal marker read the
  step is green and simply reports that there was nothing to upload. If you are running
  before that fix landed, the step **fails on a missing `LAST_PRE_DEPLOY` while the
  deploy itself succeeded**. Do not re-push to "get it green": a second push recreates all
  twelve displays a second time. The check that the deploy worked is on the box:

  ```sh
  curl -fsS -m 3 http://127.0.0.1:3200/health/ready
  ```

- [ ] **6a. RECOVERY — first deploy only.** The documented rollback
  (`CORE_API_IMAGE=core-api:<previous-sha> docker compose up -d core-api`) and the
  pre-deploy dump both presuppose a **second** deploy. On the cutover push there is
  neither: no previous image tag on the box, and no dump. If the gate fails on a bad
  `~/core-api.env` — a typo in a DSN, `POSTGRES_PASSWORD` disagreeing with
  `DATABASE_MIGRATION_URL`, an owner password under 24 characters — the recovery is to
  throw the volume away. **Prove it is empty first:**

  ```sh
  cd ~/restaurant-order-system && export CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env
  docker compose exec -T core-db psql -U core_api_owner -d core -tAc "select count(*) from companies"
  ls -1 ~/backups/pre-deploy-*.dump 2>/dev/null | wc -l
  test -e ~/backups/LAST_PRE_DEPLOY && cat ~/backups/LAST_PRE_DEPLOY
  ```

  Expect `0` companies, at most one `pre-deploy-*.dump`, and either no `LAST_PRE_DEPLOY`
  or one naming **this** sha. **Any other reading means STOP** — you are not on the first
  deploy and this branch destroys the production database with no way back.
  `schema_migrations` is **not** a usable guard here: Plan 1 ships exactly one migration,
  so that table holds exactly one row on every deploy until Plan 2 adds a second — a
  count of `0` or `1` is true forever and gates nothing. Then:

  ```sh
  docker compose down
  docker volume rm restaurant-order-system_core-db-data
  # fix ~/core-api.env, then re-push
  ```

  **From the second deploy onward the volume is never removed.** The block-1 pre-deploy
  dump is the recovery from then on, and the previous sha's image tag is still on the box
  — `docker image prune -f` removes only dangling images, and a tagged one is not
  dangling.

- [ ] **7. Bootstrap — deferred to Plan 2.** `scripts/create-platform-admin.js` needs the
  `users` table, `lib/password.js` and an audit writer; none exist in Plan 1 or Plan 5,
  and Plan 5 does not write that script. Skip this step at this cutover. core-api serves
  `/health` and `/health/ready` only, so there is no login to verify yet. The runbook
  entry is already in `apps/core-api/README.md`.

- [ ] **8. Client-IP topology — config layer today.** On the box:

  ```sh
  sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -E 'real_ip_header|set_real_ip_from|real_ip_recursive' || echo NONE
  sudo nginx -T | grep -qE 'proxy_set_header +X-Forwarded-For +\$proxy_add_x_forwarded_for' && echo XFF_OK
  ```

  Expect `0` and `XFF_OK`. Then record the topology in `infra/README.md`.

  **Cross-area note, and it is load-bearing:** spec §9.5's forged-XFF probe selects an
  `audit_events` row written by `POST /api/admin/auth/login`. Neither the route nor any
  writer for that table exists before Plan 2, so the probe must stay **out** of the deploy
  heredoc until then — enabled now it fails every deploy with
  `XFF probe wrote no audit row - it never reached core-api`. The `limit_req` burst
  (heredoc step 5) *is* valid today: nginx sheds with 429 before proxying, so it does not
  care what core-api answers.

- [ ] **9. Restore drill.** There is no dump on the first deploy, so run this after the
  first nightly (03:17 UTC) or after the second push, whichever comes first. On the box:

  ```sh
  cd ~/restaurant-order-system && export CORE_ENV_FILE=../core-api.env EPAPER_ENV_FILE=../restaurant-order-system.env
  ls -l ~/backups/
  cat ~/backups/LAST_PRE_DEPLOY
  docker compose exec -T core-db pg_restore --list < ~/backups/latest-pre-deploy.dump | head -5
  sh ~/restaurant-order-system/config/restore-drill.sh
  ```

  Expect `LAST_PRE_DEPLOY` to name the deploy that wrote it; `pg_restore --list` to print
  a table of contents rather than `did not find magic string`; and the drill to restore
  into `core_restore_check`, print a `schema_migrations` ledger matching the image
  (`0001_init.sql`), pass the schema-invariant assertions, print row counts, and drop the
  scratch database. A backup nobody has restored is not a recovery plan. Repeat monthly.

- [ ] **10. Close the plan.** Tick the definition of done below, append the session's row
  to the execution log at the top of this file, and commit the plan file **alone** — no
  code, no docs, so the record of what was done is one commit that reads cleanly:

  ```bash
  git add docs/superpowers/plans/2026-07-30-core-api-phase1-plan5-deployment.md
  git commit -m "docs(plan5): record the cutover and close the deployment plan"
  ```

---

### Definition of done

Every item is a command. `[repo]` items run **from the repository root** and are what the
test suite already enforces; `[box]` items can only be checked on the Lightsail host and
are verified once at cutover.

**Read this before running the first item.** A bare `npm test` on the win32 development
machine is **red by design**: core-api's database suites *throw* rather than skip when
`CORE_API_TEST_DATABASE_URL` is unset, so a missing value can never silently disable the
tenant-isolation sweep. Use one of the two forms below.

- [ ] `[repo]` **With Postgres** —
      `CORE_API_TEST_DATABASE_URL=postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres npm test`
      → green across all four workspaces, and the output includes `apps/core-api`.
      PowerShell: `$env:CORE_API_TEST_DATABASE_URL = "postgres://core_api_owner:devpassword@127.0.0.1:5433/postgres"; npm test`.
- [ ] `[repo]` **Laptop with no Postgres** (spec §12) —
      `CORE_API_SKIP_DB_TESTS=1 npm --prefix apps/core-api test` → `# fail 0` with a
      **nonzero** skip count, and every pure suite still reported as run.
- [ ] `[repo]` `node --test apps/core-api/test/config.test.js` → `# pass 27`, `# fail 0`.
- [ ] `[repo]` `node --test apps/core-api/test/operations-docs.test.js` → `# pass 8`, `# fail 0`.
- [ ] `[repo]` **BREAK — proves the compose parse is live, not decorative.** Change
      `SCRYPT_SLOTS: 2` to `SCRYPT_SLOTS: 3` in `docker-compose.yml`, then
      `node --test apps/core-api/test/config.test.js`: **exactly two** tests report
      `not ok` — `config.js defaults every knob to the value the Compose file sets` and
      `the defaults table is what config.js actually applies`. One failure instead of two
      means the parse is feeding the table but not the applied config, or the reverse.
      `git checkout docker-compose.yml` restores green.
- [ ] `[repo]` spec §12 verbatim — `npm --prefix apps/core-api ci && npm --prefix apps/core-api test`
      → `# fail 0` **and** `# skip 0`. The skip count is part of the pass condition.
- [ ] `[repo]` spec §12 **BREAK 7** verbatim — delete the `services: postgres:` block from
      `.github/workflows/deploy.yml`; **only** `test/ci-contract.test.js` reports `not ok`.
      `git checkout .github/workflows/deploy.yml` restores green.
      (`apps/core-api/test/ci-contract.test.js` is created by the workflow area's
      CI-service task; this item only cites it.)
- [ ] `[repo]` `npm --prefix apps/epaper-hub test` → green, 14 tests. This is what proves
      the five-file compose move landed completely: `deploy-config.test.js` was repointed
      at the repo root, not relaxed.
- [ ] `[repo]` `docker compose -f docker-compose.yml build epaper-hub` → succeeds. A REAL
      build, not `docker compose config` (which normalises a broken build context and
      still prints ok) and not `build --dry-run` (which never executes a `COPY` layer).
- [ ] `[repo]` `docker build -f apps/core-api/Dockerfile -t core-api:dod .` → succeeds, and
      both probes below pass. `WORKDIR /app` plus `COPY apps/core-api ./apps/core-api`
      puts the dependencies at `/app/apps/core-api/node_modules`, so the `-w` is not
      optional — without it a correct image fails and only a hoisted root copy would pass:

      ```sh
      docker run --rm -w /app/apps/core-api core-api:dod node -e "require('express');require('pg');console.log('deps ok')"
      docker run --rm core-api:dod sh -c '! test -d /app/node_modules && test -d /app/apps/core-api/node_modules && echo layout ok'
      ```

      → `deps ok` and `layout ok`.
- [ ] `[repo]` `git grep -c 'core-api' -- .github/workflows/deploy.yml` → non-zero (it was
      `0` before this plan).
- [ ] `[repo]` **Concurrency.** Cancelling a run mid-`ssh` kills the SSH client without
      stopping the remote shell, which is how the migration advisory lock gets orphaned —
      so both keys are mandatory, and the tarball must be per-sha or two runs overwrite
      one path:
      `git grep -n 'group: deploy-production' -- .github/workflows/deploy.yml` → non-empty;
      `git grep -n 'cancel-in-progress: false' -- .github/workflows/deploy.yml` → non-empty;
      `git grep -c 'core-api-image-${{ github.sha }}.tgz' -- .github/workflows/deploy.yml` → non-zero.
- [ ] `[repo]` `git grep -nE '(^|[^A-Z_])(POSTGRES_PASSWORD|DATABASE_MIGRATION_URL|DATABASE_URL)\s*:' -- docker-compose.yml`
      → no output. The three secrets exist only in `~/core-api.env`.
- [ ] `[repo]` `test -f infra/restore-drill.sh` → exit 0, and
      `git grep -c 'config/restore-drill.sh' -- .github/workflows/deploy.yml infra/README.md`
      → non-zero for both files. The drill is a host script driving `docker compose`, so it
      cannot live in the image; the deploy scp's it into `config/`, which the `find` spares.
- [ ] `[repo]` `test "$(grep -c limit_req infra/nginx/api.conf)" -ge 2` → exit 0.
- [ ] `[repo]` spec §12 verbatim, one command:
      `grep -q TRUSTED_PROXY_HOPS infra/README.md && grep -q 'ALTER ROLE' infra/README.md && grep -q business_date infra/README.md && grep -q 'outside service hours' infra/README.md && grep -q create-platform-admin apps/core-api/README.md && grep -q CORE_API_TEST_DATABASE_URL apps/core-api/README.md`
      → exit 0.
- [ ] `[repo]` `ls apps/core-api/test | grep -v '\.test\.js$'` → no output. The compose
      reader went to `testing/`, which is where helpers live (C13).
- [ ] `[repo]` **After the second push:** `gh run list --workflow=Deploy --limit 1` → the
      head commit's run is `success`. Reserved for the second push because the first run's
      artifact step has no `LAST_PRE_DEPLOY` to upload — see MANUAL VERIFICATION step 6.
- [ ] `[box]` `curl -fsS -m 3 http://127.0.0.1:3200/health/ready` → `{"ok":true,"app":"core-api"}`.
      This is what the deploy gate polls for 90 seconds.
- [ ] `[box]` `curl -fsS -m 5 --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health`
      → `{"ok":true,"app":"core-api"}` through the real TLS chain, and
      `curl -s -o /dev/null -w '%{http_code}\n' -m 5 --resolve api.yeyintlwin.com:443:127.0.0.1 https://api.yeyintlwin.com/health/ready`
      → `404`. Readiness is never exposed publicly.
- [ ] `[box]` 20 rapid POSTs to `/api/admin/auth/login` through that same `--resolve`
      chain produce at least one `429` — nginx `limit_req` is live in production, not
      merely present in a file. Valid today even though the route does not exist: nginx
      sheds before it proxies.
- [ ] `[box]` `sudo nginx -T | grep -vE '^[[:space:]]*#' | grep -E 'real_ip_header|set_real_ip_from|real_ip_recursive' || echo NONE` → `0`, and in
      `api.yeyintlwin.com.conf` the count of `proxy_pass` equals the count of
      `include .*core-api-proxy.conf`.
- [ ] `[box]` **From the second deploy onward:** `cat ~/backups/LAST_PRE_DEPLOY` names the
      currently deployed sha, and `ls -l ~/backups/latest-pre-deploy.dump` shows a
      mode-600 file with non-zero size. Empty on the very first deploy by design — the
      dump is gated on the volume existing.
- [ ] `[box]` after the first nightly: `find "$HOME/backups/LAST_OK" -mtime -2 2>/dev/null | grep -q .`
      → exit 0; `crontab -l | grep -q backup-core-db.sh` → exit 0; and
      `ls -l ~/backups/CRON_INSTALLED_AT` → one zero-byte marker dated at the first deploy.
- [ ] `[box]` `sh ~/restaurant-order-system/config/restore-drill.sh` → restores the dump
      into `core_restore_check`, prints a `schema_migrations` ledger matching the image,
      passes the schema-invariant assertions, prints row counts, drops the scratch
      database, exits 0.
- [ ] **Plan 2, not this plan:** the forged-XFF audit-row probe, `create-platform-admin.js`
      and its TTY refusal, and `scripts/sweep-expired.js`. Until the sweep script exists,
      the crontab line the deploy installs writes a nightly `Cannot find module` into
      `~/backups/sweep.log` — harmless, expected, and the first thing Plan 2 closes.

---

## Notes from each part

**Part 1 — The compose move, the Dockerfile and the two secrets files**

- ORDERING CHANGED FROM THE DRAFT, and it is load-bearing. The Dockerfile task now comes BEFORE the Compose task, because the Compose task's commit adds `docker build -f apps/core-api/Dockerfile ...` to CI. The draft's order would have produced one commit where every push to main fails at the build step.
- CORE-DB AND CORE-API ARE NOW ONE TASK, not two. The draft split them, but `core-db` alone already declares `env_file: ${CORE_ENV_FILE:-.env}`, so the compose file becomes unloadable on the box the instant core-db lands unless the deploy exports CORE_ENV_FILE - and the file-ownership table permits only 'the task that adds the core-api service' to touch deploy.yml. Merging is the only reading that satisfies both the ownership rule and 'deployable at every commit'.
- The area leaves apps/core-api/test/deploy-config.test.js at EXACTLY six tests, as the ownership table requires: Dockerfile (1), core-db (2), core-api (3), the compose-to-deploy reconciliation (4), the core-net/env_file isolation sweep (5), the operator docs (6). The draft's separate 'the deploy points core-db and core-api at the second secrets file' test was absorbed into the reconciliation test, which now covers CORE_ENV_FILE, EPAPER_ENV_FILE, the two negative crossovers, the find line and the test -f guard.
- Helper names follow the ownership table verbatim: readText (CRLF-normalising), composeText, workflowText, servicesOf. The draft's `compose()` was renamed to `composeText()` and a `workflowText()` helper added, so the workflow area's appended tests have the four helpers the table promises them and redeclare none.
- The reconciliation test collapses `${{ github.sha }}` to the literal `SHA` before matching. Without that, `\S+` tokenisation of `EPAPER_IMAGE=epaper-hub:${{ github.sha }}` stops at the space inside the Actions expression and captures `epaper-hub:${{`. This is why the test reads `flat` rather than the raw workflow text.
- EVERY trailing comment was removed from assertion-bearing lines in docker-compose.yml. Spec 9.1 writes `networks: [core-net]             # NOT on the default network`, which would break the `$`-anchored `/^    networks: \[core-net\]$/m` the fix list mandates. All comments now sit on their own lines. This also keeps cutover's testing/compose.js parser simple.
- The compose file's comments were rewritten to avoid the literal string 5432, because `assert.doesNotMatch(text, /5432/)` covers the whole file including comments. The draft's core-db comment said 'Not 127.0.0.1:5432:5432' and would have failed its own test.
- apps/epaper-hub/README.md's local recipe now ends `docker compose up -d --build epaper-hub customer-order` and carries CORE_ENV_FILE. Naming a subset does NOT exempt the other services from env_file validation - that is the same fact the runbook fix is about - so both variables are required even for the two-service form. Task 1's new README assertion is deliberately not `$`-anchored so this later refinement does not turn it red.
- apps/core-api/README.md's create-platform-admin snippet is at line 138, not 132-136 as the ownership table says (132 is the `## Bootstrapping` heading; 136-140 is the fence). The task edits the actual line and the 'Ships in a later plan of this phase' sentence at :134 is left untouched and asserted.
- One deploy.yml change is slightly beyond the fix list's enumeration: `:88` gains `/tmp/core-api-image-${{ github.sha }}.tgz` in the `rm -f`. Without it a sha-named tarball accumulates in /tmp on both the runner and the box, one per deploy. Its assertion is written loosely (`/rm -f \/tmp\/[^\n]*image[^\n]*\.tgz/`) so it keeps matching when the workflow area folds it into `/tmp/*-image*.tgz`.
- `docker volume create restaurant-order-system_core-db-data` (spec 9.5) is deliberately NOT added here - it is not in the sanctioned pipeline list and Compose creates the volume itself. It is flagged in the task's 'what this task does NOT add' block for the workflow area.
- The `docker compose config --services` check needs an env file that exists, so the step creates `/tmp/empty.env` first rather than relying on `/dev/null` surviving Git Bash's path translation on win32. Both that command and Task 1's `git grep` are labelled Bash-tool commands.
- The MANUAL VERIFICATION block for creating ~/core-api.env moved from the draft's last task into the Compose task, because that is the commit whose push it gates. The docs that describe the file land one task later; the block therefore carries the full commands rather than pointing at them.
- config.test.js is not touched by this area at all - the draft's Task 6 was deleted per the fix list. cutover owns that edit via apps/core-api/testing/compose.js and the 25 -> 27 count.

**Part 2 — `infra/nginx/` and the client-IP chain**

- FILES OWNED: infra/nginx/api.conf and infra/nginx/core-api-proxy.conf (created and tested here only) and apps/core-api/test/nginx-config.test.js (new file, created by task 1 with its module header, appended by tasks 2-5, ends at 9 tests). SHARED: infra/README.md gets exactly one appended section under the reserved heading `## Core API: Nginx for api.yeyintlwin.com` and no existing line changes. This area does NOT touch .github/workflows/deploy.yml, docker-compose.yml, apps/core-api/test/deploy-config.test.js, apps/core-api/test/config.test.js or apps/core-api/testing/compose.js.
- HANDOFF TO `workflow` - the verbatim required-assertion list is written out inside the MANUAL VERIFICATION task under "Preconditions this area does not own": the two scp lines to /tmp, BOTH `cp -a … .bak` snapshots, the two `install -m0644` lines, the two-branch rollback that restores or removes BOTH files, the rollback's own `nginx -t`, and `systemctl reload nginx`. The `cp -a /etc/nginx/snippets/core-api-proxy.conf /tmp/core-api-proxy.conf.bak` snapshot and its restore/rm branch are an ADDITION to spec 9.5, which snapshots only the vhost; without it a bad snippet survives the rollback, the rollback's own nginx -t fails, and the box is left unloadable. These assertions belong in apps/core-api/test/deploy-config.test.js, appended by `workflow` as top-level test() blocks.
- SECOND HANDOFF TO `workflow`, smaller: spec 9.5's two post-reload proofs (`sudo nginx -T | grep -q 'limit_req_zone .*zone=core_login'` and `… grep -q 'proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for'`) should gain `| grep -vE '^[[:space:]]*#'` ahead of the grep, for the same reason every on-box check in this area does: nginx -T prints comments verbatim. The two files as written here are safe today - neither spells those full directive forms in a comment, and both carry a comment saying never to - but the filter costs nothing and removes the dependency on that discipline.
- infra/README.md heading collisions to watch at assembly: this area's section carries `### TRUSTED_PROXY_HOPS=1, and the four ways it breaks silently` and `### One-time prerequisite order`, both `###` inside its own reserved `##`. `cutover` owns the top-level `## The client-IP chain` and `## Cutover checklist`; those should record the OBSERVED topology and the full 9-step cutover list and link here rather than restating the four breakers or the certbot ordering. This area deliberately does NOT carry the "every push recreates epaper-hub and customer-order / deploy outside service hours" paragraph - that is `cutover`'s `## Deploy window`.
- TEST COUNTS, in order: 1, 3, 6, 8, 9. The Step 2 expectations are stated per task and two of them are not ENOENT - the TLS task fails three tests with one regex message and two copies of "api.conf has no `listen 443 ssl;` line", and the structural-guard task PASSES on first run (8 tests) by design, with non-vacuity proved by two throwaway mutations reverted with `git checkout --`.
- Fix applied: the `server_name api.yeyintlwin.com;` count-of-2 assertion moved verbatim out of the port-80 task (where only one server block exists) into the TLS task's first test. The port-80 task keeps a presence-only `/^[ \t]*server_name api\.yeyintlwin\.com;$/m`, and both tasks' Step 2 counts are restated: 2 failing tests for the port-80 task, 3 for the TLS task.
- Fix applied: a `tlsServer(text)` helper slices the TLS block by brace-matching back from `listen 443 ssl http2;` to its `server {`, and all four TLS locations are selected from that slice - not just the catch-all. The port-80 test now pins `locationBody(conf, "/")` to `return 301 https://$host$request_uri;`, so if the blocks are ever reordered the port-80 test goes red instead of the catch-all's rate-limit assertion silently grading the redirect.
- Fix applied: the structural guard is now `assert.equal(includeCount, 4)` plus `assert.doesNotMatch(conf, /proxy_pass/)`. The proxy_pass-vs-include arithmetic and its `5 !== 4` expected output are gone - that failure was unreachable, because `^[ \t]*proxy_pass` does not match the single-line `location /x/ { proxy_pass … }` form spec 9.6 itself uses. The mutation step now expects the message that actually fires: `AssertionError [ERR_ASSERTION]: api.conf must never proxy_pass directly`.
- Verified against the existing suite: apps/epaper-hub/test/deploy-config.test.js reads infra/README.md in four tests and forbids `/table_number/`, `/\?table=/`, `/table number in the URL/i` and a set of stale-lifecycle phrases in it. The appended section contains none of them, which is why the README task's Step 4 re-runs that suite.

**Part 3 — Backup, restore and the drill**

- FILE OWNERSHIP: this area now writes NO change to .github/workflows/deploy.yml. Everything it needs is in the 'Handoff to the workflow area' block at the top, including the complete `test()` body workflow appends to apps/core-api/test/deploy-config.test.js. workflow must implement handoff items (a)-(d) or the nightly and the drill never reach the box.
- HANDOFF ITEM (b) IS A LIVE DEFECT, not hardening. Once the `:48` mkdir creates config/, deploy.yml:72's `[ ! -d ~/restaurant-order-system/config ]` is permanently false (Upload app runs before Deploy on Lightsail), so the legacy `mv` becomes dead code sitting directly above `rm -rf ~/epaper-emulator` - and even if reached, mv into an existing directory would produce config/config. It must change to the content-aware `cp -a` in the SAME commit as (a). Verified against deploy.yml:45-75 at HEAD.
- COMPLETION GATE RETARGETED per the fix list: the drill's first hand-run is against a NIGHTLY taken by hand after the first successful deploy, NOT against deploy #1's pre-deploy dump. `docker volume create restaurant-order-system_core-db-data` runs a few lines above the volume gate and the dump precedes `docker compose up -d --no-build`, so deploy #1's pre-deploy dump is a dump of a freshly initialised EMPTY core and migrate.js --check correctly rejects it with 'pending migration(s) never applied: 0001_init.sql'. The optional dump-path argument is reserved for deploy #2 onward. Spec 12's DoD line ('scripts/restore-drill.sh run once by hand against the first pre-deploy dump') is therefore superseded on two counts - the path AND the target - and `cutover` must reconcile both when it writes the definition of done.
- DRILL STEP ORDER CHANGED from the draft: the non-vacuity check (table count >= 11, to_regclass on schema_migrations, ledger count >= 1) now runs at step 5, BEFORE the migrate.js --check at step 6. Otherwise a wrong or empty dump fails with the runner's version-skew message instead of 'only 0 base tables restored; expected at least 11'. The mirrored invariants moved from step 5 to step 7 and their comment now says 'S6 is what step 6 above already did'.
- NIGHTLY VERIFICATION IS NOW TWO-STAGE. `pg_restore --list` reads only the TOC, which pg_dump -Fc writes first, so it passes an 80%-truncated dump. Added `pg_restore --data-only -f /dev/null` (a full decompression pass) as the check that reaches end of file, and the Task 1 manual step now truncates a known-good dump with `head -c` and shows --list exit 0 while the data read exits 1. The old `docker compose stop core-db` step was removed: it produced a zero-byte file already caught by `test -s`, proving nothing.
- The `-T` assertion is scoped to executable lines (skip lines whose trimmed form starts with `#` or `echo`) so the drill's on-failure operator hint - a deliberately TTY-attached `docker compose exec core-db … psql` for a human to paste - survives. The Scenario A drop-sequence count of 3 is anchored to the slice between `### Scenario A` and `### Scenario B`; a whole-document count sees 5 because Scenario B's CREATE ROLE and the rotation recipe's ALTER ROLE use the same psql invocation.
- BACKUP-HEALTH GATE REWRITTEN around a bootstrap marker. `[ -f LAST_OK ]` made the one failure the gate exists to catch - the nightly never having succeeded even once - silent forever. The deploy now writes ~/backups/CRON_INSTALLED_AT exactly ONCE (`[ -f … ] || touch …`; touching it every deploy would keep it permanently fresh on a repo that deploys daily and the gate would never fire), and the build fails only when that marker is older than 48h AND LAST_OK is missing or stale. The README sentence was corrected accordingly and a test forbids the old flat claim.
- The volume-name drift assertion (read `core-db-data` out of docker-compose.yml's volumes: block, require `restaurant-order-system_<name>` in deploy.yml) is in the handoff for `workflow`, since it asserts deploy.yml text. It depends on `compose` having created docker-compose.yml at the repo root and on workflow's pre-deploy-dump task providing the `docker volume create` / `docker volume inspect` literals.
- FREE-SPACE GATE added before anything is restored: refuses unless free bytes on `/` >= 3x the dump size and disk use is under 70%, with the exact message `restore-drill: refusing, need <n> bytes free, have <m>`. It measures `/` rather than /var/lib/docker because that directory is mode 0710 root:root on Ubuntu and a non-root `df` on it fails; $HOME and the docker volume are both on `/` on a stock Lightsail instance. `df -Pk` is explicit about 1K blocks - plain `df -P` reports 512-byte blocks under POSIXLY_CORRECT, which would double the apparent headroom.
- Two spec-12 requirements the draft missed and this version adds, both inside this area's reserved headings: the 'Never rehearse Scenario A verbatim - substitute core_scenario_a in steps 3-5, receipt at ~/backups/SCENARIO_A_REHEARSED' warning, and the matching checklist box. Spec 12's final line also greps infra/README.md for 'ALTER ROLE', which the rotation recipe satisfies; there is no section 9.13 (the draft cited one).
- TEST COUNTS VERIFIED AT HEAD: apps/epaper-hub/test/deploy-config.test.js is 13 tests, not 12 (ran it). This area's own file goes 3, 5, 8, 11, 12. The final step uses `node --test apps/core-api/test/backup-restore.test.js apps/epaper-hub/test/deploy-config.test.js` (25 tests) and explicitly forbids `npm test`, because apps/core-api's pretest no-ops without CORE_API_TEST_DATABASE_URL and the database suites then fail rather than skip.
- Every SQL construct in the mirrored invariants was checked against the real migrations/0001_init.sql: anchors users_id_company_key / shops_id_company_key / shop_tables_id_shop_company_key / terminals_id_shop_company_key exist (:120, :168, :206, :311); users.password_hash is text with a `LIKE 'scrypt$%'` CHECK (:96-98) which pg_get_constraintdef renders containing 'scrypt$%'; the four bytea %_hash columns carry `octet_length(x) = 32`; triggers are `EXECUTE FUNCTION set_updated_at()` (:41, :65-67 …) - the S5 match deliberately drops the EXECUTE FUNCTION prefix because pg_get_triggerdef schema-qualifies when public is not in search_path; and the grant block at :508-517 grants DML on ALL TABLES, so schema_migrations is covered by the has_table_privilege assertion. Extractor shapes confirmed: TENANT_COLUMN_EXCEPTIONS 5, ANCHORS 4, TEXT_HASH_EXCEPTIONS 1, PLAINTEXT_COLUMN_NAMES 5. Table count is 11.
- The drill's psql/pg_dump/pg_restore wrappers dropped the `exec` before the binary that the draft had (`PGPASSWORD=… exec psql`). A variable assignment prefixing a special built-in has shell-dependent export semantics; prefixing a simple command is guaranteed by POSIX to export for that command, and it matches the spec's own form.
- migrate.js CLI strings confirmed verbatim for the expected-output blocks: `migration 0001_init.sql sha256:<12 hex> already applied` (digest is `checksum.toString('hex').slice(0, 12)`, migrate.js:232), `migrations: 0 applied, 1 already applied (check mode, nothing was applied)` (:319-320), and `pending migration(s) never applied: …; the database schema is older than this code` (:273-276). The CLI calls `startupConfiguration(process.env)` at runtime, so the drill's exported DATABASE_MIGRATION_URL takes effect, and loadDotEnv() never overrides an existing value.
- infra/README.md heading discipline respected: this area appends only under `## core-db backups` (with `### The restore drill`, `### Scenario A`, `### Scenario B`, `### Rotating database passwords`) and `## Before core-api's first production deploy`. The 'what this protects' material is a bold lead-in plus a table rather than a new `###`, to avoid colliding with anyone's reserved heading. The drill's 'outside service hours' sentence lives in `### The restore drill` and points at the deploy window rather than editing `cutover`'s `## Deploy window` section - `cutover` should link the two when it reconciles.
- Appending to infra/README.md is safe against the epaper-hub suite: deploy-config.test.js:114-135 forbids `?table=` and `table_number` in that file and :131 requires the opaque visit URL to remain. None of the appended text introduces the forbidden strings, and nothing is removed. C13 in source-structure.test.js is satisfied - backup-restore.test.js is a *.test.js file in test/ with no fs write calls - and spawnSync is already used by migrate.test.js:9 and scripts.test.js:4.

**Part 4 — `.github/workflows/deploy.yml`**

- FILE OWNERSHIP HELD. This area now owns `.github/workflows/deploy.yml` alone except for compose's two carve-outs, and it writes NO assertions into apps/epaper-hub/test/deploy-config.test.js. All nine new deploy.yml assertions are appended as top-level test() blocks at the end of apps/core-api/test/deploy-config.test.js, which compose creates (header + readText/composeText/servicesOf/workflowText + six tests). No helper is redeclared: the workflow is read via compose's `workflowText()`, and every other read is an inline `fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n')` with paths derived from `path.join(__dirname, ...)` inside the test body, so nothing depends on how compose named its module-level constants. Final registration count: 6 + 9 = 15.
- TWO DRAFT TASKS WERE DELETED, NOT MOVED DOWN. The core-api image build/save task is gone entirely - compose now owns `docker build -f apps/core-api/Dockerfile`, `docker save … > /tmp/core-api-image-${{ github.sha }}.tgz`, the scp of that tarball, `docker load -i`, `CORE_API_IMAGE=`, `CORE_ENV_FILE=../core-api.env` and the `test -f ~/core-api.env` precondition, all in the same commit that adds the service to docker-compose.yml. The remaining Upload task covers only the mkdir, the two nginx confs to /tmp and the two infra scripts into config/. Three tasks show compose-owned lines in context and say so explicitly at the point of the edit (Upload app's two scp lines; the pre-deploy task's `docker load -i /tmp/core-api-image-…` line and the export block's two core variables, which the task asserts survive verbatim).
- THE XFF PROBE IS RETITLED AND REDUCED, and the reason is not stylistic. Spec 9.5 block 4 asserts an audit_events row exists and that its source_ip is neither the forged address nor NULL. Plan 1 ships the audit_events TABLE but no POST /api/admin/auth/login, no lib/client-ip.js and no audit writer, so that SELECT returns zero rows on every deploy and the only way to green it today is `|| true` - the exact vacuous probe the spec warns against. The block is now `LOGIN-PATH ROUTING PROBE (the XFF assertion arrives in Plan 2)`, asserts HTTP 404 with a body containing "code":"not_found" (only core-api's own 404 tail produces that; nginx's 404 is text/html and a dead upstream is a 502 page), and reads TRUSTED_PROXY_HOPS from /proc/1/environ rather than `printenv`, which would echo back the compose file this same deploy uploaded. The comment states plainly that nothing in the block can fail because the hop count produces the wrong ADDRESS - only because the variable is not 1. The `never "the most recent row"` comment-presence assertion is deleted (it cannot fail for a real defect); the `PLAN 2: restore the full forgeability assertion here` marker assertion is kept because it has a defined removal trigger.
- THE 404 EXPECTATION BREAKS IN CI, NOT AT 22:00. The block-4 task's test walks apps/core-api/http/routes/ and fails if any file contains "/api/admin/auth/login", with a message naming the three things Plan 2 must do in the same commit that registers the route (404 -> 401, restore the forgeability assertion, delete the marker). Without it, Plan 2 registering the route turns the deploy red after the migration has already applied.
- THE TWO NGINX PROOFS WERE ABORTING EVERY DEPLOY AS DRAFTED, after the reload. Two independent defects: spec 9.6's api.conf is column-aligned (three spaces) while spec 9.5's grep pattern has one, so the pattern never matched; and `sudo nginx -T | grep -q` closes the pipe on first match, so once the config dump passes 64 KB nginx -T takes SIGPIPE and pipefail propagates. Now captured once into `nginx_dump`, matched with `grep -Eq … +`, each with a `|| { echo …; exit 1; }` diagnostic. Step 4 also greps the repository copies of api.conf and core-api-proxy.conf with the same patterns, so a pattern that cannot match is caught before it ever reaches the box.
- THREE THINGS MOVED FOR A REASON, all asserted in their new positions. (1) The 85% `df` gate is at the TOP of the heredoc, not in block 6 - in block 6 it fires after the migration applied and the containers restarted. (2) The image tarballs are deleted immediately after `docker load`, not in the block-7 cleanup, and the glob `/tmp/core-api-image-*.tgz` sweeps earlier runs' leftovers; block 7's cleanup is now exactly `rm -f /tmp/api.conf /tmp/core-api-proxy.conf`. (3) Pre-deploy dumps are pruned to 14 immediately after `ln -sfn` - the prune runs right after the dump it wrote, so the glob always matches and `ls` cannot fail the pipeline under `pipefail`, which is stated as a one-line comment.
- THE ARTIFACT STEP NO LONGER INFERS ANYTHING FROM THE VOLUME. `docker volume create` runs unconditionally above block 1's gate, so the volume exists after the first ATTEMPT regardless of whether LAST_PRE_DEPLOY was written; the `ssh … 'docker volume inspect …'` guard and its assertion are gone. The marker is read non-fatally (empty -> explain and exit 0), and a sha mismatch hard-fails only when `job.status == 'success'`, since on a failed run an older sha is the expected reading and a second red X would bury the real failure. The manual block now states the reachable expectation: the FIRST deploy does produce an artifact, containing a dump of a freshly initialised empty `core`, and its small size is correct rather than a fault.
- ONE ADDITION BEYOND THE HANDOVER LIST, in the nginx task: `sudo rm -f /tmp/api.conf.bak /tmp/core-api-proxy.conf.bak` before the two snapshots. Without it a .bak left by an earlier run survives, `[ -f /tmp/api.conf.bak ]` stops meaning "this run snapshotted a file that existed", and the rollback branch can restore a config from an unrelated deploy. It uses sudo because `sudo cp -a` writes those files as root, which is also why block 7's cleanup does not try to rm them as the deploy user. Asserted with an ordering check.
- CROSS-AREA PREREQUISITES, none of which a text assertion can create. compose: the root docker-compose.yml (git mv) and the whole core-api image pipeline in deploy.yml, plus apps/core-api/test/deploy-config.test.js with its helpers - this area's tasks cannot even load their tests until that file exists. nginx: infra/nginx/api.conf and infra/nginx/core-api-proxy.conf. backup: infra/backup-core-db.sh and infra/restore-drill.sh, both +x in the repo. Host, from 9.11: the DNS A record, `certbot certonly --nginx -d api.yeyintlwin.com` (nginx -t fails without the certificate), ~/core-api.env mode 600, and passwordless sudo for install / nginx -t / systemctl reload nginx - a password prompt hangs the ssh heredoc forever. The Upload task's `fs.existsSync` loop is what turns a missing infra file from a red deploy into a red `node --test`.
- SCOPE BOUNDARIES HELD. scripts/create-platform-admin.js (spec 9.10) is not written here and is not referenced by any crontab line; the cron task says plainly that it arrives in Plan 2, because it needs the users table, lib/password.js and an audit writer. The migration runner contract (9.4) is already implemented in Plan 1's db/migrate.js - this area only wires it into the deploy and asserts the wiring. Local development (9.9) is already in apps/core-api/README.md and is untouched. sweep-expired.js does not exist: the crontab line AND its `crontab -l | grep -q` proof ship together as logged debt (the line without the grep is the one combination that must never ship), and the nightly `Cannot find module` in ~/backups/sweep.log is checked in that task's manual verification.
- TEST-COUNT CONVENTION AND VERIFICATION. Every Step 2 and Step 4 uses `node --test --test-name-pattern="<fragment>" apps/core-api/test/deploy-config.test.js`, verified locally against this repository (node reports `# tests 1`, `# fail 0`, and filters non-matching tests out entirely rather than skipping them). Whole-file runs appear only as regression checks with `# fail 0` as the pass condition; the single absolute number left anywhere is the registration count of 15, which is a count of `^test(` in the source rather than of results, so a test nested inside another test() is loud instead of silent. The YAML parse command was run against the current file and prints `12 steps` today; the task steps state 14 after the CI service lands and 16 after the two artifact steps. `on:` parses as the boolean `True` under YAML 1.1, which is why no assertion touches it.
- ci-contract.test.js AND EVERY APPENDED TEST NORMALISE CRLF on read, and `.gitattributes` gains `*.yml text eol=lf` in the first task with the C12 assertion to match. This repository is `core.autocrlf=false` and the workflow is LF today, so the attribute produces no diff now - it is insurance for the next clone, and it is the same reason `*.sh text eol=lf` exists, since the heredoc body ships into a remote sh. `.dockerignore` and `.gitignore` are untouched by this area, as bound.

**Part 5 — Environment contract, cutover and the definition of done**

- Ownership honoured: this area writes only apps/core-api/testing/compose.js (new), apps/core-api/test/config.test.js, apps/core-api/test/operations-docs.test.js (new, mine alone), the three reserved infra/README.md headings (## The client-IP chain, ## Deploy window, ## Cutover checklist, plus one ### subsection under the last), and the plan file. It edits no Dockerfile, no docker-compose.yml, no deploy.yml, no nginx conf, no backup script, no README.md, no apps/core-api/README.md, no .dockerignore and no .gitignore.
- DROPPED per the ownership table: the drafted '## core-api: the second secrets file' section. That content is the compose area's '## Core API runtime: two secrets files and core-net'; the client-IP task now links to it by heading and asserts `doesNotMatch(readme, /^## core-api: the second secrets file$/m)` so a duplicate cannot reappear. The drafted apps/core-api/test/config.test.js edit is unchanged (compose Task 6 was the duplicate and is deleted there, not here).
- Verified against the tree, not assumed: apps/core-api/test/config.test.js has exactly 25 `test(` blocks today, the Compose-contract literal is lines 368-408 with line 4 the require, so 25 -> 27 and the 369-409 range after inserting the require are both correct. config.js exports { startupConfiguration, ConfigurationError, DEFAULTS } and its config object carries databaseMigrationUrl / databaseUrl / databaseAppPassword. apps/epaper-hub/test/deploy-config.test.js has exactly 14 tests. source-structure.test.js puts `testing` in IGNORED_DIRECTORIES, so testing/compose.js is exempt from C1/C2/C4, and C13 (test/ holds only *.test.js) is satisfied.
- The SCRYPT_SLOTS BREAK was traced through the rewritten tests: `config.js defaults every knob...` fails on deepEqual(DEFAULTS, COMPOSE_DEFAULTS) and `the defaults table is what config.js actually applies` fails because startupConfiguration({...DEV_ENV, SCRYPT_SLOTS:'3'}) differs. The closed-list test compares key NAMES only and stays green. Exactly two failures - the definition of done says so and says what one failure would mean.
- The secrets rule bans the write, not the word, and the regex was checked against the real deploy.yml the workflow area will produce: `test -f ~/core-api.env`, `export CORE_ENV_FILE=../core-api.env` and the crontab printf (whose `>>` targets ~/backups/sweep.log) all pass; `cat > ~/core-api.env` fails. `core_api_(?:owner|app):[^@\s]+@` does not hit `-U core_api_owner` in pg_dump/psql/pg_isready because there is no colon.
- Cross-area assertions this area makes that will go red if another area under-delivers, listed so the failure is attributable: `Core API runtime: two secrets files and core-net` (compose's heading), `CORE_ENV_FILE=../core-api.env` and `infra/restore-drill.sh` -> `config/restore-drill.sh` in deploy.yml (workflow), `infra/restore-drill.sh` existing and `ALTER ROLE` in infra/README.md (backup), `${CORE_ENV_FILE:-.env}` in docker-compose.yml (compose).
- Spec 9.7's `scripts/restore-drill.sh` is deliberately superseded by `infra/restore-drill.sh` -> `~/restaurant-order-system/config/restore-drill.sh`; the reason (a host script driving `docker compose`, which does not exist inside the image) is stated in the plan text, in the README subsection and in the definition of done, and both ends are asserted so the runbook and the shipping file cannot drift apart. The draft's 'substitute the path' hedge is gone.


## What Plan 5 deliberately leaves to later plans

- **`scripts/create-platform-admin.js`** (spec §9.10) needs the `users` table, `lib/password.js` and
  an audit writer — all Plan 2. The runbook references it; the script arrives with Plan 2.
- **The `TRUSTED_PROXY_HOPS` forgeability assertion** (spec §9.5 block 4) needs an `audit_events`
  row, which needs a login route. Plan 5 ships the reduced probe in the correct slot with the
  request byte-identical to the one Plan 2 will assert on, so Plan 2 adds an assertion rather than
  a step.
- **Continuous archiving / PITR** — spec §11 defers it to Phase 3, when orders and money enter the
  database.
- **Zero-downtime deploys** — Phase 4, when the kitchen display holds long-lived connections.
