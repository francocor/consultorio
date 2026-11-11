import type {
  ChargeDto,
  ChargeExistsExtension,
  ChargeListResponse,
  Problem,
  TenantPayerDto,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { insertAppointmentRow } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * Capturing a charge for an appointment (billing-payments, "Charge capture per appointment",
 * "Price lookup finds no matching price", "Price snapshot on charges"): from check-in on, once per
 * appointment, with the price the quote showed.
 */

let runtime: DbHandle;
let world: BillingWorld;
let osdeCatalogId: string;
let osde: TenantPayerDto;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'capture-charge' });
  osdeCatalogId = await world.catalogPayer('capture-charge-osde', 'OSDE Cobros');
  osde = (
    await world.api.post('/billing/payers', world.owner, { payerId: osdeCatalogId })
  ).json<TenantPayerDto>();
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const capture = (body: Record<string, unknown>, by = world.reception) =>
  world.api.post('/billing/charges', by, body);

async function audits(action: 'charge.captured' | 'billing.price.override') {
  return asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

async function ensureGeneralPrice(amountCents = 2_000_000) {
  const listed = await world.api.get('/billing/prices', world.owner);
  const has = listed
    .json<{
      prices: {
        appointmentTypeId: string;
        locationId: string | null;
        professionalId: string | null;
        active: boolean;
      }[];
    }>()
    .prices.some(
      (price) =>
        price.appointmentTypeId === world.consulta &&
        price.locationId === null &&
        price.professionalId === null &&
        price.active,
    );
  if (!has) await world.setPrice(amountCents);
}

describe('capturing a charge from check-in on', () => {
  it('creates a pending charge at check-in, with its line, who captured it and when', async () => {
    await ensureGeneralPrice(2_000_000);
    const appointment = await world.appointment({ stage: 'checked_in' });

    const response = await capture({ appointmentId: appointment.id });

    expect(response.statusCode, response.body).toBe(201);
    const charge = response.json<ChargeDto>();
    expect(charge).toMatchObject({
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      professionalId: appointment.professionalId,
      locationId: appointment.locationId,
      status: 'pending',
      explicitAmount: false,
      needsReview: false,
      tenantPayerId: null,
      totalCents: 2_000_000,
      patientCents: 2_000_000,
      payerCents: 0,
      paidCents: 0,
      outstandingCents: 2_000_000,
      invoicing: 'not_invoiced',
      capturedBy: world.reception.user.id,
      lines: [
        {
          position: 1,
          kind: 'service',
          portion: 'patient',
          description: 'Consulta',
          amountCents: 2_000_000,
          invoicedCents: 0,
        },
      ],
    });
    expect(charge.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(charge.snapshot).toMatchObject({
      explicitAmountCents: null,
      appointmentTypeName: 'Consulta',
      quote: { source: 'private', totalCents: 2_000_000 },
    });
    const [row] = await audits('charge.captured');
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: world.reception.user.id,
      resourceType: 'charge',
      resourceId: charge.id,
      patientId: appointment.patientId,
      metadata: { totalCents: 2_000_000, source: 'private', appointmentId: appointment.id },
    });
  });

  it('also captures while the consultation is in progress and after it was attended', async () => {
    await ensureGeneralPrice();
    const inProgress = await world.appointment({ stage: 'in_progress' });
    const attended = await world.appointment({ stage: 'attended' });

    const first = await capture({ appointmentId: inProgress.id });
    const second = await capture({ appointmentId: attended.id });

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json<ChargeDto>().status).toBe('pending');
  });

  it('refuses before check-in, and says the patient must be checked in first', async () => {
    await ensureGeneralPrice();
    const scheduled = await world.appointment({ stage: 'scheduled' });
    const confirmed = await world.appointment({ stage: 'confirmed' });

    for (const appointment of [scheduled, confirmed]) {
      const response = await capture({ appointmentId: appointment.id });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<Problem>().code).toBe('charge_check_in_required');
    }
    const list = await world.api.get(`/billing/charges?appointmentId=${scheduled.id}`, world.owner);
    expect(list.json<ChargeListResponse>().charges).toEqual([]);
  });

  it('points to the existing charge when the appointment already has one', async () => {
    await ensureGeneralPrice();
    const appointment = await world.appointment();
    const first = (await capture({ appointmentId: appointment.id })).json<ChargeDto>();

    const again = await capture({ appointmentId: appointment.id });

    expect(again.statusCode).toBe(409);
    expect(again.json<Problem & ChargeExistsExtension>()).toMatchObject({
      code: 'conflict',
      existingChargeId: first.id,
    });
    const list = await world.api.get(
      `/billing/charges?appointmentId=${appointment.id}`,
      world.owner,
    );
    expect(list.json<ChargeListResponse>().charges).toHaveLength(1);
  });

  it('creates exactly one charge when two captures arrive together', async () => {
    await ensureGeneralPrice();
    const appointment = await world.appointment();

    const [one, two] = await Promise.all([
      capture({ appointmentId: appointment.id }),
      capture({ appointmentId: appointment.id }),
    ]);

    expect([one.statusCode, two.statusCode].sort()).toEqual([201, 409]);
    const list = await world.api.get(
      `/billing/charges?appointmentId=${appointment.id}`,
      world.owner,
    );
    expect(list.json<ChargeListResponse>().charges).toHaveLength(1);
  });
});

