import {
  money,
  type AddChargeLineRequest,
  type CaptureChargeRequest,
  type ChargeDto,
  type ChargeSnapshotDto,
  type QuoteDto,
} from '@consultorio/contracts';
import { and, eq, max, ne } from 'drizzle-orm';

import { charge, chargeLine } from '../../../db/schema/billing-charges.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { AppointmentForCharge } from '../../scheduling/index.js';
import { LINE_LABELS } from '../domain/labels.js';

import { refreshChargeStatus } from './charge-state.js';
import { loadCharge } from './charge-view.js';
import {
  CURRENT_TENANT,
  UNIQUE_VIOLATION,
  localDay,
  sqlState,
  type BillingActor,
} from './common.js';
import { resolveQuote, selectionOf, visibleAppointment } from './quote.js';
import { billingScopeOf, canSee, type ScopeViewer } from './scope.js';
import { loadBillingSettings } from './settings.js';

/** What a charge for this appointment is made of, once its status is understood. */
type Plan = { kind: 'service' } | { kind: 'late_fee'; amountCents: number };

/**
 * Whether the appointment may be charged, and for what (billing-payments, "Charge capture per
 * appointment"): from check-in on for the service; before check-in never; a no-show, or a
 * cancellation made too late, only when the organization enabled the fee, and then as an explicit
 * fee line.
 */
function planOf(
  appointment: AppointmentForCharge,
  fee: { enabled: boolean; amountCents: number },
): Plan {
  switch (appointment.status) {
    case 'checked_in':
    case 'in_progress':
    case 'attended':
      return { kind: 'service' };
    case 'no_show':
      if (fee.enabled && fee.amountCents > 0)
        return { kind: 'late_fee', amountCents: fee.amountCents };
      throw new AppError('charge_not_billable');
    case 'cancelled':
      if (appointment.lateCancellation === true && fee.enabled && fee.amountCents > 0) {
        return { kind: 'late_fee', amountCents: fee.amountCents };
      }
      throw new AppError('charge_not_billable');
    default:
      throw new AppError('charge_check_in_required');
  }
}

interface NewLine {
  kind: 'service' | 'payer_coverage' | 'copago' | 'plus' | 'late_fee';
  portion: 'patient' | 'payer';
  description: string;
  amountCents: number;
}

function linesOfQuote(quote: QuoteDto, typeName: string): NewLine[] {
  return quote.lines.map((line) => ({
    kind: line.kind,
    portion: line.portion,
    amountCents: line.amountCents,
    description:
      line.kind === 'service'
        ? typeName
        : line.kind === 'payer_coverage'
          ? LINE_LABELS.coverage(quote.payer?.name ?? '')
          : line.kind === 'copago'
            ? LINE_LABELS.copago
            : LINE_LABELS.plus,
  }));
}

export type CaptureOutcome =
  { created: true; charge: ChargeDto } | { created: false; existingChargeId: string };

async function findActiveCharge(tx: Tx, appointmentId: string): Promise<string | undefined> {
  const [existing] = await tx
    .select({ id: charge.id })
    .from(charge)
    .where(and(eq(charge.appointmentId, appointmentId), ne(charge.status, 'voided')));
  return existing?.id;
}

/**
 * Captures the charge of an appointment. The same quote the desk saw prices it; a service nothing
 * prices needs an amount typed by a person (audited as an override). A second capture, even a
 * simultaneous one, points at the charge that exists instead of making another.
 */
