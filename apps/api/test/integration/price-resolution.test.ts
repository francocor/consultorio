import type { PriceQuoteResponse, TenantPayerDto } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { insertAppointmentRow } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * The price quote of an appointment (billing-payments, "Price catalog per organization", "Payer
 * and plan catalog with coverage pricing", "Price snapshot on charges"): which price applies, the
 * split between the patient and the payer, and that asking changes nothing.
 */

let runtime: DbHandle;
let world: BillingWorld;
let osdeCatalogId: string;
let osde: TenantPayerDto;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'price-resolution' });
  osdeCatalogId = await world.catalogPayer('price-resolution-osde', 'OSDE Resolución');
  osde = (
    await world.api.post('/billing/payers', world.owner, { payerId: osdeCatalogId })
  ).json<TenantPayerDto>();
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

async function quote(
  appointmentId: string,
  query: Record<string, string> = {},
  by = world.reception,
) {
  const params = new URLSearchParams({ appointmentId, ...query });
  return world.api.get(`/billing/price-quote?${params.toString()}`, by);
}

async function payerPrice(extra: Record<string, unknown> = {}) {
  const response = await world.api.post('/billing/payer-prices', world.owner, {
    tenantPayerId: osde.id,
    appointmentTypeId: world.consulta,
    payerAmountCents: 1_500_000,
    copagoCents: 300_000,
    plusCents: 0,
    effectiveFrom: '2031-01-01',
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(201);
}

describe('the quote of an appointment', () => {
  it('says there is no price, rather than an implied zero, when nothing matches', async () => {
    const appointment = await world.appointment();

    const response = await quote(appointment.id);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PriceQuoteResponse>()).toEqual({
      appointmentId: appointment.id,
      appointmentTypeName: 'Consulta',
      quote: null,
    });
  });

  it('is the private price, all of it owed by the patient, for a patient with no coverage', async () => {
    await world.setPrice(2_000_000);
    const appointment = await world.appointment();

    const body = (await quote(appointment.id)).json<PriceQuoteResponse>();

    expect(body.quote).toMatchObject({
      source: 'private',
      payer: null,
      totalCents: 2_000_000,
      patientCents: 2_000_000,
      payerCents: 0,
      lines: [{ kind: 'service', portion: 'patient', amountCents: 2_000_000 }],
      notes: [],
    });
  });

  it('uses the price of the professional for that professional and the general one for the other', async () => {
    await world.setPrice(2_500_000, { professionalId: world.doctor.professionalId });
    const mine = await world.appointment();
    const theirs = await world.appointment({ professional: world.colleague });

    const forDoctor = (await quote(mine.id)).json<PriceQuoteResponse>();
    const forColleague = (await quote(theirs.id)).json<PriceQuoteResponse>();

    expect(forDoctor.quote?.totalCents).toBe(2_500_000);
    expect(forColleague.quote?.totalCents).toBe(2_000_000);
  });

  it('does not use a price that starts after the day of the appointment', async () => {
    const appointment = await world.appointment();
    const day = appointment.startsAt.slice(0, 10);
    const later = new Date(Date.parse(`${day}T12:00:00Z`) + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await world.setPrice(9_900_000, { effectiveFrom: later, locationId: world.centro });

    const body = (await quote(appointment.id)).json<PriceQuoteResponse>();

    expect(body.quote?.totalCents).not.toBe(9_900_000);
  });
});

describe('the quote of a patient with a payer', () => {
  it('splits the copago from what the payer covers, and tracks the payer portion apart', async () => {
    await payerPrice({ planName: '210', copagoCents: 300_000, payerAmountCents: 1_500_000 });
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeCatalogId, planName: '210' });
    const appointment = await world.appointment({ patientId });

    const body = (await quote(appointment.id)).json<PriceQuoteResponse>();

    expect(body.quote).toMatchObject({
      source: 'payer',
      payer: { tenantPayerId: osde.id, name: 'OSDE Resolución', planName: '210' },
      totalCents: 1_800_000,
      patientCents: 300_000,
      payerCents: 1_500_000,
      lines: [
        { kind: 'payer_coverage', portion: 'payer', amountCents: 1_500_000 },
        { kind: 'copago', portion: 'patient', amountCents: 300_000 },
      ],
    });
  });

  it('shows the plus as its own line apart from the copago', async () => {
    await payerPrice({ planName: 'Plus', copagoCents: 300_000, plusCents: 500_000 });
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeCatalogId, planName: 'Plus' });
    const appointment = await world.appointment({ patientId });

    const body = (await quote(appointment.id)).json<PriceQuoteResponse>();

    expect(body.quote?.patientCents).toBe(800_000);
    expect(body.quote?.lines.map((line) => line.kind)).toEqual([
      'payer_coverage',
      'copago',
      'plus',
    ]);
  });

  it('falls back to the private price, and says why, when the payer has no price for the plan', async () => {
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeCatalogId, planName: 'Sin Precio' });
    const appointment = await world.appointment({ patientId });

    const body = (await quote(appointment.id)).json<PriceQuoteResponse>();

    expect(body.quote).toMatchObject({ source: 'private', notes: ['payer_without_price'] });
  });

  it('uses the price for every plan of the payer when no price names the plan', async () => {
    const other = (
      await world.api.post('/billing/payers', world.owner, {
        customName: 'Mutual Todos Los Planes',
      })
    ).json<TenantPayerDto>();
    await payerPrice({
      tenantPayerId: other.id,
      appointmentTypeId: world.consulta,
      copagoCents: 100_000,
      payerAmountCents: 900_000,
    });
    const patientId = await world.freshPatient();
    await world.cover(patientId, { customName: 'Mutual Todos Los Planes', planName: 'Cualquiera' });
    const appointment = await world.appointment({ patientId });

    const body = (await quote(appointment.id)).json<PriceQuoteResponse>();

    expect(body.quote).toMatchObject({
      source: 'payer',
      patientCents: 100_000,
      payerCents: 900_000,
    });
  });

  it('does not offer a deactivated payer for new charges, but the private price still applies', async () => {
    const closing = (
      await world.api.post('/billing/payers', world.owner, { customName: 'Prepaga Cerrada' })
    ).json<TenantPayerDto>();
    await payerPrice({ tenantPayerId: closing.id, copagoCents: 50_000, payerAmountCents: 450_000 });
    const patientId = await world.freshPatient();
    await world.cover(patientId, { customName: 'Prepaga Cerrada' });
    const appointment = await world.appointment({ patientId });
    const before = (await quote(appointment.id)).json<PriceQuoteResponse>();

    await world.api.patch(`/billing/payers/${closing.id}`, world.owner, { active: false });
    const after = (await quote(appointment.id)).json<PriceQuoteResponse>();

    expect(before.quote).toMatchObject({ source: 'payer', payerCents: 450_000 });
    expect(after.quote).toMatchObject({ source: 'private', notes: ['payer_inactive'] });
  });

  it('ignores a coverage that ended before the day of the appointment', async () => {
    const patientId = await world.freshPatient();
    await world.cover(patientId, {
      payerId: osdeCatalogId,
      planName: '210',
      validTo: '2031-05-01',
    });
    const appointment = await world.appointment({ patientId });

    const body = (await quote(appointment.id)).json<PriceQuoteResponse>();

    expect(body.quote?.source).toBe('private');
  });
});