describe('what a no-show or a cancellation is charged', () => {
  async function setLateFee(enabled: boolean, amountCents = 500_000) {
    const response = await world.api.patch('/settings', world.owner, {
      billing: { lateFeeEnabled: enabled, lateFeeAmount: amountCents },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  it('does not charge a no-show by default', async () => {
    await ensureGeneralPrice();
    await setLateFee(false);
    const appointment = await world.appointment({ stage: 'no_show' });

    const response = await capture({ appointmentId: appointment.id });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<Problem>().code).toBe('charge_not_billable');
  });

  it('charges a no-show with an explicit fee line when the organization enables the fee', async () => {
    await ensureGeneralPrice();
    await setLateFee(true, 500_000);
    const appointment = await world.appointment({ stage: 'no_show' });

    const response = await capture({ appointmentId: appointment.id });
    await setLateFee(false);

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<ChargeDto>()).toMatchObject({
      totalCents: 500_000,
      lines: [{ kind: 'late_fee', portion: 'patient', amountCents: 500_000 }],
    });
    expect(response.json<ChargeDto>().lines[0]?.description).toMatch(/ausencia|cancelación/i);
  });

  it('does not charge a cancellation, even with the fee on, unless it was a late one', async () => {
    await ensureGeneralPrice();
    await setLateFee(true, 400_000);
    const plain = await world.appointment({ stage: 'cancelled' });
    const late = await world.appointment({ stage: 'cancelled' });
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx.execute(sql`UPDATE appointment SET late_cancellation = true WHERE id = ${late.id}`),
    );

    const refused = await capture({ appointmentId: plain.id });
    const charged = await capture({ appointmentId: late.id });
    await setLateFee(false);

    expect(refused.statusCode).toBe(409);
    expect(refused.json<Problem>().code).toBe('charge_not_billable');
    expect(charged.statusCode, charged.body).toBe(201);
    expect(charged.json<ChargeDto>().lines).toMatchObject([
      { kind: 'late_fee', amountCents: 400_000 },
    ]);
  });

  it('does not charge a no-show when the fee is on but its amount is zero', async () => {
    await setLateFee(true, 0);
    const appointment = await world.appointment({ stage: 'no_show' });

    const response = await capture({ appointmentId: appointment.id });
    await setLateFee(false);

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('charge_not_billable');
  });
});

