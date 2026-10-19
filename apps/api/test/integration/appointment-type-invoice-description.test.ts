import type { AppointmentTypeDto, InvoiceDto } from '@consultorio/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * The generic wording of a service on an invoice (S4.12, task 4.51; spec "Invoice document and
 * delivery": "the invoice description MUST use generic service wording ... and MUST NOT contain
 * diagnoses or clinical details"). An appointment type may carry an invoice description; without one
 * the invoice shows the generic "Servicios de salud", never the name of the type (JD-S4 R1-C9).
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'type-invoice-description' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

describe('the invoice description of an appointment type', () => {
  it('starts empty, is set and cleared by the owner, and shows in the type', async () => {
    const created = await world.api.post('/appointment-types', world.owner, {
      name: 'Psicología - sesión',
      durationMinutes: 45,
      mode: 'in_person',
    });
    expect(created.statusCode, created.body).toBe(201);
    const type = created.json<AppointmentTypeDto>();
    expect(type.invoiceDescription).toBeNull();

    const set = await world.api.patch(`/appointment-types/${type.id}`, world.owner, {
      invoiceDescription: 'Consulta profesional',
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<AppointmentTypeDto>().invoiceDescription).toBe('Consulta profesional');

    const cleared = await world.api.patch(`/appointment-types/${type.id}`, world.owner, {
      invoiceDescription: null,
    });
    expect(cleared.json<AppointmentTypeDto>().invoiceDescription).toBeNull();
  });

  it('can be given when the type is created, and is short', async () => {
    const created = await world.api.post('/appointment-types', world.owner, {
      name: 'Control',
      durationMinutes: 20,
      mode: 'in_person',
      invoiceDescription: 'Control profesional',
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<AppointmentTypeDto>().invoiceDescription).toBe('Control profesional');

    const tooLong = await world.api.post('/appointment-types', world.owner, {
      name: 'Otro',
      durationMinutes: 20,
      mode: 'in_person',
      invoiceDescription: 'x'.repeat(121),
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('is what the invoice line says, instead of the name of the type', async () => {
    const created = await world.api.post('/appointment-types', world.owner, {
      name: 'Psicoterapia individual',
      durationMinutes: 30,
      mode: 'in_person',
      invoiceDescription: 'Consulta profesional',
    });
    const type = created.json<AppointmentTypeDto>();
    const priced = await world.api.post('/billing/prices', world.owner, {
      appointmentTypeId: type.id,
      amountCents: 1_000_000,
      effectiveFrom: '2031-01-01',
    });
    expect(priced.statusCode, priced.body).toBe(201);
    const appointment = await world.appointment({ typeId: type.id });
    const charged = await world.api.post('/billing/charges', world.reception, {
      appointmentId: appointment.id,
    });
    expect(charged.statusCode, charged.body).toBe(201);

    const response = await world.invoiceCharge(charged.json());

    expect(response.statusCode, response.body).toBe(202);
    const lines = response.json<InvoiceDto>().lines;
    expect(lines.map((line) => line.description)).toEqual(['Consulta profesional']);
    expect(JSON.stringify(lines)).not.toMatch(/Psicoterapia/);
  });

  it('falls back to the generic wording, never the name of the type, when the type has no description', async () => {
    const charge = await world.charge();

    const response = await world.invoiceCharge(charge);

    const lines = response.json<InvoiceDto>().lines;
    expect(lines.map((line) => line.description)).toEqual(['Servicios de salud']);
    expect(JSON.stringify(lines)).not.toMatch(/Consulta/);
  });
});
