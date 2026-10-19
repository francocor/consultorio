import type { ChargeDto, InvoiceDto, Problem, TenantPayerDto } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { nextCuit } from '../../src/adapters/invoice-issuer.contract.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { tenantPayer } from '../../src/db/schema/billing-pricing.js';
import { worklistItem } from '../../src/db/schema/worklist.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { submissionKey } from '../support/billing-world.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * Judgment day, Stage 4, round 2: finding R2-6 (what a manual voucher may replace), R2-2 (a manual
 * voucher in place of an invoice whose outcome is unknown) and the suspect B-S1 (the worklist item of a
 * parked invoice closes when the invoice is replaced).
 */

let runtime: DbHandle;
let world: InvoicingWorld;
let osde: TenantPayerDto;
let osdeCatalogId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-replacement' });
  osdeCatalogId = await world.catalogPayer('invoice-replacement-osde', 'OSDE Reemplazos');
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

const problem = (response: LightMyRequestResponse) => response.json<Problem>();
const after = (base: number, minutes: number) => () => new Date(base + minutes * 60_000);

const auditRows = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action as never)))
      .orderBy(desc(auditEvent.occurredAt)),
  );

const attentionItems = (invoiceId: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(worklistItem)
      .where(
        and(eq(worklistItem.kind, 'invoice_attention'), eq(worklistItem.subjectId, invoiceId)),
      ),
  );

/** Settles what other tests left, then asks for an invoice of a new charge (its job is not run). */
async function requested(extra: Record<string, unknown> = {}) {
  world.issuer.setMode('ok');
  await world.runIssue();
  const charge: ChargeDto = await world.charge();
  const response = await world.invoiceCharge(charge, extra);
  expect(response.statusCode, response.body).toBe(202);
  return { charge, created: response.json<InvoiceDto>(), t0: Date.now() };
}

async function replaceBody(
  charge: ChargeDto,
  replaces: string,
  extra: Record<string, unknown> = {},
) {
  const lines = (await world.linesOf(charge.id)).filter((line) => line.portion === 'patient');
  return {
    idempotencyKey: submissionKey(),
    type: 'FC',
    pointOfSale: 1,
    number: 800_000 + Math.floor(Math.random() * 1e5),
    cae: String(73_000_000_000_000 + Math.floor(Math.random() * 1e9)),
    issueDate: '2031-05-20',
    caeExpiresOn: '2031-05-30',
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    lines: lines.map((line) => ({ chargeLineId: line.id })),
    recipient: { kind: 'patient' },
    replacesInvoiceId: replaces,
    ...extra,
  };
}

const manual = (body: Record<string, unknown>) =>
  world.api.post('/invoices/manual', world.admin, body);