describe('when no price matches', () => {
  let bare: BillingWorld;

  beforeAll(async () => {
    // An organization with no price list at all.
    bare = await createBillingWorld(runtime, { slug: 'capture-charge-bare' });
  });

  afterAll(async () => {
    await bare.close();
  });

  it('does not create a charge with an implied zero: it asks for the amount', async () => {
    const appointment = await bare.appointment();

    const response = await bare.api.post('/billing/charges', bare.reception, {
      appointmentId: appointment.id,
    });

    expect(response.statusCode, response.body).toBe(422);
    expect(response.json<Problem>().code).toBe('charge_amount_required');
    const list = await bare.api.get(`/billing/charges?appointmentId=${appointment.id}`, bare.owner);
    expect(list.json<ChargeListResponse>().charges).toEqual([]);
  });

  it('takes the amount typed by a person, marks the charge and audits the override', async () => {
    const appointment = await bare.appointment();

    const response = await bare.api.post('/billing/charges', bare.reception, {
      appointmentId: appointment.id,
      explicitAmountCents: 1_234_50,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<ChargeDto>()).toMatchObject({
      explicitAmount: true,
      totalCents: 123_450,
      lines: [{ kind: 'service', amountCents: 123_450 }],
      snapshot: { quote: null, explicitAmountCents: 123_450 },
    });
    const override = await asTenant(runtime, bare.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.tenantId, bare.tenant.id),
            eq(auditEvent.action, 'billing.price.override'),
          ),
        ),
    );
    expect(override).toHaveLength(1);
    expect(override[0]).toMatchObject({
      actorUserId: bare.reception.user.id,
      resourceId: response.json<ChargeDto>().id,
      metadata: { amountCents: 123_450, appointmentId: appointment.id },
    });
  });

  it('refuses an amount typed by hand when the catalog does have a price', async () => {
    await ensureGeneralPrice();
    const appointment = await world.appointment();

    const response = await capture({ appointmentId: appointment.id, explicitAmountCents: 100 });

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('charge_price_exists');
  });
});

describe('payers and the snapshot', () => {
  it('splits a covered charge into the payer portion and the copago, as separate lines', async () => {
    await ensureGeneralPrice();
    await world.api.post('/billing/payer-prices', world.owner, {
      tenantPayerId: osde.id,
      appointmentTypeId: world.consulta,
      planName: '210',
      payerAmountCents: 1_500_000,
      copagoCents: 300_000,
      plusCents: 500_000,
      effectiveFrom: '2031-01-01',
    });
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeCatalogId, planName: '210' });
    const appointment = await world.appointment({ patientId });

    const response = await capture({ appointmentId: appointment.id });

    expect(response.statusCode, response.body).toBe(201);
    const charge = response.json<ChargeDto>();
    expect(charge).toMatchObject({
      tenantPayerId: osde.id,
      payerName: 'OSDE Cobros',
      planName: '210',
      totalCents: 2_300_000,
      patientCents: 800_000,
      payerCents: 1_500_000,
      outstandingCents: 800_000,
    });
    expect(charge.lines.map((line) => [line.kind, line.portion, line.amountCents])).toEqual([
      ['payer_coverage', 'payer', 1_500_000],
      ['copago', 'patient', 300_000],
      ['plus', 'patient', 500_000],
    ]);
  });

  it('captures what the quote showed, and a later price change does not touch the charge', async () => {
    await ensureGeneralPrice(2_000_000);
    const appointment = await world.appointment();
    const quoted = await world.api.get(
      `/billing/price-quote?appointmentId=${appointment.id}`,
      world.reception,
    );

    const charged = (await capture({ appointmentId: appointment.id })).json<ChargeDto>();
    const later = await world.appointment();
    // The catalog price goes up from the day before the next appointment.
    const raise = await world.setPrice(2_200_000, { effectiveFrom: '2031-02-01' });
    const fresh = (await capture({ appointmentId: later.id })).json<ChargeDto>();
    // Back to the old list, so the tests that follow quote what they expect.
    await world.api.patch(`/billing/prices/${raise.id}`, world.owner, { active: false });
    const reread = (
      await world.api.get(`/billing/charges/${charged.id}`, world.reception)
    ).json<ChargeDto>();

    expect(quoted.json<{ quote: { totalCents: number } }>().quote.totalCents).toBe(
      charged.totalCents,
    );
    expect(reread.totalCents).toBe(2_000_000);
    expect(reread.snapshot.quote?.totalCents).toBe(2_000_000);
    expect(fresh.totalCents).toBe(2_200_000);
  });

  it('charges the private price when the payer is chosen by hand to be private', async () => {
    await ensureGeneralPrice();
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeCatalogId, planName: '210' });
    const appointment = await world.appointment({ patientId });

    const response = await capture({ appointmentId: appointment.id, payer: 'private' });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<ChargeDto>()).toMatchObject({ tenantPayerId: null, payerCents: 0 });
  });
});

