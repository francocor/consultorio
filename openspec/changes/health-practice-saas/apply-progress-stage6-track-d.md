# Apply progress: Stage 6, Track D (production readiness, demo data and the Stage 6 gate)

Branch `feat/stage-6-track-6d`, cut from the Stage 6 integration tip `a3c6d705` (tracks A, B and C integrated). Mode: automatic, strict TDD, work-unit commits. Slices S6.11 (tasks 6.44 to 6.46), S6.12 (tasks 6.47, 6.48; task 6.49 stays open for `judgment-day`) and the open part of task 6.32, plus four known issues of the integration. No migration: `0690` to `0699` are unused (`db:check` and `db:restamp` report no drift). The paths of the files are in `docs/stage6-tracks.md`, "Track D as delivered".

## Commits (in order)

| Unit | Commit | What |
| --- | --- | --- |
| Lint | `70cc5e00` | `pnpm lint` runs in shards of at most 300 files (`packages/config/eslint/{shards,lint,ignores}.js`); the default heap is enough (peak 2.5 GB) |
| Flake | `cb244ccb` | the DecryptionError of `archive-release.test.ts` was the helper that built the packages: it swept every queued export of the shared database |
| Globs | `cdcaf57e` | the demo coverage reads its exemptions from the folder (`discoverModules`); a guard fails with the instruction when a glob registry is stale |
| Policy | `ed460f10` | `stage6-routes.ts` and `stage6-audit.ts`, `patient.bulk_read` written by the export, three placeholder actions retired |
| Demo | `5ec20f07`, `0358250e` | `seedStage6` (the exempt state), `pnpm demo:platform` (four billed organizations), reception everywhere, a professional with usage and a statement in the active one |
| Banner | `a718a81c` | the read-only banner by role (found by the e2e); the e2e stack creates the four organizations |
| E2E | `52684eae` | `stage6-demo.spec.ts` (3 journeys at 360 px) and two tests of task 6.32 in `stage6-signup.spec.ts` |
| 6.44 | `6aa4d5e5` | the restore drill |
| 6.45 | `52e258c1`, `065c858b` | the metrics port, the collector, the catalog, the alert rules, the compose profile, the CI job of promtool |
| 6.46 | `065c858b` | four runbooks, the go-live checklist and its docs test |
| Streaming | `4c36ae7d` | the contributors of the tables that grow read them a page at a time |
| Docs | `176e1b1d` | `docs/demo.md` (Stage 6), `docs/security/asvs-l2-final.md` (draft), the tasks and the traceability |
| CI | `64ced52a` | lint is a job of its own |
| Verification | `9536c91e`, `951cb08f`, `66e10c6d` | the unsealed-events check compares at a quiet moment; the teleconsult spec finds free time on a fine grid; the e2e stack retries a dropped MinIO exec |

## The known issues

