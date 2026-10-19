import { randomUUID } from 'node:crypto';

import {
  effectivePermissions,
  invoiceKindOf,
  type DownloadLinkResponse,
  type InvoiceType,
  type RecipientTaxCondition,
  type TaxCondition,
} from '@consultorio/contracts';
import { asc, eq } from 'drizzle-orm';

import {
  fiscalProfile,
  invoice,
  invoiceDocument,
  invoiceLine,
  type InvoiceRow,
} from '../../../db/schema/index.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { FileRefused, type FileResource } from '../../../platform/files/file-resources.js';
import { AppError } from '../../../platform/http/problem.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { tenantKey, type ObjectStorage } from '../../../platform/storage/object-storage.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { visibleLocationIds } from '../../access/index.js';

import { CURRENT_TENANT } from './common.js';
import { scopeOf, type InvoiceScope } from './invoice-view.js';
import { snapshotOfProfile } from './issuer-snapshot.js';
import { INVOICE_DELIVER_JOB } from './job-names.js';
import { renderInvoice, type InvoiceDocumentData } from './render-invoice.js';

/** The data an issued invoice or credit note prints, read from its record (which never changes). */
export async function loadDocumentData(tx: Tx, row: InvoiceRow): Promise<InvoiceDocumentData> {
  if (row.number === null || row.cae === null)
    throw new Error('only an issued invoice has a document');
  const lines = await tx
    .select()
    .from(invoiceLine)
    .where(eq(invoiceLine.invoiceId, row.id))
    .orderBy(asc(invoiceLine.position));
  const [profile] = row.issuerSnapshot ? [] : await tx.select().from(fiscalProfile);
  const issuer = row.issuerSnapshot ?? (profile ? snapshotOfProfile(profile) : null);
  if (!issuer) throw new Error('the issuer of the invoice is missing');
  const [original] =
    row.creditNoteOfId === null
      ? []
      : await tx.select().from(invoice).where(eq(invoice.id, row.creditNoteOfId));
  return {
    type: row.type as InvoiceType,
    pointOfSale: row.pointOfSale,
    number: row.number,
    issueDate: row.issueDate,
    cae: row.cae,
    caeExpiresOn: row.caeExpiresOn,
    issuedAt: row.issuedAt ?? row.createdAt,
    // The issuer is the one the invoice was requested with; the profile only serves an invoice that
    // predates the snapshot. A later edit of the profile never changes a fiscal document.
    issuer: {
      businessName: issuer.businessName,
      cuit: issuer.cuit,
      taxCondition: issuer.taxCondition as TaxCondition,
      address: issuer.address,
      activityStartedOn: issuer.activityStartedOn,
    },
    recipient: {
      name: row.recipientName,
      taxCondition: row.recipientTaxCondition as RecipientTaxCondition,
      document:
        row.recipientDocType !== null && row.recipientDocNumber !== null
          ? {
              type: row.recipientDocType === 'dni' ? 'dni' : 'cuit',
              number: row.recipientDocNumber,
            }
          : null,
    },
    lines: lines.map((line) => ({
      description: line.description,
      amountCents: line.amountCents,
    })),
    totalCents: row.totalCents,
    netCents: row.netCents,
    vatCents: row.vatCents,
    exemptCents: row.exemptCents,
    testDocument: row.environment === 'homologation' || row.simulated,
    associated:
      original?.number != null
        ? {
            type: original.type as InvoiceType,
            pointOfSale: original.pointOfSale,
            number: original.number,
          }
        : null,
  };
}

export interface PdfDeps {
  storage: ObjectStorage;
  clock: () => Date;
  /** Queues the delivery of the invoice to its recipient. */
  jobs?: JobClient | undefined;
}

/**
 * Renders the PDF of an issued invoice, stores it as `t/{tenantId}/invoices/{uuid}.pdf` and
 * records it (`invoice_document`), then queues the delivery when the invoice is addressed to a
 * patient. Safe to run again: an invoice that has its document keeps it. Anything else than an
 * issued invoice has none (a pending one will, once the authority answers).
 */
