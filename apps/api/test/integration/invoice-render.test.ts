import { randomUUID } from 'node:crypto';

import type {
  DownloadLinkResponse,
  InvoiceDto,
  Problem,
  TenantPayerDto,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { invoiceDocument } from '../../src/db/schema/index.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { loadNoticeRecipient } from '../../src/modules/notifications/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { EmailDeliveryError, type EmailSender } from '../../src/platform/mail/email-sender.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { allText, readPdf } from '../support/pdf.js';

/**
 * The invoice document and its delivery (S4.12, tasks 4.51 and 4.52; spec "Invoice document and
 * delivery"): the PDF job stores `t/{tenant}/invoices/{uuid}.pdf`, the delivery job emails the
 * recipient through the channel policy (email only, never WhatsApp, no clinical content), and the
 * link to the file is bound to the session, lasts five minutes and works once.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-render' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const problem = (response: LightMyRequestResponse) => response.json<Problem>();

/** A charge of a new patient, with an email on file unless told otherwise. */
async function chargeOfPatient(email: string | null = `${randomUUID().slice(0, 8)}@example.test`) {
  const patientId = await world.freshPatient();
  await world.inTenant((tx) =>
    tx.execute(
      sql`UPDATE patient SET email = ${email}, phone = '1144445555' WHERE id = ${patientId}`,
    ),
  );
  return { patientId, email, charge: await world.charge({ patientId }) };
}

/** An issued invoice with its PDF rendered (and its delivery run). */
async function issuedWithDocument(
  email: string | null = `${randomUUID().slice(0, 8)}@example.test`,
) {
  await world.runIssue();
  world.email.clear();
  const made = await chargeOfPatient(email);
  const issued = await world.issueInvoiceOf(made.charge);
  await world.runDocuments();
  return { ...made, issued };
}

const documentOf = (invoiceId: string) =>
  world.inTenant(async (tx) => {
    const [row] = await tx
      .select()
      .from(invoiceDocument)
      .where(eq(invoiceDocument.invoiceId, invoiceId));
    return row;
  });

const bytesOf = async (objectKey: string): Promise<Buffer> => {
  const stored = await world.storage.get(world.tenant.id, objectKey);
  if (!stored) throw new Error('no such object');
  const chunks: Buffer[] = [];
  for await (const chunk of stored.stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
};

describe('the invoice PDF job (task 4.52)', () => {
  it('renders the document of an issued invoice and stores it under the organization', async () => {
    const { issued } = await issuedWithDocument();

    const document = await documentOf(issued.id);

    expect(document?.objectKey).toMatch(
      new RegExp(`^t/${world.tenant.id}/invoices/[0-9a-f-]{36}\\.pdf$`),
    );
    const bytes = await bytesOf(document?.objectKey ?? '');
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(document?.sizeBytes).toBe(bytes.length);
    const text = allText(readPdf(bytes));
    expect(text).toContain(`CAE N° ${issued.cae ?? ''}`);
    expect(text).toContain(`Comp. Nro ${String(issued.number).padStart(8, '0')}`);
    expect(text).toContain('Factura C');
    // The generic wording of a service: the appointment type gave no description of its own.
    expect(text).toContain('Servicios de salud');
    // The world runs on a simulator: the document is marked as a test.
    expect(text).toContain('Documento de prueba sin validez fiscal');
    expect((await world.getInvoice(issued.id)).hasPdf).toBe(true);
  });

  it('renders it once, however many times the job is delivered', async () => {
    const { issued } = await issuedWithDocument();
    const first = await documentOf(issued.id);

    const [pdf] = world.documentJobs();
    for (let delivery = 0; delivery < 3; delivery += 1) {
      await runJob(runtime.db, pdf, {
        id: randomUUID(),
        name: 'invoice.pdf',
        data: { tenantId: world.tenant.id, invoiceId: issued.id },
        enqueuedAt: new Date(),
        retryCount: 0,
      });
    }

    const rows = await world.inTenant((tx) =>
      tx.select().from(invoiceDocument).where(eq(invoiceDocument.invoiceId, issued.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.objectKey).toBe(first?.objectKey);
  });

  it('renders nothing for an invoice that is not issued', async () => {
    await world.runIssue();
    const charge = await world.charge();
    const pending = (await world.invoiceCharge(charge)).json<InvoiceDto>();
    const [pdf] = world.documentJobs();

    const result = await runJob(runtime.db, pdf, {
      id: randomUUID(),
      name: 'invoice.pdf',
      data: { tenantId: world.tenant.id, invoiceId: pending.id },
      enqueuedAt: new Date(),
      retryCount: 0,
    });

    expect(result.status).toBe('completed');
    expect(await documentOf(pending.id)).toBeUndefined();
    await world.runIssue();
  });

  it('renders a credit note with the voucher it cancels', async () => {
    const { issued } = await issuedWithDocument();
    const note = (await world.creditNote(issued.id)).json<InvoiceDto>();
    await world.runIssue();
    await world.runDocuments();

    const document = await documentOf(note.id);

    const text = allText(readPdf(await bytesOf(document?.objectKey ?? '')));
    expect(text).toContain('Nota de Crédito C');
    expect(text).toContain(
      `Comprobante asociado Factura C 0001-${String(issued.number).padStart(8, '0')}`,
    );
  });

  it('still runs in a read-only organization: a PDF is built from what the organization may read', async () => {
    await world.runIssue();
    const made = await chargeOfPatient();
    const issued = await world.issueInvoiceOf(made.charge);
    const status = (value: 'active' | 'read_only') =>
      world.inTenant((tx) =>
        tx
          .update(tenantTable)
          .set(
            value === 'read_only'
              ? { status: value, readOnlySince: new Date() }
              : { status: value, readOnlySince: null },
          )
          .where(eq(tenantTable.id, world.tenant.id)),
      );
    await status('read_only');
    try {
      const [pdf] = world.documentJobs();
      const result = await runJob(runtime.db, pdf, {
        id: randomUUID(),
        name: 'invoice.pdf',
        data: { tenantId: world.tenant.id, invoiceId: issued.id },
        enqueuedAt: new Date(),
        retryCount: 0,
      });

      expect(result).toEqual({ status: 'completed' });
      expect(await documentOf(issued.id)).toBeDefined();
    } finally {
      await status('active');
    }
  });
});

describe('the delivery of an invoice (task 4.52, spec "Invoice document and delivery")', () => {
  it('emails the patient, with the voucher and the amount and nothing clinical', async () => {
    await world.runIssue();
    world.email.clear();
    const made = await chargeOfPatient('juana.perez@example.test');
    await world.api.post(`/billing/charges/${made.charge.id}/lines`, world.reception, {
      description: 'Estudio de HIV',
      amountCents: 300_000,
    });
    const issued = await world.issueInvoiceOf(made.charge);

    await world.runDocuments();

    const sent = world.email.lastTo('juana.perez@example.test');
    expect(sent?.subject).toMatch(
      new RegExp(`: su Factura C 0001-${String(issued.number).padStart(8, '0')}$`),
    );
    expect(sent?.text).toContain('Factura C');
    expect(sent?.text).toContain('$ 23.000,00');
    expect([sent?.subject, sent?.text, sent?.html].join('\n')).not.toMatch(
      /HIV|diagn|tratamiento|receta|psicolog|estudio|consulta/i,
    );
    expect(sent?.tenant).toEqual({ id: world.tenant.id, isDemo: false });
    expect((await documentOf(issued.id))?.deliveredAt).not.toBeNull();
  });

  it('sends one email, however many times the job runs', async () => {
    const { issued, email } = await issuedWithDocument();
    const count = world.email.sent.filter((message) => message.to === email).length;
    const [, deliver] = world.documentJobs();

    for (let delivery = 0; delivery < 3; delivery += 1) {
      await runJob(runtime.db, deliver, {
        id: randomUUID(),
        name: 'invoice.deliver',
        data: { tenantId: world.tenant.id, invoiceId: issued.id },
        enqueuedAt: new Date(),
        retryCount: 0,
      });
    }

    expect(count).toBe(1);
    expect(world.email.sent.filter((message) => message.to === email)).toHaveLength(1);
  });

  it('uses email only, whatever the patient opted in to: the channel policy refuses WhatsApp for an invoice', async () => {
    const { patientId } = await chargeOfPatient();
    await world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO channel_preference (tenant_id, patient_id, channel, state, source)
              VALUES (${world.tenant.id}, ${patientId}, 'whatsapp', 'opted_in', 'online_booking')`,
      ),
    );

    const recipient = await world.inTenant((tx) => loadNoticeRecipient(tx, patientId, 'invoice'));
    const reminder = await world.inTenant((tx) => loadNoticeRecipient(tx, patientId, 'otp_code'));

    expect(recipient?.channels).toEqual(['email']);
    expect(reminder?.channels).toEqual(['email']);
  });

  it('sends nothing to a patient who opted out of email, and says why', async () => {
    await world.runIssue();
    world.email.clear();
    const made = await chargeOfPatient();
    await world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO channel_preference (tenant_id, patient_id, channel, state, source)
              VALUES (${world.tenant.id}, ${made.patientId}, 'email', 'opted_out', 'email_link')`,
      ),
    );
    const issued = await world.issueInvoiceOf(made.charge);

    await world.runDocuments();

    expect(world.email.sent).toHaveLength(0);
    const document = await documentOf(issued.id);
    expect(document?.deliveredAt).toBeNull();
    expect(document?.deliverySkippedReason).toBe('opted_out');
  });

  it('sends nothing when there is no email on file, and says why', async () => {
    const { issued } = await issuedWithDocument(null);

    const document = await documentOf(issued.id);

    expect(world.email.sent).toHaveLength(0);
    expect(document?.deliveredAt).toBeNull();
    expect(document?.deliverySkippedReason).toBe('no_contact');
  });

  it('does not email an invoice to a payer', async () => {
    await world.runIssue();
    world.email.clear();
    const catalogId = await world.catalogPayer('invoice-render-osde', 'OSDE Render');
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
    const payerLine = (await world.linesOf(charge.id)).find((line) => line.portion === 'payer');
    const created = await world.invoice({
      lines: [{ chargeLineId: payerLine?.id ?? '' }],
      recipient: { kind: 'payer' },
    });
    expect(created.statusCode, created.body).toBe(202);
    await world.runIssue();

    await world.runDocuments();

    expect(world.email.sent).toHaveLength(0);
    // The document exists all the same.
    expect(await documentOf(created.json<InvoiceDto>().id)).toBeDefined();
  });

  it('is not sent in a read-only organization: a message is cancelled and never replayed', async () => {
    const { issued } = await issuedWithDocument(null);
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE patient SET email = 'late@example.test' WHERE id = ${issued.recipient.patientId}`,
      ),
    );
    const [, deliver] = world.documentJobs();
    await world.inTenant((tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, world.tenant.id)),
    );
    try {
      const result = await runJob(runtime.db, deliver, {
        id: randomUUID(),
        name: 'invoice.deliver',
        data: { tenantId: world.tenant.id, invoiceId: issued.id },
        enqueuedAt: new Date(Date.now() + 1000),
        retryCount: 0,
      });

      expect(result).toEqual({ status: 'cancelled', reason: 'tenant_read_only' });
    } finally {
      await world.inTenant((tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, world.tenant.id)),
      );
    }
  });

  it('fails the job when the email could not be sent, and sends it once on the retry', async () => {
    await world.runIssue();
    world.email.clear();
    const made = await chargeOfPatient('retry@example.test');
    const issued = await world.issueInvoiceOf(made.charge);
    const run = (
      job: ReturnType<typeof world.documentJobs>[number],
      name: string,
      retryCount = 0,
    ) =>
      runJob(runtime.db, job, {
        id: randomUUID(),
        name,
        data: { tenantId: world.tenant.id, invoiceId: issued.id },
        enqueuedAt: new Date(),
        retryCount,
      });
    const [pdf] = world.documentJobs();
    await run(pdf, 'invoice.pdf');
    const broken: EmailSender = { send: () => Promise.reject(new EmailDeliveryError()) };
    const [, failing] = world.documentJobs({ email: broken });

    await expect(run(failing, 'invoice.deliver')).rejects.toBeDefined();

    expect((await documentOf(issued.id))?.deliveredAt).toBeNull();
    const [, working] = world.documentJobs();
    await run(working, 'invoice.deliver', 1);
    expect(world.email.sent.filter((message) => message.to === 'retry@example.test')).toHaveLength(
      1,
    );
    expect((await documentOf(issued.id))?.deliveredAt).not.toBeNull();
  });
});

describe('the link to the PDF (spec design 5.6, task 4.52)', () => {
  const link = (invoiceId: string, by = world.reception) =>
    world.api.get(`/invoices/${invoiceId}/pdf-link`, by);

  it('is a link for this session: five minutes, one use, and it serves the stored PDF', async () => {
    const { issued } = await issuedWithDocument();

    const response = await link(issued.id);

    expect(response.statusCode, response.body).toBe(200);
    const { url, expiresAt } = response.json<DownloadLinkResponse>();
    expect(url).toMatch(/^\/files\/[A-Za-z0-9_-]{43}$/);
    const minutes = (Date.parse(expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4);
    expect(minutes).toBeLessThanOrEqual(5);

    const file = await world.api.get(url, world.reception);
    expect(file.statusCode).toBe(200);
    expect(String(file.headers['content-type'])).toContain('application/pdf');
    expect(String(file.headers['content-disposition'])).toMatch(
      new RegExp(
        `^attachment; filename="factura-c-0001-${String(issued.number).padStart(8, '0')}\\.pdf"$`,
      ),
    );
    const stored = await documentOf(issued.id);
    expect(file.rawPayload.equals(await bytesOf(stored?.objectKey ?? ''))).toBe(true);
    // A second use is refused, and so is the same link in another session.
    expect((await world.api.get(url, world.reception)).statusCode).toBe(403);
  });

  it('is useless to another session and to nobody', async () => {
    const { issued } = await issuedWithDocument();
    const { url } = (await link(issued.id)).json<DownloadLinkResponse>();

    expect((await world.api.get(url, world.owner)).statusCode).toBe(403);
    expect((await world.api.get(url, null)).statusCode).toBe(401);
    expect((await world.api.get(url, world.reception)).statusCode).toBe(200);
  });

  it('is checked again when it is used: reception that lost the location in those minutes gets nothing', async () => {
    const { issued } = await issuedWithDocument();
    const { url } = (await link(issued.id)).json<DownloadLinkResponse>();
    const assign = (locationIds: string[]) =>
      world.api.put(`/members/${world.reception.membershipId}/locations`, world.owner, {
        locationIds,
      });
    await assign([world.norte]);
    try {
      expect((await world.api.get(url, world.reception)).statusCode).toBe(403);
    } finally {
      await assign([world.centro]);
    }
  });

  it('is refused for an invoice that is not issued or has no document yet', async () => {
    await world.runIssue();
    const pendingCharge = await world.charge();
    const pending = (await world.invoiceCharge(pendingCharge)).json<InvoiceDto>();
    const issuedCharge = await world.charge();
    const issued = await world.issueInvoiceOf(issuedCharge);

    const early = await link(pending.id);
    const withoutDocument = await link(issued.id);

    expect(early.statusCode).toBe(409);
    expect(problem(early).code).toBe('invoice_pdf_not_ready');
    expect(withoutDocument.statusCode).toBe(409);
    expect(problem(withoutDocument).code).toBe('invoice_pdf_not_ready');
    await world.runDocuments();
    expect((await link(issued.id)).statusCode).toBe(200);
  });

  it('is for who issues invoices: a professional is denied, a stranger invoice answers not found', async () => {
    const { issued } = await issuedWithDocument();

    expect((await link(issued.id, world.doctor)).statusCode).toBe(403);
    expect((await link('0190a000-0000-7000-8000-00000000ffff')).statusCode).toBe(404);
  });

  it('is available in a read-only organization: an existing invoice stays downloadable', async () => {
    const { issued } = await issuedWithDocument();
    await world.inTenant((tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, world.tenant.id)),
    );
    try {
      const response = await link(issued.id);
      expect(response.statusCode, response.body).toBe(200);
      const file = await world.api.get(response.json<DownloadLinkResponse>().url, world.reception);
      expect(file.statusCode).toBe(200);
    } finally {
      await world.inTenant((tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, world.tenant.id)),
      );
    }
  });
});
