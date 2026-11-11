import type { InvoiceDto, TenantPayerDto } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { listInvoicesForPatient } from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * The invoices of one patient (S4.12, task 4.53; spec "Patient downloads own invoice"): only the
 * invoices addressed to the patient (a payer's are not theirs), only the ones that exist as
 * documents (issued or registered), and every read audited. The patient portal of Stage 5 calls it.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-patient-list' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const actor = {
  userId: null,
  actingRole: null,
  ip: '10.0.0.1',
  userAgent: 'portal',
  requestId: 'portal-request',
};

const listFor = (patientId: string) =>
  world.inTenant((tx) =>
    listInvoicesForPatient(tx, { clock: () => new Date() }, { patientId, actor }),
  );

const readAudits = () =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, 'patient.read')))
      .orderBy(desc(auditEvent.occurredAt)),
  );

describe('the invoices of a patient', () => {
  it('lists the ones addressed to them, and not the ones of another patient', async () => {
    await world.runIssue();
    const mine = await world.charge();
    const theirs = await world.charge();
    const own = await world.issueInvoiceOf(mine);
    const other = await world.issueInvoiceOf(theirs);

    const listed = await listFor(mine.patientId);

    expect(listed.map((entry) => entry.id)).toEqual([own.id]);
    expect(listed.map((entry) => entry.id)).not.toContain(other.id);
    expect(listed[0]).toMatchObject({ status: 'issued', type: 'FC', totalCents: 2_000_000 });
  });

  it('leaves out a payer invoice, which is not addressed to the patient', async () => {
    await world.runIssue();
    const catalogId = await world.catalogPayer('invoice-patient-osde', 'OSDE Portal');
    const payer = (
      await world.api.post('/billing/payers', world.owner, {
        payerId: catalogId,
        cuit: '30-70857833-5',
      })
    ).json<TenantPayerDto>();
    await world.api.post('/billing/payer-prices', world.owner, {
      tenantPayerId: payer.id,
      appointmentTypeId: world.consulta,
      payerAmountCents: 1_500_000,
      copagoCents: 300_000,
      plusCents: 0,
      effectiveFrom: '2031-01-01',
    });
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: catalogId });
    const charge = await world.charge({ patientId });
    const lines = await world.linesOf(charge.id);
    const toPayer = await world.invoice({
      lines: lines
        .filter((line) => line.portion === 'payer')
        .map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'payer' },
    });
    expect(toPayer.statusCode, toPayer.body).toBe(202);
    const toPatient = await world.invoice({
      lines: lines
        .filter((line) => line.portion === 'patient')
        .map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'patient' },
    });
    expect(toPatient.statusCode, toPatient.body).toBe(202);
    await world.runIssue();

    const listed = await listFor(patientId);

    expect(listed.map((entry) => entry.id)).toEqual([toPatient.json<InvoiceDto>().id]);
    expect(listed.every((entry) => entry.recipient.kind === 'patient')).toBe(true);
  });

  it('lists what exists as a document only: not a pending invoice, not a rejected attempt', async () => {
    await world.runIssue();
    const waiting = await world.charge();
    await world.invoiceCharge(waiting);
    const rejected = await world.charge();
    await world.invoiceCharge(rejected);
    world.issuer.setMode('down');
    await world.runIssue();
    world.issuer.setMode('ok');

    expect(await listFor(waiting.patientId)).toEqual([]);
    expect(await listFor(rejected.patientId)).toEqual([]);
    await world.runIssue();
  });

  it('includes the credit notes of the patient, newest first', async () => {
    await world.runIssue();
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);
    const note = (await world.creditNote(original.id, { amountCents: 500_000 })).json<InvoiceDto>();
    await world.runIssue();

    const listed = await listFor(charge.patientId);

    expect(listed.map((entry) => entry.id)).toEqual([note.id, original.id]);
    expect(listed.map((entry) => entry.kind)).toEqual(['credit_note', 'invoice']);
  });

  it('records every read in the audit trail, with the patient and how many invoices were read', async () => {
    await world.runIssue();
    const charge = await world.charge();
    await world.issueInvoiceOf(charge);
    const before = (await readAudits()).length;

    await listFor(charge.patientId);
    await listFor(charge.patientId);

    const rows = await readAudits();
    expect(rows.length).toBe(before + 2);
    expect(rows[0]).toMatchObject({
      outcome: 'allow',
      patientId: charge.patientId,
      resourceType: 'invoice',
      ip: '10.0.0.1',
    });
    expect(rows[0]?.metadata).toEqual({ scope: 'invoices', count: 1 });
  });

  it('records the read even when the patient has no invoice', async () => {
    const charge = await world.charge();
    const before = (await readAudits()).length;

    expect(await listFor(charge.patientId)).toEqual([]);

    expect((await readAudits()).length).toBe(before + 1);
  });
});
