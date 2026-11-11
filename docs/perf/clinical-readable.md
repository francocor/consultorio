# Benchmark: the clinical row level security (`app.clinical_readable`)

Task 2.97. The design risk table said: "`clinical_readable` in RLS adds per-row cost. Indexed
`care_relationship` lookup; settings read once per transaction. Benchmark in Stage 2." This is that
benchmark and its answer.

## Result: the target is met, no index change is needed

Run of 2026-10-17 on a developer laptop (Docker Desktop, Postgres 17.11 in a container, nothing else
tuned), with the application role `app_rw`, the policies ON, a tenant context and a professional
context set exactly as the application sets them:

Clinical notes: 102,000 in 20,000 patients, 5 professionals (each patient treated by two).

| Query                                                     | Samples | p50 (ms) | p95 (ms) | max (ms) | Target p95 |
| --------------------------------------------------------- | ------- | -------- | -------- | -------- | ---------- |
| Timeline of a treated patient (RLS on)                    | 300     | 0.8      | 1.0      | 1.4      | < 50       |
| Drafts of the professional (RLS on)                       | 300     | 0.6      | 0.8      | 1.0      | < 50       |
| Timeline of a patient NOT treated (RLS filters every row) | 100     | 0.9      | 1.1      | 1.3      | < 50       |
| A chart of 2,000 entries, all of them read (RLS on)       | 100     | 18.9     | 25.7     | 29.2     | < 150      |
| Timeline of a treated patient (no policies, superuser)    | 300     | 0.6      | 0.8      | 1.2      | reference  |

Reading the table:

- A normal screen (the chart of a patient, the drafts) answers in about a millisecond with 100,000
  notes in the table. The policies add about **0.2 ms** to a query that returns a handful of rows.
- The plan is an index scan on `clinical_note_patient_idx (tenant_id, patient_id, created_at)`. The
  policy predicate (`clinical_readable`) runs as a filter on the rows the index already narrowed down
  to one patient, so its cost grows with the entries of a patient, not with the size of the table.
- The heaviest chart the screens ask for is the window of the per-patient search: 2,000 entries, every
  one passing through the predicate. It takes about 19 ms (p95 26 ms), which is the per-row cost
  (about 10 microseconds). That is also the ceiling of the design: the search is capped at 2,000
  entries and asks for a date range beyond it (design 4.3).
- A patient the professional does not treat returns nothing just as fast: the filter rejects the rows
  of that one patient without touching anything else.

## How to run it again

```bash
pnpm --filter @consultorio/api bench:clinical                 # 100,000 notes (about a minute)
pnpm --filter @consultorio/api bench:clinical --notes 5000    # a quick check of the script
```

It needs only Docker. It starts a Postgres 17, applies every migration, fills the tables as the
superuser with triggers and foreign keys off (it measures reads; the guards of the writes have their
own tests), measures with the application role and prints this report in Markdown. The exit code is 1
when a target is missed, so it can gate a release.

## Limits of this measurement

- One tenant. Row level security also filters by `tenant_id`, but the leading column of every index is
  `tenant_id`, so other tenants' rows are never visited; the plan above shows it.
- The content is not decrypted: the timeline of the product decrypts after the read, and that cost is
  application CPU, measured by the clinical search tests, not by the database.
- The numbers are those of a laptop. What matters for a regression is the ratio between "policies on"
  and "policies off" and the shape of the plan; both are printed by the script.
- The test data is uniform. A real center has patients with many entries and professionals with
  many patients; the 2,000-entry case bounds the former, and the index bounds the latter.

## If the target is ever missed

In order: look at the plan first (the index scan must stay); then check that `clinical_readable` is
still `STABLE` and reads the sharing settings from `set_config` values rather than from a table;
only then consider caching the care relationship per transaction. Do not widen the policy or bypass
it to gain speed: the policy is the backstop of the clinical access rule (ADR-003).
