import type { InvoiceDto, Problem } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * Credit notes (S4.10, task 4.45, spec "Credit notes"): the matching letter, partial or total, a
 * cumulative amount that never goes above the invoice, a reason, its own CAE through the issuer, the
 * invoiced balance of the charge, the void rule of billing, and owner and admin only.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'credit-note' });
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

const problem = (response: LightMyRequestResponse) => response.json<Problem>();

describe('a total credit note', () => {
  it('cancels an issued Factura C with a Nota de Credito C of its own, and leaves the invoice unchanged', async () => {
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);
    expect(original).toMatchObject({ status: 'issued', type: 'FC', totalCents: 2_000_000 });

    const response = await world.creditNote(original.id, {
      reason: 'Error en la carga del importe',
    });

    expect(response.statusCode, response.body).toBe(202);
    const note = response.json<InvoiceDto>();
    expect(note).toMatchObject({
      kind: 'credit_note',
      type: 'NCC',
      status: 'pending',
      creditNoteOfId: original.id,
      reason: 'Error en la carga del importe',
      totalCents: 2_000_000,
      recipient: original.recipient,
    });
    // Until the note is issued, the charge still counts as invoiced.
    expect((await world.chargeOf(charge.id)).invoicedCents).toBe(2_000_000);

    await world.runIssue();
    const issued = await world.getInvoice(note.id);
    expect(issued).toMatchObject({ status: 'issued', type: 'NCC' });
    expect(issued.cae).toMatch(/^\d{14}$/);
    expect(issued.number).toBeGreaterThan(0);
    // Its own voucher: another number and another CAE than the invoice it cancels.
    expect(issued.cae).not.toBe(original.cae);
    expect(world.issuer.vouchers().filter((voucher) => voucher.type === 'NCC')).toHaveLength(1);

    const after = await world.getInvoice(original.id);
    expect(after).toMatchObject({
      status: 'issued',
      cae: original.cae,
      number: original.number,
      totalCents: 2_000_000,
      creditedCents: 2_000_000,
    });
    const settled = await world.chargeOf(charge.id);
    expect(settled.invoicedCents).toBe(0);
    expect(settled.invoicing).toBe('not_invoiced');
    expect(await auditRows('invoice.credit_note')).toEqual(
      expect.arrayContaining([expect.objectContaining({ resourceId: note.id, outcome: 'allow' })]),
    );
  });

  it('is the whole of what is left when earlier notes took part of the invoice', async () => {
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);
    expect((await world.creditNote(original.id, { amountCents: 500_000 })).statusCode).toBe(202);

    const rest = await world.creditNote(original.id);

    expect(rest.statusCode, rest.body).toBe(202);
    expect(rest.json<InvoiceDto>().totalCents).toBe(1_500_000);
  });
});

describe('the cumulative limit', () => {
  it('refuses a note that would go above the invoice, counting the notes that are still pending', async () => {
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);

    const first = await world.creditNote(original.id, { amountCents: 1_500_000 });
    expect(first.statusCode, first.body).toBe(202);
    // Still pending: it counts already.
    const over = await world.creditNote(original.id, { amountCents: 800_000 });
    expect(over.statusCode).toBe(409);
    expect(problem(over).code).toBe('invoice_credit_note_exceeds');
    await world.runIssue();
    const overAfterIssue = await world.creditNote(original.id, { amountCents: 800_000 });
    expect(overAfterIssue.statusCode).toBe(409);

    const exact = await world.creditNote(original.id, { amountCents: 500_000 });
    expect(exact.statusCode, exact.body).toBe(202);
    const nothingLeft = await world.creditNote(original.id, { amountCents: 1 });
    expect(nothingLeft.statusCode).toBe(409);
    const total = await world.creditNote(original.id);
    expect(total.statusCode).toBe(409);
    expect((await world.getInvoice(original.id)).creditedCents).toBe(2_000_000);
  });

  it('does not count a rejected note: the balance is free again', async () => {
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);
    await world.runIssue();
    const note = (await world.creditNote(original.id)).json<InvoiceDto>();
    world.issuer.setMode('reject_next');
    await world.runIssue();
    expect((await world.getInvoice(note.id)).status).toBe('rejected');
    // A rejected note released nothing and took nothing.
    expect((await world.chargeOf(charge.id)).invoicedCents).toBe(2_000_000);

    const again = await world.creditNote(original.id);

    expect(again.statusCode, again.body).toBe(202);
  });

  it('splits a partial note over the lines of an invoice of two charges, in proportion', async () => {
    const first = await world.charge();
    const second = await world.charge({ patientId: first.patientId });
    const [lineOne] = await world.linesOf(first.id);
    const [lineTwo] = await world.linesOf(second.id);
    const created = await world.invoice({
      lines: [{ chargeLineId: lineOne?.id ?? '' }, { chargeLineId: lineTwo?.id ?? '' }],
      recipient: { kind: 'patient' },
    });
    const original = created.json<InvoiceDto>();
    await world.runIssue();

    const note = await world.creditNote(original.id, { amountCents: 1_000_000 });

    expect(note.statusCode, note.body).toBe(202);
    expect(note.json<InvoiceDto>().lines.map((line) => line.amountCents)).toEqual([
      500_000, 500_000,
    ]);
    await world.runIssue();
    expect((await world.chargeOf(first.id)).invoicedCents).toBe(1_500_000);
    expect((await world.chargeOf(second.id)).invoicedCents).toBe(1_500_000);
  });
});

