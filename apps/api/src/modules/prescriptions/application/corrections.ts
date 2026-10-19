import type {
  CancelPrescriptionRequest,
  PrescriptionCancelResult,
  RegisterManualPrescriptionRequest,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { prescription, type PrescriptionRow } from '../../../db/schema/prescriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { cancelKeyOf } from '../domain/prescription.js';

import {
  CANCEL_REASON_FIELD,
  UNIQUE_VIOLATION,
  constraintOf,
  sqlState,
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
    if (row.deliveryState === 'awaiting_reconciliation') {
      throw new PrescriptionConflict(
        'prescription_awaiting_reconciliation',
        'prescription_awaiting_reconciliation',
        entryOf(row),
      );
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
  const result: PrescriptionCancelResult = await provider
    .cancel(row.externalId, reason, cancelKeyOf(organization.id, row.id))
    .catch((): PrescriptionCancelResult => ({
      status: 'retryable',
      message: 'unreachable',
      outcomeUnknown: true,
    }));
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
  if (row.deliveryState === 'awaiting_reconciliation') {
    throw new AppError('prescription_awaiting_reconciliation');
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