export async function captureCharge(
  tx: Tx,
  input: { request: CaptureChargeRequest; actor: BillingActor; viewer: ScopeViewer },
): Promise<CaptureOutcome> {
  const { request, actor } = input;
  const scope = await billingScopeOf(tx, input.viewer);
  const appointment = await visibleAppointment(tx, request.appointmentId, scope);
  const settings = await loadBillingSettings(tx);
  const plan = planOf(appointment, {
    enabled: settings.lateFeeEnabled,
    amountCents: settings.lateFeeAmount,
  });

  const already = await findActiveCharge(tx, appointment.id);
  if (already) return { created: false, existingChargeId: already };

  const serviceDate = localDay(appointment.startsAt, appointment.locationTimeZone);
  let lines: NewLine[];
  let quote: QuoteDto | null = null;
  let explicit: number | null = null;
  if (plan.kind === 'late_fee') {
    lines = [
      {
        kind: 'late_fee',
        portion: 'patient',
        description: LINE_LABELS.lateFee,
        amountCents: plan.amountCents,
      },
    ];
  } else {
    const resolved = await resolveQuote(tx, appointment, selectionOf(request));
    quote = resolved.quote;
    if (quote) {
      // The catalog prices it: an amount typed by hand would silently override the list.
      if (request.explicitAmountCents !== undefined) throw new AppError('charge_price_exists');
      lines = linesOfQuote(quote, appointment.appointmentTypeName);
    } else {
      if (request.explicitAmountCents === undefined) throw new AppError('charge_amount_required');
      explicit = request.explicitAmountCents;
      lines = [
        {
          kind: 'service',
          portion: 'patient',
          description: appointment.appointmentTypeName,
          amountCents: explicit,
        },
      ];
    }
  }

  const snapshot: ChargeSnapshotDto = {
    quote,
    explicitAmountCents: explicit === null ? null : money(explicit),
    appointmentTypeName: appointment.appointmentTypeName,
    serviceDate,
  };

  let chargeId: string;
  try {
    // A savepoint: losing the race for the unique index must leave the transaction usable.
    chargeId = await tx.transaction(async (inner) => {
      const [row] = await inner
        .insert(charge)
        .values({
          tenantId: CURRENT_TENANT,
          appointmentId: appointment.id,
          patientId: appointment.patientId,
          professionalId: appointment.professionalId,
          locationId: appointment.locationId,
          tenantPayerId: quote?.payer?.tenantPayerId ?? null,
          planName: quote?.payer?.planName ?? null,
          snapshot,
          explicitAmount: explicit !== null,
          capturedBy: actor.userId,
        })
        .returning({ id: charge.id });
      if (!row) throw new Error('charge insert returned no row');
      await inner.insert(chargeLine).values(
        lines.map((line, index) => ({
          tenantId: CURRENT_TENANT,
          chargeId: row.id,
          position: index + 1,
          kind: line.kind,
          portion: line.portion,
          description: line.description,
          amountCents: line.amountCents,
          createdBy: actor.userId,
        })),
      );
      return row.id;
    });
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) {
      const winner = await findActiveCharge(tx, appointment.id);
      if (winner) return { created: false, existingChargeId: winner };
    }
    throw error;
  }

  await refreshChargeStatus(tx, chargeId);
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  await audit(tx, {
    action: 'charge.captured',
    outcome: 'allow',
    actor,
    resourceType: 'charge',
    resourceId: chargeId,
    patientId: appointment.patientId,
    metadata: {
      appointmentId: appointment.id,
      totalCents: total,
      source: plan.kind === 'late_fee' ? 'late_fee' : (quote?.source ?? 'explicit'),
    },
  });
  if (explicit !== null) {
    await audit(tx, {
      action: 'billing.price.override',
      outcome: 'allow',
      actor,
      resourceType: 'charge',
      resourceId: chargeId,
      patientId: appointment.patientId,
      metadata: {
        appointmentId: appointment.id,
        appointmentTypeId: appointment.appointmentTypeId,
        amountCents: explicit,
      },
    });
  }

  const created = await loadCharge(tx, chargeId, scope);
  if (!created) throw new Error('the charge just captured cannot be read');
  return { created: true, charge: created };
}

/** Adds a line to a charge that is not voided. Lines are never edited or removed afterwards. */
export async function addChargeLine(
  tx: Tx,
  input: {
    chargeId: string;
    request: AddChargeLineRequest;
    actor: BillingActor;
    viewer: ScopeViewer;
  },
): Promise<ChargeDto> {
  const scope = await billingScopeOf(tx, input.viewer);
  // The lock serializes line numbers and the state of the charge with payments recorded together.
  const [row] = await tx
    .select({
      status: charge.status,
      locationId: charge.locationId,
      professionalId: charge.professionalId,
      patientId: charge.patientId,
    })
    .from(charge)
    .where(eq(charge.id, input.chargeId))
    .for('update');
  if (!row || !canSee(scope, row)) throw new AppError('not_found');
  if (row.status === 'voided') throw new AppError('charge_voided');

  const [last] = await tx
    .select({ position: max(chargeLine.position) })
    .from(chargeLine)
    .where(eq(chargeLine.chargeId, input.chargeId));
  const position = (last?.position ?? 0) + 1;
  await tx.insert(chargeLine).values({
    tenantId: CURRENT_TENANT,
    chargeId: input.chargeId,
    position,
    kind: 'manual',
    portion: input.request.portion ?? 'patient',
    description: input.request.description,
    amountCents: input.request.amountCents,
    createdBy: input.actor.userId,
  });
  await refreshChargeStatus(tx, input.chargeId);
  await audit(tx, {
    action: 'charge.captured',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'charge',
    resourceId: input.chargeId,
    patientId: row.patientId,
    metadata: {
      change: 'line_added',
      position,
      amountCents: input.request.amountCents,
      portion: input.request.portion ?? 'patient',
    },
  });

  const updated = await loadCharge(tx, input.chargeId, scope);
  if (!updated) throw new AppError('not_found');
  return updated;
}
