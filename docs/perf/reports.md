# Benchmark: the operational reports

Task 4.31. The reports spec says every figure must be reproducible from its source records, and the
design puts the target at a p95 under 1 second for a dashboard over 50,000 appointments. This page is
that benchmark, the numbers it gave, and the choices that made them.

## Result: the target is met

Run of 2026-10-17 on a developer laptop (Docker Desktop shared with other projects, Postgres 17.11 in
a container, nothing tuned), as the application role `app_rw` with the row level security policies ON
and a tenant context set exactly as the application sets it. Every query goes through the same
functions the routes call (`operationalReport`, `operationalRecords`).

Data: 50,000 appointments over the year 2025 (4,110 in the month measured), 20 professionals, 3
locations, 5,000 patients, a history with a move for one appointment in ten and a confirmation by the
patient for one in three, and working hours Monday to Friday for everyone.

| Query                                               | Samples | p50 (ms) | p95 (ms) | max (ms) | Target p95 |
| --------------------------------------------------- | ------- | -------- | -------- | -------- | ---------- |
| Report of a month, whole organization               | 20      | 140      | 207      | 237      | < 1000     |
| Report of a year, whole organization                | 20      | 428      | 533      | 593      | < 1000     |
| Report of a month, reception of one location        | 20      | 98       | 119      | 123      | < 1000     |
| Report of a month, one professional                 | 20      | 64       | 73       | 73       | < 1000     |
| Drill-down page of 50, a month (all)                | 20      | 32       | 45       | 46       | < 1000     |
| Drill-down page of 50, no-shows of a year           | 20      | 21       | 27       | 28       | < 1000     |
| (of which) the counts of the appointments of a year | 20      | 369      | 465      | 467      | reference  |
| (of which) the available working time of a year     | 20      | 104      | 123      | 140      | reference  |

The heaviest screen is the report of a whole year for the whole organization: **533 ms at p95**, with
half of the budget left. The monthly dashboard, which is what people open, takes about 0.2 s.

The same run with the three indexes of migration 0430 dropped (`--no-indexes`) gave 901 ms at p95 for
the year and 103 ms for the no-shows of a year. The indexes are worth having, but the queries are
sound without them: the existing indexes of the appointments (professional, location and patient, by
time) and of the history (by appointment) already carry most of the load.

## What makes it fast

1. **One pass over the appointments of the period.** The counts by status, day, location,
   professional and specialty come from a single query that works out the facts of each appointment
   once (its day at the location, whether it was moved, whether the patient confirmed it) and then
   adds them up in five groupings. Separate queries read the same rows several times.
2. **The period is a window the index can use.** The days are read in the time zone of each location,
   so the exact test is `starts_at >= (date::timestamp AT TIME ZONE l.time_zone)`, which an index
   cannot use. A coarse window in UTC (one day before, two days after, because a zone is at most 14
   hours from UTC) goes first, and `appointment_report_idx (tenant_id, starts_at, status)` serves it.
3. **The professionals are joined after counting, not before.** The counts are grouped by professional
   id first; the names and the specialties are attached to those twenty groups. The professional is
   joined per appointment only when the report is filtered by specialty.
4. **Two small partial indexes for the history.** "Was it moved?" and "did the patient confirm?" are
   asked appointment by appointment, and a row of the history is rarely either one. Partial indexes on
   `kind = 'rescheduled'` and on `status_changed` to `confirmed` by the patient are tiny and answer by
   index only.
5. **Available time is arithmetic.** Occupancy needs the minutes the professionals work in the period.
   Converting each working window of each day to an instant (daylight saving aware) took three
   seconds for a year of twenty professionals. Hours are minutes of the wall clock, so a day that no
   block touches is counted by arithmetic; only the days a block touches are cut exactly, in instants.
   That took the available time of a year from about 3,000 ms to about 100 ms.

## How to run it again

```bash
pnpm --filter @consultorio/api exec tsx scripts/bench-reports.ts                      # 50,000
pnpm --filter @consultorio/api exec tsx scripts/bench-reports.ts --appointments 5000  # a quick check
pnpm --filter @consultorio/api exec tsx scripts/bench-reports.ts --no-indexes         # without 0430
```

It needs only Docker. It starts a Postgres 17, applies every migration, fills the tables as the
superuser with triggers and foreign keys off (it measures reads; the guards of the writes have their
own tests), measures with the application role and prints this report in Markdown, with how many
times each new index was scanned. The exit code is 1 when a target is missed.

## Limits of this measurement

- One tenant. Row level security also filters by `tenant_id`, but the leading column of every index
  is `tenant_id`, so other tenants' rows are never visited.
- The numbers are those of a laptop under load from other containers. What matters for a regression is
  the ratio between the queries, and that the monthly dashboard stays far from the target.
- The test data is uniform: one appointment type, a regular mix of statuses. The cost grows with the
  number of appointments in the period, not with the size of the table.
- The drill-down is paged (50 rows, 200 at most), so its cost does not grow with the period.
- Financial and cash reports (S4.14) are not measured here; they get their own rows when they land.

## If the target is ever missed

1. Look at the plan of the counts query first (`EXPLAIN (ANALYZE, BUFFERS)` of the `c` CTE of
   `operationalFacts`): a sequential scan of `appointment` means the coarse window or
   `appointment_report_idx` is not being used.
2. A period of more than a year is refused (366 days), so the cost has a ceiling per request.
3. Past several hundred thousand appointments a year, the next step is a daily summary table kept by
   the appointment events, so a report adds up days instead of appointments.
