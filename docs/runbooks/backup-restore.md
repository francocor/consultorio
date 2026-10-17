# Runbook: backups and the restore drill

Audience: whoever runs the platform. Scope: what is backed up, how to take and verify a backup, and
how to prove once a quarter that a backup can be restored. Task 2.99 of the plan.

## What exists today

| Where                  | Status                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local environment      | **Built and tested.** `pnpm backup:local` backs up the Postgres database and the document bucket; the restore is exercised by an integration test on throwaway containers.       |
| Staging and production | **Not provisioned.** The cloud account, the region (decision Q1) and the managed Postgres do not exist yet. The section "Production" is the design the infrastructure must meet. |

Cloud delivery to staging (task 2.98) is deferred and blocks nothing; see `docs/runbooks/deploy.md`.

## What a backup must contain

1. **The database.** One Postgres database holds everything: patients, the clinical record (encrypted
   fields included), the audit chain, the job queues. A backup that misses a table is not a backup.
2. **The document bucket.** Every object under `t/{tenantId}/docs/...` and the logos. The database
   points at them by key; a database without its objects shows files that cannot be downloaded.
3. **The key-encryption key (KEK).** Clinical fields are encrypted with a per-organization key that
   the KEK wraps (`tenant_key`). A restored database with the wrong KEK is unreadable. Locally that is
   `KMS_LOCAL_KEK_BASE64`; in production it is the AWS KMS key. **The KEK is never inside the backup**:
   keep it in its own escrow (for KMS: key deletion protection, a multi-region replica or a
   documented recovery owner), and test that the restored copy opens with it.

## Local environment

Development only; the defaults are the public values of `infra/docker-compose.yml`.

```bash
pnpm infra:up                                   # Postgres and MinIO, as usual
pnpm backup:local                               # writes ./backups/backup-<UTC timestamp>/
pnpm backup:local verify backups/backup-...     # checks every checksum, touches nothing
pnpm backup:local restore backups/backup-... --into consultorio_restore --bucket consultorio-restore
```

What a backup folder holds: `database.dump` (custom-format `pg_dump`), `objects/` (the bucket, one
file per key), `objects.json` (key, size, SHA-256 and content type of each) and `manifest.json`
(written last; a folder without it is an unfinished copy and is refused).

What the commands guarantee:

- The Postgres tools run **inside the database container** (`docker exec`), so the host needs only
  Docker. The container is `consultorio-postgres-1` (`BACKUP_PG_CONTAINER` or `--container` changes it);
  the database, user, S3 endpoint and bucket come from `POSTGRES_DB`, `POSTGRES_SUPERUSER`,
  `S3_ENDPOINT` and `S3_BUCKET` (or `--database`, `--user`, `--endpoint`, `--bucket`).
- `verify` and `restore` first prove the dump and every object against their recorded SHA-256. A
  folder that was changed after it was taken is refused before anything is created.
- **A restore never overwrites.** It creates a NEW database (`--into`) and puts the objects in the
  bucket named with `--bucket` (created if missing); an existing database name is refused. `--bucket`
  is required (there is no default), cannot be the live bucket (`S3_BUCKET`, or the one the backup
  was taken from), and the bucket must be new or empty. To switch the application over, change
  `DATABASE_URL` and `S3_BUCKET` and restart; the old database stays as it was.
- The roles of the cluster (`app_owner`, `app_rw`, ...) must already exist in the target server
  (`infra/postgres/init/01-roles.sql`); the dump keeps ownership, grants, row level security (with
  FORCE) and policies, and the test compares them with the source.
- `backups/` is git-ignored. Backups of a real database are patient data: encrypt the disk they are on.

### The restore test

`apps/api/test/integration/backup-restore.test.ts` does the drill on throwaway containers (Postgres
17 and MinIO): two organizations with patients and files, a backup, a restore into a new database and
bucket, then it checks that each organization still sees only its own rows, that the FORCE row level
security and the policies are the same as the source, that the PDF is byte for byte equal, and that a
tampered dump or an existing database name is refused. It runs with the rest of `pnpm test:integration`.

## Production (the design the infrastructure must meet)

| Layer            | Requirement                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Point in time    | Continuous WAL archiving (managed Postgres PITR) with at least **35 days** of retention. Target **RPO 5 minutes**, **RTO 4 hours** (proposed; the owner confirms).                                   |
| Logical dump     | **Weekly** `pg_dump -Fc` (the same format as the local tool) copied to a bucket in another account and region, kept 12 weeks. It is the way out of a managed-service problem that PITR cannot cover. |
| Objects          | Bucket versioning on, replication to a second region, and the `docs/` prefix never lifecycle-expired (documents are kept 10 years after the last encounter; see `docs/runbooks/documents.md`).       |
| Key              | KMS key with deletion protection and a documented recovery owner; the restore drill opens a restored copy with it.                                                                                   |
| Before a release | Take a snapshot before every migration deploy (forward-only migrations: the way back is a restore, never a down migration).                                                                          |
| Access           | Backups are encrypted at rest and readable only by the platform operator role; reading one is audited by the cloud provider.                                                                         |

## Quarterly restore drill (checklist)

Run it every quarter and after any change of provider, region or key. Record the date, who ran it and
the results in the operations log; a drill nobody recorded did not happen.

1. [ ] Pick the backup: the latest weekly dump **and** a PITR target 24 hours ago.
2. [ ] Restore into an **isolated** environment (never the live database) with a new bucket.
3. [ ] `verify` the dump checksum and the object count against the manifest.
4. [ ] Start the application against the restored copy. Sign in as a demo-style test account of a real
       organization created for drills.
5. [ ] Open a patient, a signed clinical note (decrypts: the KEK works), a document (downloads, the
       bytes match its recorded SHA-256) and the audit trail.
6. [ ] Run the audit verification job: every chain of the restored copy must verify from its first
       event. A broken chain after a restore means the copy is not faithful.
7. [ ] Check isolation: two organizations, each sees only its own rows (the policies came across).
8. [ ] Record the time it took (RTO) and the age of the newest row in the copy (RPO).
9. [ ] Destroy the isolated environment and its bucket.
10. [ ] Any failed step is a defect with an owner and a date before the next drill.

## Never

- Never restore over a live database, locally or in production: restore into a new one, compare,
  switch.
- Never keep the KEK in the same place (or the same backup) as the data it protects.
- Never edit a dump or an object inside a backup folder; the checksums exist to catch exactly that.
- Never delete the last good backup before the next one has been verified.