1. **Lint out of memory.** Cause: type-aware linting keeps the TypeScript program of a package and what it resolves grows with every file, so one `eslint .` over 2,400 files passes the 4 GB of default heap (measured: web 2.7 GB, api sources 3.4 GB, api tests 2.4 GB, each alone). The config is not too broad (no stray folder is linted; the ignores are one list now, shared by the config and the runner). Fix: the root script plans shards from the files on disk (folders packed in name order, at most 300 files, a folder that is too big is split by its subfolders and then by files) and runs them one after the other in separate processes, so a new folder is covered without editing a list. The heaviest shard peaks at 2.5 GB. Tests: `shards.test.js` (plan, coverage exactly once, scan of a real folder, the runner continues after a failing shard and fails at the end, a crash is a failure). The heap is not raised anywhere. `ci.yml`: lint is its own job (about five minutes), beside the rest.
2. **`archive-release.test.ts` DecryptionError.** Cause (from the trace: `anamnesis-export.ts` read a blob that was not a valid ciphertext): `RetentionWorld.buildPackages()` called `enqueuePendingExports` over the shared database and ran every export it found, including the queued export of another test file's organization, whose records were sealed with the keys of another world. Which file did it depended on the order Vitest picked, hence "once in a full run". Fix, test first (`retention-world.test.ts` fails with the foreign organization present): the helper keeps only the request of its own organization; the release test also looks for its own request in the sweep. 61 tests of the four retention files pass together.
3. **Streaming exports.** Done, bounded. `pagedRows`, `pagedBatches` and `pagedByStamp` (`modules/tenancy/application/export-pages.ts`): a keyset over the order of the export, the timestamp kept as text so a microsecond is never lost, a page of 500 rows (`ExportContext.pageSize` lowers it in a test). 26 sections of 15 contributors are async iterables: audit, notifications (3), scheduling (appointments and history), patients, billing (charges, lines, payments, refunds), invoicing (invoices, lines, documents), documents (both parts), consent (requests, signed consents), clinical entries, anamnesis, prescriptions, teleconsultation, waitlist (2), portal (4). Proof on the whole demo organization (`export-streaming.test.ts`, 32 tests): each streamed section is an async iterable; a package made with pages of seven rows is byte for byte the one made with a single page, administrative and clinical; every streamed section has as many rows as its table. **What stays an array, because the size of the organization bounds it, not time:** tenancy, identity, access, staff, onboarding, online-booking links, reports and subscriptions, and inside scheduling, billing and invoicing the appointment types, blocks, days off, special hours, payers, price lists, cash sessions, fiscal profile and points of sale. The eight tests that call contributors directly consume a section with `settled()` (`test/support/export-sections.ts`).
4. **Vitest glob cache.** `demo-coverage.test.ts` reads the folder with `discoverModules` (an `import()` of each file, nothing remembered). The fixtures and the `no-delete` lists, which have to stay synchronous, are compared with their folder by `discover-modules.test.ts`, which names `node_modules/.vitest-cache`; `docs/dev-setup.md` documents the step (troubleshooting).

## Tasks

- **6.44 done.** `pnpm drill:restore` (`scripts/drill/`): counts every table before and after the dump, backs up, keeps the backup in the MinIO store and reads it back, restores into a scratch database and bucket, compares the counts (between the two source counts), walks the chain of every organization and of the platform, prints a report, removes the scratch copy, exit 0 only if it passed (and something was verified). `restore-drill.test.ts` (4): passes on the demo data (701 events verified, 124 tables), cleans up, `--keep`, and fails naming the event when a sealed event was altered before the dump with every count still equal.
- **6.45 done.** Not a route of the API: a port of each process (`METRICS_PORT`, off by default; a token as soon as the host is not the machine itself), so the host, session, rate-limit and read-only policies stay as they are. The worker measures, organization by organization and as the system, the queues, the messages of the day by status, the invoices pending past the outage threshold, the documents waiting for the scan, the unsealed audit events, the subscriptions by state and reminder, the organizations by status. 13 alert rules, a compose profile `observability`, a CI job with promtool (validated locally with `prom/prometheus:v3.5.0`: 13 rules found). Catalog test, rules test, server test, listener test, config test, collector test against a superuser oracle.
- **6.46 done.** `docs/runbooks/{incident,afip-outage,provider-switch,tenant-cancellation}.md` and `docs/go-live-checklist.md`; the docs test reads the deferred tasks from `tasks.md` and fails when one is missing, when it does not repeat what the task needs, or when a finished task is still listed.
- **6.47 done.** The demonstration organization shows the exempt state and has no subscription (the database refuses one for it). The rows of the subscription, signup and retention tables therefore stay empty for it: the three exemption files of the tracks became one (`demo-coverage-exemptions/stage6.ts`) with the reason of each entry. `pnpm demo:platform` makes four billed organizations through `createTrialStarter`, `startCheckout`, `reconcileSubscription`, `runDunningStep`, `runUsageSnapshot` and `generateStatements` against the local Mercado Pago, with a clock of the seed; the active one is laid out on the billing calendar so its statement exists whatever the day of the month. The guard refuses production (`guard.test.ts`, `demo-platform.test.ts`).
- **6.48 done**, with one deviation (below).
- **6.32 done** (the open part): `stage6-signup.spec.ts` has the professional denied on the billing and the reception refused a write in a read-only organization (the banner names the owner of the account; the form shows the reason; no word about the subscription).
- **6.49 open**: `docs/security/asvs-l2-final.md` is written from the code and the tests and the traceability is updated; the review itself, and `sdd-init`, are for the orchestrator.

