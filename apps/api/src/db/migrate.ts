import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

import { describeFailure } from '../platform/db/failure-log.js';
import { createOwnerDb, type Db } from '../platform/db/pool.js';
import { installJobs } from '../platform/jobs/install.js';
import type { QueueDefinition } from '../platform/jobs/queues.js';
import { listTenantIds } from '../platform/jobs/tenant-scan.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

export interface MigrationOptions {
  /** A folder other than the application's own (tests of the runner). */
  migrationsFolder?: string;
}

/**
 * Validates every constraint a migration left NOT VALID, one statement at a time and outside the
 * transaction the migrator runs in. Drizzle applies all pending migrations in a single transaction,
 * so a `VALIDATE CONSTRAINT` written inside a migration would keep the ACCESS EXCLUSIVE lock of the
 * `ADD CONSTRAINT` before it until the whole run ends. Here the validation takes only a SHARE UPDATE
 * EXCLUSIVE lock, which lets reads and writes go on while the existing rows are scanned.
 * A migration that adds a constraint to a table with many rows states it NOT VALID and leaves the
 * validation to this step. It is safe to run again: it only touches what is still unvalidated.
 */
export async function validateDeferredConstraints(pool: Pool): Promise<string[]> {
  const pending = await pool.query<{ table_name: string; constraint_name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS table_name, k.conname AS constraint_name
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT k.convalidated AND n.nspname = 'public' AND k.contype IN ('c', 'f')
      ORDER BY c.relname, k.conname`,
  );
  const validated: string[] = [];
  for (const row of pending.rows) {
    await pool.query(
      `ALTER TABLE ${row.table_name} VALIDATE CONSTRAINT ${quoteIdentifier(row.constraint_name)}`,
    );
    validated.push(`${row.table_name}.${row.constraint_name}`);
  }
  return validated;
}

/** Rows one statement of the usage backfill changes at most (see `backfillUsageConfirmation`). */
const USAGE_BACKFILL_BATCH = 500;

/**
 * The data fix of migration 0398, as a step of the runner instead of a migration (judgment day
 * round 4, finding W2). 0398 lifts FORCE row level security on `message` and `whatsapp_usage_event`
 * for the length of the migrator's single transaction, which holds an ACCESS EXCLUSIVE lock on both
 * tables until the whole run ends and stops every writer (see docs/migration-ranges.md). 0398 is
 * applied in databases that exist and cannot be edited, so it stays; any later fix of the same kind
 * is written here.
 *
 * Rows of `whatsapp_usage_event` written before migration 0396 have no `confirmed_at`, and a place
 * that leaked was never released: a row of a message the provider took (sent, delivered, read) is
 * confirmed at the time it was counted, and an unconfirmed row of a message that ended without going
 * (cancelled, failed) is released. Rows of messages still queued are live reservations.
 *
 * It runs as the owner but under the tenant context of each organization in turn, so the ordinary
 * `tenant_isolation` policy applies and FORCE is never touched. It works a batch of rows per
 * transaction and skips a row another transaction holds (`FOR UPDATE SKIP LOCKED`), so it never
 * waits for a writer nor makes one wait; a skipped row is done by the next run. It is idempotent
 * (it only touches rows still unconfirmed and unreleased) and runs on every boot. The partial index
 * `whatsapp_usage_event_unsettled_idx` (migration 0498) holds exactly those rows, so a boot reads
 * the few that are left (the live reservations of queued messages among them) and not the whole table.
 *
 * It is best effort and never rejects: it is a repair of old rows, not a condition of the deploy, so
 * a failure must not stop the application from starting. A tenant that fails is reported (the
 * class and the database code of the error and the tenant id, never the message, which can carry row
 * values) and skipped; the others go on, and the next run retries it.
 */
export async function backfillUsageConfirmation(
  db: Db,
  options: { batchSize?: number; onFailure?: (failure: UsageBackfillFailure) => void } = {},
): Promise<{ confirmed: number; released: number }> {
  const batchSize = options.batchSize ?? USAGE_BACKFILL_BATCH;
  const reportFailure = options.onFailure ?? reportUsageBackfillFailure;
  const totals = { confirmed: 0, released: 0 };
  let tenantIds: string[];
  try {
    // A database migrated from a folder that has no such table (the tests of the runner) has nothing to do.
    const present = await db.execute<{ found: boolean }>(
      sql`select to_regclass('public.whatsapp_usage_event') is not null and to_regclass('public.tenant') is not null as found`,
    );
    if (present.rows[0]?.found !== true) return totals;
    tenantIds = await listTenantIds(db);
  } catch (error) {
    reportFailure({ tenantId: null, ...describeFailure(error) });
    return totals;
  }
  for (const tenantId of tenantIds) {
    try {
      await backfillTenant(db, tenantId, batchSize, totals);
    } catch (error) {
      reportFailure({ tenantId, ...describeFailure(error) });
    }
  }
  return totals;
}

/** What is reported about a tenant the backfill could not finish: no message, no row value. */
export interface UsageBackfillFailure {
  /** `null` when the failure came before any tenant (the lookup of the tenants itself). */
  tenantId: string | null;
  name: string;
  code: string;
}

/** One structured line on stderr, where the log shipper and the alerts read it. */
function reportUsageBackfillFailure(failure: UsageBackfillFailure): void {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'usage_backfill_failed', ...failure })}\n`,
  );
}

