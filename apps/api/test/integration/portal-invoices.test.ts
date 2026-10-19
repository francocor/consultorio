import type { PortalDownloadLinkResponse, PortalInvoicesResponse } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { openPortalSession } from '../support/portal-session.js';

/**
 * The invoices and receipts in the portal (S5.08, task 5.33): the patient sees the vouchers
 * addressed to them, as the invoicing module decides, and nothing of what a payer owes.
 */
let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'portal-invoices' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

describe('the invoices of the patient', () => {
  it('are the ones addressed to them, without their lines, and not those of another patient', async () => {
    await world.runIssue();
    const mine = await world.charge();
    const theirs = await world.charge();
    const own = await world.issueInvoiceOf(mine);
    await world.issueInvoiceOf(theirs);
    const session = await openPortalSession(world, mine.patientId);

    const response = await session.get('/portal/invoices');

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<PortalInvoicesResponse>();
    expect(body.invoices.map((invoice) => invoice.id)).toEqual([own.id]);
    expect(body.invoices[0]).toMatchObject({
      kind: 'invoice',
      type: 'FC',
      totalCents: 2_000_000,
      number: own.number,
    });
    // The lines, the tax breakdown and the authority's answer stay with the organization.
    expect(Object.keys(body.invoices[0] ?? {}).sort()).toEqual([
      'hasPdf',
      'id',
      'issueDate',
      'kind',
      'number',
      'pointOfSale',
      'testDocument',
      'totalCents',
      'type',
    ]);
  });

  it('are an empty list for a patient with nothing invoiced', async () => {
    const patientId = await world.freshPatient();
    const session = await openPortalSession(world, patientId);

    const response = await session.get('/portal/invoices');

    expect(response.json<PortalInvoicesResponse>().invoices).toEqual([]);
  });

  it('are read as the patient and written in the trail', async () => {
    await world.runIssue();
    const charge = await world.charge();
    await world.issueInvoiceOf(charge);
    const session = await openPortalSession(world, charge.patientId);

    await session.get('/portal/invoices');

    const [row] = await world.inTenant((tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.tenantId, world.tenant.id),
            eq(auditEvent.action, 'patient.read'),
            eq(auditEvent.patientId, charge.patientId),
          ),
        )
        .orderBy(desc(auditEvent.occurredAt))
        .limit(1),
    );
    expect(row).toMatchObject({
      actingRole: 'patient',
      actorUserId: null,
      resourceType: 'invoice',
    });
    expect(row?.metadata).toMatchObject({ scope: 'invoices', count: 1 });
  });
});

describe('the PDF of an invoice', () => {
  it("is downloaded through a link of the portal, and only the patient's own invoice has one", async () => {
    await world.runIssue();
    const mine = await world.charge();
    const theirs = await world.charge();
    const own = await world.issueInvoiceOf(mine);
    const other = await world.issueInvoiceOf(theirs);
    await world.runDocuments();
    const session = await openPortalSession(world, mine.patientId);

    const link = await session.post(`/portal/invoices/${own.id}/download-link`);
    expect(link.statusCode, link.body).toBe(200);
    const file = await session.get(link.json<PortalDownloadLinkResponse>().url);

    expect(file.statusCode, file.body).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(String(file.headers['content-disposition'])).toMatch(
      /^attachment; filename="factura-[a-c]-\d{4}-\d{8}\.pdf"/,
    );
    // The invoice of another patient answers as if it did not exist.
    const foreign = await session.post(`/portal/invoices/${other.id}/download-link`);
    expect(foreign.statusCode).toBe(404);
  });

  it('is not given before the document exists', async () => {
    await world.runIssue();
    const charge = await world.charge();
    const invoice = await world.issueInvoiceOf(charge);
    const session = await openPortalSession(world, charge.patientId);
    // The PDF is rendered by a job that has not run for this invoice yet.
    const response = await session.post(`/portal/invoices/${invoice.id}/download-link`);

    expect(response.statusCode).toBe(404);
  });
});
