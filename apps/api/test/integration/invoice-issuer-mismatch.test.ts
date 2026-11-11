import type { InvoiceDto, Problem } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { nextCuit } from '../../src/adapters/invoice-issuer.contract.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { invoiceStrayVoucher } from '../../src/db/schema/index.js';
import { worklistItem } from '../../src/db/schema/worklist.js';
import { runDueAttempts } from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { generateDevCertificate } from '../../src/testing/dev-afip-certificate.js';
import { submissionKey } from '../support/billing-world.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * Judgment day, Stage 4, round 2, suspect B-T5: an invoice, a credit note or a retry carries the CUIT
 * of the issuer it was requested with (the snapshot), while the credential of the real authority
 * follows the live fiscal profile. With a real issuer the two can disagree, and the request would be
 * signed for one CUIT and name another. Nothing is sent: the credit note is refused, the invoice is
 * parked for a person. A simulator has no credential, so it is not affected.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-issuer-mismatch' });
});

afterAll(async () => {
  // Back to what the other tests of the file expect.
  Object.defineProperty(world.issuer, 'simulated', { value: true, configurable: true });
  await world.close();
  await runtime.close();
});

const OLD_CUIT = '20123456786';

/** Makes the issuer of this world look like the real one: it has no `simulated` mark. */
function behaveLikeTheRealAuthority() {
  Object.defineProperty(world.issuer, 'simulated', { value: false, configurable: true });
}

