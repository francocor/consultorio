import type { InvoiceDto, Problem } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * Rejected attempts and the rule that an authorized invoice is never voided (S4.10, task 4.46, spec
 * "Voided and rejected invoices"): a rejection keeps the message of the authority, carries no CAE and
 * releases the lines; a retry is a new attempt linked to the old one; a CAE is taken back only by a
 * credit note.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-rejection' });
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

/** Asks for an invoice and has the authority reject it. */
async function rejectedInvoice() {
  // The invoices other tests left waiting are submitted first: the rejection is for this one.
  await world.runIssue();
  const charge = await world.charge();
  const created = (await world.invoiceCharge(charge)).json<InvoiceDto>();
  world.issuer.setMode('reject_next');
  await world.runIssue();
  return { charge, rejected: await world.getInvoice(created.id) };
}

describe('an invoice the authority rejects', () => {
  it('is kept as a rejected attempt with the message, no CAE and no number, and releases its lines', async () => {
    await world.runIssue();
    const charge = await world.charge();
    const created = (await world.invoiceCharge(charge)).json<InvoiceDto>();
    expect((await world.chargeOf(charge.id)).invoicedCents).toBe(2_000_000);
    world.issuer.setMode('reject_next');

    await world.runIssue();

    const rejected = await world.getInvoice(created.id);
    expect(rejected).toMatchObject({
      status: 'rejected',
      cae: null,
      number: null,
      caeExpiresOn: null,
      issuedAt: null,
      ageMinutes: null,
      outageFlag: false,
    });
    expect(rejected.rejectionMessage).toMatch(/simulad/i);
    // The charge remains not invoiced, and nothing was issued by the authority.
    const after = await world.chargeOf(charge.id);
    expect(after.invoicedCents).toBe(0);
    expect(after.invoicing).toBe('not_invoiced');
    expect(world.issuer.vouchers()).toHaveLength(0);
    expect(await auditRows('invoice.rejected')).toEqual(
      expect.arrayContaining([expect.objectContaining({ resourceId: created.id })]),
    );
  });

  it('does not count in what the charge says is invoiced, and the lines can be invoiced again', async () => {
    const { charge } = await rejectedInvoice();

    const again = await world.invoiceCharge(charge);

    expect(again.statusCode, again.body).toBe(202);
  });
});

describe('the retry of a rejected attempt', () => {
  it('creates a new attempt linked to the old one, and the old one stays rejected', async () => {
    const { charge, rejected } = await rejectedInvoice();

    const retry = await world.invoiceCharge(charge, { previousAttemptId: rejected.id });

    expect(retry.statusCode, retry.body).toBe(202);
    const second = retry.json<InvoiceDto>();
    expect(second).toMatchObject({ status: 'pending', previousAttemptId: rejected.id });
    expect(second.id).not.toBe(rejected.id);
    expect(await auditRows('invoice.retried')).toEqual(
      expect.arrayContaining([expect.objectContaining({ resourceId: second.id })]),
    );

    await world.runIssue();
    expect(await world.getInvoice(second.id)).toMatchObject({
      status: 'issued',
      previousAttemptId: rejected.id,
    });
    expect(await world.getInvoice(rejected.id)).toMatchObject({
      status: 'rejected',
      cae: null,
    });
    expect((await world.chargeOf(charge.id)).invoicedCents).toBe(2_000_000);
  });

  it('is allowed once per rejected attempt', async () => {
    const { charge, rejected } = await rejectedInvoice();
    const first = await world.invoiceCharge(charge, { previousAttemptId: rejected.id });
    expect(first.statusCode, first.body).toBe(202);
    world.issuer.setMode('reject_next');
    await world.runIssue();
    expect((await world.getInvoice(first.json<InvoiceDto>().id)).status).toBe('rejected');

    // The first attempt has its successor already, even though that one was rejected too.
    const repeated = await world.invoiceCharge(charge, { previousAttemptId: rejected.id });
    expect(repeated.statusCode).toBe(409);
    expect(problem(repeated).code).toBe('invoice_not_rejected');

    // The chain goes on from the last rejected attempt.
    const next = await world.invoiceCharge(charge, {
      previousAttemptId: first.json<InvoiceDto>().id,
    });
    expect(next.statusCode, next.body).toBe(202);
  });

  it('is for an attempt that was rejected, not for a pending or an issued invoice', async () => {
    const charge = await world.charge();
    const pending = (await world.invoiceCharge(charge)).json<InvoiceDto>();
    const other = await world.charge();

    const onPending = await world.invoiceCharge(other, { previousAttemptId: pending.id });
    expect(onPending.statusCode).toBe(409);
    expect(problem(onPending).code).toBe('invoice_not_rejected');

    await world.runIssue();
    const onIssued = await world.invoiceCharge(other, { previousAttemptId: pending.id });
    expect(onIssued.statusCode).toBe(409);
    expect(problem(onIssued).code).toBe('invoice_not_rejected');

    const stranger = await world.invoiceCharge(other, {
      previousAttemptId: '0190a000-0000-7000-8000-00000000ffff',
    });
    expect(stranger.statusCode).toBe(404);
    expect((await world.chargeOf(other.id)).invoicedCents).toBe(0);
  });
});

describe('an authorized invoice is not voided or deleted (spec "Voided and rejected invoices")', () => {
  it('refuses to void an invoice with a CAE and points at the credit note', async () => {
    const charge = await world.charge();
    const issued = await world.issueInvoiceOf(charge);
    expect(issued.cae).toMatch(/^\d{14}$/);

    const response = await world.api.post(`/invoices/${issued.id}/void`, world.owner, {});

    expect(response.statusCode).toBe(409);
    expect(problem(response).code).toBe('invoice_cannot_void');
    expect(await world.getInvoice(issued.id)).toMatchObject({ status: 'issued', cae: issued.cae });
  });

  it('refuses to void a pending or a rejected one as well: there is no voided state', async () => {
    const { rejected } = await rejectedInvoice();
    const pendingCharge = await world.charge();
    const pending = (await world.invoiceCharge(pendingCharge)).json<InvoiceDto>();

    for (const invoice of [rejected, pending]) {
      const response = await world.api.post(`/invoices/${invoice.id}/void`, world.owner, {});
      expect(response.statusCode).toBe(409);
      expect(problem(response).code).toBe('invoice_cannot_void');
    }
    expect((await world.getInvoice(pending.id)).status).toBe('pending');
  });

  it('has no way to delete an invoice at all', async () => {
    const charge = await world.charge();
    const issued = await world.issueInvoiceOf(charge);

    const response = await world.api.delete(`/invoices/${issued.id}`, world.owner);

    expect(response.statusCode).toBe(404);
    expect(await world.getInvoice(issued.id)).toMatchObject({ status: 'issued' });
  });
});
