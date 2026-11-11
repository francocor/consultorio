import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { patientCoverage, payerPlan } from '../../src/db/schema/coverage.js';
import { dataProcessingConsent, patientRightsRequest } from '../../src/db/schema/privacy.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createTestPatient } from '../support/patients.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;
let catalogPayerId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'coverage-schema-a' });
  b = await createTestTenant(runtime, { slug: 'coverage-schema-b' });
  // The platform catalog is data the operator maintains: written on the owner connection.
  const owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  const inserted = await owner.query<{ id: string }>(
    "insert into payer (country, code, name, kind) values ('AR', 'coverage-schema', 'Obra de prueba', 'obra_social') on conflict (country, code) do update set name = excluded.name returning id",
  );
  await owner.end();
  catalogPayerId = inserted.rows[0]?.id ?? '';
});

afterAll(async () => {
  await runtime.close();
});

async function plan(
  values: Partial<typeof payerPlan.$inferInsert> = {},
  tenant = a,
): Promise<string> {
  const [row] = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .insert(payerPlan)
      .values({ tenantId: tenant.id, customName: `Obra ${randomUUID().slice(0, 8)}`, ...values })
      .returning({ id: payerPlan.id }),
  );
  return row?.id ?? '';
}

async function coverage(
  patientId: string,
  payerPlanId: string,
  values: Partial<typeof patientCoverage.$inferInsert> = {},
  tenant = a,
) {
  return asTenant(runtime, tenant.id, (tx) =>
    tx
      .insert(patientCoverage)
      .values({ tenantId: tenant.id, patientId, payerPlanId, memberNumber: '1', ...values })
      .returning({ id: patientCoverage.id }),
  );
}

describe('payer_plan', () => {
  it('takes its payer from the platform catalog or is a custom entry, never both or neither', async () => {
    expect(catalogPayerId).not.toBe('');
    await plan({ payerId: catalogPayerId, customName: null, planName: 'Plan 210' });
    await plan({ customName: 'Mutual del barrio' });

    await expect(plan({ payerId: catalogPayerId, customName: 'Ambos' })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await expect(plan({ customName: null })).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('enables a payer and plan once, and a custom name once whatever its case', async () => {
    await plan({ payerId: catalogPayerId, customName: null, planName: 'Plan único' });
    await plan({ customName: 'Mutual Única', planName: 'Base' });

    await expect(
      plan({ payerId: catalogPayerId, customName: null, planName: 'Plan único' }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(
      plan({ customName: 'MUTUAL ÚNICA'.toLowerCase().replace('ú', 'ú'), planName: 'Base' }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('keeps custom entries to the organization that made them', async () => {
    await plan({ customName: 'Compartida', planName: null }, a);

    await plan({ customName: 'Compartida', planName: null }, b);
  });

  it('cannot be deleted by the runtime role', async () => {
    const id = await plan();

    await expect(
      asTenant(runtime, a.id, (tx) => tx.delete(payerPlan).where(eq(payerPlan.id, id))),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('patient_coverage', () => {
  it('allows one primary coverage per patient at a time', async () => {
    const patientId = await createTestPatient(runtime, a.id);
    const first = await plan();
    const second = await plan();
    const [primary] = await coverage(patientId, first, { isPrimary: true });
    await coverage(patientId, second, { isPrimary: false });

    await expect(coverage(patientId, second, { isPrimary: true })).rejects.toMatchObject({
      cause: { code: '23505' },
    });

    // Ending the primary frees the place.
    await asTenant(runtime, a.id, (tx) =>
      tx
        .update(patientCoverage)
        .set({ endedAt: new Date(), endReason: 'replaced' })
        .where(eq(patientCoverage.id, primary?.id ?? '')),
    );
    await coverage(patientId, second, { isPrimary: true });
  });

  it('keeps primaries of different patients apart', async () => {
    const one = await createTestPatient(runtime, a.id);
    const two = await createTestPatient(runtime, a.id);
    const shared = await plan();

    await coverage(one, shared, { isPrimary: true });
    await coverage(two, shared, { isPrimary: true });
  });

  it('refuses an end date before the start date', async () => {
    const patientId = await createTestPatient(runtime, a.id);

    await expect(
      coverage(patientId, await plan(), { validFrom: '2026-06-01', validTo: '2026-05-31' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await coverage(patientId, await plan(), { validFrom: '2026-06-01', validTo: '2026-06-01' });
    await coverage(patientId, await plan(), { validFrom: null, validTo: '2026-06-01' });
  });

  it('records why a coverage ended, or neither the date nor the reason', async () => {
    const patientId = await createTestPatient(runtime, a.id);

    await expect(coverage(patientId, await plan(), { endedAt: new Date() })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await expect(
      coverage(patientId, await plan(), { endedAt: new Date(), endReason: 'lost' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await coverage(patientId, await plan(), { endedAt: new Date(), endReason: 'removed' });
  });

  it("cannot use another organization's plan or patient", async () => {
    const patientId = await createTestPatient(runtime, a.id);
    const foreignPlan = await plan({}, b);

    await expect(coverage(patientId, foreignPlan)).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  });
});

describe('data_processing_consent', () => {
  const consent = (
    patientId: string,
    values: Partial<typeof dataProcessingConsent.$inferInsert> = {},
  ) =>
    asTenant(runtime, a.id, (tx) =>
      tx.insert(dataProcessingConsent).values({
        tenantId: a.id,
        patientId,
        textKey: 'consent.data_processing.ar',
        textVersion: '1',
        recordedBy: randomUUID(),
        ...values,
      }),
    );

  it('has one live consent per patient, and a new one after a revocation', async () => {
    const patientId = await createTestPatient(runtime, a.id);
    await consent(patientId);

    await expect(consent(patientId)).rejects.toMatchObject({ cause: { code: '23505' } });

    await asTenant(runtime, a.id, (tx) =>
      tx
        .update(dataProcessingConsent)
        .set({ revokedAt: new Date(), revokedBy: randomUUID() })
        .where(eq(dataProcessingConsent.patientId, patientId)),
    );
    await consent(patientId);
  });

  it('records who revoked together with when', async () => {
    const patientId = await createTestPatient(runtime, a.id);

    await expect(consent(patientId, { revokedAt: new Date() })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
  });
});

describe('patient_rights_request', () => {
  const request = (
    patientId: string,
    values: Partial<typeof patientRightsRequest.$inferInsert> = {},
  ) =>
    asTenant(runtime, a.id, (tx) =>
      tx.insert(patientRightsRequest).values({
        tenantId: a.id,
        patientId,
        kind: 'access',
        requestedBy: randomUUID(),
        ...values,
      }),
    );

  it('knows two kinds and two statuses', async () => {
    const patientId = await createTestPatient(runtime, a.id);

    await request(patientId, { kind: 'rectification' });
    await expect(request(patientId, { kind: 'deletion' })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await expect(request(patientId, { status: 'closed' })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
  });

  it('is fulfilled by someone at some time, or not at all', async () => {
    const patientId = await createTestPatient(runtime, a.id);

    await expect(request(patientId, { status: 'fulfilled' })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await request(patientId, {
      status: 'fulfilled',
      fulfilledAt: new Date(),
      fulfilledBy: randomUUID(),
    });
  });
});