async function uploadCredentialFor(cuit: string) {
  const made = generateDevCertificate({ cuit, algorithm: 'ec' });
  const response = await world.api.put('/invoicing/credentials', world.owner, {
    certificate: made.certificate,
    privateKey: made.privateKey,
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function changeProfileCuit(cuit: string) {
  const profile = (await world.api.get('/invoicing/config', world.owner)).json<{
    profile: { businessName: string; address: string; activityStartedOn: string };
  }>().profile;
  const response = await world.api.put('/invoicing/profile', world.owner, {
    cuit,
    taxCondition: 'monotributo',
    businessName: profile.businessName,
    address: profile.address,
    activityStartedOn: profile.activityStartedOn,
  });
  expect(response.statusCode, response.body).toBe(200);
}

describe('an invoice whose issuer is not the one of the credential (JD-S4 R2-B-T5)', () => {
  it('refuses a credit note, and parks a pending invoice, instead of signing for one CUIT and naming another', async () => {
    // An invoice issued, and another one requested, while the organization is still the old CUIT.
    const issued: InvoiceDto = await world.issueInvoiceOf(await world.charge());
    const charge = await world.charge();
    const pendingResponse = await world.invoiceCharge(charge);
    expect(pendingResponse.statusCode, pendingResponse.body).toBe(202);
    const pending = pendingResponse.json<InvoiceDto>();

    // The organization changes its CUIT and loads the certificate of the new one.
    const newCuit = nextCuit();
    await changeProfileCuit(newCuit);
    behaveLikeTheRealAuthority();
    const issue = vi.spyOn(world.issuer, 'issue');
    try {
      await uploadCredentialFor(newCuit);

      const note = await world.creditNote(issued.id);
      const results = await world.sweep(() => new Date(Date.now() + 60_000));

      expect(note.statusCode, note.body).toBe(409);
      expect(note.json<Problem>().code).toBe('invoice_issuer_mismatch');
      expect(results).toContainEqual({ invoiceId: pending.id, outcome: 'attention' });
      expect(issue).not.toHaveBeenCalled();
    } finally {
      issue.mockRestore();
      Object.defineProperty(world.issuer, 'simulated', { value: true, configurable: true });
      await changeProfileCuit(OLD_CUIT);
      await uploadCredentialFor(OLD_CUIT);
    }
    expect(await world.rowOf(pending.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'needs_attention',
    });
    const items = await world.inTenant((tx) =>
      tx
        .select()
        .from(worklistItem)
        .where(
          and(eq(worklistItem.kind, 'invoice_attention'), eq(worklistItem.subjectId, pending.id)),
        ),
    );
    expect(items).toHaveLength(1);
  });

  it('does not touch a simulator, which has no credential', async () => {
    const issued = await world.issueInvoiceOf(await world.charge());

    const note = await world.creditNote(issued.id);

    expect(note.statusCode, note.body).toBe(202);
  });
});

describe('an invoice parked while its outcome is unknown (JD-S4 R3-4)', () => {
  /** An invoice whose answer was lost, then parked because the credential is for another CUIT. */
  async function parkedWhileUnknown() {
    world.issuer.setMode('ok');
    await world.runIssue();
    const charge = await world.charge();
    const response = await world.invoiceCharge(charge);
    expect(response.statusCode, response.body).toBe(202);
    const pending = response.json<InvoiceDto>();
    const t0 = Date.now();
    world.issuer.setMode('timeout_after_authorize');
    await world.runIssue(() => new Date(t0));
    expect(await world.rowOf(pending.id)).toMatchObject({
      deliveryState: 'awaiting_reconciliation',
    });

    const newCuit = nextCuit();
    await changeProfileCuit(newCuit);
    behaveLikeTheRealAuthority();
    const errors: { object: Record<string, unknown>; message: string }[] = [];
    try {
      await uploadCredentialFor(newCuit);
      await runDueAttempts(
        runtime.db,
        {
          ...world.issueDeps(() => new Date(t0 + 10 * 60_000)),
          log: { error: (object, message) => errors.push({ object, message }) },
        },
        { error: () => undefined },
        { tenantIds: [world.tenant.id] },
      );
    } finally {
      Object.defineProperty(world.issuer, 'simulated', { value: true, configurable: true });
      await changeProfileCuit(OLD_CUIT);
      await uploadCredentialFor(OLD_CUIT);
    }
    return { charge, pending, errors };
  }

  const itemsOf = (invoiceId: string) =>
    world.inTenant((tx) =>
      tx.select().from(worklistItem).where(eq(worklistItem.subjectId, invoiceId)),
    );

  it('says in the audit entry, the item and the log that the outcome is unknown, and does not claim a voucher was issued', async () => {
    const { pending, errors } = await parkedWhileUnknown();

    const parkedRow = await world.rowOf(pending.id);
    expect(parkedRow).toMatchObject({ status: 'pending', deliveryState: 'needs_attention' });
    // The number it expected is remembered as one where its voucher may sit (JD-S4 R4-3).
    const remembered = await world.inTenant((tx) =>
      tx.select().from(invoiceStrayVoucher).where(eq(invoiceStrayVoucher.invoiceId, pending.id)),
    );
    expect(parkedRow.expectedNumber).not.toBeNull();
    expect(remembered).toMatchObject([
      { number: parkedRow.expectedNumber, reason: 'parked_unknown' },
    ]);
    const entries = await world.inTenant((tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.resourceId, pending.id)),
    );
    const parked = entries.find((entry) => entry.action === 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'issuer_mismatch', outcomeUnknown: true });
    const [item] = await itemsOf(pending.id);
    expect(item?.status).toBe('open');
    const logged = errors.find((entry) => entry.object['invoiceId'] === pending.id);
    expect(logged?.object).toMatchObject({ reason: 'issuer_mismatch', outcomeUnknown: true });
    expect(logged?.message).not.toMatch(/issued a voucher/);
  });

  it('is replaced only with the acknowledgement of the owner, and the number it expected is remembered', async () => {
    const { charge, pending } = await parkedWhileUnknown();
    const lines = (await world.linesOf(charge.id)).filter((line) => line.portion === 'patient');
    const body = {
      idempotencyKey: submissionKey(),
      type: 'FC',
      pointOfSale: 2,
      number: 3000 + Math.floor(Math.random() * 1e5),
      cae: String(76_000_000_000_000 + Math.floor(Math.random() * 1e9)),
      issueDate: '2031-05-20',
      caeExpiresOn: '2031-05-30',
      totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
      lines: lines.map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'patient' },
      replacesInvoiceId: pending.id,
    };

    const refused = await world.api.post('/invoices/manual', world.admin, body);
    const accepted = await world.api.post('/invoices/manual', world.admin, {
      ...body,
      idempotencyKey: submissionKey(),
      acknowledgeUnknownOutcome: true,
    });

    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<Problem>().code).toBe('invoice_awaiting_reconciliation');
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect((await world.rowOf(pending.id)).status).toBe('rejected');
    const strays = await world.inTenant((tx) =>
      tx.select().from(invoiceStrayVoucher).where(eq(invoiceStrayVoucher.invoiceId, pending.id)),
    );
    expect(strays).toHaveLength(1);
  });

  it('is replaced as before when it was parked without any doubt about its outcome', async () => {
    world.issuer.setMode('ok');
    await world.runIssue();
    const charge = await world.charge();
    const response = await world.invoiceCharge(charge);
    const pending = response.json<InvoiceDto>();
    const newCuit = nextCuit();
    await changeProfileCuit(newCuit);
    behaveLikeTheRealAuthority();
    try {
      await uploadCredentialFor(newCuit);
      await world.sweep(() => new Date(Date.now() + 60_000));
    } finally {
      Object.defineProperty(world.issuer, 'simulated', { value: true, configurable: true });
      await changeProfileCuit(OLD_CUIT);
      await uploadCredentialFor(OLD_CUIT);
    }
    expect(await world.rowOf(pending.id)).toMatchObject({
      deliveryState: 'needs_attention',
      expectedNumber: null,
    });
    const lines = (await world.linesOf(charge.id)).filter((line) => line.portion === 'patient');

    const replaced = await world.api.post('/invoices/manual', world.admin, {
      idempotencyKey: submissionKey(),
      type: 'FC',
      pointOfSale: 2,
      number: 4000 + Math.floor(Math.random() * 1e5),
      cae: String(77_000_000_000_000 + Math.floor(Math.random() * 1e9)),
      issueDate: '2031-05-20',
      caeExpiresOn: '2031-05-30',
      totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
      lines: lines.map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'patient' },
      replacesInvoiceId: pending.id,
    });

    expect(replaced.statusCode, replaced.body).toBe(201);
  });
});
