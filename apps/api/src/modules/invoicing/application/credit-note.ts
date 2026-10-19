import type { CreateCreditNoteRequest, InvoiceDto, InvoiceType } from '@consultorio/contracts';
import { asc, eq, sql } from 'drizzle-orm';

import { invoice, invoiceLine, pointOfSale } from '../../../db/schema/index.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { visibleLocationIds } from '../../access/index.js';
import { readChargeLines } from '../../billing/index.js';
import { allocateCredit } from '../domain/invoice-amounts.js';

import { CHECK_VIOLATION, hashOf, sqlState, todayIn, type InvoicingActor } from './common.js';
import { packFor } from './country-rules.js';
import {
  assertReady,
  findReplay,
  insertInvoice,
  insertInvoiceLines,
  queueIssue,
  type InvoicingDeps,
  type Recipient,
  type Viewer,
} from './create-invoice.js';
import { effectiveEnvironment } from './fiscal-config.js';
import { loadInvoice } from './invoice-view.js';
import { currentIssuer } from './issuer-snapshot.js';
import { isSimulatedIssuer, issuerFor } from './issuer.js';
import { loadOrganization } from './settings.js';

export interface CreateCreditNoteInput {
  invoiceId: string;
  request: CreateCreditNoteRequest;
  actor: InvoicingActor;
  viewer: Viewer;
  tenantId: string;
}

/**
 * Cancels an invoice, in whole or in part, with a credit note (e-invoicing-afip, "Credit notes").
 * The note has the letter of the invoice, its own CAE (it goes through the issuer like any
 * voucher), says why, and never credits more than the invoice: pending notes count against the
 * limit, rejected ones do not. The original invoice is not touched. Only once the note is ISSUED
 * does the amount invoiced of the charge lines go down (the database does it).
 *
 * The charges of the invoice are locked first (shared) and then its charge lines, in the order of
 * their ids, so two notes over the same invoice (and an invoice being created over the same lines)
 * wait for each other, and a void of the charge does not meet them in the opposite order.
 */
export async function createCreditNote(
  tx: Tx,
  deps: InvoicingDeps,
  input: CreateCreditNoteInput,
): Promise<InvoiceDto> {
  const [original] = await tx.select().from(invoice).where(eq(invoice.id, input.invoiceId));
  if (!original) throw new AppError('not_found');
  const locations = await visibleLocationIds(tx, input.viewer);
  if (locations !== 'all' && !original.locationIds.some((id) => locations.includes(id))) {
    throw new AppError('not_found');
  }

  const originalLines = await tx
    .select()
    .from(invoiceLine)
    .where(eq(invoiceLine.invoiceId, original.id))
    .orderBy(asc(invoiceLine.position));
  await readChargeLines(
    tx,
    originalLines.map((line) => line.chargeLineId),
    // The charges first (shared), then the lines: the order of the writers of invoices and of the void
    // of a charge, so the note and a void never wait for each other in a circle (JD-S4 R2-5).
    { lock: true, lockCharges: true },
  );

  const requestHash = hashOf({
    invoiceId: original.id,
    reason: input.request.reason,
    amountCents: input.request.amountCents ?? null,
  });
  const replay = await findReplay(tx, deps, input.request.idempotencyKey, requestHash, locations);
  if (replay) return replay;

  if (!['issued', 'manual'].includes(original.status) || original.creditNoteOfId !== null) {
    throw new AppError('invoice_credit_note_not_applicable');
  }
  const organization = await loadOrganization(tx);
  await assertReady(tx, deps, organization);

  // What each line can still take back: its amount in the invoice minus what earlier notes took.
  const taken = await tx.execute<{ charge_line_id: string; credited: string }>(
    sql`SELECT il.charge_line_id, coalesce(sum(il.amount_cents), 0) AS credited
          FROM invoice_line il
          JOIN invoice note ON note.tenant_id = il.tenant_id AND note.id = il.invoice_id
         WHERE note.credit_note_of_id = ${original.id} AND note.status <> 'rejected'
         GROUP BY il.charge_line_id`,
  );
  const creditedBy = new Map(taken.rows.map((row) => [row.charge_line_id, Number(row.credited)]));
  const left = originalLines.map(
    (line) => line.amountCents - (creditedBy.get(line.chargeLineId) ?? 0),
  );
  const available = left.reduce((sum, cents) => sum + cents, 0);
  const noteCents = input.request.amountCents ?? available;
  if (available === 0 || noteCents > available) throw new AppError('invoice_credit_note_exceeds');

  const pack = packFor(organization.country);
  const noteType = pack.invoiceRules.creditNoteTypeFor(original.type as InvoiceType);
  if (!noteType.ok) throw new AppError('invoice_credit_note_not_applicable');

  const [point] = (await tx.select().from(pointOfSale)).filter(
    (candidate) => candidate.number === original.pointOfSale && candidate.active,
  );
  if (!point) throw new AppError('invoice_point_of_sale_invalid');
  const simulated = isSimulatedIssuer(
    issuerFor(deps.adapters, { id: organization.id, isDemo: organization.isDemo }),
  );

  const recipient: Recipient = {
    kind: original.recipientKind === 'payer' ? 'payer' : 'patient',
    patientId: original.patientId,
    tenantPayerId: original.tenantPayerId,
    name: original.recipientName,
    taxCondition: original.recipientTaxCondition as Recipient['taxCondition'],
    document:
      original.recipientDocType !== null && original.recipientDocNumber !== null
        ? {
            type: original.recipientDocType as 'cuit' | 'dni',
            number: original.recipientDocNumber,
          }
        : null,
  };

  const parts = allocateCredit(left, noteCents);
  let noteId: string;
  try {
    const row = await insertInvoice(tx, deps, {
      actor: input.actor,
      values: {
        status: 'pending',
        type: noteType.value,
        pointOfSale: original.pointOfSale,
        environment: effectiveEnvironment(point.environment, simulated),
        simulated,
        issueDate: todayIn(deps.clock(), pack.defaults.timeZone),
        key: input.request.idempotencyKey,
        requestHash,
        recipient,
        totalCents: noteCents,
        locationIds: original.locationIds,
        // The note is issued by the one who issued the invoice it cancels.
        issuer: original.issuerSnapshot ?? (await currentIssuer(tx)),
        creditNote: { originalId: original.id, reason: input.request.reason },
      },
    });
    noteId = row.id;
    await insertInvoiceLines(
      tx,
      row.id,
      originalLines.flatMap((line, index) => {
        const cents = parts[index] ?? 0;
        return cents > 0
          ? [
              {
                chargeLineId: line.chargeLineId,
                chargeId: line.chargeId,
                description: line.description,
                amountCents: cents,
              },
            ]
          : [];
      }),
    );
  } catch (error) {
    // The backstop of the database: two notes that raced for the same balance.
    if (sqlState(error) === CHECK_VIOLATION) throw new AppError('invoice_credit_note_exceeds');
    throw error;
  }

  await audit(tx, {
    action: 'invoice.credit_note',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'invoice',
    resourceId: noteId,
    ...(recipient.patientId ? { patientId: recipient.patientId } : {}),
    metadata: {
      type: noteType.value,
      originalInvoiceId: original.id,
      totalCents: noteCents,
      total: noteCents === available,
    },
  });

  await queueIssue(tx, deps, input.tenantId, noteId);
  const created = await loadInvoice(tx, deps.clock, noteId, { kind: 'all' });
  if (!created) throw new Error('the credit note just created cannot be read');
  return created;
}
