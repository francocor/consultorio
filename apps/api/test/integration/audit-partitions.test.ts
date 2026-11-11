import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  AUDIT_PARTITIONS_JOB,
  PARTITIONS_AHEAD_MONTHS,
  ensureAuditPartitions,
} from '../../src/platform/audit/partitions.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createMetrics } from '../../src/platform/metrics.js';

let runtime: DbHandle;
let owner: pg.Client;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await runtime.close();
});

async function partitionNames(): Promise<string[]> {
  const result = await owner.query<{ relname: string }>(
    `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'public.audit_event'::regclass order by c.relname`,
  );
  return result.rows.map((row) => row.relname);
}

function monthName(date: Date, plus = 0): string {
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + plus, 1));
  return `audit_event_${String(shifted.getUTCFullYear())}_${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

describe('audit partitions', () => {
  it('has the current month and the next three after the migrations', async () => {
    const names = await partitionNames();
    const now = new Date();

    for (let ahead = 0; ahead <= PARTITIONS_AHEAD_MONTHS; ahead += 1) {
      expect(names).toContain(monthName(now, ahead));
    }
  });

  it('creates what is missing ahead of a given month, and nothing the second time', async () => {
    const from = new Date('2031-05-10T12:00:00Z');

    const first = await ensureAuditPartitions(runtime.db, { from });
    const second = await ensureAuditPartitions(runtime.db, { from });

    expect(first.created).toBe(PARTITIONS_AHEAD_MONTHS + 1);
    expect(second.created).toBe(0);
    const names = await partitionNames();
    for (const month of ['2031_05', '2031_06', '2031_07', '2031_08']) {
      expect(names).toContain(`audit_event_${month}`);
    }
  });

  it('reports how many months are ready beyond the current one, and keeps the metrics', async () => {
    const metrics = createMetrics();

    const result = await ensureAuditPartitions(runtime.db, { metrics });

    expect(result.ahead).toBeGreaterThanOrEqual(PARTITIONS_AHEAD_MONTHS);
    expect(metrics.get('audit_partitions_ahead')).toBe(result.ahead);
    expect(metrics.render()).toContain('audit_partitions_ahead');
  });

  it('is named like the other scheduled audit tasks', () => {
    expect(AUDIT_PARTITIONS_JOB).toBe('audit.partitions');
  });
});
