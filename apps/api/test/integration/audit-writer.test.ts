import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { location } from '../../src/db/schema/tenant.js';
import { createAuditDeny } from '../../src/platform/audit/deny.js';
import { audit, type AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, TEST_USER, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

const ACTOR: AuditActor = {
  userId: TEST_USER,
  actingRole: 'admin',
  ip: '203.0.113.9',
  userAgent: 'vitest',
  requestId: '0190a000-0000-7000-8000-0000000000c2',
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'writer-a' });
  b = await createTestTenant(runtime, { slug: 'writer-b' });
});

afterAll(async () => {
  await runtime.close();
});

async function auditRows(tenantId: string, requestId: string) {
  return asTenant(runtime, tenantId, (tx) =>
    tx.select().from(auditEvent).where(eq(auditEvent.requestId, requestId)),
  );
}

async function locationNamed(tenantId: string, name: string) {
  return asTenant(runtime, tenantId, (tx) =>
    tx.select({ id: location.id }).from(location).where(eq(location.name, name)),
  );
}

describe('audit() inside the business transaction', () => {
  it('commits the business write and its audit row together, stamped with the context tenant', async () => {
    const requestId = 'writer-commit';

    await asTenant(runtime, a.id, async (tx) => {
      await tx.insert(location).values({ tenantId: a.id, name: 'Audited', timeZone: 'UTC' });
      await audit(tx, {
        action: 'tenant.created',
        outcome: 'allow',
        actor: { ...ACTOR, requestId },
        resourceType: 'location',
        metadata: { changedFields: ['name'] },
      });
    });

    const rows = await auditRows(a.id, requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: a.id,
      action: 'tenant.created',
      outcome: 'allow',
      actorUserId: TEST_USER,
      actingRole: 'admin',
      ip: '203.0.113.9',
      userAgent: 'vitest',
      resourceType: 'location',
      metadata: { changedFields: ['name'] },
      seq: null,
      hash: null,
    });
    expect(await locationNamed(a.id, 'Audited')).toHaveLength(1);
    expect(await auditRows(b.id, requestId)).toHaveLength(0);
  });

  it('aborts the business write when the audit insert fails (fail closed)', async () => {
    await expect(
      asTenant(runtime, a.id, async (tx) => {
        await tx.insert(location).values({ tenantId: a.id, name: 'MustNotExist', timeZone: 'UTC' });
        await audit(tx, {
          action: 'tenant.created',
          outcome: 'allow',
          // Not an address: the database refuses it, so the audit row cannot be written.
          actor: { ...ACTOR, ip: 'not-an-ip', requestId: 'writer-fail' },
        });
      }),
    ).rejects.toBeDefined();

    expect(await locationNamed(a.id, 'MustNotExist')).toHaveLength(0);
    expect(await auditRows(a.id, 'writer-fail')).toHaveLength(0);
  });

  it('aborts the business write when the audit event itself is invalid', async () => {
    await expect(
      asTenant(runtime, a.id, async (tx) => {
        await tx.insert(location).values({ tenantId: a.id, name: 'AlsoAbsent', timeZone: 'UTC' });
        await audit(tx, {
          action: 'clinical.note.updated',
          outcome: 'allow',
          actor: ACTOR,
          metadata: { content: 'free text from a note' },
        });
      }),
    ).rejects.toBeDefined();

    expect(await locationNamed(a.id, 'AlsoAbsent')).toHaveLength(0);
  });

  it('removes the audit row too when the business transaction rolls back afterwards', async () => {
    await expect(
      asTenant(runtime, a.id, async (tx) => {
        await audit(tx, {
          action: 'patient.updated',
          outcome: 'allow',
          actor: { ...ACTOR, requestId: 'writer-rollback' },
        });
        throw new Error('business rule failed after the audit write');
      }),
    ).rejects.toThrow('business rule');

    expect(await auditRows(a.id, 'writer-rollback')).toHaveLength(0);
  });

  it('cannot write an event for another tenant: the tenant is the transaction context', async () => {
    await asTenant(runtime, b.id, (tx) =>
      audit(tx, {
        action: 'patient.read',
        outcome: 'allow',
        actor: { ...ACTOR, requestId: 'writer-ctx' },
      }),
    );

    expect(await auditRows(b.id, 'writer-ctx')).toHaveLength(1);
    expect(await auditRows(a.id, 'writer-ctx')).toHaveLength(0);
  });
});