## Defects found on the way (all fixed test first)

1. **The read-only banner told every role to "regularice la suscripción desde Facturación"**, an entry that no longer exists, and a reception could not act on it. Now the owner (`billing.manage`) reads it with a link to "Suscripción"; everybody else reads to consult the owner of the account, with no word about the subscription (`shell.test.tsx`, `states.test.tsx`, the e2e).
2. **`patient.bulk_read`** had a Stage 6 placeholder and the spec says every read of identity data by export is audited: the administrative package now writes it (a count and the package, never a name). `auth.portal.sign_in`, `export.created` and `archive.read` were retired (superseded by `portal.signin.*`, `export.cancellation.*` and the platform `archive.*`, nothing ever wrote them); the contract test of the mandatory families counts the platform archive actions.
3. **`stage6-audit.ts` found a stale claim of its own** (`export.cancellation.downloaded` was listed as written outside the routes while `GET /files/:token` declares it): the table was corrected, which is the point of the check.

## TDD cycle evidence

| Unit | Tests | RED | GREEN |
| --- | --- | --- | --- |
| Shards | `packages/config/eslint/shards.test.js` (12) | module missing | passed; the full run linted 10 shards at the default heap |
| Flake | `retention-world.test.ts` (2) | failed: the foreign export was built (admin ready, clinical failed with the key of another world) | passed; 4 retention files, 61 tests |
| Globs | `discover-modules.test.ts` (5) | helper missing | passed; `demo-coverage` passes through it |
| Routes and audit | `route-categories.test.ts`, `audit-coverage.test.ts` (Stage 6 sections, 12) | 3 failures that were real findings (stale claim, HEAD of an export link) | passed |
| bulk_read | `cancellation-export.test.ts` (2) | failed: no event | passed |
| Demo | `demo-platform.test.ts` (8), `guard.test.ts` (4) | module missing | passed first run, with the states, dunning steps, statement and reception refusal asserted |
| Banner | `shell.test.tsx` (2), `states.test.tsx` (1) | failed | passed |
| E2E | `stage6-demo.spec.ts` (3), `stage6-signup.spec.ts` (2 new) | the first run failed on an unsafe port and then on one assertion (quota prorated by the days left) | passed, axe clean at 360 px |
| Drill | `report.test.ts` (8), `restore-drill.test.ts` (4) | modules missing | passed; the tamper test fails the drill on purpose |
| Metrics | `metrics.test.ts` (3 new), `metrics-catalog.test.ts` (6), `metrics-server.test.ts` (5), `metrics-listener.test.ts` (3), `config-metrics.test.ts` (6), `platform-metrics.test.ts` (8), `compose.test.ts` (2), `alert-rules.test.ts` (5) | modules missing | passed |
| Checklist | `go-live-checklist.test.ts` (6) | checklist missing | passed |
| Streaming | `export-pages.test.ts` (9), `export-streaming.test.ts` (32) | 20 of 23 failed (every section was an array) | passed after the conversion of the contributors |

## Deviations and decisions

