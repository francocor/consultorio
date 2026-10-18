import type { ChargeDto, ChargeListResponse, Problem } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { voidCharge } from '../../src/modules/billing/application/void-charge.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * Voiding a charge (billing-payments, "Charge lifecycle and voiding"): with permission and a
 * reason, never while money is held for it or an invoice stands over it, and never by deleting.
 */

let runtime: DbHandle;
let world: BillingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'void-charge' });
  await world.setPrice(2_000_000);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

async function newCharge() {
  const appointment = await world.appointment();
  const response = await world.api.post('/billing/charges', world.reception, {
    appointmentId: appointment.id,
  });
  expect(response.statusCode, response.body).toBe(201);
  return { appointment, charge: response.json<ChargeDto>() };
}

const voidIt = (id: string, reason: string, by = world.owner) =>
  world.api.post(`/billing/charges/${id}/void`, by, { reason });

async function audits(action: 'charge.voided' | 'access.denied') {
  return asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('voiding an unpaid charge', () => {
  it('leaves it voided and visible, with the reason, who and when, and audits it', async () => {
    const { charge } = await newCharge();

    const response = await voidIt(charge.id, 'Cargado por error');

    expect(response.statusCode, response.body).toBe(200);
    const voided = response.json<ChargeDto>();
    expect(voided).toMatchObject({
      id: charge.id,
      status: 'voided',
      voidReason: 'Cargado por error',
      totalCents: 2_000_000,
    });
    expect(voided.voidedAt).not.toBeNull();
    const [row] = await audits('charge.voided');
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: world.owner.user.id,
      resourceType: 'charge',
      resourceId: charge.id,
      metadata: { reason: 'Cargado por error', totalCents: 2_000_000 },
    });
    // It is still there: listed, readable, never deleted.
    const listed = (
      await world.api.get(`/billing/charges?status=voided`, world.owner)
    ).json<ChargeListResponse>();
    expect(listed.charges.map((entry) => entry.id)).toContain(charge.id);
    expect((await world.api.get(`/billing/charges/${charge.id}`, world.owner)).statusCode).toBe(
      200,
    );
  });

  it('can be done by an administrator, and the appointment can be charged again afterwards', async () => {
    const { appointment, charge } = await newCharge();

    const response = await voidIt(charge.id, 'Se cobró otro importe', world.admin);
    const again = await world.api.post('/billing/charges', world.reception, {
      appointmentId: appointment.id,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json<ChargeDto>().id).not.toBe(charge.id);
    const both = (
      await world.api.get(`/billing/charges?appointmentId=${appointment.id}`, world.owner)
    ).json<ChargeListResponse>();
    expect(both.charges.map((entry) => entry.status).sort()).toEqual(['pending', 'voided']);
  });

  it('is final: a second void, a new line or a missing reason are refused', async () => {
    const { charge } = await newCharge();
    await voidIt(charge.id, 'Duplicado');

    const second = await voidIt(charge.id, 'Otra vez');
    const line = await world.api.post(`/billing/charges/${charge.id}/lines`, world.reception, {
      description: 'Material',
      amountCents: 100,
    });
    const { charge: other } = await newCharge();
    const blank = await voidIt(other.id, 'x');

    expect(second.statusCode).toBe(409);
    expect(second.json<Problem>().code).toBe('charge_voided');
    expect(line.statusCode).toBe(409);
    expect(line.json<Problem>().code).toBe('charge_voided');
    expect(blank.statusCode).toBe(400);
  });
});

describe('who may void', () => {
  it('denies reception and the professional, and audits the denial', async () => {
    const { charge } = await newCharge();
    const before = (await audits('access.denied')).length;

    const byReception = await voidIt(charge.id, 'Intento de recepción', world.reception);
    const byDoctor = await voidIt(charge.id, 'Intento del profesional', world.doctor);

    expect([byReception.statusCode, byDoctor.statusCode]).toEqual([403, 403]);
    expect((await audits('access.denied')).length).toBe(before + 2);
    const still = (
      await world.api.get(`/billing/charges/${charge.id}`, world.owner)
    ).json<ChargeDto>();
    expect(still.status).toBe('pending');
  });

  it('answers not found for a charge that does not exist', async () => {
    const response = await voidIt('0190a000-0000-7000-8000-0000000000aa', 'No existe');

    expect(response.statusCode).toBe(404);
  });
});

describe('when something stands in the way', () => {
  async function inTenant<T>(work: Parameters<typeof asTenant<T>>[2]) {
    return asTenant(runtime, world.tenant.id, work);
  }
  const actor = () => ({
    userId: world.owner.user.id,
    actingRole: 'owner' as const,
    ip: null,
    userAgent: null,
    requestId: null,
  });
  const viewer = () => ({
    roles: ['owner' as const],
    membershipId: world.owner.membershipId,
    professionalId: null,
  });

  it('refuses while an issued invoice covers the charge, and says a credit note comes first', async () => {
    const { charge } = await newCharge();

    const error = await inTenant((tx) =>
      voidCharge(tx, {
        chargeId: charge.id,
        request: { reason: 'Intento con factura' },
        actor: actor(),
        viewer: viewer(),
        invoices: { hasIssuedInvoice: () => Promise.resolve(true) },
      }),
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ code: 'charge_has_invoice' });
    const still = (
      await world.api.get(`/billing/charges/${charge.id}`, world.owner)
    ).json<ChargeDto>();
    expect(still.status).toBe('pending');
  });

  it('voids when the invoicing module says there is no invoice, and asks it about this charge', async () => {
    const { charge } = await newCharge();
    const asked: string[] = [];

    const result = await inTenant((tx) =>
      voidCharge(tx, {
        chargeId: charge.id,
        request: { reason: 'Sin factura' },
        actor: actor(),
        viewer: viewer(),
        invoices: {
          hasIssuedInvoice: (_tx, id) => {
            asked.push(id);
            return Promise.resolve(false);
          },
        },
      }),
    );

    expect(asked).toEqual([charge.id]);
    expect(result.status).toBe('voided');
  });
});
