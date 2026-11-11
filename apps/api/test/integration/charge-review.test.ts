import type { ChargeDto, ChargeListResponse } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * An appointment that ends without the service after its charge was captured at check-in
 * (billing-payments, "Appointment ends without service after charge capture"): the charge is
 * flagged for a person to look at, and nothing is voided or refunded on its own.
 */

let runtime: DbHandle;
let world: BillingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'charge-review' });
  await world.setPrice(2_000_000);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

async function chargedAppointment() {
  const appointment = await world.appointment();
  const response = await world.api.post('/billing/charges', world.reception, {
    appointmentId: appointment.id,
  });
  expect(response.statusCode, response.body).toBe(201);
  return { appointment, charge: response.json<ChargeDto>() };
}

const read = async (id: string) =>
  (await world.api.get(`/billing/charges/${id}`, world.reception)).json<ChargeDto>();

async function flagAudits(chargeId: string) {
  const rows = await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, 'charge.flagged')))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.resourceId === chargeId);
}

describe('a charge whose appointment ended without the service', () => {
  it('is flagged when the appointment is cancelled, and stays as it was otherwise', async () => {
    const { appointment, charge } = await chargedAppointment();

    const cancelled = await world.act(appointment, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });

    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const after = await read(charge.id);
    expect(after).toMatchObject({
      needsReview: true,
      reviewReason: 'cancelled',
      status: 'pending',
      totalCents: 2_000_000,
      voidReason: null,
    });
    expect(after.flaggedAt).not.toBeNull();
    const [row] = await flagAudits(charge.id);
    expect(row).toMatchObject({
      outcome: 'allow',
      resourceType: 'charge',
      patientId: appointment.patientId,
      metadata: { reason: 'cancelled', appointmentId: appointment.id },
    });
  });

  it('is flagged when the patient does not show up, and is neither voided nor refunded', async () => {
    const { appointment, charge } = await chargedAppointment();
    const before = world.now();
    world.setNow(new Date(Date.parse(appointment.startsAt) + 10 * 60_000));
    try {
      const response = await world.act(appointment, 'no-show', world.reception);
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      world.setNow(before);
    }

    const after = await read(charge.id);

    expect(after).toMatchObject({
      needsReview: true,
      reviewReason: 'no_show',
      status: 'pending',
      voidReason: null,
      voidedAt: null,
    });
    expect((await flagAudits(charge.id))[0]?.metadata).toMatchObject({ reason: 'no_show' });
  });

  it('lets the list show what is waiting for a decision', async () => {
    const { appointment, charge } = await chargedAppointment();
    await world.act(appointment, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });

    const flagged = (
      await world.api.get('/billing/charges?needsReview=true', world.owner)
    ).json<ChargeListResponse>();
    const calm = (
      await world.api.get('/billing/charges?needsReview=false', world.owner)
    ).json<ChargeListResponse>();

    expect(flagged.charges.map((entry) => entry.id)).toContain(charge.id);
    expect(flagged.charges.every((entry) => entry.needsReview)).toBe(true);
    expect(calm.charges.map((entry) => entry.id)).not.toContain(charge.id);
  });

  it('does nothing for an appointment that has no charge, and flags a charge only once', async () => {
    const plain = await world.appointment();
    const cancelledPlain = await world.act(plain, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });
    expect(cancelledPlain.statusCode, cancelledPlain.body).toBe(200);
    const none = (
      await world.api.get(`/billing/charges?appointmentId=${plain.id}`, world.owner)
    ).json<ChargeListResponse>();
    expect(none.charges).toEqual([]);

    const { appointment, charge } = await chargedAppointment();
    await world.act(appointment, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });

    expect(await flagAudits(charge.id)).toHaveLength(1);
  });

  it('leaves a voided charge alone', async () => {
    const { appointment, charge } = await chargedAppointment();
    const voided = await world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Cargado por error',
    });
    expect(voided.statusCode, voided.body).toBe(200);

    await world.act(appointment, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });

    const after = await read(charge.id);
    expect(after).toMatchObject({ status: 'voided', needsReview: false });
    expect(await flagAudits(charge.id)).toHaveLength(0);
  });
});