1. **The e2e web port is 5062, not 5060.** Chromium refuses 5060 as an unsafe port (`ERR_UNSAFE_PORT`); the API and MinIO ports were the ones asked (4060, 9060).
2. **Task 6.48 walks the dunning and the read-only state from organizations that the seed built with a clock**, not live: a browser cannot wait weeks. The walk itself (day 1, 3 and 5, the grace, read-only, payment, recovery) is `billing-timeline.test.ts`; the browser proves the screens of those states and the real payment that brings an organization back (`prueba-atrasada`, once per stack).
3. **`/metrics` is a port of its own and not a Fastify route** (the task says "`/metrics` from `platform/metrics.ts`"), so no policy file (`PUBLIC_ROUTE_PREFIXES`, host exemptions, rate limits) was touched and a scraper never needs a tenant host.
4. **The metrics are measured per organization by the worker** instead of with a cross-tenant `SECURITY DEFINER` function and `owner_lookup` policies on six more tables (no migration, row level security whole). The cost is one query per organization per minute; the ASVS page records it.
5. **The Stage 6 exemptions stay**, consolidated, because the demonstration organization is exempt by design; the tables are covered by the four billed organizations (`demo-platform.test.ts`), not by the demo coverage test.
6. **`ci.yml`**: lint moved to its own job, and an `alert-rules` job was added. The name of the `check` job is unchanged so required checks keep matching.
7. Two scenarios stay `pending` in `audit-scenarios.ts`, both Stage 1 decisions, not Stage 6: `auth.password.changed` (the change-password screen was not built) and `cross_tenant.denied` (a cookie replayed on another organization is answered 401, nobody to attribute).

## For the owner and the maintainer

- Everything in `docs/go-live-checklist.md`: the eleven deferred real-provider tasks (3.80 to 3.83, 4.68, 4.69, 5.53, 5.54, 6.50 to 6.52), the legal decisions Q1 (hosting) and Q7 (erasure), the retention policy of the hot rows, the rotation of the legacy secrets (0.1), the sign-off of `legacy-parity.md` (2.101), the terms of service, the owners of the alerts.
- The maintainer: `.env.example` `DB_POOL_MAX` to 36 (not touched here); the required checks of the repository if a rule names the CI job (a job `Lint` and a job `Alert rules (promtool)` were added); the new optional variables `METRICS_PORT`, `METRICS_HOST`, `METRICS_TOKEN` (documented in `docs/dev-setup.md`; not added to `.env.example`).
- Not done on purpose: the refund of a subscription payment has no operator route (the service exists and is proven), so `subscription.refunded` is written by the service only.

## Risks

- The per-organization metrics sweep costs one query per organization per minute; revisit the interval or move to a definer function when the number of organizations reaches the thousands.
- The platform demo e2e journey that pays the overdue amount consumes `prueba-atrasada`: a second run needs a fresh stack (Playwright starts one unless `reuseExistingServer` finds the old one).
- The ASVS page is the author's reading; the independent review is open (task 6.49).
- **The Lighthouse job fails** (median LCP 2,644 ms against 2,500 ms) for a reason that predates this track: see "Lighthouse" in the Verification section.
- `pnpm lint` takes about five minutes on a laptop (sequential shards). A parallel runner would be faster at the cost of memory; the shards are sized so that a pair would still fit in 8 GB.

## Verification

