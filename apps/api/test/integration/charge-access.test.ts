import type { ChargeDto, ChargeListResponse } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { insertAppointmentRow, returningId } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * Who sees which charge (billing-payments, "Billing access control", "Tenant isolation"): an
 * administrator all of them, reception those of its locations, a professional those of their own
 * appointments; nobody sees a colleague's revenue, nothing clinical is in a charge, and a charge of
 * another organization does not exist.
 */

let runtime: DbHandle;
let world: BillingWorld;
let atNorte: string;
let ownByColleague: string;
let atCentro: string;
let ownByDoctor: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'charge-access' });
  await world.setPrice(2_000_000);

  const mine = await world.appointment();
  const theirs = await world.appointment({ professional: world.colleague });
  const capture = async (appointmentId: string) =>
    (await world.api.post('/billing/charges', world.reception, { appointmentId })).json<ChargeDto>()
      .id;
  ownByDoctor = await capture(mine.id);
  ownByColleague = await capture(theirs.id);
  atCentro = ownByDoctor;

  // A charge at the other location, written straight into the tables: reception does not work there.
  atNorte = await asTenant(runtime, world.tenant.id, async (tx) => {
    const patientId = await world.freshPatient();
    const appointmentId = await insertAppointmentRow(tx, world.tenant.id, {
      patient_id: patientId,
      professional_id: world.doctor.professionalId,
      location_id: world.norte,
      appointment_type_id: world.consulta,
    });
    return returningId(
      tx,
      sql`INSERT INTO charge (tenant_id, appointment_id, patient_id, professional_id, location_id,
                              snapshot, captured_by)
            VALUES (${world.tenant.id}, ${appointmentId}, ${patientId},
                    ${world.doctor.professionalId}, ${world.norte},
                    ${JSON.stringify({
                      quote: null,
                      explicitAmountCents: 1_000,
                      appointmentTypeName: 'Consulta',
                      serviceDate: '2031-06-02',
                    })}::jsonb, ${world.owner.user.id})
            RETURNING id`,
    ).then(async (id) => {
      await tx.execute(
        sql`INSERT INTO charge_line (tenant_id, charge_id, position, kind, portion, description, amount_cents)
              VALUES (${world.tenant.id}, ${id}, 1, 'service', 'patient', 'Consulta', 1000)`,
      );
      return id;
    });
  });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const ids = (response: LightMyRequestResponse) =>
  response.json<ChargeListResponse>().charges.map((charge) => charge.id);

