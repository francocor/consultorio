import type {
  PayerListResponse,
  PayerPriceDto,
  PriceDto,
  PriceListResponse,
  Problem,
  TenantPayerDto,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let world: BillingWorld;
let osdeId: string;
let swissId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'billing-pricing-api' });
  osdeId = await world.catalogPayer('billing-api-osde', 'OSDE Prueba');
  swissId = await world.catalogPayer('billing-api-swiss', 'Swiss Medical Prueba', 'prepaga');
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

async function audits(action: 'billing.price.changed' | 'access.denied') {
  return asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('the payers of the organization', () => {
  it('lists what can be copied from the catalog of the country, and nothing copied yet', async () => {
    const response = await world.api.get('/billing/payers', world.reception);

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<PayerListResponse>();
    expect(body.payers).toEqual([]);
    expect(body.available.map((payer) => payer.payerId)).toEqual(
      expect.arrayContaining([osdeId, swissId]),
    );
    expect(body.available.find((payer) => payer.payerId === swissId)).toMatchObject({
      name: 'Swiss Medical Prueba',
      kind: 'prepaga',
    });
  });

  it('copies a payer of the catalog, audits it, and no longer offers it', async () => {
    const created = await world.api.post('/billing/payers', world.owner, { payerId: osdeId });

    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<TenantPayerDto>()).toMatchObject({
      payerId: osdeId,
      name: 'OSDE Prueba',
      kind: 'obra_social',
      active: true,
      deactivatedAt: null,
    });
    const list = (
      await world.api.get('/billing/payers', world.reception)
    ).json<PayerListResponse>();
    expect(list.payers.map((payer) => payer.payerId)).toContain(osdeId);
    expect(list.available.map((payer) => payer.payerId)).not.toContain(osdeId);
    const [row] = await audits('billing.price.changed');
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: world.owner.user.id,
      resourceType: 'payer',
      resourceId: created.json<TenantPayerDto>().id,
      metadata: { entity: 'payer', change: 'created' },
    });
  });

  it('adds a payer of its own, and refuses the same payer or name twice', async () => {
    const custom = await world.api.post('/billing/payers', world.admin, {
      customName: 'Mutual del Barrio',
    });
    const again = await world.api.post('/billing/payers', world.admin, {
      customName: 'MUTUAL DEL BARRIO',
    });
    const twice = await world.api.post('/billing/payers', world.owner, { payerId: osdeId });

    expect(custom.statusCode, custom.body).toBe(201);
    expect(custom.json<TenantPayerDto>()).toMatchObject({ payerId: null, kind: 'custom' });
    expect(again.statusCode).toBe(409);
    expect(again.json<Problem>().code).toBe('billing_payer_exists');
    expect(twice.statusCode).toBe(409);
    expect(twice.json<Problem>().code).toBe('billing_payer_exists');
  });

  it('answers not found for a catalog payer that does not exist', async () => {
    const response = await world.api.post('/billing/payers', world.owner, {
      payerId: '0190a000-0000-7000-8000-00000000dead',
    });

    expect(response.statusCode).toBe(404);
  });

  it('deactivates and reactivates a payer, audited, keeping the row', async () => {
    const created = (
      await world.api.post('/billing/payers', world.owner, { customName: 'Prepaga Que Cierra' })
    ).json<TenantPayerDto>();

    const off = await world.api.patch(`/billing/payers/${created.id}`, world.owner, {
      active: false,
    });
    const listed = (
      await world.api.get('/billing/payers', world.reception)
    ).json<PayerListResponse>();
    const on = await world.api.patch(`/billing/payers/${created.id}`, world.owner, {
      active: true,
    });

    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<TenantPayerDto>()).toMatchObject({ active: false });
    expect(off.json<TenantPayerDto>().deactivatedAt).not.toBeNull();
    // A deactivated payer still lists, with its flag, so old charges render and it can come back.
    expect(listed.payers.find((payer) => payer.id === created.id)).toMatchObject({ active: false });
    expect(on.json<TenantPayerDto>()).toMatchObject({ active: true, deactivatedAt: null });
    const changes = (await audits('billing.price.changed')).map((row) => row.metadata);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'payer', change: 'deactivated' }),
        expect.objectContaining({ entity: 'payer', change: 'activated' }),
      ]),
    );
  });

  it('denies reception the changes, with a deny entry in the audit log, and lets it read', async () => {
    const before = (await audits('access.denied')).length;

    const create = await world.api.post('/billing/payers', world.reception, {
      customName: 'No Debería',
    });
    const patch = await world.api.patch(
      '/billing/payers/0190a000-0000-7000-8000-0000000000aa',
      world.reception,
      { active: false },
    );

    expect(create.statusCode).toBe(403);
    expect(patch.statusCode).toBe(403);
    expect((await audits('access.denied')).length).toBe(before + 2);
    expect((await world.api.get('/billing/payers', world.doctor)).statusCode).toBe(200);
  });

  it('answers not found for the payer of another organization', async () => {
    const other = await createTestTenant(runtime, { slug: 'billing-pricing-api-b' });
    const foreign = await asTenant(runtime, other.id, async (tx) => {
      const result = await tx.execute<{ id: string }>(
        sql`INSERT INTO tenant_payer (tenant_id, custom_name) VALUES (${other.id}, 'Ajena') RETURNING id`,
      );
      return result.rows[0]?.id ?? '';
    });

    const response = await world.api.patch(`/billing/payers/${foreign}`, world.owner, {
      active: false,
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('the private price list', () => {
  it('creates a price for a type, from a day, and lists it with names', async () => {
    const created = await world.api.post('/billing/prices', world.owner, {
      appointmentTypeId: world.consulta,
      amountCents: 2_000_050,
      effectiveFrom: '2031-03-01',
    });

    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<PriceDto>()).toMatchObject({
      appointmentTypeId: world.consulta,
      appointmentTypeName: 'Consulta',
      professionalId: null,
      specialty: null,
      locationId: null,
      amountCents: 2_000_050,
      effectiveFrom: '2031-03-01',
      active: true,
    });
    const listed = (
      await world.api.get('/billing/prices', world.reception)
    ).json<PriceListResponse>();
    expect(listed.prices.map((price) => price.id)).toContain(created.json<PriceDto>().id);
    const [row] = await audits('billing.price.changed');
    expect(row).toMatchObject({
      resourceType: 'price',
      metadata: { entity: 'price', change: 'created', amountCents: 2_000_050 },
    });
  });

  it('narrows a price to a professional, a specialty and a location, with their names', async () => {
    const created = await world.api.post('/billing/prices', world.admin, {
      appointmentTypeId: world.consulta,
      professionalId: world.doctor.professionalId,
      locationId: world.centro,
      specialty: 'pediatría',
      amountCents: 2_500_000,
      effectiveFrom: '2031-03-01',
    });

    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<PriceDto>()).toMatchObject({
      professionalId: world.doctor.professionalId,
      locationId: world.centro,
      locationName: 'Centro',
      specialty: 'pediatría',
    });
    expect(created.json<PriceDto>().professionalName).not.toBeNull();
  });

  it('refuses a second active price for the same type, scope and day, and an inactive one does not count', async () => {
    const body = {
      appointmentTypeId: world.withBuffer,
      amountCents: 1_000_000,
      effectiveFrom: '2031-04-01',
    };
    const first = await world.api.post('/billing/prices', world.owner, body);
    const second = await world.api.post('/billing/prices', world.owner, {
      ...body,
      amountCents: 1_200_000,
    });
    const otherDay = await world.api.post('/billing/prices', world.owner, {
      ...body,
      effectiveFrom: '2031-05-01',
    });
    await world.api.patch(`/billing/prices/${first.json<PriceDto>().id}`, world.owner, {
      active: false,
    });
    const afterSwitchOff = await world.api.post('/billing/prices', world.owner, {
      ...body,
      amountCents: 1_200_000,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json<Problem>().code).toBe('billing_price_duplicate');
    expect(otherDay.statusCode).toBe(201);
    expect(afterSwitchOff.statusCode, afterSwitchOff.body).toBe(201);
  });

  it('corrects the amount and switches a price off, audited with the figures', async () => {
    const created = (
      await world.api.post('/billing/prices', world.owner, {
        appointmentTypeId: world.consulta,
        locationId: world.centro,
        amountCents: 1_500_000,
        effectiveFrom: '2031-02-01',
      })
    ).json<PriceDto>();

    const fixed = await world.api.patch(`/billing/prices/${created.id}`, world.owner, {
      amountCents: 1_600_000,
    });
    const off = await world.api.patch(`/billing/prices/${created.id}`, world.owner, {
      active: false,
    });

    expect(fixed.json<PriceDto>()).toMatchObject({ amountCents: 1_600_000, active: true });
    expect(off.json<PriceDto>()).toMatchObject({ amountCents: 1_600_000, active: false });
    const rows = (await audits('billing.price.changed')).filter(
      (row) => row.resourceId === created.id,
    );
    expect(rows.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          change: 'updated',
          previousAmountCents: 1_500_000,
          amountCents: 1_600_000,
        }),
        expect.objectContaining({ change: 'deactivated' }),
      ]),
    );
  });

  it('rejects a negative, zero or fractional amount and unknown fields', async () => {
    for (const amountCents of [-1, 0, 12.5]) {
      const response = await world.api.post('/billing/prices', world.owner, {
        appointmentTypeId: world.consulta,
        amountCents,
        effectiveFrom: '2031-08-01',
      });
      expect(response.statusCode, String(amountCents)).toBe(400);
    }
    const extra = await world.api.post('/billing/prices', world.owner, {
      appointmentTypeId: world.consulta,
      amountCents: 1,
      effectiveFrom: '2031-08-01',
      tenantId: world.tenant.id,
    });
    expect(extra.statusCode).toBe(400);
  });

  it("answers not found for a type, a professional or a location that is not the organization's", async () => {
    const strange = '0190a000-0000-7000-8000-0000000000bb';
    const bodies = [
      { appointmentTypeId: strange },
      { appointmentTypeId: world.consulta, professionalId: strange },
      { appointmentTypeId: world.consulta, locationId: strange },
    ];

    for (const body of bodies) {
      const response = await world.api.post('/billing/prices', world.owner, {
        amountCents: 1_000_000,
        effectiveFrom: '2031-09-01',
        ...body,
      });
      expect(response.statusCode, JSON.stringify(body)).toBe(404);
    }
  });

  it('denies reception and the professional the price changes, and audits the denial', async () => {
    const before = (await audits('access.denied')).length;
    const body = { appointmentTypeId: world.consulta, amountCents: 5, effectiveFrom: '2031-10-01' };

    const byReception = await world.api.post('/billing/prices', world.reception, body);
    const byDoctor = await world.api.post('/billing/prices', world.doctor, body);
    const patch = await world.api.patch(
      '/billing/prices/0190a000-0000-7000-8000-0000000000aa',
      world.reception,
      { active: false },
    );

    expect([byReception.statusCode, byDoctor.statusCode, patch.statusCode]).toEqual([
      403, 403, 403,
    ]);
    expect((await audits('access.denied')).length).toBe(before + 3);
  });
});

