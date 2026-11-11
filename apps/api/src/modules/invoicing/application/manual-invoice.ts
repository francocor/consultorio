import {
  CREDIT_NOTE_TYPES,
  type CreateManualInvoiceRequest,
  type FieldError,
  type InvoiceDto,
  type RecipientTaxCondition,
} from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';

import { fiscalProfile, invoice, invoiceLine, type InvoiceRow } from '../../../db/schema/index.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { visibleLocationIds } from '../../access/index.js';
import { lineWording, planParts } from '../domain/invoice-amounts.js';

import { hashOf, type InvoicingActor } from './common.js';
import { packFor } from './country-rules.js';
import {
  findReplay,
  insertInvoice,
  insertInvoiceLines,
  lockLines,
  resolveRecipient,
  type InvoicingDeps,
  type Recipient,
  type Viewer,
} from './create-invoice.js';
import { loadInvoice } from './invoice-view.js';
import { snapshotOfProfile, type IssuerSnapshot } from './issuer-snapshot.js';
import { loadOrganization } from './settings.js';
import { recordStrayVoucher } from './stray-vouchers.js';

export interface RegisterManualInput {
  request: CreateManualInvoiceRequest;
  actor: InvoicingActor;
  viewer: Viewer;
  tenantId: string;
}

const validation = (path: string, i18nKey: string): AppError =>
  new AppError('validation_failed', [{ path, i18nKey } satisfies FieldError]);

/** The recipient a note already has: the one of the invoice it cancels, as the parked note carries it. */
function recipientOfNote(note: InvoiceRow): Recipient {
  return {
    kind: note.recipientKind === 'payer' ? 'payer' : 'patient',
    patientId: note.patientId,
    tenantPayerId: note.tenantPayerId,
    name: note.recipientName,
    taxCondition: note.recipientTaxCondition as RecipientTaxCondition,
    document:
      note.recipientDocType !== null && note.recipientDocNumber !== null
        ? {
            type: note.recipientDocType === 'dni' ? 'dni' : 'cuit',
            number: note.recipientDocNumber,
          }
        : null,
  };
}

/** What a pending invoice that a manual voucher stands in for says about itself afterwards. */
const REPLACED_MESSAGE =
  'Reemplazada por un comprobante registrado manualmente (emitido fuera del sistema).';

/** A line of a voucher as it is written: what it covers of a charge line. */
interface CoveredLine {
  chargeLineId: string;
  chargeId: string;
  description: string;
  amountCents: number;
}

interface Replacement {
  id: string;
  lineIds: string[];
}

/** The pending invoice a manual voucher is said to replace, with the charge lines it covers. */
async function readReplacement(tx: Tx, id: string): Promise<Replacement> {
  const [pending] = await tx.select({ id: invoice.id }).from(invoice).where(eq(invoice.id, id));
  if (!pending) throw new AppError('not_found');
  const lines = await tx
    .select({ chargeLineId: invoiceLine.chargeLineId })
    .from(invoiceLine)
    .where(eq(invoiceLine.invoiceId, id))
    .orderBy(asc(invoiceLine.chargeLineId));
  return { id, lineIds: lines.map((line) => line.chargeLineId) };
}

/**
 * Closes the pending invoice that the manual voucher replaces, as rejected, in the same transaction.
 *
 * - No attempt may be working on it: the advisory lock of the attempts is tried, and a replacement
 *   that finds it held answers `conflict` (the attempt could be about to receive a voucher; the
 *   other way round, an attempt that finds the invoice closed records what it got as an orphan).
 * - Its outcome must not be in doubt: while the request to the authority may have been answered
 *   (`awaiting_reconciliation`) the voucher may exist, and registering another one could bill the
 *   service twice. A person waits for the reconciliation, UNLESS the owner or an admin acknowledges
 *   that the outcome is unknown (`acknowledgeUnknownOutcome`): during a real outage the unknown
 *   outcome lasts as long as the outage, and the fallback exists exactly for that. The replacement
 *   is audited as `invoice.replaced_unresolved` and a person is told to look for the voucher in ARCA
 *   (JD-S4 R2-2).
 * - It must be the same invoice (JD-S4 R2-6): of the same voucher type and the same total, covering
 *   lines the voucher covers, for the same recipient and the same document. A credit note is replaced
 *   only by a credit note, and only one that was parked for a person: the same type, cancelling the
 *   same voucher, for the same total (JD-S4 R5-B-W2).
 * - It leaves the worklist: the item that asked a person to look at it is resolved (JD-S4 B-S1).
 */
