# Apply progress: Stage 4, track B (reports)

Change: `health-practice-saas`. Branch `feat/stage-4-track-4b`, from the seam tip `caf5ee1`. Mode: automatic, strict TDD, work-unit commits, no PR, no merge, CI not polled. Slices S4.06 (operational read models) and S4.07 (dashboard UI) are done except task 4.33 (export buttons), which waits for track A's export job. S4.14 (financial and cash reports) and task 4.33 are done in wave 2 (see the last section).

## Status of the tasks

| Task | State   | Notes                                                                                                                                                                                  |
| ---- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.28 | done    | `domain/filters.ts` (inverted range, span over 366 days), `application/scope.ts` (the one place that decides who sees what), `domain/rates.ts`. Payer filter left for S4.14.            |
| 4.29 | done    | `application/operational.ts` plus read functions in `scheduling` and `waitlist` (declared exceptions). D9 rate, rescheduled from history, occupancy, new vs returning, recovered slots. |
| 4.30 | done    | `GET /reports/options`, `GET /reports/operational`, `GET /reports/operational/records`; `report.accessed` on the drill-down only.                                                      |
| 4.31 | done    | Migration `0430_report_indexes.sql` (3 indexes), `scripts/bench-reports.ts`, `docs/perf/reports.md` (see "Deviations": the doc content is in Engram).                                   |
| 4.32 | done    | `features/reports/*`, `locales/es-AR/reports.json`; Recharts lazy-loaded; every chart has a table; patterns as non-colour encoding.                                                    |
| 4.33 | done (wave 2) | Export panel on the money and cash screens, through track A's export job (wave 2).                                                                                      |
| 4.34 | done    | `e2e/stage4-reports.spec.ts` (7 tests at 360 px).                                                                                                                                      |
| 4.57 | done (wave 2) | Financial report and drill-down (wave 2). |
| 4.58 | done (wave 2) | Cash report (wave 2). |
| 4.59 | done (wave 2) | Money and cash screens (wave 2). |

## Commits (in order)

| Commit    | Tasks      | What                                                                                                                              |
| --------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `755c58c` | 4.28       | Contracts (filters and response shapes), filters, scope, rate math.                                                               |
| `2f1ce70` | 4.29, 4.30 | Read functions in scheduling and waitlist, the operational report, routes, wiring, audit scenario, integration test (36 tests).   |
| `9fb1dc2` | 4.31       | Migration 0430, one counting pass, arithmetic available time, benchmark script.                                                   |
| `fcbf225` | 4.32       | The dashboard (widgets, filter bar, charts, tables), locale file, `localTime` in the drill-down rows, component tests (16).       |
| `b4ad18b` | 4.34       | The e2e spec; the migration tool test stops assuming that track B has no migration.                                               |

## Decisions

