import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { backfillUsageConfirmation, type UsageBackfillFailure } from '../../src/db/migrate.js';
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

interface World {
  tenantId: string;
  patientId: string;
  professionalId: string;
}

let runtime: DbHandle;
let owner: DbHandle;
let tenantId: string;
let patientId: string;
let professionalId: string;
let seeded = 0;

const mainWorld = (): World => ({ tenantId, patientId, professionalId });

/** A second organization, with the same building blocks as the main one. */
async function createWorld(slug: string): Promise<World> {
  const id = (await createTestTenant(runtime, { slug })).id;
  return asTenant(runtime, id, async (tx) => ({
    tenantId: id,
    patientId: await insertPatient(tx, id),
    professionalId: await insertProfessional(tx, id),
  }));
}

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
async function seed(world: World = mainWorld()): Promise<Record<Name, string>> {
  seeded += 1;
  const ids = {} as Record<Name, string>;
  await asTenant(runtime, world.tenantId, async (tx) => {
    for (const status of ['sent', 'delivered', 'queued', 'cancelled', 'failed'] as const) {
      const result = await tx.execute<{ id: string }>(
        sql`INSERT INTO message (tenant_id, patient_id, kind, channel, status, cancel_reason, failure_reason,
                                 dedupe_key, send_at)
              VALUES (${world.tenantId}, ${world.patientId}, 'reminder', 'whatsapp', ${status},
                      ${status === 'cancelled' ? 'quota_exhausted' : null},
                      ${status === 'failed' ? 'not_on_whatsapp' : null},
                      ${`runner:${String(seeded)}:${status}`}, now())
              RETURNING id`,
      );
      const id = result.rows[0]?.id ?? '';
      ids[status] = id;
      await tx.execute(
        sql`INSERT INTO whatsapp_usage_event (tenant_id, message_id, professional_id, period, counted_at)
              VALUES (${world.tenantId}, ${id}, ${world.professionalId}, '2031-05', '2031-05-06T12:00:00Z')`,
      );
    }
  });
  return ids;
}

const usageOf = (messageId: string, inTenant: string = tenantId) =>
  asTenant(runtime, inTenant, async (tx) => {
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

    // Safe to run on every boot: the second run finds nothing left to do. The exact {0, 0} relies on
    // `fileParallelism: false` (vitest.integration.config.ts): the step works on every organization of
    // the shared database, so a file running at the same time could leave rows for this run to change.
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

describe('the usage backfill step is best effort (JD-S3 follow-up)', () => {
  /** A real SQL error (22012) on every update of the usage rows of one organization. */
  async function breakUpdatesOf(badTenantId: string): Promise<() => Promise<void>> {
    await owner.pool.query(
      `CREATE FUNCTION public.test_usage_backfill_boom() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN PERFORM 1 / 0; RETURN NEW; END $$`,
    );
    await owner.pool.query(
      `CREATE TRIGGER test_usage_backfill_boom BEFORE UPDATE ON whatsapp_usage_event
         FOR EACH ROW WHEN (NEW.tenant_id = '${badTenantId}') EXECUTE FUNCTION public.test_usage_backfill_boom()`,
    );
    return async () => {
      await owner.pool.query('DROP TRIGGER test_usage_backfill_boom ON whatsapp_usage_event');
      await owner.pool.query('DROP FUNCTION public.test_usage_backfill_boom()');
    };
  }

  it('skips a tenant that fails, reports it without its message, finishes the others and does not reject', async () => {
    // Tenant ids are time ordered: the one that fails is listed first, so the others come after it.
    const bad = await createWorld('usage-runner-bad');
    const good = await createWorld('usage-runner-good');
    const badIds = await seed(bad);
    const goodIds = await seed(good);
    const failures: UsageBackfillFailure[] = [];
    const restore = await breakUpdatesOf(bad.tenantId);
    try {
      const totals = await backfillUsageConfirmation(owner.db, {
        onFailure: (failure) => failures.push(failure),
      });

      expect(totals.confirmed).toBeGreaterThanOrEqual(2);
      expect(failures.map(({ tenantId: id, code }) => ({ tenantId: id, code }))).toEqual([
        { tenantId: bad.tenantId, code: '22012' },
      ]);
      expect(JSON.stringify(failures)).not.toContain('division by zero');
      // The failing tenant keeps its rows untouched (its batch rolled back)...
      expect(await usageOf(badIds.sent, bad.tenantId)).toMatchObject({ confirmed_at: null });
      // ...and the other one was done.
      expect((await usageOf(goodIds.sent, good.tenantId))?.confirmed_at).not.toBeNull();
      expect((await usageOf(goodIds.failed, good.tenantId))?.released_at).not.toBeNull();
    } finally {
      await restore();
    }

    // A skipped tenant is retried by the next run (the next boot).
    expect((await backfillUsageConfirmation(owner.db)).confirmed).toBeGreaterThanOrEqual(2);
    expect((await usageOf(badIds.sent, bad.tenantId))?.confirmed_at).not.toBeNull();
  });

  it('logs a failure as a structured line with the tenant id, the class and the code, and never the message', async () => {
    const bad = await createWorld('usage-runner-log');
    await seed(bad);
    const restore = await breakUpdatesOf(bad.tenantId);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await backfillUsageConfirmation(owner.db);
      const lines = write.mock.calls.map(([chunk]) => String(chunk));
      const line = lines.find((entry) => entry.includes('usage_backfill_failed'));

      expect(line).toBeDefined();
      expect(JSON.parse(line ?? '')).toMatchObject({
        level: 'error',
        msg: 'usage_backfill_failed',
        tenantId: bad.tenantId,
        code: '22012',
      });
      expect(line).not.toContain('division by zero');
    } finally {
      write.mockRestore();
      await restore();
    }
    await backfillUsageConfirmation(owner.db);
  });

  it('does not reject even when it cannot look the tenants up', async () => {
    const failures: UsageBackfillFailure[] = [];
    const broken = {
      execute: () => Promise.reject(new Error('connection lost')),
    } as unknown as typeof owner.db;

    await expect(
      backfillUsageConfirmation(broken, { onFailure: (failure) => failures.push(failure) }),
    ).resolves.toEqual({ confirmed: 0, released: 0 });
    expect(failures).toEqual([{ tenantId: null, name: 'Error', code: 'unknown' }]);
  });

  it('has a partial index of the rows that are neither confirmed nor released', async () => {
    const result = await owner.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'whatsapp_usage_event_unsettled_idx'`,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.indexdef).toMatch(/\(tenant_id, id\)/);
    expect(result.rows[0]?.indexdef).toMatch(/confirmed_at IS NULL\) AND \(released_at IS NULL/);
  });
});
