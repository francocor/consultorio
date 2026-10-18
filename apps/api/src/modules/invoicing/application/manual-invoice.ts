import type { CreateManualInvoiceRequest, FieldError, InvoiceDto } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';

import { fiscalProfile, invoice } from '../../../db/schema/index.js';
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
  const lines = await lockLines(
    tx,
    request.lines.map((line) => line.chargeLineId),
    input.viewer,
  );
  const locations = await visibleLocationIds(tx, input.viewer);
  const requestHash = hashOf({
    request: { ...request, idempotencyKey: null },
    lines: [...request.lines].sort((a, b) => a.chargeLineId.localeCompare(b.chargeLineId)),
  });
  const replay = await findReplay(tx, deps, request.idempotencyKey, requestHash, locations);
  if (replay) return replay;

  if (lines.some((line) => line.chargeStatus === 'voided')) {
    throw new AppError('invoice_charge_voided');
  }

  // The pending invoice this one replaces gives its lines back first.
  if (request.replacesInvoiceId) {
    const [pending] = await tx
      .select()
      .from(invoice)
      .where(eq(invoice.id, request.replacesInvoiceId))
      .for('update');
    if (!pending) throw new AppError('not_found');
    if (pending.status !== 'pending') throw new AppError('conflict');
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

  // Lines of the invoice that were freed above are read again by the plan.
  const fresh = await lockLines(
    tx,
    request.lines.map((line) => line.chargeLineId),
    input.viewer,
  );
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

  const organization = await loadOrganization(tx);
  const pack = packFor(organization.country);
  const recipient = await resolveRecipient(tx, fresh, request.recipient);
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
