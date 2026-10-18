import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { backfillUsageConfirmation } from '../../src/db/migrate.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { insertPatient, insertProfessional } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * Judgment day round 4, finding W2. Migration 0398 lifted FORCE row level security on `message` and
 * `whatsapp_usage_event` inside the migrator's single transaction, which holds an ACCESS EXCLUSIVE
 * lock on both until the whole run ends. The same backfill now also runs after the migrator, as an
 * idempotent batched step of `runMigrations`, under the tenant context of each organization and
 * without ever touching FORCE. These tests run the step over rows built the way the old code left
 * them, run it twice, and run it while a writer holds a row.
 */

let runtime: DbHandle;
let owner: DbHandle;
let tenantId: string;
let patientId: string;
let professionalId: string;
let seeded = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = createOwnerDb(inject('ownerUrl'));
  tenantId = (await createTestTenant(runtime, { slug: 'usage-runner' })).id;
  await asTenant(runtime, tenantId, async (tx) => {
    patientId = await insertPatient(tx, tenantId);
    professionalId = await insertProfessional(tx, tenantId);
  });
});

afterAll(async () => {
  await owner.close();
  await runtime.close();
});

type Name = 'sent' | 'delivered' | 'queued' | 'cancelled' | 'failed';

/** One message per status, each with the usage row the code before migration 0396 left. */
async function seed(): Promise<Record<Name, string>> {
  seeded += 1;
  const ids = {} as Record<Name, string>;
  await asTenant(runtime, tenantId, async (tx) => {
    for (const status of ['sent', 'delivered', 'queued', 'cancelled', 'failed'] as const) {
      const result = await tx.execute<{ id: string }>(
        sql`INSERT INTO message (tenant_id, patient_id, kind, channel, status, cancel_reason, failure_reason,
                                 dedupe_key, send_at)
              VALUES (${tenantId}, ${patientId}, 'reminder', 'whatsapp', ${status},
                      ${status === 'cancelled' ? 'quota_exhausted' : null},
                      ${status === 'failed' ? 'not_on_whatsapp' : null},
                      ${`runner:${String(seeded)}:${status}`}, now())
              RETURNING id`,
      );
      const id = result.rows[0]?.id ?? '';
      ids[status] = id;
      await tx.execute(
        sql`INSERT INTO whatsapp_usage_event (tenant_id, message_id, professional_id, period, counted_at)
              VALUES (${tenantId}, ${id}, ${professionalId}, '2031-05', '2031-05-06T12:00:00Z')`,
      );
    }
  });
  return ids;
}

const usageOf = (messageId: string) =>
  asTenant(runtime, tenantId, async (tx) => {
    const result = await tx.execute<{ confirmed_at: string | null; released_at: string | null }>(
      sql`SELECT confirmed_at, released_at FROM whatsapp_usage_event WHERE message_id = ${messageId}`,
    );
    return result.rows[0];
  });

const iso = (value: string | null | undefined) => (value ? new Date(value).toISOString() : value);

describe('the usage backfill step of the migration runner', () => {
  it('confirms what the provider took, releases what leaked, leaves live reservations, and is idempotent', async () => {
    const ids = await seed();

    const first = await backfillUsageConfirmation(owner.db);

    expect(first.confirmed).toBeGreaterThanOrEqual(2);
    expect(first.released).toBeGreaterThanOrEqual(2);
    expect(iso((await usageOf(ids.sent))?.confirmed_at)).toBe('2031-05-06T12:00:00.000Z');
    expect(iso((await usageOf(ids.delivered))?.confirmed_at)).toBe('2031-05-06T12:00:00.000Z');
    expect(await usageOf(ids.queued)).toMatchObject({ confirmed_at: null, released_at: null });
    expect((await usageOf(ids.cancelled))?.released_at).not.toBeNull();
    expect((await usageOf(ids.cancelled))?.confirmed_at).toBeNull();
    expect((await usageOf(ids.failed))?.released_at).not.toBeNull();

    // Safe to run on every boot: the second run finds nothing left to do.
    expect(await backfillUsageConfirmation(owner.db)).toEqual({ confirmed: 0, released: 0 });
    expect(iso((await usageOf(ids.sent))?.confirmed_at)).toBe('2031-05-06T12:00:00.000Z');
  });

  it('works through more rows than one batch', async () => {
    const ids = await seed();
    await seed();

    await backfillUsageConfirmation(owner.db, { batchSize: 1 });

    expect((await usageOf(ids.sent))?.confirmed_at).not.toBeNull();
    expect((await usageOf(ids.failed))?.released_at).not.toBeNull();
    expect(await backfillUsageConfirmation(owner.db)).toEqual({ confirmed: 0, released: 0 });
  });

  it('never lifts FORCE row level security and does not wait for a writer that holds a row', async () => {
    const ids = await seed();
    const writer = new pg.Client({ connectionString: inject('runtimeUrl') });
    await writer.connect();
    try {
      // The writer holds the row lock of a usage row the step would confirm, and a table lock
      // (ROW EXCLUSIVE) on the table: an ALTER TABLE ... NO FORCE would wait for it for ever.
      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await writer.query(
        `UPDATE whatsapp_usage_event SET updated_at = now() WHERE message_id = $1`,
        [ids.sent],
      );

      const outcome = await Promise.race([
        backfillUsageConfirmation(owner.db).then(() => 'finished' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => {
            resolve('blocked');
          }, 8_000),
        ),
      ]);

      expect(outcome).toBe('finished');
      // The row the writer holds was skipped; every other one was done.
      expect((await usageOf(ids.sent))?.confirmed_at).toBeNull();
      expect((await usageOf(ids.delivered))?.confirmed_at).not.toBeNull();
      expect((await usageOf(ids.failed))?.released_at).not.toBeNull();
      await writer.query('COMMIT');
    } finally {
      await writer.end();
    }

    // The next run (the next boot) picks up the row that was skipped.
    expect((await backfillUsageConfirmation(owner.db)).confirmed).toBeGreaterThanOrEqual(1);
    expect((await usageOf(ids.sent))?.confirmed_at).not.toBeNull();

    const forced = await owner.pool.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE relname IN ('message', 'whatsapp_usage_event') AND relnamespace = 'public'::regnamespace`,
    );
    expect(forced.rows.map((row) => row.relforcerowsecurity)).toEqual([true, true]);
  }, 30_000);
});
