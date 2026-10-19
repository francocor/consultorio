import type {
  CancelPrescriptionRequest,
  PrescriptionCancelResult,
  RegisterManualPrescriptionRequest,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { prescription, type PrescriptionRow } from '../../../db/schema/prescriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { readPrescriberProfile } from '../../staff/index.js';
import { cancelKeyOf } from '../domain/prescription.js';

import {
  CANCEL_REASON_FIELD,
  UNIQUE_VIOLATION,
  UNREACHABLE,
  constraintOf,
  sqlState,
  withinTime,
  type PrescriptionDeps,
} from './common.js';
import { requireProvider } from './connection.js';
import { PrescriptionConflict, PrescriptionDenied } from './errors.js';
import type { Caller } from './issue.js';
import { hiddenOrMissing, lockPrescription } from './read-model.js';

/**
 * What cancelling ended in. A refusal and an outage are answered AFTER the transaction commits (the
 * route throws), so the entry of the audit trail that says the provider refused is not rolled back
 * with the request.
 */
export type CancelOutcome = 'cancelled' | 'refused' | 'unavailable';

/** The prescriber is the one who cancels; a colleague who treats the patient reads and is refused. */
function entryOf(row: PrescriptionRow) {
  return { prescriptionId: row.id, patientId: row.patientId };
}

/**
 * Leaves the row alone while an attempt waits for the provider: the advisory lock of the attempts
 * (held for the length of a job's transaction) and the lease of a request's attempt (which holds no
 * connection) both mean "somebody is sending this". The same advisory lock as `attemptSubmit`'s, and
 * a try-lock: it answers a conflict at once instead of waiting.
 */
async function assertNoAttemptInFlight(
  tx: Tx,
  deps: PrescriptionDeps,
  row: PrescriptionRow,
): Promise<void> {
  const lock = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${'erx-prescription|' + row.id}, 0)) as locked`,
  );
  const leased =
    row.attemptLeaseUntil !== null && row.attemptLeaseUntil.getTime() > deps.clock().getTime();
  if (lock.rows[0]?.locked !== true || leased) {
    throw new PrescriptionConflict(
      'prescription_attempt_in_progress',
      'prescription_attempt_in_progress',
      entryOf(row),
    );
  }
}

/**
 * Whether the provider may hold a prescription for this row: it was asked to issue it (the mark is
 * never cleared, whatever state the row was parked in since), or the answer was lost. A refused
 * draft holds nothing: the provider said so.
 */
function mayHoldAtProvider(row: PrescriptionRow): boolean {
  return (
    row.status === 'pending_submission' &&
    (row.providerContactedAt !== null || row.deliveryState === 'awaiting_reconciliation')
  );
}

/** What the provider says about the key of a row that may have reached it. */
async function askProvider(
  tx: Tx,
  deps: PrescriptionDeps,
  row: PrescriptionRow,
): Promise<'free' | 'holds' | 'unreachable'> {
  const { provider } = await requireProvider(tx, deps);
  const found = await withinTime(deps, () => provider.findByKey(row.idempotencyKey), UNREACHABLE);
  if (found === null || found.status === 'rejected') return 'free';
  return found.status === 'retryable' ? 'unreachable' : 'holds';
}

async function writeCancelled(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
  row: PrescriptionRow,
  step: { reason: string; via: 'provider' | 'local' },
): Promise<void> {
  const blob = await deps.keys.encryptField(
    tx,
    { ...CANCEL_REASON_FIELD, rowId: row.id },
    step.reason,
  );
  await tx
    .update(prescription)
    .set({
      status: 'cancelled',
      cancelReasonEnc: blob,
      cancelledAt: deps.clock(),
      deliveryState: null,
      nextAttemptAt: null,
      version: row.version + 1,
    })
    .where(eq(prescription.id, row.id));
  await audit(tx, {
    action: 'prescription.cancelled',
    outcome: 'allow',
    actor: caller.actor,
    resourceType: 'prescription',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: { via: step.via, status: row.status },
  });
}

/**
 * Cancels a prescription with a mandatory reason (e-prescription, "Immutability and cancellation"):
 *
 * - an issued prescription is cancelled THROUGH the provider; if the provider refuses, it stays
 *   issued and the refusal is audited; if the provider cannot be reached, nothing changes and the
 *   same request can be sent again (the cancellation key is the same, so the answer is the same);
 * - one the provider never confirmed (an outage, or a refusal) is cancelled here, without calling
 *   anybody, unless the provider may have issued it and the answer is unknown: it is asked first;
 * - anything else (dispensed, expired, already cancelled) stays as it is.
 *
 * The reason is encrypted like the rest of the prescription and never reaches the audit trail.
 */
export async function cancelPrescription(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
  input: { prescriptionId: string; request: CancelPrescriptionRequest },
): Promise<CancelOutcome> {
  const row = await lockPrescription(tx, input.prescriptionId);
  if (!row) return hiddenOrMissing(tx, input.prescriptionId);
  if (row.authorProfessionalId !== caller.professionalId) {
    throw new PrescriptionDenied('prescription_not_author', entryOf(row));
  }
  const { reason } = input.request;

  if (row.status === 'pending_submission' || row.status === 'draft') {
    // Not while an attempt is waiting for the provider (JD-S5 R1-S5-3): the provider would be given
    // a prescription that was cancelled here a moment ago.
    await assertNoAttemptInFlight(tx, deps, row);
    if (mayHoldAtProvider(row)) {
      // The provider may hold it even if this row says otherwise (a parked row, a lost answer): it
      // is asked first, and a prescription it holds is cancelled after it is recorded, not here.
      const answer = await askProvider(tx, deps, row);
      if (answer === 'unreachable') return 'unavailable';
      if (answer === 'holds') {
        throw new PrescriptionConflict(
          'prescription_awaiting_reconciliation',
          'prescription_awaiting_reconciliation',
          entryOf(row),
        );
      }
    }
    await writeCancelled(tx, deps, caller, row, { reason, via: 'local' });
    return 'cancelled';
  }
  if (row.status !== 'issued' || row.externalId === null) {
    throw new PrescriptionConflict(
      'prescription_not_cancellable',
      'prescription_not_cancellable',
      entryOf(row),
    );
  }

  const { provider, organization } = await requireProvider(tx, deps);
  const externalId = row.externalId;
  const result: PrescriptionCancelResult = await withinTime(
    deps,
    () => provider.cancel(externalId, reason, cancelKeyOf(organization.id, row.id)),
    { status: 'retryable', message: 'unreachable', outcomeUnknown: true },
  );
  if (result.status === 'cancelled') {
    await writeCancelled(tx, deps, caller, row, { reason, via: 'provider' });
    return 'cancelled';
  }
  await audit(tx, {
    action: 'prescription.failed',
    outcome: 'allow',
    actor: caller.actor,
    resourceType: 'prescription',
    resourceId: row.id,
    patientId: row.patientId,
    reason: result.status === 'rejected' ? 'cancel_refused' : 'cancel_unavailable',
    metadata: { operation: 'cancel' },
  });
  return result.status === 'rejected' ? 'refused' : 'unavailable';
}

/**
 * Registers the identifier of a prescription the professional issued directly on the provider's own
 * site (e-prescription, "Manual fallback registration"): it is stored as issued and flagged
 * "registered manually". It applies to a prescription the provider has not confirmed; one whose
 * answer may be lost waits until the provider has been asked, so the same prescription is never
 * issued twice.
 */
export async function registerManually(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
  input: { prescriptionId: string; request: RegisterManualPrescriptionRequest },
): Promise<void> {
  const row = await lockPrescription(tx, input.prescriptionId);
  if (!row) return hiddenOrMissing(tx, input.prescriptionId);
  if (row.authorProfessionalId !== caller.professionalId) {
    throw new PrescriptionDenied('prescription_not_author', entryOf(row));
  }
  if (row.status !== 'pending_submission' && row.status !== 'draft') {
    throw new AppError('prescription_not_pending');
  }
  await assertNoAttemptInFlight(tx, deps, row);
  // The identifier is typed by a person and ends on a document: the registration that vouches for it
  // is checked again now, not only when the prescription was made (JD-S5 R1-A-T5).
  const profile = await readPrescriberProfile(tx, caller.professionalId);
  if (profile?.status !== 'active' || profile.matriculaStatus !== 'verified') {
    throw new AppError('prescription_matricula_unverified');
  }
  if (mayHoldAtProvider(row)) {
    const answer = await askProvider(tx, deps, row);
    if (answer === 'unreachable') throw new AppError('prescription_provider_unavailable');
    if (answer === 'holds') throw new AppError('prescription_awaiting_reconciliation');
  }
  const now = deps.clock();
  try {
    // A savepoint: an identifier that is already registered must not abort the whole request.
    await tx.transaction(async (inner) => {
      // A refused draft goes back to waiting before it can be issued (the database allows no shortcut).
      if (row.status === 'draft') {
        await inner
          .update(prescription)
          .set({ status: 'pending_submission', rejectionMessage: null })
          .where(eq(prescription.id, row.id));
      }
      await inner
        .update(prescription)
        .set({
          status: 'issued',
          externalId: input.request.identifier,
          issuedAt: now,
          registeredManually: true,
          deliveryState: null,
          nextAttemptAt: null,
          version: row.version + 1,
        })
        .where(eq(prescription.id, row.id));
    });
  } catch (error) {
    if (
      sqlState(error) === UNIQUE_VIOLATION &&
      constraintOf(error) === 'prescription_external_key'
    ) {
      throw new AppError('prescription_identifier_taken');
    }
    throw error;
  }
  await audit(tx, {
    action: 'prescription.registered_manually',
    outcome: 'allow',
    actor: caller.actor,
    resourceType: 'prescription',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: { simulated: row.simulated },
  });
}
