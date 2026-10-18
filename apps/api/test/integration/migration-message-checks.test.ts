import { readFileSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { insertPatient } from '../support/scheduling.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * Judgment day finding C14. Migrations 0390 and 0391 added their CHECK constraints on `message`
 * already validated, while 0322 had used NOT VALID for the same table (a table with row level
 * security forced and many rows). Migration 0393 states them again as NOT VALID and validates them
 * in separate statements. What it does NOT do (round 2, finding R2-C1) is keep writers going: Drizzle
 * runs all pending migrations in one transaction, so the lock of the `ADD CONSTRAINT` stays until the
 * end of the run. A migration that wants a constraint added without stopping writers leaves it NOT
 * VALID and `runMigrations` validates it afterwards (`migrate-validation.test.ts` proves that with the
 * real runner). This file only proves 0393 ends with the three constraints validated on a table that
 * already has rows.
 */

const FILE = new URL('../../src/db/migrations/0393_message_checks_not_valid.sql', import.meta.url);
const CHECKS = [
  'message_kind_check',
  'message_whatsapp_kind_check',
  'message_cancel_reason_check',
] as const;

let runtime: DbHandle;
let owner: pg.Client;
let tenantId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  tenantId = (await createTestTenant(runtime, { slug: 'message-checks' })).id;
  await asTenant(runtime, tenantId, async (tx) => {
    const patientId = await insertPatient(tx, tenantId);
    for (let index = 0; index < 50; index += 1) {
      await tx.execute(
        sql`INSERT INTO message (tenant_id, patient_id, kind, channel, status, cancel_reason, dedupe_key, send_at)
              VALUES (${tenantId}, ${patientId}, 'reminder', 'email',
                      ${index % 2 === 0 ? 'queued' : 'cancelled'},
                      ${index % 2 === 0 ? null : 'offer_expired'},
                      ${`checks:${String(index)}`}, now())`,
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

const state = async () =>
  (
    await owner.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'public.message'::regclass AND conname = ANY($1) ORDER BY conname`,
      [[...CHECKS]],
    )
  ).rows;

describe('the CHECK constraints of message (migration 0393)', () => {
  it('states every constraint as NOT VALID and validates it in a statement of its own', () => {
    const all = statements();
    const added = all.filter((statement) => /ADD CONSTRAINT/i.test(statement));
    const validated = all.filter((statement) => /VALIDATE CONSTRAINT/i.test(statement));

    expect(added).toHaveLength(CHECKS.length);
    for (const statement of added) expect(statement).toMatch(/NOT VALID\s*;?$/i);
    expect(validated).toHaveLength(CHECKS.length);
    for (const name of CHECKS) {
      expect(validated.some((statement) => statement.includes(`"${name}"`))).toBe(true);
    }
  });

  it('runs on a table that already has rows, and leaves every constraint validated', async () => {
    const before = (await owner.query<{ n: string }>('SELECT count(*) AS n FROM message')).rows[0];
    expect(Number(before?.n)).toBeGreaterThanOrEqual(50);

    await owner.query('BEGIN');
    try {
      for (const statement of statements()) await owner.query(statement);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }

    expect(await state()).toEqual(
      CHECKS.map((conname) => ({ conname, convalidated: true })).sort((left, right) =>
        left.conname.localeCompare(right.conname),
      ),
    );
    const after = (await owner.query<{ n: string }>('SELECT count(*) AS n FROM message')).rows[0];
    expect(after?.n).toBe(before?.n);
  });

  it('still refuses what the constraints refuse', async () => {
    const attempt = asTenant(runtime, tenantId, async (tx) => {
      const [patient] = (await tx.execute<{ id: string }>(sql`SELECT id FROM patient LIMIT 1`))
        .rows;
      await tx.execute(
        sql`INSERT INTO message (tenant_id, patient_id, kind, channel, status, dedupe_key, send_at)
              VALUES (${tenantId}, ${patient?.id}, 'not_a_kind', 'email', 'queued', 'checks:bad', now())`,
      );
    });

    await expect(attempt).rejects.toMatchObject({ cause: { constraint: 'message_kind_check' } });
  });
});
