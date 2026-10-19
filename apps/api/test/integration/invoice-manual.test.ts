import type { ChargeDto, InvoiceDto, Problem } from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * Manual entry of an invoice (S4.11, task 4.49, spec "Manual invoice entry fallback"): the owner or
 * an admin registers a voucher issued outside the system with its number and CAE; it is saved as
 * manual, linked to the charge lines, immutable, unique per type, point of sale and number, and
 * reception can never enter a CAE.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-manual' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const problem = (response: LightMyRequestResponse) => response.json<Problem>();

const auditRows = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action as never)))
      .orderBy(desc(auditEvent.occurredAt)),
  );

let numbers = 5000;
const nextNumber = () => (numbers += 1);

/** The body of a manual entry over the patient lines of a charge. */
async function manualBody(charge: ChargeDto, extra: Record<string, unknown> = {}) {
  const lines = (await world.linesOf(charge.id)).filter((line) => line.portion === 'patient');
  const number = nextNumber();
  return {
    idempotencyKey: `0190a000-0000-7000-8000-${String(nextNumber()).padStart(12, '0')}`,
    type: 'FC',
    pointOfSale: 5,
    number,
    // A CAE belongs to one voucher: every entry has its own.
    cae: String(70_123_000_000_000 + number),
    issueDate: '2031-05-20',
    caeExpiresOn: '2031-05-30',
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    lines: lines.map((line) => ({ chargeLineId: line.id })),
    recipient: { kind: 'patient' },
    ...extra,
  };
}

const register = (body: Record<string, unknown>, by = world.admin) =>
  world.api.post('/invoices/manual', by, body);

describe('an invoice issued outside the system', () => {
  it('is registered by an admin while the simulator is down: manual, linked to the lines, not queued', async () => {
    world.issuer.setMode('down');
    try {
      const charge = await world.charge();
      const body = await manualBody(charge);
      const jobs = world.recorded.jobs.length;

      const response = await register(body);

      expect(response.statusCode, response.body).toBe(201);
      const saved = response.json<InvoiceDto>();
      expect(saved).toMatchObject({
        kind: 'invoice',
        type: 'FC',
        status: 'manual',
        pointOfSale: 5,
        number: body.number,
        cae: body.cae,
        caeExpiresOn: '2031-05-30',
        issueDate: '2031-05-20',
        totalCents: 2_000_000,
        ageMinutes: null,
        outageFlag: false,
        testDocument: false,
        recipient: { kind: 'patient', patientId: charge.patientId },
      });
      expect(saved.lines).toEqual([
        expect.objectContaining({ chargeId: charge.id, amountCents: 2_000_000 }),
      ]);
      // Linked to the charge lines, and nothing is sent to the authority.
      expect((await world.chargeOf(charge.id)).invoicing).toBe('invoiced');
      expect(world.recorded.jobs.length).toBe(jobs);
      expect(world.issuer.vouchers()).toHaveLength(0);
      expect(await auditRows('invoice.manual')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resourceId: saved.id,
            outcome: 'allow',
            patientId: charge.patientId,
          }),
        ]),
      );
    } finally {
      world.issuer.setMode('ok');
    }
  });

  it('works when e-invoicing is off and does not need the integration at all', async () => {
    await world.switchEinvoicing(false);
    try {
      const charge = await world.charge();

      const response = await register(await manualBody(charge));

      expect(response.statusCode, response.body).toBe(201);
    } finally {
      await world.switchEinvoicing(true);
    }
  });

  it('is immutable once saved: the database refuses to change it', async () => {
    const charge = await world.charge();
    const body = await manualBody(charge);
    const saved = (await register(body)).json<InvoiceDto>();

    const change = await world
      .inTenant((tx) =>
        tx.transaction((inner) =>
          inner.execute(sql`UPDATE invoice SET cae = '70123456780000' WHERE id = ${saved.id}`),
        ),
      )
      .then(
        () => undefined,
        (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
      );

    expect(change).toBe('42501');
    expect((await world.getInvoice(saved.id)).cae).toBe(body.cae);
  });

  it('counts for the credit note and is readable like any other invoice', async () => {
    const charge = await world.charge();
    const saved = (await register(await manualBody(charge))).json<InvoiceDto>();

    const read = await world.api.get(`/invoices?status=manual`, world.reception);

    expect(read.statusCode).toBe(200);
    expect(read.json<{ invoices: InvoiceDto[] }>().invoices.map((entry) => entry.id)).toContain(
      saved.id,
    );
  });
});

