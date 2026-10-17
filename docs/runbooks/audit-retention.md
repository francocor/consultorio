# Runbook: audit retention

Audience: the operator on call. Scope: the `audit_event` table, which holds the tamper-evident
trail of every tenant. Rules come from the audit-log spec (retention of at least 10 years, no edit
and no delete through the product) and from ADR-005.

## The rules in one place

| Rule                                   | How it is enforced                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nobody edits or deletes an entry       | The runtime role has `INSERT` and `SELECT` only; a trigger rejects `DELETE` and every `UPDATE` except the sealer filling `seq`, `prev_hash` and `hash` once.                                                              |
| Nothing in the code deletes audit rows | `apps/api/test/policy/no-audit-delete.test.ts` scans the source and fails the build on a `DELETE`, `TRUNCATE`, `DROP` or trigger bypass against the table or its partitions.                                              |
| Entries are kept at least 10 years     | Nothing in the product removes them. The only exception the product allows is the reset of a demo tenant (`demo.reset`, S1.36), which runs in a SQL function and writes a platform audit entry with the last sealed hash. |
| The chain is verifiable                | `audit.seal` chains new entries every 5 seconds; `audit.verify` re-walks every tenant chain every night and raises `audit_chain_break_total` when it finds a break.                                                       |

## Partitions

`audit_event` is partitioned by month on `occurred_at` (`audit_event_YYYY_MM`).

- A task called `audit.partitions` runs when the worker starts and every night at 03:00 UTC. It
  calls `app.ensure_audit_partitions(3)`, so the current month and the three after it always
  exist. It is idempotent and never removes anything.
- An entry whose month has no partition cannot be written, and writing is fail-closed, so a
  missing partition stops every audited action. Watch the gauge `audit_partitions_ahead`: alert
  when it is below 2, and run `select app.ensure_audit_partitions(6);` as the owner by hand if the
  worker has been down.
- Partitions are never dropped. Old ones are moved (below), not deleted.

## Moving old partitions to cold storage (older than 2 years)

Partitions older than 2 years are archived to cheaper storage and stay recoverable for the whole
10 years (and longer, while the clinical record they refer to is kept). This is a controlled
operator procedure, done at most once a quarter, never automated in a way that can delete.

1. **Choose** the partitions whose whole month is older than 2 years: `select relname from
pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.audit_event'::regclass
order by 1;`
2. **Verify first.** Run the verification for every tenant that has rows in the partition
   (`audit.verify`, or the nightly result in the metrics). Do not archive a partition of a chain that
   is broken: open an incident instead.
3. **Export** the partition as the owner role to a file: `\copy (select * from audit_event_2024_03)
to 'audit_event_2024_03.csv' csv header` (or `pg_dump --table=public.audit_event_2024_03`).
4. **Store** the file in the archive bucket, which has Object Lock in governance mode for 10 years
   and server-side encryption with the archive key. Record the object key, its SHA-256 and the
   number of rows.
5. **Check the copy**: download it, compare the SHA-256 and the row count with the partition.
6. **Detach, do not drop.** `alter table audit_event detach partition audit_event_2024_03;` keeps
   the table in the database under its own name. Entries stay readable with a direct query by the
   owner role, and the chain of each tenant is still verifiable from the export.
7. **Leave the detached table in place** until the archive copy has been restored once in a drill
   (every quarter restores one archived month into a scratch database and runs the verification).
   Even then, do not run `DROP`: dropping a detached audit partition is a legal-erasure action and
   needs the documented, audited procedure of the retention policy.

## Never

- Never `DELETE`, `TRUNCATE` or `DROP` audit data to save space. Storage is cheap; losing the trail
  is not recoverable.
- Never disable the append-only trigger. If a migration needs to change the table, it must keep the
  trigger and the privileges and say so in its header.
- Never edit `occurred_at`, `seq`, `prev_hash` or `hash` by hand. A fixed row breaks the chain
  from that point on, which is exactly what the verification exists to show.

## When something looks wrong

| Symptom                                     | First action                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_chain_break_total` increases         | Read the worker log line `audit chain break` (tenant, first bad sequence, reason). Freeze changes to that tenant, copy the table, and open an incident. Do not repair the chain. |
| Writes fail with "no partition of relation" | `select app.ensure_audit_partitions(3);` as the owner; check why the worker's nightly task did not run.                                                                          |
| `audit_seal_lag_seconds` grows              | The worker is down or the sealer is failing. Entries are durable and visible (marked "pending sealing"); restart the worker.                                                     |