export async function storeInvoiceDocument(
  tx: Tx,
  deps: PdfDeps,
  input: { tenantId: string; invoiceId: string },
): Promise<'stored' | 'exists' | 'not_issued'> {
  const [row] = await tx.select().from(invoice).where(eq(invoice.id, input.invoiceId));
  if (row?.status !== 'issued') return 'not_issued';
  const [existing] = await tx
    .select({ id: invoiceDocument.id })
    .from(invoiceDocument)
    .where(eq(invoiceDocument.invoiceId, row.id));
  if (existing) return 'exists';

  const pdf = await renderInvoice(await loadDocumentData(tx, row));
  const objectKey = tenantKey(input.tenantId, 'invoices', `${randomUUID()}.pdf`);
  await deps.storage.put(input.tenantId, objectKey, {
    body: pdf,
    contentType: 'application/pdf',
    contentLength: pdf.length,
  });
  try {
    await tx.insert(invoiceDocument).values({
      tenantId: CURRENT_TENANT,
      invoiceId: row.id,
      objectKey,
      sizeBytes: pdf.length,
    });
    // An invoice addressed to the patient is sent to them; a payer's is not (no address on file).
    if (row.recipientKind === 'patient') {
      await deps.jobs?.enqueue(tx, INVOICE_DELIVER_JOB, {
        tenantId: input.tenantId,
        invoiceId: row.id,
      });
    }
  } catch (error) {
    // The record was not written: the object is an orphan nobody can reach, so it is removed.
    await deps.storage.remove(input.tenantId, objectKey).catch(() => undefined);
    throw error;
  }
  return 'stored';
}

/** `factura-c-0005-00000077.pdf`: built from the voucher, never from anything a person typed. */
export function documentFileName(type: InvoiceType, pointOfSale: number, number: number): string {
  const kind = invoiceKindOf(type) === 'credit_note' ? 'nota-de-credito' : 'factura';
  const letter = type.slice(-1).toLowerCase();
  return `${kind}-${letter}-${String(pointOfSale).padStart(4, '0')}-${String(number).padStart(8, '0')}.pdf`;
}

/**
 * A link to the PDF of an invoice, for this session only, valid for five minutes and for one use.
 * The invoice must be issued and have its document. Reading an invoice is open in a read-only
 * organization, and so is its link.
 */
export async function issuePdfLink(
  tx: Tx,
  input: { invoiceId: string; scope: InvoiceScope; sessionId: string; tokens: ActionTokens },
): Promise<DownloadLinkResponse> {
  const [row] = await tx.select().from(invoice).where(eq(invoice.id, input.invoiceId));
  if (!row) throw new AppError('not_found');
  const { scope } = input;
  // An invoice outside the locations of the person answers like one that does not exist.
  if (scope.kind === 'limited' && !row.locationIds.some((id) => scope.locationIds.includes(id))) {
    throw new AppError('not_found');
  }
  const [document] = await tx
    .select({ id: invoiceDocument.id })
    .from(invoiceDocument)
    .where(eq(invoiceDocument.invoiceId, row.id));
  if (row.status !== 'issued' || !document) throw new AppError('invoice_pdf_not_ready');

  const issued = await input.tokens.issue(tx, {
    kind: 'invoice_pdf',
    subjectId: row.id,
    sessionId: input.sessionId,
  });
  return { url: `/files/${issued.token}`, expiresAt: issued.expiresAt.toISOString() };
}

/**
 * The invoicing module's part of `GET /files/:token`: the links of `invoice_pdf`. The link is bound
 * to the session, works once for five minutes, and is authorized AGAIN when used: only while the
 * person still issues invoices and still sees the locations of the invoice. Asking for the link is
 * a read and nothing changed hands, so the download writes no entry of its own.
 */
export function createInvoiceFileResource(tokens: ActionTokens): FileResource {
  return {
    kind: 'invoice_pdf',
    audits: [],
    async redeem(tx, input) {
      const redeemed = await tokens.redeem(tx, 'invoice_pdf', input.token, {
        sessionId: input.sessionId,
      });
      // Not a live link of this kind: the door asks the other resources before it refuses.
      if (!redeemed) return null;

      const mayStill = effectivePermissions(input.actor.roles, input.actor.grants).includes(
        'invoicing.issue',
      );
      const [row] = await tx.select().from(invoice).where(eq(invoice.id, redeemed.subjectId));
      if (!row || !mayStill) {
        throw new FileRefused('invoice_not_allowed', 'invoice', { resourceId: redeemed.subjectId });
      }
      const locations = await visibleLocationIds(tx, input.actor);
      const scope = scopeOf(locations);
      if (
        scope.kind === 'limited' &&
        !row.locationIds.some((id) => scope.locationIds.includes(id))
      ) {
        throw new FileRefused('invoice_not_allowed', 'invoice', { resourceId: row.id });
      }
      const [document] = await tx
        .select()
        .from(invoiceDocument)
        .where(eq(invoiceDocument.invoiceId, row.id));
      if (row.status !== 'issued' || !document || row.number === null) {
        throw new FileRefused('invoice_not_ready', 'invoice', { resourceId: row.id });
      }
      return {
        objectKey: document.objectKey,
        contentType: 'application/pdf',
        // Made from the voucher: nothing a person typed can reach a header.
        contentDisposition: `attachment; filename="${documentFileName(row.type as InvoiceType, row.pointOfSale, row.number)}"`,
      };
    },
  };
}
