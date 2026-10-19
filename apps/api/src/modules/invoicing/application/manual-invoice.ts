import type { CreateManualInvoiceRequest, FieldError, InvoiceDto } from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';

import { fiscalProfile, invoice, invoiceLine } from '../../../db/schema/index.js';
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
import { snapshotOfProfile } from './issuer-snapshot.js';
import { loadOrganization } from './settings.js';

export interface RegisterManualInput {
  request: CreateManualInvoiceRequest;
  actor: InvoicingActor;
  viewer: Viewer;
  tenantId: string;
}

const validation = (path: string, i18nKey: string): AppError =>
  new AppError('validation_failed', [{ path, i18nKey } satisfies FieldError]);

/** What a pending invoice that a manual voucher stands in for says about itself afterwards. */
const REPLACED_MESSAGE =
  'Reemplazada por un comprobante registrado manualmente (emitido fuera del sistema).';

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
 *   (`awaiting_reconciliation`) the voucher may exist, and registering another one would bill the
 *   service twice. A person waits for the reconciliation.
 * - It must be the same invoice: it covers lines the voucher covers and has the same recipient.
 */
async function closeReplaced(
  tx: Tx,
  input: RegisterManualInput,
  target: Replacement,
  requestedIds: readonly string[],
  recipient: Recipient,
): Promise<void> {
  const taken = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${'afip-invoice|' + target.id}, 0)) as locked`,
  );
  if (taken.rows[0]?.locked !== true) throw new AppError('conflict');
  const [pending] = await tx.select().from(invoice).where(eq(invoice.id, target.id)).for('update');
  if (!pending) throw new AppError('not_found');
  if (pending.status !== 'pending') throw new AppError('conflict');
  if (pending.deliveryState === 'awaiting_reconciliation') {
    throw new AppError('invoice_awaiting_reconciliation');
  }
  const covered = new Set(requestedIds);
  const sameRecipient =
    pending.recipientKind === recipient.kind &&
    pending.patientId === recipient.patientId &&
    pending.tenantPayerId === recipient.tenantPayerId;
  if (target.lineIds.some((id) => !covered.has(id)) || !sameRecipient) {
    throw new AppError('invoice_replacement_mismatch');
  }
  await tx
    .update(invoice)
    .set({
      status: 'rejected',
      deliveryState: null,
      rejectionMessage: REPLACED_MESSAGE,
      nextAttemptAt: null,
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

  // The pending invoice this one replaces gives its lines back first. Only one that no attempt is
  // working on, whose outcome is not in doubt, and that is the same invoice (JD-S4 R1-C3).
  if (target) await closeReplaced(tx, input, target, requestedIds, recipient);

  // Lines of the invoice that were freed above are read again by the plan.
  const fresh = await lockLines(tx, requestedIds, input.viewer);
  const plan = planParts(fresh, request.lines);
  if (!plan.ok) {
    if (plan.reason === 'over_invoiced') throw new AppError('invoice_line_over_invoiced');
    throw validation('lines', 'validation.duplicate');
  }
  if (plan.totalCents !== request.totalCents) {
    throw validation('totalCents', 'invoicing.manual.total_mismatch');
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

  // The voucher is whatever the external tool made, but its data must still be well formed, and the
  // type must be one the issuer could have made (when the fiscal profile is known).
  const [profile] = await tx.select().from(fiscalProfile);
  if (profile) {
    const typed = pack.invoiceRules.resolveInvoiceType({
      issuer: profile.taxCondition as 'monotributo' | 'responsable_inscripto' | 'exento',
      recipient: recipient.taxCondition,
      requested: request.type,
    });
    if (!typed.ok) throw validation('type', typed.error.i18nKey);
  }
  const checked = pack.invoiceRules.checkRecipient({
    type: request.type,
    totalCents: plan.totalCents,
    recipient: {
      taxCondition: recipient.taxCondition,
      ...(recipient.name ? { name: recipient.name } : {}),
      ...(recipient.document ? { document: recipient.document } : {}),
    },
  });
  if (!checked.ok) throw validation('recipient', checked.error.i18nKey);
  const normalized: Recipient = {
    ...recipient,
    taxCondition: checked.value.taxCondition,
    name: checked.value.name ?? recipient.name,
    document: checked.value.document ?? null,
  };

  const service = new Map(fresh.map((line) => [line.id, line]));
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
      recipient: normalized,
      totalCents: plan.totalCents,
      locationIds: [...new Set(fresh.map((line) => line.locationId))].sort(),
      issuer: profile ? snapshotOfProfile(profile) : null,
      manual: {
        number: request.number,
        cae: request.cae,
        caeExpiresOn: request.caeExpiresOn ?? null,
      },
    },
  });
  await insertInvoiceLines(
    tx,
    row.id,
    plan.parts.map((part) => {
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

  await audit(tx, {
    action: 'invoice.manual',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'invoice',
    resourceId: row.id,
    ...(normalized.patientId ? { patientId: normalized.patientId } : {}),
    metadata: {
      type: request.type,
      pointOfSale: request.pointOfSale,
      number: request.number,
      totalCents: plan.totalCents,
      ...(request.replacesInvoiceId ? { replacedInvoiceId: request.replacesInvoiceId } : {}),
    },
  });

  const saved = await loadInvoice(tx, deps.clock, row.id, { kind: 'all' });
  if (!saved) throw new Error('the invoice just registered cannot be read');
  return saved;
}
