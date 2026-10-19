import type { InvoiceDto, Problem } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { nextCuit } from '../../src/adapters/invoice-issuer.contract.js';
import { worklistItem } from '../../src/db/schema/worklist.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { generateDevCertificate } from '../../src/testing/dev-afip-certificate.js';
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