1. **The scope is one pure function.** `resolveScope` returns organization (owner, admin), locations (reception; plus the professional's own appointments for a reception user who is also a professional) or professional; `checkFilters` refuses a filter that would widen it (a colleague, a location the viewer does not work at) with the uniform 403 and an `access.denied` entry. A narrowing filter inside the scope is allowed.
2. **Days are read at the location's zone, in SQL.** `starts_at >= (date::timestamp AT TIME ZONE l.time_zone)` plus a coarse UTC window so `appointment_report_idx` can be used. Tests: 23:30 of the last day of a month at Buenos Aires belongs to that month; a day in Auckland belongs to the Auckland day.
3. **Rates are basis points** (integers): 1200 is 12.00%. `null` when there is nothing to divide ("no data" is not 0%). Occupancy is booked minutes (not cancelled) over working minutes times each professional's capacity, clamped to 100%.
4. **Rescheduled** is the number of appointments of the period that have a `rescheduled` event, counted with their current status. The drill-down has a `rescheduled` group; the groups of the drill-down add up to the total of the report (tested).
5. **Recovered slots** come from the accepted waitlist offers: `recoveredAppointmentIds` (waitlist) gives the ids, scheduling counts and lists them with the viewer's scope, so the figure and its records share one definition.
6. **Confirmed by the patient** is read from `appointment_event` (`status_changed` to `confirmed` with `actor_kind = patient`), which is what the reminder reply and link write.
7. **Audit**: the drill-down shows patient names, so it writes `report.accessed` (metadata: report, group, period, scope, filters, total, offset, rows). `audit_event.resource_id` is a uuid, so a report is named in the metadata and `resource_type = report`. The aggregate report writes nothing.
8. **Performance** (50,000 appointments, laptop): month 207 ms p95, year 533 ms p95, drill-down page 45 ms. Two fixes came from the benchmark: available time as arithmetic (3 s to 0.1 s for a year of 20 professionals) and one counting pass with the professionals joined after grouping.

## TDD cycle evidence

| Task      | Tests                                                                                                                                 | RED                                              | GREEN                                      | Notes                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 4.28      | `contracts/reports.test.ts` (18), `domain/filters.test.ts`, `domain/rates.test.ts`, `application/scope.test.ts` (27 in the module)     | 15 contract tests failed; the module files did not exist | passed                                     | Rounding half up checked at 1/16 and 1/32.                                                                                  |
| 4.29      | `application/operational.test.ts` (pure assembly), `test/integration/operational-report.test.ts` (36)                                  | module missing; routes missing                   | passed                                     | The audit entry first failed: `resource_id` is a uuid. Year-long available time first took 3 s (see decision 8).           |
| 4.30      | same integration file (scope matrix, tenant injection, drill-down, audit), `test/policy/*` (272, audit scenario now points at it)       | 500 on the audit insert                          | passed                                     |                                                                                                                             |
| 4.31      | `scripts/bench-reports.ts` (the benchmark gates a release), `db:check`                                                                 | year report 3.1 s                                | 533 ms                                     | Three indexes: tenant/time/status, and two partial ones on the history.                                                     |
| 4.32      | `domain/*.test.ts` (11), `reports-page.test.tsx` (16, with axe, one failing widget, empty states)                                      | modules missing; 13 failed on first run          | passed                                     | Axe found two regions with the same name (widget and its table): the table label now says "Tabla: ...".                      |
| 4.34      | `e2e/stage4-reports.spec.ts` (7)                                                                                                       | n/a (written with the screen)                    | passed                                     | Compared with the API for the same filters; the owner's demo data is asserted to be non-empty.                              |

## Deviations from the tasks, the design and the track file

1. **Two new files inside other modules**: `modules/scheduling/application/report-facts.ts` and `modules/waitlist/application/report-facts.ts`, with the export lines the track file allows. The index exports need something to point at; no existing file of those modules was edited apart from the two `index.ts`.
2. **Reminders sent is not reported.** `message` belongs to notifications, whose `index.ts` is not in track B's list. The dashboard shows the reminders that worked (confirmations by the patient, from the history) and not the number sent. A seam line (one function in notifications' `index.ts`) would add it.
3. **Migration 0430 has three indexes, not two**: `appointment (tenant_id, starts_at, status)` as asked, and two partial indexes on `appointment_event` (moved; confirmed by the patient) instead of the `(tenant_id, kind, created_at)` index of the task, because the history is asked appointment by appointment and the benchmark preferred them.
4. **A shared test was changed**: `apps/api/scripts/check-migration-drift.test.ts` assumed the first migration of track B is 0430 (and of track A 0410). It now reads the created file's name. Tracks A and C will hit the same assertion otherwise.
5. **`docs/perf/reports.md` and this file**: the harness refused to let me write `docs/perf/reports.md`. Its content is saved in Engram (`sdd/health-practice-saas/4b-perf-note`) for the coordinator to commit.
6. **Charts in jsdom**: Recharts reports a 0 pixel container, so the component tests cover the data, the tables and the states, and the e2e spec covers the rendered chart (role `img` visible at 360 px).
7. **Occupancy counts wall-clock minutes** of the working hours, so a daylight-saving change does not move it; a block cuts exactly.

## What S4.14 needs from tracks A and C

- From A (S4.03, `modules/billing/index.ts`): read functions for charges (charged, voided apart), payments and refunds by period, location, professional, payer and type, with the same scope inputs (`ReportAppointmentScope` style: all, or locations and professionals), and the cash sessions per location and day (opening, payments by method, refunds, expected, counted, difference and reason).
- From C (S4.10, `modules/invoicing/index.ts`): read functions for invoices and credit notes by the same cuts.
- From the seam: the `PaymentMethod` list and the money contract (`Money`) are in place; the export job of task 4.24 is needed by task 4.33 and by the export button of S4.14.
- Track B already provides `canSeeRevenueByProfessional` (false for reception) in `/reports/options`, and `application/scope.ts` for the server-side cut.

