# Migration ranges and the tools around them

Stages 3 to 6 are built by parallel tracks (messaging, public booking, waitlist, teleconsultation, ...). Each track adds migrations while the others do. This page is the convention that keeps those migrations from colliding, and the three commands that enforce it.

## Why ranges are safe

Drizzle's migrator never looks at the number in a tag. It reads `meta/_journal.json` and applies, in the order of the file, the entries whose `when` is later than the newest one the database already ran. So:

- A tag such as `0320_notifications_core` after `0043_document_rescan_attempts` is fine. The numbers are only a naming convention, and a range per stage and per track means two branches never create two files with the same name or two snapshots with the same number.
- The one thing the migrator does need is a journal whose `when` **rises**. A migration merged after another but stamped earlier is **skipped silently** on a database that already ran the later one (`apps/api/test/integration/migration-lanes.test.ts` shows it against a real Postgres). Stamps are taken from the clock when a migration is created, so parallel branches routinely produce this order. `pnpm db:restamp` repairs it and `pnpm db:check` refuses it.
- `drizzle-kit generate` does **not** fit parallel work: it names the next file by the last `idx`, takes the snapshot whose file name sorts last as the state of the database, and refuses two snapshots that continue the same parent. The tools below run it in a scratch copy where the snapshots are ordered by the journal, and they keep the chain in order. Do not run `drizzle-kit generate` by hand (the `db:generate` script now refuses).

Linear numbering (`0044`, `0045`, ...) with a renumbering tool was the other option. It was not chosen because two branches that each take the next number produce two `0044_snapshot.json` files, a conflict git cannot merge, while ranges never produce one. The numbers are final: nothing is renumbered, only stamps and snapshot links change.

## The ranges

Stages 0 to 2 are one linear sequence below `0300` (today `0000` to `0043`), numbered by `drizzle-kit generate` itself on the Stage 2 branch, which still receives fixes while Stage 3 is built. `pnpm db:restamp` never touches an entry of that sequence. Stage 3 work does not add to it.

| Range       | Stage                  |
| ----------- | ---------------------- |
| 0000 - 0035 | Stages 0 to 2 (frozen) |
| 0300 - 0399 | Stage 3                |
| 0400 - 0499 | Stage 4                |
| 0500 - 0599 | Stage 5                |
| 0600 - 0699 | Stage 6                |

Inside a stage each track has its own range (the track names are the ones `pnpm db:new` takes):

| Track   | Range       | Owner                         |
| ------- | ----------- | ----------------------------- |
| `3seam` | 0300 - 0319 | Stage 3 seams (S3.00, S3.00b) |
| `3a`    | 0320 - 0339 | A, messaging                  |
| `3b`    | 0340 - 0359 | B, public booking             |
| `3c`    | 0360 - 0369 | C, waitlist                   |
| `3d`    | 0370 - 0379 | D, teleconsultation           |
| `3e`    | 0390 - 0399 | E, integration                |
| `4seam` | 0400 - 0409 | Stage 4 seams                 |
| `4a`    | 0410 - 0429 | A, billing                    |
| `4b`    | 0430 - 0439 | B, reports                    |
| `4c`    | 0440 - 0469 | C, invoicing                  |
| `4d`    | 0490 - 0499 | D, integration                |
| `5seam` | 0500 - 0504 | Stage 5 seams                 |
| `5a1`   | 0505 - 0509 | A1, matricula verification    |
| `5a2`   | 0510 - 0529 | A2, consent                   |
| `5a3`   | 0530 - 0549 | A3, e-prescription            |
| `5b`    | 0550 - 0579 | B, portal                     |
| `5c`    | 0590 - 0599 | C, integration                |
| `6seam` | 0600 - 0609 | Stage 6 seams                 |
| `6a`    | 0610 - 0639 | A, subscriptions              |
| `6b`    | 0640 - 0649 | B, signup                     |
| `6c`    | 0650 - 0679 | C, retention                  |
| `6d`    | 0690 - 0699 | D, readiness                  |

