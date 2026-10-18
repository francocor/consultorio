import type { ChargeDto, InvoiceDto, Problem, TenantPayerDto } from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import fc from 'fast-check';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * Creating an invoice over charge lines (S4.10, task 4.44, spec "Issuing an invoice with CAE",
 * "Invoice type selection", "Recipient identification"): the lines are locked, an invoice can never
 * cover more than what is not yet invoiced, one invoice can cover lines of several charges and a line
 * can be invoiced in parts, and the request is queued with the invoice, in the same transaction.
 */

let runtime: DbHandle;
let world: InvoicingWorld;
let osde: TenantPayerDto;
let osdeCatalogId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-create' });
  osdeCatalogId = await world.catalogPayer('invoice-create-osde', 'OSDE Facturable');
  osde = (
    await world.api.post('/billing/payers', world.owner, {
      payerId: osdeCatalogId,
      cuit: '30-70857833-5',
    })
  ).json<TenantPayerDto>();
  await world.api.post('/billing/payer-prices', world.owner, {
    tenantPayerId: osde.id,
    appointmentTypeId: world.consulta,
    payerAmountCents: 1_500_000,
    copagoCents: 300_000,
    plusCents: 0,
    effectiveFrom: '2031-01-01',
  });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const auditRows = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action as never)))
      .orderBy(desc(auditEvent.occurredAt)),
  );

