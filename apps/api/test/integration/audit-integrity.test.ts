import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { sealTenant } from '../../src/platform/audit/sealer.js';
import { createOperatorDb, createRuntimeDb, createSealerDb } from '../../src/platform/db/pool.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, TEST_USER, type TestTenant } from '../support/tenants.js';

/**
 * Security review finding 5: the integrity of the audit trail is enforced by the database, not by
 * the code that happens to write to it.
 * - No role but the sealer can write a sealed row: a pre-filled `seq`, `prev_hash` or `hash` is
 *   refused on INSERT (a forged sequence number near the end of the range would break the sealer).
 * - The runtime and operator roles cannot become the sealer: the sealer is its own login, used by
 *   the worker only.
 */
const GENESIS = '0'.repeat(64);

let runtime: DbHandle;
let operator: DbHandle;
let sealer: DbHandle;
let owner: pg.Client;
let admin: pg.Client;
let tenant: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  operator = createOperatorDb(inject('operatorUrl'));
  sealer = createSealerDb(inject('sealerUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await Promise.all([owner.connect(), admin.connect()]);
  tenant = await createTestTenant(runtime, { slug: 'audit-integrity' });
});

afterAll(async () => {
  await Promise.all([runtime.close(), operator.close(), sealer.close(), owner.end(), admin.end()]);
});

const plainInsert = (tenantId: string) =>
  sql`INSERT INTO audit_event (tenant_id, action, outcome, actor_user_id)
        VALUES (${tenantId}, 'access.denied', 'deny', ${TEST_USER})`;

const sealedInsert = (tenantId: string, seq: string) =>
  sql`INSERT INTO audit_event (tenant_id, action, outcome, actor_user_id, seq, prev_hash, hash)
        VALUES (${tenantId}, 'access.denied', 'deny', ${TEST_USER}, ${seq}::bigint,
                ${GENESIS}, ${'f'.repeat(64)})`;

describe('a sealed row can only come from the sealer', () => {
  it('lets the runtime role append an unsealed event, as before', async () => {
    const result = await asTenant(runtime, tenant.id, (tx) => tx.execute(plainInsert(tenant.id)));

    expect(result.rowCount).toBe(1);
  });

  it('refuses an INSERT from the runtime role that pre-fills the seal columns', async () => {
    await expect(
      asTenant(runtime, tenant.id, (tx) => tx.execute(sealedInsert(tenant.id, '1'))),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/seal columns/) as unknown },
    });
  });

  it('refuses a forged sequence number near the end of the range, which would stop the sealer', async () => {
    await expect(
      asTenant(runtime, tenant.id, (tx) =>
        tx.execute(sealedInsert(tenant.id, '9223372036854775806')),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/seal columns/) as unknown },
    });

    // The real sealer is not affected: the pending events are sealed from 1.
    const sealed = await asTenant(sealer, tenant.id, (tx) => sealTenant(tx, { graceMs: 0 }));
    expect(sealed.sealed).toBeGreaterThan(0);
    expect(sealed.lastSeq).toBe(sealed.sealed);
  });

  it('refuses a partial pre-fill as well, whichever column it sets', async () => {
    for (const column of ['seq', 'prev_hash', 'hash']) {
      const value = column === 'seq' ? sql`5::bigint` : sql`${'e'.repeat(64)}`;
      await expect(
        asTenant(runtime, tenant.id, (tx) =>
          tx.execute(
            sql`INSERT INTO audit_event (tenant_id, action, outcome, ${sql.identifier(column)})
                  VALUES (${tenant.id}, 'access.denied', 'deny', ${value})`,
          ),
        ),
      ).rejects.toThrow();
    }
  });

  it('refuses the same INSERT from the migration owner: only the sealer writes a seal', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);
      await expect(
        owner.query(
          `INSERT INTO audit_event (tenant_id, action, outcome, seq, prev_hash, hash)
           VALUES ($1, 'access.denied', 'deny', 7, $2, $3)`,
          [tenant.id, GENESIS, 'd'.repeat(64)],
        ),
      ).rejects.toThrow(/seal columns/);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('refuses a pre-filled platform event from the operator role', async () => {
    await expect(
      operator.db.execute(
        sql`INSERT INTO platform_audit_event (action, outcome, seq, prev_hash, hash)
              VALUES ('operator.login.failed', 'deny', 1, ${GENESIS}, ${'c'.repeat(64)})`,
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/seal columns/) as unknown },
    });
  });

  it('still lets the operator role append an unsealed platform event', async () => {
    const result = await operator.db.execute(
      sql`INSERT INTO platform_audit_event (action, outcome)
            VALUES ('operator.login.failed', 'deny')`,
    );

    expect(result.rowCount).toBe(1);
  });
});

describe('the sealer is a login of its own', () => {
  it('is not a role the runtime or the operator login can switch to', async () => {
    const membership = await admin.query<{ rw: boolean; op: boolean }>(
      `SELECT pg_has_role('app_rw', 'audit_sealer', 'MEMBER') AS rw,
              pg_has_role('app_operator', 'audit_sealer', 'MEMBER') AS op`,
    );
    expect(membership.rows[0]).toEqual({ rw: false, op: false });

    await expect(
      asTenant(runtime, tenant.id, (tx) => tx.execute(sql`SET LOCAL ROLE audit_sealer`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(operator.db.execute(sql`SET ROLE audit_sealer`)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('seals the events of a tenant when it connects as itself', async () => {
    await asTenant(runtime, tenant.id, (tx) => tx.execute(plainInsert(tenant.id)));

    const sealed = await asTenant(sealer, tenant.id, (tx) => sealTenant(tx, { graceMs: 0 }));

    expect(sealed.sealed).toBeGreaterThan(0);
  });

  it('cannot insert or delete events, only fill the seal of existing ones', async () => {
    await expect(
      asTenant(sealer, tenant.id, (tx) => tx.execute(plainInsert(tenant.id))),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(sealer, tenant.id, (tx) => tx.execute(sql`DELETE FROM audit_event`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('cannot reach the data of the application: no patient, no staff, no sessions', async () => {
    for (const table of ['patient', 'membership', 'session', 'user_account', 'anamnesis']) {
      await expect(
        asTenant(sealer, tenant.id, (tx) =>
          tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} LIMIT 1`),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });

  it('is not the runtime login: the runtime role still cannot read the platform trail', async () => {
    await expect(
      asTenant(runtime, tenant.id, (tx) => tx.execute(sql`SELECT 1 FROM platform_audit_event`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