The gaps (`0380 - 0389`, `0470 - 0489`, `0580 - 0589`, `0680 - 0689`) are reserved and are not used by `pnpm db:new`.

**Stage 4 (revenue).** The seam (S4.00) has no tables, so `4seam` stays empty. The numbers that `tasks.md` names are: `4a` 0410 pricing, 0412 charges, 0414 payments and cash; `4b` 0430 report indexes (a custom migration, the reports have no tables); `4c` 0440 fiscal configuration, 0442 the local AFIP simulator (platform tables, no `tenant_id`), 0444 invoices; `4d` as the integration slices need. The invoices migration (0444) has a foreign key and a trigger on `charge_line` (0412): it must come later in the journal, which the run order guarantees (S4.10 waits for S4.02). What each track may touch is in `docs/stage4-tracks.md`.

## Working on a track

1. Edit the Drizzle schema (`apps/api/src/db/schema/`).
2. `pnpm db:new <track> <name>`, for example `pnpm db:new 3a notifications_core`. It asks drizzle-kit, in a scratch copy, what migration the schema still needs and writes it as the next number of the track's range (`0320_notifications_core.sql`), with the snapshot that continues the last one of the journal and a journal entry stamped later than every existing one. When the schema has nothing new, or with `--custom`, the file is empty and ready for hand-written SQL (triggers, functions, data). Use `--number 0322` when a task names the number.
3. For new tenant tables run `pnpm --filter @consultorio/api exec tsx scripts/finish-migration.ts <file> <table>...` (it moves the foreign keys inline and appends the row level security policies), then read the SQL.
4. A foreign key between two tables that both have FORCE row level security needs the statement that lifts FORCE for the length of the `ADD CONSTRAINT` (see the apply-progress notes of Stage 2, migrations 0030 and 0034).
5. `pnpm db:check`.

Migrations stay forward-only and expand-only. One migration per slice; the number to use is the one in `tasks.md`.

## After a merge or a rebase

When the journal lists migrations of different tracks, run:

```bash
pnpm db:restamp
pnpm db:check
```

`db:restamp` works in the order of the journal file, which is the merge order. It numbers `idx` again, raises each stamp that does not rise to one millisecond past the entry before it (never touching the linear sequence below `0300`), chains each snapshot to the one before it, and rebuilds the last snapshot from the Drizzle schema so it describes every merged track (`--no-refresh` skips that last step). It changes nothing when nothing needs it. Resolve the textual conflict in `_journal.json` first by keeping every entry; do not resolve the snapshots by hand.

Only restamp migrations that nobody has applied yet. A development database that already ran a migration with its old stamp can fall out of step with the new one: run `pnpm infra:reset` and `pnpm --filter @consultorio/api db:migrate` again. Once a stage is merged to the main branch its migrations are history and are never restamped.

## What `pnpm db:check` enforces

Besides the schema and the migrations agreeing, the journal itself must be sound:

| Problem                 | Meaning                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `non_monotonic_when`    | A stamp is not later than the entry before it: the migrator would skip it on an existing database |
| `duplicate_tag`         | A tag appears twice                                                                               |
| `duplicate_prefix`      | Two tags share a number, so their snapshots would overwrite each other                            |
| `out_of_range_prefix`   | The number is in no range, for example `0700`                                                     |
| `bad_tag`               | The tag is not `NNNN_lowercase_words`                                                             |
| `bad_idx`               | `idx` is not 0, 1, 2 ... in the order of the file                                                 |
| `missing_sql`           | An entry without its `.sql` file                                                                  |
| `orphan_sql`            | A `.sql` file without an entry, which would never run                                             |
| `missing_snapshot`      | An entry without its snapshot                                                                     |
| `broken_snapshot_chain` | A snapshot does not continue the one before it in the journal                                     |

When any of these is found the schema is not compared, because drizzle-kit's answer would not mean anything.
