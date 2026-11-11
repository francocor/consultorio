import type { ChargeDto, ExportRequestDto, Problem } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, submissionKey, type BillingWorld } from '../support/billing-world.js';
import { createRecordingJobClient } from '../support/jobs.js';
import { asTenant } from '../support/tenants.js';

/**
 * Billing in an organization that is read-only for non-payment (billing-payments, "Read-only tenant
 * behavior"; tenancy, the allowlist): nothing that creates or changes money goes through, a message
 * explains the account state, and what was already there can still be read and exported.
 */

let runtime: DbHandle;
let world: BillingWorld;
let chargeId: string;
let paymentId: string;
let sessionId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, {
    slug: 'billing-read-only',
    app: { storage: createMemoryObjectStorage(), jobs: createRecordingJobClient() },
  });
  await world.setPrice(1_000_000);
  sessionId = (await world.openRegister()).id;
  const charge = await world.charge();
  chargeId = charge.id;
  const paid = await world.pay(charge.id, { method: 'cash', amountCents: 400_000 });
  paymentId = paid.json<{ payment: { id: string } }>().payment.id;
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

async function setStatus(status: 'active' | 'read_only') {
  await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .update(tenantTable)
      .set(
        status === 'read_only'
          ? { status, readOnlySince: new Date() }
          : { status, readOnlySince: null },
      )
      .where(eq(tenantTable.id, world.tenant.id)),
  );
}

describe('every route of billing declares what it is in a read-only organization', () => {
  it('reads are reads, requests for an export are exports, and everything else is a write', () => {
    const routes = [...world.app.routeCategories.entries()].filter(([key]) =>
      (key.split(' ')[1] ?? '').startsWith('/billing'),
    );

    expect(routes.length).toBeGreaterThan(20);
    for (const [key, category] of routes) {
      const [method, path] = key.split(' ');
      const expected =
        method === 'GET' || method === 'HEAD'
          ? 'read'
          : path === '/billing/exports' || path === '/billing/exports/:id/download'
            ? 'export'
            : 'write';
      expect(category, key).toBe(expected);
    }
  });
});

describe('with the organization read-only', () => {
  it('refuses every write with 402 and the message of the account state', async () => {
    await setStatus('read_only');
    try {
      const api = world.api;
      const key = () => submissionKey();
      const writes = await Promise.all([
        api.post('/billing/charges', world.reception, {
          appointmentId: '0190a000-0000-7000-8000-0000000000aa',
        }),
        api.post(`/billing/charges/${chargeId}/lines`, world.reception, {
          description: 'x',
          amountCents: 100,
        }),
        api.post(`/billing/charges/${chargeId}/void`, world.owner, { reason: 'Cargado por error' }),
        world.pay(chargeId, { method: 'debit', amountCents: 100_000 }),
        api.post(`/billing/payments/${paymentId}/refund`, world.owner, {
          amountCents: 100,
          reason: 'Devolución',
          idempotencyKey: key(),
        }),
        api.post(`/billing/payments/${paymentId}/correct`, world.owner, {
          amountCents: 100,
          reason: 'Corrección',
          idempotencyKey: key(),
        }),
        api.post('/billing/cash/sessions', world.admin, {
          locationId: world.norte,
          openingCents: 0,
        }),
        api.post(`/billing/cash/sessions/${sessionId}/close`, world.reception, { countedCents: 0 }),
        api.post('/billing/prices', world.owner, {
          appointmentTypeId: world.consulta,
          amountCents: 1,
          effectiveFrom: '2031-09-01',
        }),
        api.post('/billing/payers', world.owner, { customName: 'Prepaga Nueva' }),
        api.post('/billing/payer-prices', world.owner, {
          tenantPayerId: '0190a000-0000-7000-8000-0000000000aa',
          appointmentTypeId: world.consulta,
          payerAmountCents: 1,
          copagoCents: 0,
          plusCents: 0,
          effectiveFrom: '2031-09-01',
        }),
      ]);

      expect(writes.map((response) => response.statusCode)).toEqual(
        Array<number>(writes.length).fill(402),
      );
      for (const response of writes) expect(response.json<Problem>().code).toBe('tenant_read_only');
    } finally {
      await setStatus('active');
    }
    // Nothing moved while it was refused.
    const after = (
      await world.api.get(`/billing/charges/${chargeId}`, world.owner)
    ).json<ChargeDto>();
    expect(after).toMatchObject({ paidCents: 400_000, status: 'partially_paid' });
    expect(after.payments).toHaveLength(1);
  });

  it('still reads charges, payments, registers and prices, and exports last month', async () => {
    await setStatus('read_only');
    try {
      const reads = await Promise.all([
        world.api.get('/billing/charges', world.reception),
        world.api.get(`/billing/charges/${chargeId}`, world.reception),
        world.api.get('/billing/prices', world.reception),
        world.api.get('/billing/payers', world.reception),
        world.api.get('/billing/receivables', world.owner),
        world.api.get(`/billing/cash/current?locationId=${world.centro}`, world.reception),
        world.api.get(`/billing/cash/sessions/${sessionId}`, world.reception),
      ]);
      const exported = await world.api.post('/billing/exports', world.owner, {
        kind: 'payments',
        format: 'csv',
        from: '2031-04-01',
        to: '2031-04-30',
      });

      expect(reads.map((response) => response.statusCode)).toEqual(
        Array<number>(reads.length).fill(200),
      );
      expect(exported.statusCode, exported.body).toBe(202);
      expect(exported.json<ExportRequestDto>().status).toBe('queued');
    } finally {
      await setStatus('active');
    }
  });
});
