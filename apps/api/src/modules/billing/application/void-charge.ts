import type { ChargeDto, VoidChargeRequest } from '@consultorio/contracts';
import { asc, eq } from 'drizzle-orm';

import { charge, chargeLine } from '../../../db/schema/billing-charges.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { InvoiceLookup } from '../../invoicing/index.js';

import { loadCharge } from './charge-view.js';
import type { BillingActor } from './common.js';
import { paidNetByCharge } from './payment-totals.js';
import { billingScopeOf, canSee, type ScopeViewer } from './scope.js';

/**
 * Voids a charge (billing-payments, "Charge lifecycle and voiding"). It needs a reason, and it is
 * refused while the patient holds a payment that was not refunded (refund first) and while an issued
 * invoice stands over it (a credit note first, asked of the invoicing module). The charge stays,
 * with its reason, who and when; nothing is deleted.
 */
export async function voidCharge(
  tx: Tx,
  input: {
    chargeId: string;
    request: VoidChargeRequest;
    actor: BillingActor;
    viewer: ScopeViewer;
    invoices: InvoiceLookup;
    now?: Date;
  },
): Promise<ChargeDto> {
  const scope = await billingScopeOf(tx, input.viewer);
  const [row] = await tx
    .select({
      status: charge.status,
      patientId: charge.patientId,
      locationId: charge.locationId,
      professionalId: charge.professionalId,
    })
    .from(charge)
    .where(eq(charge.id, input.chargeId))
    .for('update');
  if (!row || !canSee(scope, row)) throw new AppError('not_found');
  if (row.status === 'voided') throw new AppError('charge_voided');

  // The lines of the charge are locked, in the order of their ids, before the invoices are asked
  // about: an invoice being created over them holds these locks until it commits, so the question
  // below sees it (JD-S4 R1-C2). Charge first, then lines: the order of the writers of invoices.
  await tx
    .select({ id: chargeLine.id })
    .from(chargeLine)
    .where(eq(chargeLine.chargeId, input.chargeId))
    .orderBy(asc(chargeLine.id))
    .for('update');

  const paid = (await paidNetByCharge(tx, [input.chargeId])).get(input.chargeId) ?? 0;
  if (paid > 0) throw new AppError('charge_has_payments');
  if (await input.invoices.hasIssuedInvoice(tx, input.chargeId)) {
    throw new AppError('charge_has_invoice');
  }

  const before = await loadCharge(tx, input.chargeId, scope);
  await tx
    .update(charge)
    .set({
      status: 'voided',
      voidReason: input.request.reason,
      voidedAt: input.now ?? new Date(),
      voidedBy: input.actor.userId,
    })
    .where(eq(charge.id, input.chargeId));
  await audit(tx, {
    action: 'charge.voided',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'charge',
    resourceId: input.chargeId,
    patientId: row.patientId,
    metadata: { reason: input.request.reason, totalCents: before?.totalCents ?? 0 },
  });

  const voided = await loadCharge(tx, input.chargeId, scope);
  if (!voided) throw new AppError('not_found');
  return voided;
}