describe('who may enter a CAE', () => {
  it('is for owner and admin: reception is denied, audited, and nothing is saved', async () => {
    const charge = await world.charge();
    const body = await manualBody(charge);
    const denied = (await auditRows('access.denied')).length;
    const manual = (await auditRows('invoice.manual')).length;

    const refused = await register(body, world.reception);

    expect(refused.statusCode).toBe(403);
    expect((await auditRows('access.denied')).length).toBe(denied + 1);
    expect((await auditRows('invoice.manual')).length).toBe(manual);
    expect((await world.chargeOf(charge.id)).invoicedCents).toBe(0);
    expect((await register(body, world.owner)).statusCode).toBe(201);
  });

  it('is not open to a professional either, or to a request with no session', async () => {
    const charge = await world.charge();
    const body = await manualBody(charge);

    expect((await register(body, world.doctor)).statusCode).toBe(403);
    expect((await world.api.post('/invoices/manual', null, body)).statusCode).toBe(401);
  });
});

describe('uniqueness and format', () => {
  it('rejects a duplicate type, point of sale and number, and accepts the same number elsewhere', async () => {
    const charge = await world.charge();
    const first = await manualBody(charge);
    expect((await register(first)).statusCode).toBe(201);
    const other = await world.charge();

    const duplicate = await register(await manualBody(other, { number: first.number }));
    expect(duplicate.statusCode).toBe(409);
    expect(problem(duplicate).code).toBe('invoice_number_taken');
    expect((await world.chargeOf(other.id)).invoicedCents).toBe(0);

    // Another point of sale, or another type, may use the number.
    const point = await register(await manualBody(other, { number: first.number, pointOfSale: 6 }));
    expect(point.statusCode, point.body).toBe(201);
  });

  it('does not repeat a number the system itself issued', async () => {
    const issued = await world.issueInvoiceOf(await world.charge());
    const charge = await world.charge();

    const response = await register(
      await manualBody(charge, { pointOfSale: issued.pointOfSale, number: issued.number }),
    );

    expect(response.statusCode).toBe(409);
    expect(problem(response).code).toBe('invoice_number_taken');
  });

  it('checks the CAE (14 digits), the dates and the total against the lines', async () => {
    const charge = await world.charge();
    const good = await manualBody(charge);

    for (const bad of [
      { ...good, cae: '1234567890123' },
      { ...good, cae: '7012345678901x' },
      { ...good, issueDate: '20/05/2031' },
      { ...good, number: 0 },
    ]) {
      expect((await register(bad)).statusCode).toBe(400);
    }
    const mismatch = await register({ ...good, totalCents: 1_999_999 });
    expect(mismatch.statusCode).toBe(400);
    expect(problem(mismatch).errors).toEqual([
      expect.objectContaining({ path: 'totalCents', i18nKey: 'invoicing.manual.total_mismatch' }),
    ]);
    expect((await world.chargeOf(charge.id)).invoicedCents).toBe(0);
  });

  it('follows the rules of the type: a Factura A from a monotributista is refused, a bad document too', async () => {
    const charge = await world.charge();

    const forbidden = await register(await manualBody(charge, { type: 'FA' }));
    const document = await register(
      await manualBody(charge, {
        recipient: { kind: 'patient', document: { type: 'dni', number: '12AB' } },
      }),
    );

    expect(forbidden.statusCode).toBe(400);
    expect(problem(forbidden).errors).toEqual([
      expect.objectContaining({ path: 'type', i18nKey: 'country.ar.invoice.type_forbidden' }),
    ]);
    expect(document.statusCode).toBe(400);
  });

  it('cannot cover more than what is left of a line, and cannot cover a voided charge', async () => {
    const charge = await world.charge();
    expect((await register(await manualBody(charge))).statusCode).toBe(201);

    const again = await register(await manualBody(charge));
    expect(again.statusCode).toBe(409);
    expect(problem(again).code).toBe('invoice_line_over_invoiced');

    const voided = await world.charge();
    await world.api.post(`/billing/charges/${voided.id}/void`, world.owner, {
      reason: 'Cargado por error',
    });
    const refused = await register(await manualBody(voided));
    expect(refused.statusCode).toBe(409);
    expect(problem(refused).code).toBe('invoice_charge_voided');
  });

  it('refuses a CAE that another voucher of the organization already holds', async () => {
    const first = await manualBody(await world.charge());
    const second = await manualBody(await world.charge(), { cae: first.cae });
    expect((await register(first)).statusCode).toBe(201);

    const response = await register(second);

    expect(response.statusCode, response.body).toBe(409);
    expect(problem(response).code).toBe('invoice_cae_taken');
  });

  it('is one invoice for one key even when the lines come in another order', async () => {
    const charge = await world.charge();
    await world.api.post(`/billing/charges/${charge.id}/lines`, world.reception, {
      description: 'Material',
      amountCents: 500_000,
    });
    const body = await manualBody(charge);
    const reversed = { ...body, lines: [...body.lines].reverse() };

    const first = await register(body);
    const replay = await register(reversed);

    expect(body.lines).toHaveLength(2);
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json<InvoiceDto>().id).toBe(first.json<InvoiceDto>().id);
  });

  it('is one invoice for one key and refuses the key for another entry', async () => {
    const charge = await world.charge();
    const body = await manualBody(charge);

    const first = await register(body);
    const replay = await register(body);
    const other = await register({ ...body, cae: '70123456780000' });

    expect(replay.statusCode).toBe(201);
    expect(replay.json<InvoiceDto>().id).toBe(first.json<InvoiceDto>().id);
    expect(other.statusCode).toBe(409);
    expect(problem(other).code).toBe('idempotency_key_reused');
  });
});

