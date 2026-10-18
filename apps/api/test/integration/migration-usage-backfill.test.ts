import { readFileSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { insertPatient, insertProfessional } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * Judgment day round 2, findings A12 and R2-C2. Rows of `whatsapp_usage_event` written before
 * migration 0396 have no `confirmed_at`, and reservations that leaked were never released. The
 * migration 0398 confirms the first and releases the second. The rows are built the way the old
 * code left them and the statements of the migration are run over them.
 */

const FILE = new URL('../../src/db/migrations/0398_usage_confirmed_backfill.sql', import.meta.url);

let runtime: DbHandle;
let owner: pg.Client;
let tenantId: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  tenantId = (await createTestTenant(runtime, { slug: 'usage-backfill' })).id;
  await asTenant(runtime, tenantId, async (tx) => {
    const patientId = await insertPatient(tx, tenantId);
    const professionalId = await insertProfessional(tx, tenantId);
    for (const [name, status] of [
      ['sent', 'sent'],
      ['delivered', 'delivered'],
      ['queued', 'queued'],
      ['cancelled', 'cancelled'],
      ['failed', 'failed'],
    ] as const) {
      const result = await tx.execute<{ id: string }>(
        sql`INSERT INTO message (tenant_id, patient_id, kind, channel, status, cancel_reason, failure_reason,
                                 dedupe_key, send_at)
              VALUES (${tenantId}, ${patientId}, 'reminder', 'whatsapp', ${status},
                      ${status === 'cancelled' ? 'quota_exhausted' : null},
                      ${status === 'failed' ? 'not_on_whatsapp' : null},
                      ${`backfill:${name}`}, now())
              RETURNING id`,
      );
      const id = result.rows[0]?.id ?? '';
      ids[name] = id;
      await tx.execute(
        sql`INSERT INTO whatsapp_usage_event (tenant_id, message_id, professional_id, period, counted_at)
              VALUES (${tenantId}, ${id}, ${professionalId}, '2031-05', '2031-05-06T12:00:00Z')`,
      );
    }
  });
});

afterAll(async () => {
  await owner.end();
  await runtime.close();
});

const statements = () =>
  readFileSync(FILE, 'utf8')
    .split('--> statement-breakpoint')
    .map((part) =>
      part
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((part) => part !== '');

describe('migration 0398', () => {
  it('confirms the places of messages the provider took, releases the leaked ones and leaves live reservations', async () => {
    await owner.query('BEGIN');
    try {
      for (const statement of statements()) await owner.query(statement);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }

    const rows = await asTenant(
      runtime,
      tenantId,
      async (tx) =>
        (
          await tx.execute<{
            message_id: string;
            confirmed_at: string | null;
            released_at: string | null;
          }>(sql`SELECT message_id, confirmed_at, released_at FROM whatsapp_usage_event`)
        ).rows,
    );
    const of = (name: string) => rows.find((row) => row.message_id === ids[name]);
    const iso = (value: string | null | undefined) =>
      value ? new Date(value).toISOString() : value;

    expect(iso(of('sent')?.confirmed_at)).toBe('2031-05-06T12:00:00.000Z');
    expect(iso(of('delivered')?.confirmed_at)).toBe('2031-05-06T12:00:00.000Z');
    expect(of('queued')).toMatchObject({ confirmed_at: null, released_at: null });
    expect(of('cancelled')?.released_at).not.toBeNull();
    expect(of('cancelled')?.confirmed_at).toBeNull();
    expect(of('failed')?.released_at).not.toBeNull();
  });
});