/** Works the rows of one tenant, batch after batch, adding what each batch changed to `totals`. */
async function backfillTenant(
  db: Db,
  tenantId: string,
  batchSize: number,
  totals: { confirmed: number; released: number },
): Promise<void> {
  for (const step of ['confirm', 'release'] as const) {
    for (;;) {
      const changed = await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const result =
          step === 'confirm'
            ? await tx.execute(sql`
                WITH batch AS (
                  SELECT e.id FROM whatsapp_usage_event e
                    JOIN message m ON m.tenant_id = e.tenant_id AND m.id = e.message_id
                   WHERE e.confirmed_at IS NULL AND e.released_at IS NULL
                     AND m.status IN ('sent', 'delivered', 'read')
                   ORDER BY e.id LIMIT ${batchSize}
                     FOR UPDATE OF e SKIP LOCKED)
                UPDATE whatsapp_usage_event e SET confirmed_at = e.counted_at
                  FROM batch WHERE e.id = batch.id`)
            : await tx.execute(sql`
                WITH batch AS (
                  SELECT e.id FROM whatsapp_usage_event e
                    JOIN message m ON m.tenant_id = e.tenant_id AND m.id = e.message_id
                   WHERE e.confirmed_at IS NULL AND e.released_at IS NULL
                     AND m.status IN ('cancelled', 'failed')
                   ORDER BY e.id LIMIT ${batchSize}
                     FOR UPDATE OF e SKIP LOCKED)
                UPDATE whatsapp_usage_event e SET released_at = now()
                  FROM batch WHERE e.id = batch.id`);
        return result.rowCount ?? 0;
      });
      totals[step === 'confirm' ? 'confirmed' : 'released'] += changed;
      if (changed < batchSize) break;
    }
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Applies pending migrations as the owner role, validates the constraints they left NOT VALID, runs
 * the data backfill steps that must not run inside the migrator's transaction (best effort: a tenant
 * the backfill cannot finish is reported and left to the next run, it never fails the deploy), then
 * installs or upgrades the pg-boss schema and its queues (also as the owner). Migrations are
 * forward-only.
 *
 * @param extraQueues queues to create besides the application's own (tests add theirs)
 */
export async function runMigrations(
  migrationDatabaseUrl: string,
  extraQueues: readonly QueueDefinition[] = [],
  options: MigrationOptions = {},
): Promise<void> {
  const handle = createOwnerDb(migrationDatabaseUrl);
  try {
    await migrate(handle.db, { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });
    await validateDeferredConstraints(handle.pool);
    await backfillUsageConfirmation(handle.db);
  } finally {
    await handle.close();
  }
  await installJobs(migrationDatabaseUrl, extraQueues);
}