describe('the payer plan prices', () => {
  let payerId: string;

  beforeAll(async () => {
    payerId = (
      await world.api.post('/billing/payers', world.owner, { customName: 'Plan Payer Prices' })
    ).json<TenantPayerDto>().id;
  });

  it('creates what the payer covers, the copago and the plus for a plan and a type', async () => {
    const created = await world.api.post('/billing/payer-prices', world.owner, {
      tenantPayerId: payerId,
      appointmentTypeId: world.consulta,
      planName: '210',
      payerAmountCents: 1_500_000,
      copagoCents: 300_000,
      plusCents: 500_000,
      effectiveFrom: '2031-01-01',
    });

    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<PayerPriceDto>()).toMatchObject({
      tenantPayerId: payerId,
      payerName: 'Plan Payer Prices',
      planName: '210',
      appointmentTypeName: 'Consulta',
      payerAmountCents: 1_500_000,
      copagoCents: 300_000,
      plusCents: 500_000,
      active: true,
    });
    const listed = (
      await world.api.get('/billing/prices', world.reception)
    ).json<PriceListResponse>();
    expect(listed.payerPrices.map((price) => price.id)).toContain(created.json<PayerPriceDto>().id);
  });

  it('refuses the same plan, type and day twice, but takes another plan or the whole payer', async () => {
    const body = {
      tenantPayerId: payerId,
      appointmentTypeId: world.withBuffer,
      planName: '310',
      payerAmountCents: 1_000_000,
      copagoCents: 100_000,
      plusCents: 0,
      effectiveFrom: '2031-01-01',
    };
    const first = await world.api.post('/billing/payer-prices', world.owner, body);
    const second = await world.api.post('/billing/payer-prices', world.owner, body);
    const otherPlan = await world.api.post('/billing/payer-prices', world.owner, {
      ...body,
      planName: '410',
    });
    const wholePayer = await world.api.post('/billing/payer-prices', world.owner, {
      ...body,
      planName: undefined,
    });

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json<Problem>().code).toBe('billing_price_duplicate');
    expect(otherPlan.statusCode).toBe(201);
    expect(wholePayer.statusCode, wholePayer.body).toBe(201);
  });

  it('refuses a price that adds up to nothing, a negative part, and an unknown payer', async () => {
    const body = {
      tenantPayerId: payerId,
      appointmentTypeId: world.consulta,
      payerAmountCents: 0,
      copagoCents: 0,
      plusCents: 0,
      effectiveFrom: '2031-06-01',
    };

    expect((await world.api.post('/billing/payer-prices', world.owner, body)).statusCode).toBe(400);
    expect(
      (await world.api.post('/billing/payer-prices', world.owner, { ...body, copagoCents: -5 }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await world.api.post('/billing/payer-prices', world.owner, {
          ...body,
          copagoCents: 5,
          tenantPayerId: '0190a000-0000-7000-8000-0000000000bb',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('corrects the parts of a payer price and switches it off, never below nothing', async () => {
    const created = (
      await world.api.post('/billing/payer-prices', world.owner, {
        tenantPayerId: payerId,
        appointmentTypeId: world.consulta,
        planName: 'Plan Corregible',
        payerAmountCents: 1_000_000,
        copagoCents: 200_000,
        plusCents: 0,
        effectiveFrom: '2031-01-01',
      })
    ).json<PayerPriceDto>();

    const fixed = await world.api.patch(`/billing/payer-prices/${created.id}`, world.owner, {
      copagoCents: 250_000,
    });
    const nothing = await world.api.patch(`/billing/payer-prices/${created.id}`, world.owner, {
      payerAmountCents: 0,
      copagoCents: 0,
    });
    const off = await world.api.patch(`/billing/payer-prices/${created.id}`, world.owner, {
      active: false,
    });

    expect(fixed.json<PayerPriceDto>()).toMatchObject({
      copagoCents: 250_000,
      payerAmountCents: 1_000_000,
    });
    expect(nothing.statusCode).toBe(400);
    expect(off.json<PayerPriceDto>()).toMatchObject({ active: false });
  });

  it('denies reception the changes', async () => {
    const response = await world.api.post('/billing/payer-prices', world.reception, {
      tenantPayerId: payerId,
      appointmentTypeId: world.consulta,
      copagoCents: 1,
      payerAmountCents: 0,
      plusCents: 0,
      effectiveFrom: '2031-07-01',
    });

    expect(response.statusCode).toBe(403);
  });
});