describe('auditDeny() on its own connection', () => {
  it('keeps the denial although the business transaction rolled back', async () => {
    const alerts: unknown[] = [];
    const auditDeny = createAuditDeny({ db: runtime.db, alert: (alert) => alerts.push(alert) });

    await expect(
      asTenant(runtime, a.id, async (tx) => {
        await tx.insert(location).values({ tenantId: a.id, name: 'DeniedWrite', timeZone: 'UTC' });
        const outcome = await auditDeny(a.id, {
          action: 'access.denied',
          actor: { ...ACTOR, requestId: 'deny-survives' },
          resourceType: 'clinical_note',
          reason: 'admin_has_no_clinical_access',
        });
        expect(outcome).toEqual({ recorded: true });
        throw new Error('request denied, transaction rolled back');
      }),
    ).rejects.toThrow('request denied');

    const rows = await auditRows(a.id, 'deny-survives');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'deny',
      action: 'access.denied',
      reason: 'admin_has_no_clinical_access',
    });
    expect(await locationNamed(a.id, 'DeniedWrite')).toHaveLength(0);
    expect(alerts).toEqual([]);
  });

  it('records the denial of an anonymous caller (no user)', async () => {
    const auditDeny = createAuditDeny({ db: runtime.db, alert: () => undefined });

    const outcome = await auditDeny(a.id, {
      action: 'cross_tenant.denied',
      actor: {
        userId: null,
        actingRole: null,
        ip: '198.51.100.4',
        userAgent: null,
        requestId: 'deny-anon',
      },
    });

    expect(outcome).toEqual({ recorded: true });
    expect(await auditRows(a.id, 'deny-anon')).toHaveLength(1);
  });

  it('still returns, and raises an alert, when the denial cannot be recorded', async () => {
    const broken = createRuntimeDb(inject('runtimeUrl'));
    await broken.close();
    const alerts: { kind: string; tenantId: string; action: string }[] = [];
    const auditDeny = createAuditDeny({
      db: broken.db,
      alert: (alert) => alerts.push(alert),
    });

    const outcome = await auditDeny(a.id, {
      action: 'access.denied',
      actor: { ...ACTOR, requestId: 'deny-unrecorded' },
    });

    expect(outcome).toEqual({ recorded: false });
    expect(alerts).toEqual([
      {
        kind: 'audit_deny_failed',
        tenantId: a.id,
        action: 'access.denied',
        errorCode: expect.any(String) as unknown,
      },
    ]);
    expect(await auditRows(a.id, 'deny-unrecorded')).toHaveLength(0);
  });

  it('never throws even if the alert hook itself fails', async () => {
    const broken = createRuntimeDb(inject('runtimeUrl'));
    await broken.close();
    const auditDeny = createAuditDeny({
      db: broken.db,
      alert: () => {
        throw new Error('pager down');
      },
    });

    await expect(auditDeny(a.id, { action: 'access.denied', actor: ACTOR })).resolves.toEqual({
      recorded: false,
    });
  });

  it('sets the context of the target tenant, so the row lands in the right partition set', async () => {
    const auditDeny = createAuditDeny({ db: runtime.db, alert: () => undefined });
    await auditDeny(b.id, { action: 'access.denied', actor: { ...ACTOR, requestId: 'deny-b' } });

    const count = await asTenant(runtime, b.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_event WHERE request_id = 'deny-b'`,
      ),
    );
    expect(count.rows[0]?.n).toBe(1);
    expect(await auditRows(a.id, 'deny-b')).toHaveLength(0);
  });
});
