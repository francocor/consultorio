import { createHash } from 'node:crypto';

import {
  money,
  type ChargeDto,
  type CorrectPaymentRequest,
  type PaymentDto,
  type PaymentMethod,
  type PaymentResultResponse,
  type RecordPaymentRequest,
  type RefundPaymentRequest,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { charge, chargeLine } from '../../../db/schema/billing-charges.js';
import { payment, paymentReversal } from '../../../db/schema/billing-payments.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { summarizeCharge } from '../domain/charge-status.js';

import { assertMayOperate, findOpenSession } from './cash-register.js';
import { refreshChargeStatus } from './charge-state.js';
import { loadCharge } from './charge-view.js';
import {
  CURRENT_TENANT,
  UNIQUE_VIOLATION,
  constraintOf,
  sqlState,
  type BillingActor,
} from './common.js';
import { paidNetByCharge } from './payment-totals.js';
import { billingScopeOf, canSee, type BillingScope, type ScopeViewer } from './scope.js';

/**
 * Payments, refunds and corrections (billing-payments, "Payment recording", "Duplicate payment
 * protection", "Refunds and payment reversals", "Closed register immutability"). Every one of them
 * takes the lock on the charge first, so the amounts it reads cannot change under it and two
 * submissions of the same payment cannot both go through. Entries are only ever added.
 */

function hashOf(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

interface LockedCharge {
  id: string;
  status: string;
  locationId: string;
  patientId: string;
}

async function lockCharge(tx: Tx, chargeId: string, scope: BillingScope): Promise<LockedCharge> {
  const [row] = await tx
    .select({
      id: charge.id,
      status: charge.status,
      locationId: charge.locationId,
      professionalId: charge.professionalId,
      patientId: charge.patientId,
    })
    .from(charge)
    .where(eq(charge.id, chargeId))
    .for('update');
  if (!row || !canSee(scope, row)) throw new AppError('not_found');
  return row;
}

/** What the patient still owes of their portion, from the lines and the entries so far. */
async function outstandingOf(tx: Tx, chargeId: string): Promise<number> {
  const lines = await tx.select().from(chargeLine).where(eq(chargeLine.chargeId, chargeId));
  const paid = (await paidNetByCharge(tx, [chargeId])).get(chargeId) ?? 0;
  return summarizeCharge(lines, paid).outstandingCents;
}

/**
 * Where the money of an entry is counted: cash needs the open register of the location and is
 * refused without one; any other method joins the open register for the daily summary when there
 * is one, and is not tied to a register otherwise.
 *
 * The register is read with a lock (a close in progress makes the entry wait, then the register is
 * no longer open: JD-S4 R1-C1), and whoever puts money in it must be someone who may operate the
 * location, the rule the register itself applies (JD-S4 R1-B-T4): seeing the charge is not enough,
 * for example for staff who see their own appointments at a place they are not assigned to.
 */
async function registerFor(
  tx: Tx,
  viewer: ScopeViewer,
  locationId: string,
  methods: readonly PaymentMethod[],
): Promise<string | null> {
  const open = await findOpenSession(tx, locationId, { lock: true });
  if (open !== undefined || methods.includes('cash')) {
    await assertMayOperate(tx, viewer, locationId);
  }
  if (methods.includes('cash') && !open) throw new AppError('cash_register_required');
  return open ?? null;
}

function paymentOf(chargeDto: ChargeDto, paymentId: string): PaymentDto {
  const found = chargeDto.payments.find((entry) => entry.id === paymentId);
  if (!found) throw new Error('the payment just recorded cannot be read');
  return found;
}

interface NewPayment {
  chargeId: string;
  locationId: string;
  method: PaymentMethod;
  amountCents: number;
  externalRef: string | undefined;
  overrideReason: string | undefined;
  confirmCredit: boolean | undefined;
  idempotencyKey: string;
  requestHash: string;
  correctsPaymentId?: string;
  actor: BillingActor;
  viewer: ScopeViewer;
  now: Date;
  patientId: string;
}

/** Writes one payment after the rules of an amount owed, a voucher and a register. */
async function insertPayment(tx: Tx, input: NewPayment): Promise<string> {
  const outstanding = await outstandingOf(tx, input.chargeId);
  const excess = Math.max(0, input.amountCents - outstanding);
  if (excess > 0 && input.confirmCredit !== true) throw new AppError('payment_overpayment');

  const register = await registerFor(tx, input.viewer, input.locationId, [input.method]);

  let repeatedReference = false;
  if (input.externalRef !== undefined) {
    const [seen] = await tx
      .select({ id: payment.id })
      .from(payment)
      .where(eq(payment.externalRef, input.externalRef))
      .limit(1);
    repeatedReference = seen !== undefined;
    if (repeatedReference && input.overrideReason === undefined) {
      throw new AppError('payment_voucher_duplicate');
    }
  }

  let id: string;
  try {
    id = await tx.transaction(async (inner) => {
      const [row] = await inner
        .insert(payment)
        .values({
          tenantId: CURRENT_TENANT,
          chargeId: input.chargeId,
          locationId: input.locationId,
          cashSessionId: register,
          method: input.method,
          amountCents: input.amountCents,
          creditCents: excess,
          paidAt: input.now,
          recordedBy: input.actor.userId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          externalRef: input.externalRef ?? null,
          overrideReason: repeatedReference ? (input.overrideReason ?? null) : null,
          correctsPaymentId: input.correctsPaymentId ?? null,
        })
        .returning({ id: payment.id });
      if (!row) throw new Error('payment insert returned no row');
      return row.id;
    });
  } catch (error) {
    // Two submissions met at a unique index. Which index says what went wrong: the same voucher
    // twice, or the same idempotency key for another submission (JD-S4 R1-C10).
    if (sqlState(error) === UNIQUE_VIOLATION) {
      const constraint = constraintOf(error);
      if (constraint === 'payment_reference_key') throw new AppError('payment_voucher_duplicate');
      if (constraint === 'payment_idempotency_key') throw new AppError('idempotency_key_reused');
    }
    throw error;
  }

  await audit(tx, {
    action: 'payment.recorded',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'payment',
    resourceId: id,
    patientId: input.patientId,
    metadata: {
      chargeId: input.chargeId,
      method: input.method,
      amountCents: input.amountCents,
      creditCents: excess,
      locationId: input.locationId,
    },
  });
  if (repeatedReference) {
    await audit(tx, {
      action: 'payment.override',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'payment',
      resourceId: id,
      patientId: input.patientId,
      metadata: { chargeId: input.chargeId, reason: input.overrideReason ?? '' },
    });
  }
  return id;
}

async function result(
  tx: Tx,
  scope: BillingScope,
  chargeId: string,
  paymentId: string,
  replayed: boolean,
): Promise<PaymentResultResponse> {
  const chargeDto = await loadCharge(tx, chargeId, scope);
  if (!chargeDto) throw new AppError('not_found');
  return { payment: paymentOf(chargeDto, paymentId), charge: chargeDto, replayed };
}

/** Records a payment of the patient against a charge. A retry of the same submission is a replay. */
export async function recordPayment(
  tx: Tx,
  input: {
    chargeId: string;
    request: RecordPaymentRequest;
    actor: BillingActor;
    viewer: ScopeViewer;
    now: Date;
  },
): Promise<PaymentResultResponse> {
  const { request } = input;
  const scope = await billingScopeOf(tx, input.viewer);
  const locked = await lockCharge(tx, input.chargeId, scope);
  const requestHash = hashOf({
    chargeId: input.chargeId,
    method: request.method,
    amountCents: request.amountCents,
    externalRef: request.externalRef ?? null,
    overrideReason: request.overrideReason ?? null,
    confirmCredit: request.confirmCredit ?? false,
  });

  const [earlier] = await tx
    .select({ id: payment.id, chargeId: payment.chargeId, requestHash: payment.requestHash })
    .from(payment)
    .where(eq(payment.idempotencyKey, request.idempotencyKey));
  if (earlier) {
    if (earlier.chargeId !== input.chargeId || earlier.requestHash !== requestHash) {
      throw new AppError('idempotency_key_reused');
    }
    return result(tx, scope, input.chargeId, earlier.id, true);
  }

  if (locked.status === 'voided') throw new AppError('charge_voided');
  const id = await insertPayment(tx, {
    chargeId: input.chargeId,
    locationId: locked.locationId,
    method: request.method,
    amountCents: request.amountCents,
    externalRef: request.externalRef,
    overrideReason: request.overrideReason,
    confirmCredit: request.confirmCredit,
    idempotencyKey: request.idempotencyKey,
    requestHash,
    actor: input.actor,
    viewer: input.viewer,
    now: input.now,
    patientId: locked.patientId,
  });
  await refreshChargeStatus(tx, input.chargeId);
  return result(tx, scope, input.chargeId, id, false);
}

interface OriginalPayment {
  id: string;
  chargeId: string;
  locationId: string;
  method: PaymentMethod;
  amountCents: number;
  remainingCents: number;
}

/** The payment to refund or correct, locked through its charge, with what is left of it. */
async function loadOriginal(
  tx: Tx,
  paymentId: string,
  scope: BillingScope,
): Promise<{ original: OriginalPayment; locked: LockedCharge }> {
  const [row] = await tx.select().from(payment).where(eq(payment.id, paymentId));
  if (!row) throw new AppError('not_found');
  const locked = await lockCharge(tx, row.chargeId, scope);
  const [taken] = await tx
    .select({ total: sql<string>`coalesce(sum(${paymentReversal.amountCents}), 0)` })
    .from(paymentReversal)
    .where(eq(paymentReversal.paymentId, paymentId));
  const reversed = Number(taken?.total ?? 0);
  return {
    locked,
    original: {
      id: row.id,
      chargeId: row.chargeId,
      locationId: row.locationId,
      method: row.method as PaymentMethod,
      amountCents: row.amountCents,
      remainingCents: money(row.amountCents - reversed),
    },
  };
}

async function findReversal(tx: Tx, key: string) {
  const [found] = await tx
    .select({
      id: paymentReversal.id,
      paymentId: paymentReversal.paymentId,
      requestHash: paymentReversal.requestHash,
    })
    .from(paymentReversal)
    .where(eq(paymentReversal.idempotencyKey, key));
  return found;
}

/**
 * Gives back part or all of what is left of a payment, with a reason. The payment is not touched:
 * the refund is an entry of its own, linked to it, in the open register when the money was cash.
 */
export async function refundPayment(
  tx: Tx,
  input: {
    paymentId: string;
    request: RefundPaymentRequest;
    actor: BillingActor;
    viewer: ScopeViewer;
    now: Date;
  },
): Promise<PaymentResultResponse> {
  const { request } = input;
  const scope = await billingScopeOf(tx, input.viewer);
  const { original, locked } = await loadOriginal(tx, input.paymentId, scope);
  const requestHash = hashOf({
    paymentId: input.paymentId,
    amountCents: request.amountCents,
    reason: request.reason,
    kind: 'refund',
  });

  const earlier = await findReversal(tx, request.idempotencyKey);
  if (earlier) {
    if (earlier.paymentId !== input.paymentId || earlier.requestHash !== requestHash) {
      throw new AppError('idempotency_key_reused');
    }
    return result(tx, scope, original.chargeId, original.id, true);
  }

  if (request.amountCents > original.remainingCents) throw new AppError('payment_refund_exceeds');
  const register = await registerFor(tx, input.viewer, original.locationId, [original.method]);

  await tx.insert(paymentReversal).values({
    tenantId: CURRENT_TENANT,
    paymentId: original.id,
    chargeId: original.chargeId,
    locationId: original.locationId,
    cashSessionId: register,
    amountCents: request.amountCents,
    reason: request.reason,
    kind: 'refund',
    reversedBy: input.actor.userId,
    reversedAt: input.now,
    idempotencyKey: request.idempotencyKey,
    requestHash,
  });
  await refreshChargeStatus(tx, original.chargeId);
  await audit(tx, {
    action: 'payment.refunded',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'payment',
    resourceId: original.id,
    patientId: locked.patientId,
    metadata: {
      chargeId: original.chargeId,
      method: original.method,
      amountCents: request.amountCents,
      reason: request.reason,
    },
  });
  return result(tx, scope, original.chargeId, original.id, false);
}

/**
 * Corrects a payment that was recorded wrong, also after its register closed: what is left of it is
 * reversed and a new entry with the right amount is made, both in the register that is open, linked
 * to the original. The closed register is not touched.
 */
export async function correctPayment(
  tx: Tx,
  input: {
    paymentId: string;
    request: CorrectPaymentRequest;
    actor: BillingActor;
    viewer: ScopeViewer;
    now: Date;
  },
): Promise<PaymentResultResponse> {
  const { request } = input;
  const scope = await billingScopeOf(tx, input.viewer);
  const { original, locked } = await loadOriginal(tx, input.paymentId, scope);
  const method = request.method ?? original.method;
  const requestHash = hashOf({
    paymentId: input.paymentId,
    amountCents: request.amountCents,
    reason: request.reason,
    method,
    externalRef: request.externalRef ?? null,
    overrideReason: request.overrideReason ?? null,
    confirmCredit: request.confirmCredit ?? false,
    kind: 'correction',
  });

  const reversalKey = `${request.idempotencyKey}:reversal`;
  const earlier = await findReversal(tx, reversalKey);
  if (earlier) {
    if (earlier.paymentId !== input.paymentId || earlier.requestHash !== requestHash) {
      throw new AppError('idempotency_key_reused');
    }
    const [replacement] = await tx
      .select({ id: payment.id })
      .from(payment)
      .where(eq(payment.idempotencyKey, request.idempotencyKey));
    if (!replacement) throw new AppError('idempotency_key_reused');
    return result(tx, scope, original.chargeId, replacement.id, true);
  }

  if (locked.status === 'voided') throw new AppError('charge_voided');
  if (original.remainingCents <= 0) throw new AppError('payment_refund_exceeds');
  // Both entries go into the open register: the money of a cash payment leaves it, and the new
  // one may be cash as well. Cash on either side needs a register to be open.
  const register = await registerFor(tx, input.viewer, original.locationId, [
    original.method,
    method,
  ]);

  await tx.insert(paymentReversal).values({
    tenantId: CURRENT_TENANT,
    paymentId: original.id,
    chargeId: original.chargeId,
    locationId: original.locationId,
    cashSessionId: register,
    amountCents: original.remainingCents,
    reason: request.reason,
    kind: 'correction',
    reversedBy: input.actor.userId,
    reversedAt: input.now,
    idempotencyKey: reversalKey,
    requestHash,
  });
  const replacementId = await insertPayment(tx, {
    chargeId: original.chargeId,
    locationId: original.locationId,
    method,
    amountCents: request.amountCents,
    externalRef: request.externalRef,
    overrideReason: request.overrideReason,
    confirmCredit: request.confirmCredit,
    idempotencyKey: request.idempotencyKey,
    requestHash,
    correctsPaymentId: original.id,
    actor: input.actor,
    viewer: input.viewer,
    now: input.now,
    patientId: locked.patientId,
  });
  await refreshChargeStatus(tx, original.chargeId);
  await audit(tx, {
    action: 'cash.adjusted',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'payment',
    resourceId: original.id,
    patientId: locked.patientId,
    metadata: {
      chargeId: original.chargeId,
      replacementPaymentId: replacementId,
      previousAmountCents: original.remainingCents,
      amountCents: request.amountCents,
      reason: request.reason,
    },
  });
  return result(tx, scope, original.chargeId, replacementId, false);
}