async function closeReplaced(
  tx: Tx,
  deps: InvoicingDeps,
  input: RegisterManualInput,
  target: Replacement,
  requestedIds: readonly string[],
  manual: {
    type: string;
    totalCents: number;
    recipient: Recipient;
    associatedVoucher: { type: string; pointOfSale: number; number: number } | undefined;
  },
): Promise<InvoiceRow> {
  const taken = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${'afip-invoice|' + target.id}, 0)) as locked`,
  );
  if (taken.rows[0]?.locked !== true) throw new AppError('conflict');
  const [pending] = await tx.select().from(invoice).where(eq(invoice.id, target.id)).for('update');
  if (!pending) throw new AppError('not_found');
  if (pending.status !== 'pending') throw new AppError('conflict');
  // The outcome is in doubt while the request may have been answered, and also for an invoice that was
  // parked with that doubt still open (it keeps the number it expected; JD-S4 R3-4).
  const unknownOutcome =
    pending.deliveryState === 'awaiting_reconciliation' ||
    (pending.deliveryState === 'needs_attention' && pending.expectedNumber !== null);
  if (unknownOutcome && input.request.acknowledgeUnknownOutcome !== true) {
    throw new AppError('invoice_awaiting_reconciliation');
  }
  const covered = new Set(requestedIds);
  const { recipient } = manual;
  // The document of a patient is the one the person typed, so it must be the one the invoice carries.
  // The document of a payer is read from the payer when the voucher is registered, and the payer may
  // have been corrected since the invoice was requested: the payer is the same, so the invoice stays
  // replaceable (JD-S4 R3-B-T1).
  const sameDocument =
    recipient.kind === 'payer' ||
    (pending.recipientDocType === (recipient.document?.type ?? null) &&
      pending.recipientDocNumber === (recipient.document?.number ?? null));
  const isNote = pending.creditNoteOfId !== null;
  // The recipient of a credit note is the one of the invoice it cancels: it is the parked note that says
  // which, not what was typed.
  const sameRecipient =
    pending.recipientKind === recipient.kind &&
    pending.patientId === recipient.patientId &&
    pending.tenantPayerId === recipient.tenantPayerId &&
    (isNote || sameDocument);
  if (
    isNote !== CREDIT_NOTE_TYPES.some((type) => type === manual.type) ||
    // A note is replaced when it is parked for a person or when its request may have been answered (the
    // latter only with the acknowledgement, checked above), like an invoice (JD-S4 R6-B-T4).
    (isNote &&
      pending.deliveryState !== 'needs_attention' &&
      pending.deliveryState !== 'awaiting_reconciliation') ||
    !(await cancelsTheSameVoucher(tx, pending, manual.associatedVoucher)) ||
    pending.type !== manual.type ||
    pending.totalCents !== manual.totalCents ||
    target.lineIds.some((id) => !covered.has(id)) ||
    !sameRecipient
  ) {
    throw new AppError('invoice_replacement_mismatch');
  }
  await tx
    .update(invoice)
    .set({
      status: 'rejected',
      deliveryState: null,
      rejectionMessage: REPLACED_MESSAGE,
      nextAttemptAt: null,
      expectedNumber: null,
      authorityLastAtMark: null,
      lastSentAt: null,
      lookupMisses: 0,
      refusedNotNext: 0,
      awaitingSince: null,
    })
    .where(eq(invoice.id, pending.id));
  await audit(tx, {
    action: 'invoice.rejected',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'invoice',
    resourceId: pending.id,
    ...(pending.patientId ? { patientId: pending.patientId } : {}),
    metadata: { type: pending.type, replacedByManual: true },
  });
  // Whatever asked a person to look at the invoice is settled by this replacement.
  await deps.worklist?.closeBySubject(tx, {
    kind: 'invoice_attention',
    subjectType: 'invoice',
    subjectId: pending.id,
    status: 'resolved',
    resolution: 'replaced_by_manual',
    actor: input.actor,
  });
  if (!unknownOutcome) return pending;
  const unresolved = {
    type: pending.type,
    pointOfSale: pending.pointOfSale,
    expectedNumber: pending.expectedNumber,
    // The voucher may sit anywhere from the number after the last the authority had authorized when the
    // request went out (JD-S4 R6-B-T2).
    ...(pending.authorityLastAtMark !== null
      ? { candidatesFrom: pending.authorityLastAtMark + 1 }
      : {}),
  };
  // A voucher may sit at that number, and it is not the voucher of any invoice that asks later: the
  // number is remembered, so a lookup never adopts it and the next number expected is counted after it
  // (JD-S4 R3-3).
  if (pending.expectedNumber !== null) {
    await recordStrayVoucher(
      tx,
      pending.id,
      pending,
      pending.expectedNumber,
      'replaced_unresolved',
    );
  }
  await audit(tx, {
    action: 'invoice.replaced_unresolved',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'invoice',
    resourceId: pending.id,
    ...(pending.patientId ? { patientId: pending.patientId } : {}),
    metadata: { ...unresolved, replacedByManual: true },
  });
  // The voucher may exist at the authority. If it does, the organization holds two for one service:
  // a person looks for it at that number and cancels it in ARCA with a credit note.
  await deps.worklist?.openItem(tx, {
    kind: 'invoice_attention',
    subjectType: 'invoice',
    subjectId: pending.id,
    detail: { reason: 'replaced_unresolved', ...unresolved },
  });
  return pending;
}

/**
 * Whether the voucher a manual credit note says it cancels is the one the parked note cancels. An
 * invoice has none and says none.
 */
async function cancelsTheSameVoucher(
  tx: Tx,
  pending: InvoiceRow,
  associated: { type: string; pointOfSale: number; number: number } | undefined,
): Promise<boolean> {
  if (pending.creditNoteOfId === null) return associated === undefined;
  if (associated === undefined) return false;
  const [original] = await tx
    .select({ type: invoice.type, pointOfSale: invoice.pointOfSale, number: invoice.number })
    .from(invoice)
    .where(eq(invoice.id, pending.creditNoteOfId));
  return (
    original !== undefined &&
    original.type === associated.type &&
    original.pointOfSale === associated.pointOfSale &&
    original.number === associated.number
  );
}

/**
 * Registers a voucher that was issued outside the system (e-invoicing-afip, "Manual invoice entry
 * fallback"): the owner or an admin enters type, point of sale, number, CAE, date, recipient and
 * amount. It is saved as `manual` straight away, linked to charge lines, immutable (a trigger),
 * and unique per type, point of sale and number. It needs none of the integration: it works with
 * e-invoicing off, with no certificate, with the authority down.
 *
 * When the invoice was already requested and is pending (the outage), `replacesInvoiceId` closes it
 * as rejected, in the same transaction, so the voucher that exists is the one registered and the
 * pending one can never be issued as a second document for the same service.
 */
export async function registerManualInvoice(
  tx: Tx,
  deps: InvoicingDeps,
  input: RegisterManualInput,
): Promise<InvoiceDto> {
  const { request } = input;
  const requestedIds = request.lines.map((line) => line.chargeLineId);
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw validation('lines', 'validation.duplicate');
  }
  // A credit note made by hand takes the place of one that was parked, and says which voucher it
  // cancels; an invoice does not (JD-S4 R5-B-W2).
  const isNote = CREDIT_NOTE_TYPES.some((type) => type === request.type);
  if (isNote && !request.replacesInvoiceId) {
    throw validation('replacesInvoiceId', 'invoicing.manual.credit_note_replaces');
  }
  if (isNote && !request.associatedVoucher) {
    throw validation('associatedVoucher', 'invoicing.manual.associated_required');
  }
  if (!isNote && request.associatedVoucher) {
    throw validation('associatedVoucher', 'invoicing.manual.associated_only_for_notes');
  }
  // The invoice this one replaces is read first, without a lock, only to know its lines: they are
  // locked together with the ones of the request, in the order of their ids, like every other writer.
  const target = request.replacesInvoiceId
    ? await readReplacement(tx, request.replacesInvoiceId)
    : undefined;
  const locked = await lockLines(
    tx,
    [...new Set([...requestedIds, ...(target?.lineIds ?? [])])],
    input.viewer,
  );
  const lines = locked.filter((line) => requestedIds.includes(line.id));
  const locations = await visibleLocationIds(tx, input.viewer);
  // The lines are sorted apart: the same request with its lines in another order is the same request.
  const requestHash = hashOf({
    request: { ...request, lines: null, idempotencyKey: null },
    lines: [...request.lines].sort((a, b) => a.chargeLineId.localeCompare(b.chargeLineId)),
  });
  const replay = await findReplay(tx, deps, request.idempotencyKey, requestHash, locations);
  if (replay) return replay;

  if (lines.some((line) => line.chargeStatus === 'voided')) {
    throw new AppError('invoice_charge_voided');
  }

  const organization = await loadOrganization(tx);
  const pack = packFor(organization.country);
  const recipient = await resolveRecipient(tx, lines, request.recipient);

  // The voucher is whatever the external tool made, but its data must still be well formed, and the
  // type must be one the issuer could have made (when the fiscal profile is known). The total is the
  // one of the request here; it is checked against the lines below.
  const [profile] = await tx.select().from(fiscalProfile);
  if (profile && !isNote) {
    const typed = pack.invoiceRules.resolveInvoiceType({
      issuer: profile.taxCondition as 'monotributo' | 'responsable_inscripto' | 'exento',
      recipient: recipient.taxCondition,
      requested: request.type,
    });
    if (!typed.ok) throw validation('type', typed.error.i18nKey);
  }
  // A credit note takes the recipient of the note it replaces (the one of the invoice it cancels): the
  // rules of an invoice about the recipient do not apply to it.
  const checked = isNote
    ? undefined
    : pack.invoiceRules.checkRecipient({
        type: request.type,
        totalCents: request.totalCents,
        recipient: {
          taxCondition: recipient.taxCondition,
          ...(recipient.name ? { name: recipient.name } : {}),
          ...(recipient.document ? { document: recipient.document } : {}),
        },
      });
  if (checked && !checked.ok) throw validation('recipient', checked.error.i18nKey);
  const normalized: Recipient = checked?.ok
    ? {
        ...recipient,
        taxCondition: checked.value.taxCondition,
        name: checked.value.name ?? recipient.name,
        document: checked.value.document ?? null,
      }
    : recipient;

  // The pending invoice this one replaces gives its lines back first. Only one that no attempt is
  // working on, whose outcome is not in doubt (or whose doubt the owner or an admin accepts), and
  // that is the same invoice: the same type, total, lines and recipient (JD-S4 R1-C3, R2-2, R2-6).
  const replaced = target
    ? await closeReplaced(tx, deps, input, target, requestedIds, {
        type: request.type,
        totalCents: request.totalCents,
        recipient: normalized,
        associatedVoucher: request.associatedVoucher,
      })
    : undefined;

  // What the voucher covers. An invoice: the plan of the lines asked for (the lines of the invoice it
  // replaces were freed above, so they are read again). A credit note: exactly what the note it replaces
  // covered, cancelling the same invoice for the same reason.
  const covered: CoveredLine[] = [];
  // A credit note is addressed to whoever the note it replaces is addressed to, not to what was typed
  // (JD-S4 R6-5); an invoice to the recipient resolved from its lines.
  let addressee: Recipient = normalized;
  let totalCents = request.totalCents;
  let locationIds: string[];
  let issuer: IssuerSnapshot | null;
  let creditNote: { originalId: string; reason: string } | undefined;
  if (isNote) {
    if (!replaced?.creditNoteOfId || replaced.reason === null) {
      throw new Error('a credit note is only registered in place of a credit note');
    }
    const lines = await tx
      .select()
      .from(invoiceLine)
      .where(eq(invoiceLine.invoiceId, replaced.id))
      .orderBy(asc(invoiceLine.position));
    covered.push(
      ...lines.map((line) => ({
        chargeLineId: line.chargeLineId,
        chargeId: line.chargeId,
        description: line.description,
        amountCents: line.amountCents,
      })),
    );
    locationIds = replaced.locationIds;
    issuer = replaced.issuerSnapshot;
    creditNote = { originalId: replaced.creditNoteOfId, reason: replaced.reason };
    addressee = recipientOfNote(replaced);
  } else {
    const fresh = await lockLines(tx, requestedIds, input.viewer);
    const plan = planParts(fresh, request.lines);
    if (!plan.ok) {
      if (plan.reason === 'over_invoiced') throw new AppError('invoice_line_over_invoiced');
      throw validation('lines', 'validation.duplicate');
    }
    if (plan.totalCents !== request.totalCents) {
      throw validation('totalCents', 'invoicing.manual.total_mismatch');
    }
    totalCents = plan.totalCents;
    const service = new Map(fresh.map((line) => [line.id, line]));
    covered.push(
      ...plan.parts.map((part) => {
        const line = service.get(part.chargeLineId);
        if (!line) throw new Error('a planned part has no line');
        return {
          chargeLineId: line.id,
          chargeId: line.chargeId,
          description: lineWording({ kind: line.kind, serviceName: '' }),
          amountCents: part.amountCents,
        };
      }),
    );
    locationIds = [...new Set(fresh.map((line) => line.locationId))].sort();
    issuer = profile ? snapshotOfProfile(profile) : null;
  }

  const [taken] = await tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(
      and(
        eq(invoice.pointOfSale, request.pointOfSale),
        eq(invoice.type, request.type),
        eq(invoice.number, request.number),
      ),
    );
  if (taken) throw new AppError('invoice_number_taken');

  const row = await insertInvoice(tx, deps, {
    actor: input.actor,
    values: {
      status: 'manual',
      type: request.type,
      pointOfSale: request.pointOfSale,
      // It came from the real tool of the authority.
      environment: 'production',
      simulated: false,
      issueDate: request.issueDate,
      key: request.idempotencyKey,
      requestHash,
      recipient: addressee,
      totalCents,
      locationIds,
      issuer,
      ...(creditNote ? { creditNote } : {}),
      manual: {
        number: request.number,
        cae: request.cae,
        caeExpiresOn: request.caeExpiresOn ?? null,
      },
    },
  });
  await insertInvoiceLines(tx, row.id, covered);

  await audit(tx, {
    action: 'invoice.manual',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'invoice',
    resourceId: row.id,
    ...(addressee.patientId ? { patientId: addressee.patientId } : {}),
    metadata: {
      type: request.type,
      pointOfSale: request.pointOfSale,
      number: request.number,
      totalCents,
      ...(request.replacesInvoiceId ? { replacedInvoiceId: request.replacesInvoiceId } : {}),
    },
  });

  const saved = await loadInvoice(tx, deps.clock, row.id, { kind: 'all' });
  if (!saved) throw new Error('the invoice just registered cannot be read');
  return saved;
}