describe('who sees which charge', () => {
  it('shows an owner and an administrator every charge of the organization', async () => {
    for (const viewer of [world.owner, world.admin]) {
      const listed = ids(await world.api.get('/billing/charges', viewer));
      expect(listed).toEqual(expect.arrayContaining([ownByDoctor, ownByColleague, atNorte]));
    }
  });

  it('shows reception the charges of its locations and not those of the other', async () => {
    const listed = ids(await world.api.get('/billing/charges', world.reception));
    const direct = await world.api.get(`/billing/charges/${atNorte}`, world.reception);

    expect(listed).toEqual(expect.arrayContaining([atCentro, ownByColleague]));
    expect(listed).not.toContain(atNorte);
    expect(direct.statusCode).toBe(404);
  });

  it("shows a professional their own charges and answers not found for a colleague's", async () => {
    const listed = ids(await world.api.get('/billing/charges', world.doctor));
    const own = await world.api.get(`/billing/charges/${ownByDoctor}`, world.doctor);
    const colleagues = await world.api.get(`/billing/charges/${ownByColleague}`, world.doctor);
    const reverse = await world.api.get(`/billing/charges/${ownByDoctor}`, world.colleague);

    expect(listed).toContain(ownByDoctor);
    expect(listed).not.toContain(ownByColleague);
    expect(own.statusCode).toBe(200);
    expect(colleagues.statusCode).toBe(404);
    expect(reverse.statusCode).toBe(404);
  });

  it("does not let a professional filter their way into a colleague's revenue", async () => {
    const response = await world.api.get(
      `/billing/charges?professionalId=${world.colleague.professionalId}`,
      world.doctor,
    );

    expect(response.statusCode).toBe(200);
    expect(ids(response)).toEqual([]);
  });

  it('keeps reception from capturing or quoting an appointment of a location it does not work at', async () => {
    const norteAppointment = await asTenant(runtime, world.tenant.id, (tx) =>
      returningId(tx, sql`SELECT appointment_id AS id FROM charge WHERE id = ${atNorte}`),
    );

    const capture = await world.api.post('/billing/charges', world.reception, {
      appointmentId: norteAppointment,
    });
    const quote = await world.api.get(
      `/billing/price-quote?appointmentId=${norteAppointment}`,
      world.reception,
    );
    const line = await world.api.post(`/billing/charges/${atNorte}/lines`, world.reception, {
      description: 'Material',
      amountCents: 100,
    });

    expect([capture.statusCode, quote.statusCode, line.statusCode]).toEqual([404, 404, 404]);
  });

  it('answers not found for a charge of another organization', async () => {
    const other = await createTestTenant(runtime, { slug: 'charge-access-b' });
    const foreign = await asTenant(runtime, other.id, async (tx) => {
      const appointmentId = await insertAppointmentRow(tx, other.id);
      const rows = await tx.execute<{
        patient_id: string;
        professional_id: string;
        location_id: string;
      }>(
        sql`SELECT patient_id, professional_id, location_id FROM appointment WHERE id = ${appointmentId}`,
      );
      const row = rows.rows[0];
      return returningId(
        tx,
        sql`INSERT INTO charge (tenant_id, appointment_id, patient_id, professional_id, location_id,
                                snapshot, captured_by)
              VALUES (${other.id}, ${appointmentId}, ${row?.patient_id}, ${row?.professional_id},
                      ${row?.location_id},
                      '{"quote":null,"explicitAmountCents":1,"appointmentTypeName":"X","serviceDate":"2031-06-02"}'::jsonb,
                      gen_random_uuid())
              RETURNING id`,
      );
    });

    for (const viewer of [world.owner, world.reception, world.doctor]) {
      expect((await world.api.get(`/billing/charges/${foreign}`, viewer)).statusCode).toBe(404);
    }
    expect(ids(await world.api.get('/billing/charges', world.owner))).not.toContain(foreign);
  });

  it('answers 401 without a session', async () => {
    expect((await world.api.get('/billing/charges', null)).statusCode).toBe(401);
  });
});

describe('what a charge shows', () => {
  const FORBIDDEN = /note|diagnos|prescri|anamnes|symptom|treatment|clinical|allerg/i;

  function keysOf(value: unknown, path = ''): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => keysOf(item, path));
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([key, inner]) => [
      `${path}${key}`,
      ...keysOf(inner, `${path}${key}.`),
    ]);
  }

  it('has the administrative fields of the contract and no clinical content', async () => {
    const response = await world.api.get(`/billing/charges/${ownByDoctor}`, world.doctor);
    const charge = response.json<ChargeDto>();

    expect(Object.keys(charge).sort()).toEqual([
      'appointmentId',
      'appointmentTypeName',
      'capturedAt',
      'capturedBy',
      'creditCents',
      'explicitAmount',
      'flaggedAt',
      'id',
      'invoicedCents',
      'invoicing',
      'lines',
      'locationId',
      'locationName',
      'needsReview',
      'outstandingCents',
      'paidCents',
      'patientCents',
      'patientId',
      'patientName',
      'payerCents',
      'payerName',
      'planName',
      'professionalId',
      'professionalName',
      'reviewReason',
      'snapshot',
      'startsAt',
      'status',
      'tenantPayerId',
      'totalCents',
      'voidReason',
      'voidedAt',
    ]);
    expect(Object.keys(charge.lines[0] ?? {}).sort()).toEqual([
      'amountCents',
      'description',
      'id',
      'invoicedCents',
      'kind',
      'portion',
      'position',
    ]);
    expect(keysOf(charge).filter((key) => FORBIDDEN.test(key))).toEqual([]);
    expect(keysOf(charge).length).toBeGreaterThan(30);
  });

  it('keeps every amount a whole number of cents', async () => {
    const listed = (
      await world.api.get('/billing/charges', world.owner)
    ).json<ChargeListResponse>();

    expect(listed.charges.length).toBeGreaterThan(2);
    for (const charge of listed.charges) {
      for (const amount of [
        charge.totalCents,
        charge.patientCents,
        charge.payerCents,
        charge.paidCents,
      ]) {
        expect(Number.isInteger(amount)).toBe(true);
      }
      for (const line of charge.lines) expect(Number.isInteger(line.amountCents)).toBe(true);
    }
  });
});