## Verification (tip `b4ad18b`, Node v24.22.0, pnpm 10.34.7, Docker shared with other worktrees and under load)

| Command                                                  | Result                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm install --frozen-lockfile`                | exit 0                                                                                                                                                                                                                                                                                 |
| `typecheck`, `lint`, `format:check`                      | exit 0                                                                                                                                                                                                                                                                                 |
| `test`                                                   | 336 files, 4,311 tests. First run: 2 failures under load (`check-migration-drift` restamp test timed out at 60 s; `clinical-editor` axe check). Both passed when re-run alone, together with `apps/api/scripts` (70 tests).                                                           |
| `test:integration`                                       | 180 files, 2,824 tests. First run: 4 failed under load (`admin-denied`, `storage-s3`, `worker`, `waitlist-offer-link`). Re-run alone: the first three passed; `waitlist-offer-link` (a race test that failed with "offer undefined was not delivered") failed once and passed once. Nothing in it touches the reports. |
| `build`                                                  | exit 0; `recharts` is in its own lazy chunk (`BarChart-*.js`, 308 kB), not in the entry chunk or in any modulepreload of `index.html`                                                                                                                                                  |
| `db:check`                                               | No migration drift                                                                                                                                                                                                                                                                     |
| `test:e2e` (ports 3720/4720/9720, `--workers=3`)         | 190 passed, 1 failed: `stage3-messaging` "the owner resends a reminder..." fails axe `color-contrast` on a toast title (`div[data-title]`). It failed again when re-run alone. It is a Stage 3 spec and screen that track B does not touch; it passed in the seam verification of 2026-10-17. A comparison run on the seam tip could not be completed (a second install in a scratch worktree hung), so the cause is not proven. The 7 tests of `stage4-reports.spec.ts` passed. |
| `scripts/bench-reports.ts` (50,000 appointments)         | year 533 ms p95, month 207 ms p95 (target 1,000 ms)                                                                                                                                                                                                                                    |

CI was not run or polled. No `.env` file was read or written.


## Wave 2: S4.14 financial and cash reports, and task 4.33 (export buttons)

Branch `feat/stage-4-track-4b`, from `e866655` (the Stage 4 integration tip `6e343fa` and track C wave 2 `cad5473` already merged). Mode: automatic, strict TDD, work-unit commits, no PR, no merge, CI not polled. Tasks 4.33, 4.57, 4.58 and 4.59 are done; with them track B is complete (4.28 to 4.34 and 4.57 to 4.59).

### Status of the tasks

| Task | State | Notes                                                                                                                                                                                                                                                  |
| ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.57 | done  | `application/financial.ts` and `invoiced-facts.ts`; `GET /reports/financial` and `GET /reports/financial/records` (six kinds: charged, voided, collected, outstanding, receivable, invoiced). Voided charges apart, refunds and credit notes as reductions. |
| 4.58 | done  | `application/cash-report.ts` and `domain/cash-days.ts`; `GET /reports/cash`: per location and day, opening, payments by method, refunds, expected, counted, difference and the reason of each register.                                                |
| 4.59 | done  | `features/reports/financial/*`: money report page, cash report page, widgets, export panel; routes `/reports/financial` and `/reports/cash` (lazy); server-side scope; role matrix in the Playwright spec.                                              |
| 4.33 | done  | `ExportPanel` (CSV, Excel, PDF) on the money and cash pages through `POST /billing/exports` and the `export.build` job of track A, with the filters on screen; never disabled by a read-only organization.                                              |

### Commits (in order)

| Commit    | Tasks               | What                                                                                                                                                                                   |
| --------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `08043ba` | 4.57, 4.58          | Contracts, billing report facts, financial and cash read models, scope rules, routes, integration test (37 tests).                                                                    |
| `8d8d4ba` | 4.57, 4.58 (perf)   | Vouchers added up by the database, one pass over charges and payments, migration `0431`, benchmark rows.                                                                               |
| next      | 4.59, 4.33          | Web: pages, widgets, export panel, locale, component tests (26), Playwright role matrix (9 new tests), docs, tasks marked.                                                             |

### Decisions

1. **Each figure keeps its own date, and says so.** Charges, outstanding and payer receivables by the day of the service at the clock of the location; payments and refunds by the day they happened; vouchers by the date printed on them; registers by the day they were opened. The screen states it in one sentence and the drill-down of each figure uses the same definition, so its rows add up to the figure (tested for all six kinds, page by page).
2. **Billing exposes read facts, not tables.** `modules/billing/application/report-facts.ts` (new file) and new lines in `billing/index.ts`: `chargeFacts`, `paymentFacts`, `chargeRecords`, `paymentRecords`, `cashRegisters`, `reportPayers`, `reportNames`. The reports module owns the rules of the report, billing the SQL over its own tables. The scope is a parameter of every function, as in the scheduling facts.
3. **Outstanding is the figure of the charge list**: the patient part minus what the patient paid net of refunds, never below zero per charge; the integration test compares the totals with `GET /billing/charges` summed.
4. **Vouchers are added up by the database in the reports module** (`invoiced-facts.ts`), not through `readInvoicedLines`: that function takes about 2 s for 14,500 lines (chunks of 500 through billing), and the year report needed under 1 s. See "Deviations" for the boundary this crosses and how it is held.
5. **Scope in one place** (`application/scope.ts`): reception gets no `byProfessional` (null) and a filter by professional is refused (403 and `access.denied`), except its own profile if it is also a professional; a professional gets only their rows, a colleague is refused; the cash report is for the organization and reception only (a professional gets 403). Reception's drill-down rows carry no professional name.
6. **Audit**: the aggregate reports write nothing; every read of the records behind a figure writes `report.accessed` (kind, period, filters, total, rows). `audits: ['report.accessed']` is declared on the route and the audit scenario of the action already points at the operational test (the financial test proves the same entry).
7. **The cash report cannot widen**: `cashReport` throws for a professional scope instead of falling through to "every location", and the page never asks the server until it knows the viewer may read it (a professional would otherwise leave a denial in the audit log on each visit).
8. **Exports go through track A's job** with its three kinds (charges, payments, payer settlement): the money page offers the three, the cash page the payments and refunds by method. The file carries the filters and the generation time (the job writes them), and the scope of the person comes from the session, never from the request (a test asserts the request has only kind, format, period and the chosen filters).
9. **Performance**: charges and payments are cut every way in one statement (`GROUPING SETS`), what was paid is joined and not asked per charge, and the transaction asks for 32 MB of working memory (the default made the hash tables spill to disk).

### Benchmark (50,000 appointments, 35,000 charges, 29,143 payments, 999 refunds, 14,500 vouchers, 1,095 registers; laptop busy with other projects)

| Query                                                  | p50 (ms) | p95 (ms) | Target |
| ------------------------------------------------------ | -------- | -------- | ------ |
| Financial report of a month, whole organization        | 96       | 117      | < 1000 |
| Financial report of a year, whole organization         | 619      | 767      | < 1000 |
| Financial report of a month, reception of one location | 53       | 66       | < 1000 |
| Financial report of a month, one professional          | 29       | 30       | < 1000 |
| Financial drill-down, 50 charges of a month            | 86       | 93       | < 1000 |
| Financial drill-down, 50 payments of a year            | 382      | 466      | < 1000 |
| Financial drill-down, 50 voucher lines of a year       | 91       | 98       | < 1000 |
| Cash report of a month / of a year                     | 6 / 34   | 11 / 41  | < 1000 |

The heaviest is the year report (767 ms at p95, run to run 770 to 1,075 ms on a loaded machine in the earlier runs, so the margin is real but not large). The story of the numbers, including the first version at 3 s, is in `docs/perf/reports.md`.

### TDD cycle evidence

| Task      | Tests                                                                                                                                                                        | RED                                                                                                      | GREEN                                                  | Notes                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.57/4.58 | `contracts/reports.test.ts` (+11), `domain/financial-rows.test.ts` (5), `domain/cash-days.test.ts` (7), `application/scope.test.ts` (+10), `test/integration/financial-report.test.ts` (39) | 12 contract tests failed before the schemas; domain and scope tests written before the modules           | all passed                                             | The integration file went green on its first run apart from two test mistakes (a metadata assertion and HEAD routes); a mutation check (voided counted as charged, refunds ignored) failed 9 of 37 tests, so they do detect a wrong figure. |
| 4.57 perf | benchmark (`--explain` prints the plans), `invoiced-facts` parity test against `readInvoicedLines` and `summarizeInvoiced`                                                    | year report 2,991 ms and vouchers 2,164 ms before; target missed                                         | 767 ms p95                                             | Parity with the index of invoicing is tested for the total, day, location, professional and payer.                                                                                          |
| 4.59/4.33 | `financial/domain/money-series.test.ts` (4), `financial/financial-report-page.test.tsx` (26, with axe, a failing widget with retry, empty states, read-only, scope), `e2e/stage4-reports.spec.ts` (+9) | component tests written before the pages; first run 8 failed (my queries, one real: the cash report was asked before the options were known) | 57/57 in `features/reports`; 16/16 e2e | The real defect (a professional's browser asking `/reports/cash` before knowing it may not) is fixed and has its own test.                                                                  |

### Deviations from the tasks, the design and the track file

1. **New file inside billing** (`report-facts.ts`) and new lines in `billing/index.ts` and `docs/stage4-tracks.md`, because S4.03 did not export the read functions the track file says it waits for. Nothing existing in billing was edited apart from the index.
2. **Reports read the invoice tables directly in one place** (`invoiced-facts.ts`: `invoice`, `invoice_line`, `charge`), against "invoices only through `invoicing/index.ts`". The coordinator allowed a read function in the reports module when the flat read model is too slow, and the benchmark showed that it is (2 s for a year). The risk is drift from the rules of invoicing; `financial-report.test.ts` compares the two for every cut. `readInvoicedLines` stays the reference.
3. **Migration `0431`** (indexes only, in `4b`'s range) on `charge`, `payment`, `payment_reversal` and `invoice`, tables of tracks A and C, like `0430` did for the scheduling tables.
4. **Exports use the three kinds of track A.** There is no export of appointments (the operational dashboard has no export button) and no export of the cash sessions as such (the payments export lists the same movements by method). A new kind needs a change to `EXPORT_KINDS` and to the check constraint of `export_request`, which is track A's; proposed as a seam if wanted.
5. **The e2e stack cannot build an export file**: `scripts/stack/start-stack.ts` passes no `S3_BUCKET` to the configuration of the worker, so billing's `export.build` job is not registered and a request stays queued. The e2e test follows the request and its status; the three formats are tested by the integration tests of track A. A fix is one line of the stack file (outside my list; for the coordinator or track D).
6. **`ReportOptionsResponse` grew** (`payers`, `canSeeCashReport`) so the filter and the navigation know what the viewer may use; additive.
7. **Lighthouse was not run** (no browser tooling in this session): the money and cash pages are lazy routes with their own chunks (`FinancialReportPage`, `CashReportPage`), and Recharts stays in its own lazy chunk (`BarChart`, 308 kB), outside the entry chunk and `index.html`, as for the dashboard.

### Verification (tip of the wave, Node v24.22.0, pnpm 10.34.7, Docker shared with other worktrees and under load)

| Command                                                          | Result                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm install --frozen-lockfile`                        | exit 0                                                                                                                                                                                                     |
| `typecheck`, `lint`, `format:check`                              | exit 0                                                                                                                                                                                                     |
| `test`                                                           | 380 files, 4,830 tests, all passed (`boot.test.ts` and the policy tests included)                                                                                                                         |
| integration, targeted files only (the integrator runs the suite) | `financial-report` (39), `operational-report` (36), `invoice-reads`, `billing-exports`, `cash-register`: 5 files, 107 tests passed                                                                         |
| `build`                                                          | exit 0; `FinancialReportPage` and `CashReportPage` are their own chunks, Recharts is not in `index.html`                                                                                                  |
| `db:check`                                                       | No migration drift (with `0431` restamped)                                                                                                                                                                 |
| `stage4-reports.spec.ts` (ports 3860/4860/9860)                  | 16 passed (7 of wave 1, 9 new: the money report as three people, the records add up, denials, the cash report as owner and reception, no cash report for a professional, the export request)             |
| `scripts/bench-reports.ts` (50,000 appointments)                 | table above; year report 767 ms p95                                                                                                                                                                        |

CI was not run or polled. No `.env` file was read or written. The containers of my runs (the benchmark, the integration files and the e2e stack on 9860) stopped by themselves; none of the other worktrees' containers was touched.