describe('adding lines to a charge', () => {
  it('adds a line by hand to the patient or to the payer, numbered after the others', async () => {
    await ensureGeneralPrice();
    const appointment = await world.appointment();
    const charge = (await capture({ appointmentId: appointment.id })).json<ChargeDto>();

    const added = await world.api.post(`/billing/charges/${charge.id}/lines`, world.reception, {
      description: 'Material descartable',
      amountCents: 150_000,
    });
    const forPayer = await world.api.post(`/billing/charges/${charge.id}/lines`, world.reception, {
      description: 'Estudio autorizado',
      amountCents: 80_000,
      portion: 'payer',
    });

    expect(added.statusCode, added.body).toBe(201);
    const updated = forPayer.json<ChargeDto>();
    expect(
      updated.lines.map((line) => [line.position, line.kind, line.portion, line.amountCents]),
    ).toEqual([
      [1, 'service', 'patient', 2_000_000],
      [2, 'manual', 'patient', 150_000],
      [3, 'manual', 'payer', 80_000],
    ]);
    expect(updated).toMatchObject({
      totalCents: 2_230_000,
      patientCents: 2_150_000,
      payerCents: 80_000,
    });
    const rows = (await audits('charge.captured')).filter((row) => row.resourceId === charge.id);
    expect(rows.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ change: 'line_added', amountCents: 150_000 }),
      ]),
    );
  });

  it('answers not found for a charge that does not exist', async () => {
    const response = await world.api.post(
      '/billing/charges/0190a000-0000-7000-8000-0000000000aa/lines',
      world.reception,
      { description: 'x', amountCents: 100 },
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('who may capture', () => {
  it('denies the professional, who reads but does not charge, and audits the denial', async () => {
    await ensureGeneralPrice();
    const appointment = await world.appointment();
    const before = await asTenant(runtime, world.tenant.id, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_event WHERE action = 'access.denied'`,
      );
      return rows.rows[0]?.n ?? 0;
    });

    const response = await capture({ appointmentId: appointment.id }, world.doctor);

    expect(response.statusCode).toBe(403);
    const after = await asTenant(runtime, world.tenant.id, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_event WHERE action = 'access.denied'`,
      );
      return rows.rows[0]?.n ?? 0;
    });
    expect(after).toBe(before + 1);
  });

  it('lets an administrator capture, and the audit entry names the role', async () => {
    await ensureGeneralPrice();
    const appointment = await world.appointment();

    const response = await capture({ appointmentId: appointment.id }, world.admin);

    expect(response.statusCode, response.body).toBe(201);
    const [row] = await audits('charge.captured');
    expect(row).toMatchObject({ actorUserId: world.admin.user.id, actingRole: 'admin' });
  });

  it('answers not found for an appointment of another organization', async () => {
    const other = await createTestTenant(runtime, { slug: 'capture-charge-b' });
    const foreign = await asTenant(runtime, other.id, (tx) => insertAppointmentRow(tx, other.id));

    const response = await capture({ appointmentId: foreign });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a body that names the organization, a float amount or unknown fields', async () => {
    const appointment = await world.appointment();

    for (const extra of [
      { tenantId: world.tenant.id },
      { explicitAmountCents: 12.5 },
      { status: 'paid' },
    ]) {
      const response = await capture({ appointmentId: appointment.id, ...extra });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
  });

  it('is refused with 402 while the organization is in read-only mode', async () => {
    await ensureGeneralPrice();
    const appointment = await world.appointment();
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, world.tenant.id)),
    );
    try {
      const response = await capture({ appointmentId: appointment.id });

      expect(response.statusCode).toBe(402);
      expect(response.json<Problem>().code).toBe('tenant_read_only');
    } finally {
      await asTenant(runtime, world.tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, world.tenant.id)),
      );
    }
  });
});