describe('choosing the payer by hand', () => {
  it('quotes the private price for a covered patient when reception says so', async () => {
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeCatalogId, planName: '210' });
    const appointment = await world.appointment({ patientId });

    const covered = (await quote(appointment.id)).json<PriceQuoteResponse>();
    const privately = (
      await quote(appointment.id, { payer: 'private' })
    ).json<PriceQuoteResponse>();

    expect(covered.quote?.source).toBe('payer');
    expect(privately.quote).toMatchObject({ source: 'private', payerCents: 0, notes: [] });
  });

  it('quotes a payer of the list for a patient who has no coverage', async () => {
    const appointment = await world.appointment();

    const body = (
      await quote(appointment.id, { payer: osde.id, planName: '210' })
    ).json<PriceQuoteResponse>();

    expect(body.quote).toMatchObject({
      source: 'payer',
      payer: { tenantPayerId: osde.id, planName: '210' },
    });
  });

  it('answers not found for a payer that is not in the list of the organization', async () => {
    const appointment = await world.appointment();

    const response = await quote(appointment.id, { payer: '0190a000-0000-7000-8000-0000000000bb' });

    expect(response.statusCode).toBe(404);
  });
});

describe('asking is free of side effects, and only for what the viewer may see', () => {
  it('changes nothing in the database or the audit log', async () => {
    const appointment = await world.appointment();
    const count = async () =>
      asTenant(runtime, world.tenant.id, async (tx) => {
        const rows = await tx.execute<{ n: number }>(
          sql`SELECT (SELECT count(*) FROM audit_event)::int + (SELECT count(*) FROM price)::int
                + (SELECT count(*) FROM payer_plan_price)::int AS n`,
        );
        return rows.rows[0]?.n ?? -1;
      });
    const before = await count();

    await quote(appointment.id);
    await quote(appointment.id, { payer: 'private' });

    expect(await count()).toBe(before);
  });

  it("lets a professional quote their own appointment and not a colleague's", async () => {
    const mine = await world.appointment();
    const theirs = await world.appointment({ professional: world.colleague });

    const own = await quote(mine.id, {}, world.doctor);
    const other = await quote(theirs.id, {}, world.doctor);

    expect(own.statusCode, own.body).toBe(200);
    expect(other.statusCode).toBe(404);
  });

  it('answers not found for an appointment of another organization', async () => {
    const other = await createTestTenant(runtime, { slug: 'price-resolution-b' });
    const foreign = await asTenant(runtime, other.id, (tx) => insertAppointmentRow(tx, other.id));

    const response = await quote(foreign);

    expect(response.statusCode).toBe(404);
  });

  it('denies a session without payment access', async () => {
    const appointment = await world.appointment();

    const response = await world.api.get(
      `/billing/price-quote?appointmentId=${appointment.id}`,
      null,
    );

    expect(response.statusCode).toBe(401);
  });
});