describe('what can have a credit note', () => {
  it('is an issued invoice: not a pending one, not a credit note, not a stranger', async () => {
    const charge = await world.charge();
    await world.issueInvoiceOf(charge);
    // Asked for after the round of jobs above, so it is still waiting for its turn.
    const pendingCharge = await world.charge();
    const pending = (await world.invoiceCharge(pendingCharge)).json<InvoiceDto>();

    const onPending = await world.creditNote(pending.id);
    expect(onPending.statusCode).toBe(409);
    expect(problem(onPending).code).toBe('invoice_credit_note_not_applicable');

    await world.runIssue();
    const note = (await world.creditNote(pending.id)).json<InvoiceDto>();
    await world.runIssue();
    const onNote = await world.creditNote(note.id);
    expect(onNote.statusCode).toBe(409);
    expect(problem(onNote).code).toBe('invoice_credit_note_not_applicable');

    const unknown = await world.creditNote('0190a000-0000-7000-8000-00000000ffff');
    expect(unknown.statusCode).toBe(404);
  });

  it('has the letter of the invoice: a Factura B has a Nota de Credito B', async () => {
    await world.setTaxCondition('responsable_inscripto');
    try {
      const charge = await world.charge();
      const original = await world.issueInvoiceOf(charge);
      expect(original.type).toBe('FB');

      const note = (await world.creditNote(original.id)).json<InvoiceDto>();

      expect(note.type).toBe('NCB');
      expect(note.recipient).toEqual(original.recipient);
    } finally {
      await world.setTaxCondition('monotributo');
    }
  });

  it('needs a reason', async () => {
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);

    const blank = await world.api.post(`/invoices/${original.id}/credit-notes`, world.owner, {
      idempotencyKey: '0190a000-0000-7000-8000-00000000c001',
      reason: ' ',
    });
    const missing = await world.api.post(`/invoices/${original.id}/credit-notes`, world.owner, {
      idempotencyKey: '0190a000-0000-7000-8000-00000000c002',
    });

    expect(blank.statusCode).toBe(400);
    expect(missing.statusCode).toBe(400);
  });

  it('is one note for one key, and refuses the key for another note', async () => {
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);
    const key = '0190a000-0000-7000-8000-00000000c010';

    const first = await world.creditNote(original.id, {
      idempotencyKey: key,
      amountCents: 100_000,
    });
    const replay = await world.creditNote(original.id, {
      idempotencyKey: key,
      amountCents: 100_000,
    });
    const other = await world.creditNote(original.id, {
      idempotencyKey: key,
      amountCents: 200_000,
    });

    expect(replay.json<InvoiceDto>().id).toBe(first.json<InvoiceDto>().id);
    expect(other.statusCode).toBe(409);
    expect(problem(other).code).toBe('idempotency_key_reused');
    expect((await world.getInvoice(original.id)).creditedCents).toBe(100_000);
  });
});

describe('who may issue a credit note', () => {
  it('is for owner and admin: reception is denied and the denial is audited', async () => {
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);
    const denied = (await auditRows('access.denied')).length;
    const issued = (await auditRows('invoice.credit_note')).length;

    const refused = await world.creditNote(original.id, {}, world.reception);

    expect(refused.statusCode).toBe(403);
    expect((await auditRows('access.denied')).length).toBe(denied + 1);
    expect((await auditRows('invoice.credit_note')).length).toBe(issued);
    expect((await world.getInvoice(original.id)).creditedCents).toBe(0);
    const byAdmin = await world.creditNote(original.id, { amountCents: 100_000 }, world.admin);
    expect(byAdmin.statusCode, byAdmin.body).toBe(202);
  });
});

describe('voiding a charge that has an invoice (billing-payments, "Void a charge")', () => {
  const voidCharge = (chargeId: string) =>
    world.api.post(`/billing/charges/${chargeId}/void`, world.owner, {
      reason: 'Cargado por error',
    });

  it('is refused while an issued invoice stands over it, and allowed once a credit note took it all back', async () => {
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);

    const refused = await voidCharge(charge.id);
    expect(refused.statusCode).toBe(409);
    expect(problem(refused).code).toBe('charge_has_invoice');

    // A partial note is not enough.
    await world.creditNote(original.id, { amountCents: 1_500_000 });
    await world.runIssue();
    expect((await voidCharge(charge.id)).statusCode).toBe(409);

    await world.creditNote(original.id);
    // Pending notes release nothing: only an issued note does.
    expect((await voidCharge(charge.id)).statusCode).toBe(409);
    await world.runIssue();
    const allowed = await voidCharge(charge.id);
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('is refused while the invoice is pending (it will be issued) and allowed after a rejection', async () => {
    await world.runIssue();
    const charge = await world.charge();
    await world.invoiceCharge(charge);
    expect((await voidCharge(charge.id)).statusCode).toBe(409);

    world.issuer.setMode('reject_next');
    await world.runIssue();

    const allowed = await voidCharge(charge.id);
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('is not blocked for a charge nobody invoiced', async () => {
    const charge = await world.charge();

    expect((await voidCharge(charge.id)).statusCode).toBe(200);
  });
});