const countRows = async (table: 'invoice' | 'invoice_line') =>
  Number(
    (
      await world.inTenant((tx) =>
        tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`),
      )
    ).rows[0]?.n,
  );

const jobsFor = (invoiceId: string) =>
  world.recorded.jobs.filter(
    (job) => job.name === 'afip.issue' && job.payload['invoiceId'] === invoiceId,
  );

const problem = (response: LightMyRequestResponse) => response.json<Problem>();

/** A charge of a patient covered by OSDE: a payer line of 15.000 and a copago line of 3.000. */
async function coveredCharge(): Promise<ChargeDto> {
  const patientId = await world.freshPatient();
  await world.cover(patientId, { payerId: osdeCatalogId });
  return world.charge({ patientId });
}

describe('an invoice over the lines of a charge', () => {
  it('is saved as pending with its lines, queued in the same transaction, and the charge shows as invoiced', async () => {
    const charge = await world.charge();

    const response = await world.invoiceCharge(charge);

    expect(response.statusCode, response.body).toBe(202);
    const created = response.json<InvoiceDto>();
    expect(created).toMatchObject({
      kind: 'invoice',
      type: 'FC',
      status: 'pending',
      number: null,
      cae: null,
      pointOfSale: 1,
      environment: 'homologation',
      simulated: true,
      testDocument: true,
      totalCents: 2_000_000,
      netCents: 2_000_000,
      vatCents: 0,
      exemptCents: 0,
      outageFlag: false,
      hasPdf: false,
      recipient: { kind: 'patient', patientId: charge.patientId, taxCondition: 'consumidor_final' },
    });
    expect(created.recipient.name).toBeTruthy();
    expect(created.lines).toEqual([
      expect.objectContaining({
        description: 'Consulta',
        amountCents: 2_000_000,
        chargeId: charge.id,
      }),
    ]);
    // The retry progress is not part of what a screen reads.
    expect(Object.keys(created)).not.toContain('deliveryState');

    const after = await world.chargeOf(charge.id);
    expect(after.invoicing).toBe('invoiced');
    expect(after.invoicedCents).toBe(2_000_000);
    expect(jobsFor(created.id)).toHaveLength(1);
    expect(await auditRows('invoice.requested')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: created.id,
          outcome: 'allow',
          patientId: charge.patientId,
        }),
      ]),
    );
  });

  it('refuses a second invoice over the same lines and records nothing for it', async () => {
    const charge = await world.charge();
    expect((await world.invoiceCharge(charge)).statusCode).toBe(202);
    const invoices = await countRows('invoice');
    const jobs = world.recorded.jobs.length;
    const audits = (await auditRows('invoice.requested')).length;

    const [line] = await world.linesOf(charge.id);
    const again = await world.invoice({
      lines: [{ chargeLineId: line?.id ?? '' }],
      recipient: { kind: 'patient' },
    });

    expect(again.statusCode).toBe(409);
    expect(problem(again).code).toBe('invoice_line_over_invoiced');
    expect(await countRows('invoice')).toBe(invoices);
    expect(world.recorded.jobs.length).toBe(jobs);
    expect((await auditRows('invoice.requested')).length).toBe(audits);
  });

  it('makes one invoice for lines of two charges of the same patient', async () => {
    const first = await world.charge();
    const second = await world.charge({ patientId: first.patientId });
    const [lineOne] = await world.linesOf(first.id);
    const [lineTwo] = await world.linesOf(second.id);

    const response = await world.invoice({
      lines: [{ chargeLineId: lineOne?.id ?? '' }, { chargeLineId: lineTwo?.id ?? '' }],
      recipient: { kind: 'patient' },
    });

    expect(response.statusCode, response.body).toBe(202);
    const created = response.json<InvoiceDto>();
    expect(created.totalCents).toBe(4_000_000);
    expect(created.lines.map((line) => line.chargeId).sort()).toEqual([first.id, second.id].sort());
    expect((await world.chargeOf(first.id)).invoicing).toBe('invoiced');
    expect((await world.chargeOf(second.id)).invoicing).toBe('invoiced');
  });

  it('invoices one line in two parts and refuses a third', async () => {
    const charge = await world.charge();
    const [line] = await world.linesOf(charge.id);
    const part = (cents?: number) =>
      world.invoice({
        lines: [{ chargeLineId: line?.id ?? '', ...(cents ? { amountCents: cents } : {}) }],
        recipient: { kind: 'patient' },
      });

    const first = await part(1_200_000);
    expect(first.statusCode, first.body).toBe(202);
    expect((await world.chargeOf(charge.id)).invoicing).toBe('partly_invoiced');
    const second = await part(800_000);
    expect(second.statusCode, second.body).toBe(202);
    expect((await world.chargeOf(charge.id)).invoicing).toBe('invoiced');

    const third = await part(1);
    expect(third.statusCode).toBe(409);
    expect(problem(third).code).toBe('invoice_line_over_invoiced');
    // A part above what is left of an untouched line is refused as well.
    const other = await world.charge();
    const [fresh] = await world.linesOf(other.id);
    const over = await world.invoice({
      lines: [{ chargeLineId: fresh?.id ?? '', amountCents: 2_000_001 }],
      recipient: { kind: 'patient' },
    });
    expect(over.statusCode).toBe(409);
    expect(problem(over).code).toBe('invoice_line_over_invoiced');
  });

  it('keeps a request of the same key and the same lines as one invoice, and refuses the key for another request', async () => {
    const charge = await world.charge();
    const [line] = await world.linesOf(charge.id);
    const key = '0190a000-0000-7000-8000-00000000d001';
    const body = {
      idempotencyKey: key,
      lines: [{ chargeLineId: line?.id ?? '' }],
      recipient: { kind: 'patient' as const },
    };

    const first = await world.invoice(body);
    const replay = await world.invoice(body);
    const other = await world.invoice({
      ...body,
      lines: [{ chargeLineId: line?.id ?? '', amountCents: 5 }],
    });

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.json<InvoiceDto>().id).toBe(first.json<InvoiceDto>().id);
    expect(jobsFor(first.json<InvoiceDto>().id)).toHaveLength(1);
    expect(other.statusCode).toBe(409);
    expect(problem(other).code).toBe('idempotency_key_reused');
  });

  it('describes a line with generic wording, never with what a person typed on the charge', async () => {
    const charge = await world.charge();
    await world.api.post(`/billing/charges/${charge.id}/lines`, world.reception, {
      description: 'Estudio de HIV',
      amountCents: 300_000,
    });
    const lines = await world.linesOf(charge.id);

    const response = await world.invoice({
      lines: lines.map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'patient' },
    });

    expect(response.statusCode, response.body).toBe(202);
    const wording = response.json<InvoiceDto>().lines.map((line) => line.description);
    expect(wording).toEqual(['Consulta', 'Otros conceptos']);
    expect(wording.join(' ')).not.toMatch(/HIV/);
  });
});

describe('a payer as the recipient of its portion', () => {
  it('invoices the payer portion only, addressed to the payer with its CUIT', async () => {
    const charge = await coveredCharge();
    const lines = await world.linesOf(charge.id);
    const payerLines = lines.filter((line) => line.portion === 'payer');

    const response = await world.invoice({
      lines: payerLines.map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'payer' },
    });

    expect(response.statusCode, response.body).toBe(202);
    const created = response.json<InvoiceDto>();
    expect(created.totalCents).toBe(charge.payerCents);
    expect(created.totalCents).toBe(1_500_000);
    expect(created.recipient).toMatchObject({
      kind: 'payer',
      tenantPayerId: osde.id,
      patientId: null,
      name: 'OSDE Facturable',
      document: { type: 'cuit', number: '30708578335' },
    });
    // The patient portion is still open.
    const after = await world.chargeOf(charge.id);
    expect(after.invoicedCents).toBe(1_500_000);
    expect(after.invoicing).toBe('partly_invoiced');
  });

  it('refuses to mix the payer portion and the patient portion in one invoice', async () => {
    const charge = await coveredCharge();
    const lines = await world.linesOf(charge.id);

    for (const kind of ['patient', 'payer'] as const) {
      const response = await world.invoice({
        lines: lines.map((line) => ({ chargeLineId: line.id })),
        recipient: { kind },
      });
      expect(response.statusCode, `${kind}: ${response.body}`).toBe(422);
      expect(problem(response).code).toBe('invoice_lines_mixed');
    }
    expect((await world.chargeOf(charge.id)).invoicedCents).toBe(0);
  });

  it('refuses lines of two different patients in one invoice', async () => {
    const one = await world.charge();
    const two = await world.charge();
    const [lineOne] = await world.linesOf(one.id);
    const [lineTwo] = await world.linesOf(two.id);

    const response = await world.invoice({
      lines: [{ chargeLineId: lineOne?.id ?? '' }, { chargeLineId: lineTwo?.id ?? '' }],
      recipient: { kind: 'patient' },
    });

    expect(response.statusCode).toBe(422);
    expect(problem(response).code).toBe('invoice_lines_mixed');
  });

  it('asks for the payer CUIT when the organization has not entered it', async () => {
    const catalogId = await world.catalogPayer(
      'invoice-create-sin-cuit',
      'Prepaga sin CUIT',
      'prepaga',
    );
    const payer = (
      await world.api.post('/billing/payers', world.owner, { payerId: catalogId })
    ).json<TenantPayerDto>();
    await world.api.post('/billing/payer-prices', world.owner, {
      tenantPayerId: payer.id,
      appointmentTypeId: world.consulta,
      payerAmountCents: 1_000_000,
      copagoCents: 0,
      plusCents: 0,
      effectiveFrom: '2031-01-01',
    });
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: catalogId });
    const charge = await world.charge({ patientId });
    const payerLine = (await world.linesOf(charge.id)).find((line) => line.portion === 'payer');

    const response = await world.invoice({
      lines: [{ chargeLineId: payerLine?.id ?? '' }],
      recipient: { kind: 'payer' },
    });

    expect(response.statusCode).toBe(409);
    expect(problem(response).code).toBe('invoice_payer_cuit_required');
  });
});

describe('the type of the invoice comes from the rules (spec "Invoice type selection")', () => {
  it('is a Factura C for a monotributista, and a Factura A is refused whatever the screen sends', async () => {
    const charge = await world.charge();

    const forced = await world.invoiceCharge(charge, { type: 'FA' });

    expect(forced.statusCode).toBe(400);
    expect(problem(forced).errors).toEqual([
      expect.objectContaining({ path: 'type', i18nKey: 'country.ar.invoice.type_forbidden' }),
    ]);
    expect((await world.chargeOf(charge.id)).invoicedCents).toBe(0);
    const allowed = await world.invoiceCharge(charge, { type: 'FC' });
    expect(allowed.statusCode, allowed.body).toBe(202);
    expect(allowed.json<InvoiceDto>().type).toBe('FC');
  });

  it('is a Factura B for a consumer and a Factura A for a responsable inscripto with a CUIT, from a responsable inscripto', async () => {
    await world.setTaxCondition('responsable_inscripto');
    try {
      const consumer = await world.charge();
      const toConsumer = await world.invoiceCharge(consumer);
      expect(toConsumer.statusCode, toConsumer.body).toBe(202);
      expect(toConsumer.json<InvoiceDto>()).toMatchObject({
        type: 'FB',
        netCents: 0,
        vatCents: 0,
        exemptCents: 2_000_000,
      });

      const company = await world.charge();
      const toCompany = await world.invoiceCharge(company, {
        recipient: {
          kind: 'patient',
          taxCondition: 'responsable_inscripto',
          name: 'Clínica del Sur S.A.',
          document: { type: 'cuit', number: '30-71234567-1' },
        },
      });
      expect(toCompany.statusCode, toCompany.body).toBe(202);
      expect(toCompany.json<InvoiceDto>()).toMatchObject({
        type: 'FA',
        recipient: {
          taxCondition: 'responsable_inscripto',
          name: 'Clínica del Sur S.A.',
          document: { type: 'cuit', number: '30712345671' },
        },
      });

      // Factura A without the CUIT of the recipient: refused, asking for the missing data.
      const missing = await world.charge();
      const refused = await world.invoiceCharge(missing, {
        recipient: { kind: 'patient', taxCondition: 'responsable_inscripto' },
      });
      expect(refused.statusCode).toBe(400);
      expect(problem(refused).errors).toEqual([
        expect.objectContaining({
          path: 'recipient',
          i18nKey: 'country.ar.invoice.recipient_cuit_required',
        }),
      ]);
    } finally {
      await world.setTaxCondition('monotributo');
    }
  });

  it('refuses a document that is not valid for the recipient', async () => {
    const charge = await world.charge();

    const response = await world.invoiceCharge(charge, {
      recipient: { kind: 'patient', document: { type: 'dni', number: '12AB' } },
    });

    expect(response.statusCode).toBe(400);
    expect(problem(response).errors).toEqual([
      expect.objectContaining({ path: 'recipient', i18nKey: 'country.ar.national_id.invalid' }),
    ]);
  });
});

describe('what stops an invoice before it is created', () => {
  it('refuses a voided charge, which is final', async () => {
    const charge = await world.charge();
    const voided = await world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Cargado por error',
    });
    expect(voided.statusCode, voided.body).toBe(200);

    const response = await world.invoiceCharge(charge);

    // The lines of a voided charge are not invoiceable even though nothing is invoiced of them.
    expect(response.statusCode).toBe(409);
    expect(problem(response).code).toBe('invoice_charge_voided');
  });

  it('is blocked while e-invoicing is off, saying why, and works again when it is on', async () => {
    const charge = await world.charge();
    await world.switchEinvoicing(false);
    try {
      const response = await world.invoiceCharge(charge);

      expect(response.statusCode).toBe(409);
      expect(problem(response)).toMatchObject({
        code: 'invoicing_not_ready',
        errors: [expect.objectContaining({ i18nKey: 'invoicing.not_ready.disabled' })],
      });
    } finally {
      await world.switchEinvoicing(true);
    }
    expect((await world.invoiceCharge(charge)).statusCode).toBe(202);
  });

  it('needs a point of sale to be chosen when it is not clear which one', async () => {
    const charge = await world.charge();

    const unknown = await world.invoiceCharge(charge, { pointOfSale: 77 });

    expect(unknown.statusCode).toBe(422);
    expect(problem(unknown).code).toBe('invoice_point_of_sale_invalid');
    const chosen = await world.invoiceCharge(charge, { pointOfSale: 1 });
    expect(chosen.statusCode, chosen.body).toBe(202);
  });

  it('lets reception create invoices only over the lines of its own locations', async () => {
    const charge = await world.charge();
    const assign = (locationIds: string[]) =>
      world.api.put(`/members/${world.reception.membershipId}/locations`, world.owner, {
        locationIds,
      });
    expect((await assign([world.norte])).statusCode).toBe(200);
    try {
      const outside = await world.invoiceCharge(charge);
      // A line the caller cannot see answers like one that does not exist.
      expect(outside.statusCode).toBe(404);
      expect((await world.chargeOf(charge.id)).invoicedCents).toBe(0);
    } finally {
      await assign([world.centro]);
    }
    expect((await world.invoiceCharge(charge)).statusCode).toBe(202);
  });

  it('is for owner, admin and reception: a professional is denied and the denial is audited', async () => {
    const charge = await world.charge();
    const denied = (await auditRows('access.denied')).length;

    const response = await world.invoiceCharge(charge, {}, world.doctor);

    expect(response.statusCode).toBe(403);
    expect((await auditRows('access.denied')).length).toBe(denied + 1);
    expect((await world.invoiceCharge(charge, {}, world.admin)).statusCode).toBe(202);
    expect((await world.api.post('/invoices', null, {})).statusCode).toBe(401);
  });
});

describe('invoices never exceed the lines, whatever the order and the number of requests', () => {
  it('holds under concurrent requests over the same line (property test)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 2_500_000 }), { minLength: 2, maxLength: 5 }),
        async (amounts) => {
          const charge = await world.charge();
          const [line] = await world.linesOf(charge.id);
          const responses = await Promise.all(
            amounts.map((amountCents) =>
              world.invoice({
                lines: [{ chargeLineId: line?.id ?? '', amountCents }],
                recipient: { kind: 'patient' },
              }),
            ),
          );

          const accepted = responses.flatMap((response) =>
            response.statusCode === 202 ? [response.json<InvoiceDto>()] : [],
          );
          const refused = responses.filter((response) => response.statusCode !== 202);
          const covered = accepted.reduce((sum, entry) => sum + entry.totalCents, 0);
          const after = await world.chargeOf(charge.id);

          // Never above the line, and the line says exactly what the accepted invoices cover.
          expect(covered).toBeLessThanOrEqual(2_000_000);
          expect(after.invoicedCents).toBe(covered);
          for (const response of refused) {
            expect(response.statusCode).toBe(409);
            expect(problem(response).code).toBe('invoice_line_over_invoiced');
          }
        },
      ),
      { numRuns: 8 },
    );
  }, 120_000);
});
