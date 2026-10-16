import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, createSealerDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, TEST_USER, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let sealer: DbHandle;
let owner: pg.Client;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  sealer = createSealerDb(inject('sealerUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  a = await createTestTenant(runtime, { slug: 'audit-a' });
  b = await createTestTenant(runtime, { slug: 'audit-b' });
});

afterAll(async () => {
  await runtime.close();
  await sealer.close();
  await owner.end();
});

/** Inserts one audit row as the tenant and returns its id. */
async function insertEvent(tenantId: string, action = 'access.denied'): Promise<string> {
  const result = await asTenant(runtime, tenantId, (tx) =>
    tx.execute<{ id: string }>(
      sql`INSERT INTO audit_event (tenant_id, action, outcome, actor_user_id)
            VALUES (${tenantId}, ${action}, 'deny', ${TEST_USER}) RETURNING id`,
    ),
  );
  return result.rows[0]?.id ?? '';
}

async function partitions(): Promise<string[]> {
  const result = await owner.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'audit_event'
      ORDER BY 1`,
  );
  return result.rows.map((row) => row.name);
}

function monthName(offset: number): string {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `audit_event_${String(month.getUTCFullYear())}_${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
}

describe('audit_event partitions', () => {
  it('has the current month and the next ones after migration', async () => {
    const names = await partitions();

    expect(names).toEqual(
      expect.arrayContaining([monthName(0), monthName(1), monthName(2), monthName(3)]),
    );
  });

  it('is partitioned by month on occurred_at', async () => {
    const result = await owner.query<{ strategy: string; key: string }>(
      `SELECT pt.partstrat::text AS strategy, a.attname AS key
         FROM pg_partitioned_table pt
         JOIN pg_class c ON c.oid = pt.partrelid
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = pt.partattrs[0]
        WHERE c.relname = 'audit_event'`,
    );

    expect(result.rows).toEqual([{ strategy: 'r', key: 'occurred_at' }]);
  });

  it('creates missing partitions on demand and is idempotent', async () => {
    const first = await runtime.db.execute<{ created: number }>(
      sql`SELECT app.ensure_audit_partitions(6) AS created`,
    );
    const second = await runtime.db.execute<{ created: number }>(
      sql`SELECT app.ensure_audit_partitions(6) AS created`,
    );

    expect(first.rows[0]?.created).toBeGreaterThanOrEqual(1);
    expect(second.rows[0]?.created).toBe(0);
    expect(await partitions()).toContain(monthName(6));
  });

  it('can create partitions from a past month, so historical events have a home', async () => {
    await runtime.db.execute(sql`SELECT app.ensure_audit_partitions(1, DATE '2025-01-15')`);

    expect(await partitions()).toEqual(
      expect.arrayContaining(['audit_event_2025_01', 'audit_event_2025_02']),
    );
  });

  it('refuses an absurd range', async () => {
    await expect(
      runtime.db.execute(sql`SELECT app.ensure_audit_partitions(500)`),
    ).rejects.toThrow();
  });

  it('routes a row to the partition of its month', async () => {
    const id = await insertEvent(a.id);

    const result = await asTenant(runtime, a.id, (tx) =>
      tx.execute<{ partition: string }>(
        sql`SELECT tableoid::regclass::text AS partition FROM audit_event WHERE id = ${id}`,
      ),
    );

    expect(result.rows[0]?.partition).toBe(monthName(0));
  });
});

describe('grants: app_rw may only INSERT and SELECT', () => {
  it.each([
    ['INSERT', true],
    ['SELECT', true],
    ['UPDATE', false],
    ['DELETE', false],
    ['TRUNCATE', false],
  ])('app_rw %s on audit_event is %s', async (privilege, expected) => {
    const result = await owner.query<{ allowed: boolean }>(
      `SELECT has_table_privilege('app_rw', 'audit_event', $1) AS allowed`,
      [privilege],
    );

    expect(result.rows[0]?.allowed).toBe(expected);
  });

  it('refuses UPDATE and DELETE statements with permission denied', async () => {
    await insertEvent(a.id);

    for (const statement of [
      sql`UPDATE audit_event SET action = 'auth.logout'`,
      sql`DELETE FROM audit_event`,
    ]) {
      await expect(asTenant(runtime, a.id, (tx) => tx.execute(statement))).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    }
  });

  it('gives app_rw no access to the monthly partitions themselves', async () => {
    await expect(
      asTenant(runtime, a.id, (tx) => tx.execute(sql.raw(`SELECT * FROM ${monthName(0)}`))),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(runtime, a.id, (tx) => tx.execute(sql.raw(`DELETE FROM ${monthName(0)}`))),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('isolates tenants: tenant B sees none of tenant A events', async () => {
    const id = await insertEvent(a.id, 'patient.read');

    const seenByB = await asTenant(runtime, b.id, (tx) =>
      tx.execute(sql`SELECT 1 FROM audit_event WHERE id = ${id}`),
    );
    const seenByA = await asTenant(runtime, a.id, (tx) =>
      tx.execute(sql`SELECT 1 FROM audit_event WHERE id = ${id}`),
    );

    expect(seenByB.rows).toHaveLength(0);
    expect(seenByA.rows).toHaveLength(1);
  });

  it('refuses an outcome other than allow or deny', async () => {
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.execute(
          sql`INSERT INTO audit_event (tenant_id, action, outcome) VALUES (${a.id}, 'access.denied', 'maybe')`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('append-only triggers', () => {
  it('rejects UPDATE and DELETE by the owner role under a tenant context', async () => {
    const id = await insertEvent(a.id);
    const client = new pg.Client({ connectionString: inject('ownerUrl') });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.id]);
      await expect(
        client.query(`UPDATE audit_event SET reason = 'edited' WHERE id = $1`, [id]),
      ).rejects.toThrow(/audit_event is append-only/);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.id]);
      await expect(client.query(`DELETE FROM audit_event WHERE id = $1`, [id])).rejects.toThrow(
        /audit_event is append-only/,
      );
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  const GENESIS = '0'.repeat(64);
  it('lets the audit_sealer role fill seq, prev_hash and hash once', async () => {
    const id = await insertEvent(a.id, 'auth.login.success');

    await asTenant(sealer, a.id, async (tx) => {
      const result = await tx.execute(
        sql`UPDATE audit_event
               SET seq = 1, prev_hash = ${GENESIS}, hash = ${'a'.repeat(64)}
             WHERE id = ${id}`,
      );
      expect(result.rowCount).toBe(1);
    });

    const [row] = (
      await asTenant(runtime, a.id, (tx) =>
        tx.execute<{ seq: string; hash: string }>(
          sql`SELECT seq, hash FROM audit_event WHERE id = ${id}`,
        ),
      )
    ).rows;
    expect(row).toEqual({ seq: '1', hash: 'a'.repeat(64) });
  });

  it('refuses a second fill of an already sealed row', async () => {
    const id = await insertEvent(a.id, 'auth.logout');
    await asTenant(sealer, a.id, async (tx) => {
      await tx.execute(
        sql`UPDATE audit_event SET seq = 2, prev_hash = ${GENESIS}, hash = ${'b'.repeat(64)} WHERE id = ${id}`,
      );
    });

    await expect(
      asTenant(sealer, a.id, async (tx) => {
        await tx.execute(
          sql`UPDATE audit_event SET seq = 3, prev_hash = ${GENESIS}, hash = ${'c'.repeat(64)} WHERE id = ${id}`,
        );
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/already sealed/) as unknown },
    });
  });

  it('refuses a seal that changes any other column', async () => {
    const id = await insertEvent(a.id, 'auth.login.failed');

    await expect(
      asTenant(sealer, a.id, async (tx) => {
        await tx.execute(
          sql`UPDATE audit_event SET seq = 9, prev_hash = ${GENESIS}, hash = ${'d'.repeat(64)}, outcome = 'allow' WHERE id = ${id}`,
        );
      }),
    ).rejects.toThrow();
  });

  it('refuses a partial seal (all three columns or none)', async () => {
    const id = await insertEvent(a.id, 'auth.login.locked');

    await expect(
      asTenant(sealer, a.id, async (tx) => {
        await tx.execute(sql`UPDATE audit_event SET seq = 10 WHERE id = ${id}`);
      }),
    ).rejects.toThrow();
  });

  it('gives the sealer no DELETE and no INSERT', async () => {
    await insertEvent(a.id);

    await expect(
      asTenant(sealer, a.id, async (tx) => {
        await tx.execute(sql`DELETE FROM audit_event`);
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(sealer, a.id, async (tx) => {
        await tx.execute(
          sql`INSERT INTO audit_event (tenant_id, action, outcome) VALUES (${a.id}, 'access.denied', 'deny')`,
        );
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('does not let app_rw fill the seal columns without switching role', async () => {
    const id = await insertEvent(a.id, 'auth.session.revoked');

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.execute(sql`UPDATE audit_event SET seq = 11 WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