describe('what a manual voucher may replace (JD-S4 R2-6)', () => {
  it('refuses a credit note, even one over the same lines', async () => {
    const charge = await world.charge();
    const issued = await world.issueInvoiceOf(charge);
    const note = await world.creditNote(issued.id);
    expect(note.statusCode, note.body).toBe(202);

    const response = await manual(await replaceBody(charge, note.json<InvoiceDto>().id));

    expect(response.statusCode, response.body).toBe(409);
    expect(problem(response).code).toBe('invoice_replacement_mismatch');
    expect((await world.rowOf(note.json<InvoiceDto>().id)).status).toBe('pending');
  });

  it('refuses a voucher of another total', async () => {
    const { charge, created } = await requested();
    const [line] = (await world.linesOf(charge.id)).filter(
      (candidate) => candidate.portion === 'patient',
    );

    const response = await manual(
      await replaceBody(charge, created.id, {
        totalCents: 500_000,
        lines: [{ chargeLineId: line?.id, amountCents: 500_000 }],
      }),
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(problem(response).code).toBe('invoice_replacement_mismatch');
    expect((await world.rowOf(created.id)).status).toBe('pending');
  });

  it('refuses a voucher for another recipient document', async () => {
    const { charge, created } = await requested({
      recipient: { kind: 'patient', document: { type: 'dni', number: '30111222' } },
    });

    const response = await manual(
      await replaceBody(charge, created.id, {
        recipient: { kind: 'patient', document: { type: 'dni', number: '30999888' } },
      }),
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(problem(response).code).toBe('invoice_replacement_mismatch');
    expect((await world.rowOf(created.id)).status).toBe('pending');
  });

  it('refuses a voucher of another type than the invoice it replaces', async () => {
    const { charge, created } = await requested();
    // The organization became a responsable inscripto after the invoice was requested as a monotributo.
    await world.setTaxCondition('responsable_inscripto');

    try {
      const response = await manual(await replaceBody(charge, created.id, { type: 'FB' }));

      expect(response.statusCode, response.body).toBe(409);
      expect(problem(response).code).toBe('invoice_replacement_mismatch');
    } finally {
      await world.setTaxCondition('monotributo');
    }
    expect((await world.rowOf(created.id)).status).toBe('pending');
  });

  it('still replaces an invoice with a voucher of the same type, total, lines and recipient', async () => {
    const { charge, created } = await requested({
      recipient: { kind: 'patient', document: { type: 'dni', number: '30111222' } },
    });

    const response = await manual(
      await replaceBody(charge, created.id, {
        recipient: { kind: 'patient', document: { type: 'dni', number: '30111222' } },
      }),
    );

    expect(response.statusCode, response.body).toBe(201);
    expect((await world.rowOf(created.id)).status).toBe('rejected');
  });
});

describe('the recipient of an invoice to a payer whose CUIT was corrected meanwhile (JD-S4 R3-B-T1)', () => {
  it('still replaces the invoice: the payer is the same, only its document moved', async () => {
    world.issuer.setMode('ok');
    await world.runIssue();
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeCatalogId });
    const charge = await world.charge({ patientId });
    const payerLines = (await world.linesOf(charge.id)).filter((line) => line.portion === 'payer');
    const requestedInvoice = await world.invoice({
      lines: payerLines.map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'payer' },
    });
    expect(requestedInvoice.statusCode, requestedInvoice.body).toBe(202);
    const created = requestedInvoice.json<InvoiceDto>();
    // The CUIT of the payer was wrong and is corrected after the invoice was requested.
    await world.inTenant((tx) =>
      tx.update(tenantPayer).set({ cuit: nextCuit() }).where(eq(tenantPayer.id, osde.id)),
    );

    try {
      const response = await manual({
        ...(await replaceBody(charge, created.id)),
        totalCents: payerLines.reduce((sum, line) => sum + line.amountCents, 0),
        lines: payerLines.map((line) => ({ chargeLineId: line.id })),
        recipient: { kind: 'payer' },
      });

      expect(response.statusCode, response.body).toBe(201);
      expect((await world.rowOf(created.id)).status).toBe('rejected');
    } finally {
      await world.inTenant((tx) =>
        tx.update(tenantPayer).set({ cuit: '30708578335' }).where(eq(tenantPayer.id, osde.id)),
      );
    }
  });
});

