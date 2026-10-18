# Apply progress: Stage 4, track B (reports)

Change: `health-practice-saas`. Branch `feat/stage-4-track-4b`, from the seam tip `caf5ee1`. Mode: automatic, strict TDD, work-unit commits, no PR, no merge, CI not polled. Slices S4.06 (operational read models) and S4.07 (dashboard UI) are done except task 4.33 (export buttons), which waits for track A's export job. S4.14 (financial and cash reports) waits for tracks A and C and is not started.

## Status of the tasks

| Task | State   | Notes                                                                                                                                                                                  |
| ---- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.28 | done    | `domain/filters.ts` (inverted range, span over 366 days), `application/scope.ts` (the one place that decides who sees what), `domain/rates.ts`. Payer filter left for S4.14.            |
| 4.29 | done    | `application/operational.ts` plus read functions in `scheduling` and `waitlist` (declared exceptions). D9 rate, rescheduled from history, occupancy, new vs returning, recovered slots. |
| 4.30 | done    | `GET /reports/options`, `GET /reports/operational`, `GET /reports/operational/records`; `report.accessed` on the drill-down only.                                                      |
| 4.31 | done    | Migration `0430_report_indexes.sql` (3 indexes), `scripts/bench-reports.ts`, `docs/perf/reports.md` (see "Deviations": the doc content is in Engram).                                   |
| 4.32 | done    | `features/reports/*`, `locales/es-AR/reports.json`; Recharts lazy-loaded; every chart has a table; patterns as non-colour encoding.                                                    |
| 4.33 | pending | Export buttons use track A's `export.build` job (task 4.24), which does not exist on this branch.                                                                                      |
| 4.34 | done    | `e2e/stage4-reports.spec.ts` (7 tests at 360 px).                                                                                                                                      |
| 4.57 | pending | S4.14, waits for tracks A (S4.03) and C (S4.10).                                                                                                                                       |
| 4.58 | pending | S4.14.                                                                                                                                                                                 |
| 4.59 | pending | S4.14.                                                                                                                                                                                 |

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