describe('replacing an invoice that is still pending (the outage fallback)', () => {
  it('releases the lines of the pending invoice, so it is never issued as well', async () => {
    await world.runIssue();
    world.issuer.setMode('down');
    try {
      const charge = await world.charge();
      const pending = (await world.invoiceCharge(charge)).json<InvoiceDto>();
      await world.runIssue();
      expect((await world.getInvoice(pending.id)).status).toBe('pending');
      const body = await manualBody(charge);

      // While the pending one holds the lines, the same lines cannot be registered.
      const blocked = await register(body);
      expect(blocked.statusCode).toBe(409);

      const response = await register({ ...body, replacesInvoiceId: pending.id });

      expect(response.statusCode, response.body).toBe(201);
      expect(response.json<InvoiceDto>().status).toBe('manual');
      const replaced = await world.getInvoice(pending.id);
      expect(replaced).toMatchObject({ status: 'rejected', cae: null, number: null });
      expect(replaced.rejectionMessage).toMatch(/manual/i);
      expect((await world.chargeOf(charge.id)).invoicedCents).toBe(2_000_000);
    } finally {
      world.issuer.setMode('ok');
    }
    // The authority comes back and finds nothing to issue for it.
    const before = world.issuer.vouchers().length;
    await world.runIssue();
    expect(world.issuer.vouchers().length).toBe(before);
  });

  it('only replaces an invoice that is pending', async () => {
    const issued = await world.issueInvoiceOf(await world.charge());
    const charge = await world.charge();

    const response = await register({
      ...(await manualBody(charge)),
      replacesInvoiceId: issued.id,
    });

    expect(response.statusCode).toBe(409);
    expect(await world.getInvoice(issued.id)).toMatchObject({ status: 'issued' });
  });
});