describe('a manual voucher in place of an invoice whose outcome is unknown (JD-S4 R2-2)', () => {
  async function lostAnswer() {
    const asked = await requested();
    world.issuer.setMode('timeout_after_authorize');
    await world.runIssue(after(asked.t0, 0));
    const row = await world.rowOf(asked.created.id);
    expect(row).toMatchObject({ deliveryState: 'awaiting_reconciliation' });
    return { ...asked, expectedNumber: row.expectedNumber };
  }

  it('still refuses without the acknowledgement', async () => {
    const { charge, created, t0 } = await lostAnswer();

    const response = await manual(await replaceBody(charge, created.id));

    expect(response.statusCode, response.body).toBe(409);
    expect(problem(response).code).toBe('invoice_awaiting_reconciliation');
    expect((await world.rowOf(created.id)).status).toBe('pending');
    await world.sweep(after(t0, 1));
  });

  it('replaces it when the owner or an admin acknowledges that the outcome is unknown, and audits it', async () => {
    const { charge, created, expectedNumber } = await lostAnswer();

    const response = await manual(
      await replaceBody(charge, created.id, { acknowledgeUnknownOutcome: true }),
    );

    expect(response.statusCode, response.body).toBe(201);
    expect(await world.rowOf(created.id)).toMatchObject({
      status: 'rejected',
      deliveryState: null,
      expectedNumber: null,
    });
    const [entry] = (await auditRows('invoice.replaced_unresolved')).filter(
      (row) => row.resourceId === created.id,
    );
    expect(entry?.metadata).toMatchObject({
      type: 'FC',
      pointOfSale: 1,
      expectedNumber,
      replacedByManual: true,
    });
    // A person is told to look for a voucher at that number in ARCA: it may exist.
    const [item] = await attentionItems(created.id);
    expect(item).toMatchObject({ subjectType: 'invoice', status: 'open' });
  });

  it('does not let reception replace it, acknowledged or not', async () => {
    const { charge, created, t0 } = await lostAnswer();

    const response = await world.api.post(
      '/invoices/manual',
      world.reception,
      await replaceBody(charge, created.id, { acknowledgeUnknownOutcome: true }),
    );

    expect(response.statusCode, response.body).toBe(403);
    expect((await world.rowOf(created.id)).status).toBe('pending');
    await world.sweep(after(t0, 1));
  });

  it('writes no "unresolved" entry when the outcome was not in doubt', async () => {
    const { charge, created } = await requested();

    const response = await manual(
      await replaceBody(charge, created.id, { acknowledgeUnknownOutcome: true }),
    );

    expect(response.statusCode, response.body).toBe(201);
    expect(
      (await auditRows('invoice.replaced_unresolved')).filter(
        (row) => row.resourceId === created.id,
      ),
    ).toEqual([]);
  });

  it('can be replaced without the acknowledgement once the authority was asked, found nothing and then was down', async () => {
    const { charge, created, t0 } = await lostAnswer();
    // The authority is asked and has issued nothing since the mark; the request then fails for sure.
    const mark = (await world.rowOf(created.id)).authorityLastAtMark ?? 0;
    const probe = vi
      .spyOn(world.issuer, 'lastAuthorized')
      .mockResolvedValueOnce({ status: 'ok', number: mark });
    world.issuer.setMode('down');

    try {
      const results = await world.sweep(after(t0, 1));

      expect(results).toContainEqual({ invoiceId: created.id, outcome: 'retry' });
    } finally {
      probe.mockRestore();
      world.issuer.setMode('ok');
    }
    expect(await world.rowOf(created.id)).toMatchObject({
      deliveryState: 'retrying',
      expectedNumber: null,
    });

    const response = await manual(await replaceBody(charge, created.id));

    expect(response.statusCode, response.body).toBe(201);
  });
});

describe('the worklist item of an invoice that was parked (JD-S4 B-S1)', () => {
  it('is closed when the invoice is replaced by the voucher registered by hand', async () => {
    const takenBy = await world.issueInvoiceOf(await world.charge());
    const { charge, created, t0 } = await requested();
    const issue = vi.spyOn(world.issuer, 'issue').mockResolvedValueOnce({
      status: 'issued',
      number: takenBy.number ?? 0,
      cae: '70555555555555',
      caeExpiresOn: '2031-06-01',
    });
    try {
      await world.runIssue(after(t0, 0));
    } finally {
      issue.mockRestore();
    }
    expect(await world.rowOf(created.id)).toMatchObject({ deliveryState: 'needs_attention' });
    expect(await attentionItems(created.id)).toMatchObject([{ status: 'open' }]);

    const response = await manual(await replaceBody(charge, created.id));

    expect(response.statusCode, response.body).toBe(201);
    expect(await attentionItems(created.id)).toMatchObject([
      { status: 'resolved', resolution: 'replaced_by_manual' },
    ]);
    expect(await world.rowOf(created.id)).toMatchObject({ status: 'rejected' });
  });
});