Run on the tip of the branch, on the laptop (Windows, Docker Desktop), with `DB_POOL_MAX=36` for the stack and the smoke.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | clean |
| `pnpm typecheck` | clean |
| `pnpm lint` (default script, 10 shards, default heap) | clean (about five minutes) |
| `pnpm format:check` | clean |
| `pnpm test` (unit) | 493 files, 6,167 tests passed, 2 skipped |
| `pnpm test:integration` (FULL, Postgres 17 in Testcontainers) | 318 files, 5,013 tests: 4,998 passed, 11 skipped, **4 failed in the full run** (3,240 s). All four were found out and settled: `demo-seed.test.ts` (2 tests, 120 s timeouts under the load of the whole run) and `worker.test.ts` (the 15 s sealing wait of "seals new audit events of every tenant by itself") pass alone (26 tests of the two files, 135 s); `platform-metrics.test.ts` ("counts the audit events that are not sealed yet") was a real defect of the test: the database is shared by the parallel files, which write and seal audit events between the measurement and the oracle query. Fixed: it now compares at a quiet moment (the oracle before and after a fresh measurement must agree), 8 of 8 pass. The full suite was not run a second time (about 55 minutes): no source file changed after that run, only that test, an e2e spec and the e2e stack script |
| `pnpm build` and `pnpm db:check` | clean, no migration drift |
| `pnpm test:e2e` (FULL, real stack, web 5062, API 4060, MinIO 9060, 2 workers) | **243 of 243 passed** (9.1 min), after two fixes found by the first full run (below) |
| Demo reset time | 11.0 s for the whole demonstration (`demo-coverage.test.ts`; with Stage 4 data 38.8 s and with Stage 5 data 20.9 s measured inside the loaded full run), against the 60 s budget |
| Lighthouse (`lhci`, mobile, 4G, 4x CPU, 3 runs) | **over the LCP budget: median 2,644 ms against 2,500 ms** (runs 2,644 / 2,629 / 2,849); performance 0.70 / 0.93 / 0.91 (median above 0.85), accessibility 1.00, layout shift 0.001. See "Lighthouse" below |
| Docker smoke | image built (572 MB); a fresh `postgres:17.11` with `infra/postgres/init`; `db:migrate` twice (11 s, then 4 s; 122 migrations, both exit 0, the second one a no-op); `api` with the production-like environment and `DB_POOL_MAX=36` answers `/health` 200 against that database; `DB_POOL_MAX=20` is refused with the message of the floor (34); the metrics port answers 401 without a token and with a wrong one, 200 with the token, and `/metrics` on the public port is 404; the `worker` role starts with `AUDIT_SEALER_DATABASE_URL`, serves its series (the sweep of the first minute: audit, documents, invoices, messages) and logs no error. Containers and image removed |

### Found by the verification and fixed

1. `platform-metrics.test.ts`: see the integration row (test defect; the collector was right).
2. `stage3-teleconsult.spec.ts` (first full e2e: 1 failed, 1 did not run): the spec booked its virtual appointments at seven start offsets near the present moment and found every one of them taken when it ran in the middle of an afternoon (the demo agenda is laid out around the hour it is seeded at, and the spec of the join window had taken the free time). Not related to this track (the file, the seed of the agenda and the join window are untouched); it passes now with a grid of 28 offsets, every three minutes inside the window. Reproduced alone twice before the change.
3. `scripts/stack/start-stack.ts`: twice a stack failed to start with `TimeoutError: socket hang up` while the archive bucket was prepared: `exec` of the Docker daemon threw instead of returning a code, and the retry loops only read exit codes. A thrown exec now counts as a server that is not ready.

### Lighthouse (open, not caused by this track)

The web code of this track is 69 lines (`banners.tsx`, `StatusBanners.tsx`, two strings, `audit.json` lost three), all in the lazy signed-in shell, so nothing of it is on the sign-in page. The budget was last met at 2,439 ms (apply-progress of Stage 3, 28 files and 258 KB); the sign-in page loads now 48 files and 414 KB gzip (the catalogs alone are 83 KB: every `locales/es-AR/*.json` is eager, `shared/lib/locale-files.ts`), so the growth comes from the Stage 4 to Stage 6 tracks together. What was tried, each measured with the same three runs and all discarded: `json.stringify` for the catalogs (no change), loading only seven catalogs (354 KB: LCP 2,560 to 2,827, no change beyond the noise of about 200 ms between runs), merging the icons and the small shared modules into chunks (16 to 49 files: worse, or the page did not paint). The simulated LCP is `render delay` (2.1 s of 2.6 s) behind the script evaluation of the entry chunk (293 ms measured, multiplied by the 4x CPU) and the 6-connection waves of the preview server, not the bytes. The way forward is structural, not a tuning: load the catalogs of a namespace with the route that uses it (an i18next backend with `import.meta.glob` without `eager`, or the signed-in shell registering them), and take the features' `nav` and `slots` out of the entry chunk (71 KiB of the entry and `cn` chunks is unused on the sign-in page). It touches every `useTranslation`, so it is a slice of its own with the e2e suite as the safety net. The `Lighthouse` job of `ci.yml` will fail until then.
