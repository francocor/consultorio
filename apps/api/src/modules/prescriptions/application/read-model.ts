import type {
  PrescriptionDto,
  PrescriptionFailureDto,
  PrescriptionStatus,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { prescription, type PrescriptionRow } from '../../../db/schema/prescriptions.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { parseContent, type PrescriptionContent } from '../domain/prescription.js';

import { CANCEL_REASON_FIELD, CONTENT_FIELD } from './common.js';
import { PrescriptionDenied } from './errors.js';

/** The prescription by id, as the policies of the database let this transaction see it. */
export async function findPrescription(tx: Tx, id: string): Promise<PrescriptionRow | undefined> {
  const [row] = await tx.select().from(prescription).where(eq(prescription.id, id));
  return row;
}

/** The prescription by id with its row locked, for a change. */
export async function lockPrescription(tx: Tx, id: string): Promise<PrescriptionRow | undefined> {
  const [row] = await tx.select().from(prescription).where(eq(prescription.id, id)).for('update');
  return row;
}

/**
 * A prescription the policies of the database hid. A professional who may not read it (neither the
 * prescriber nor treating the patient, whatever the sharing scope says) is refused, and the refusal
 * is audited with the patient; one that does not exist is "not found". A definer function tells the
 * two apart and returns the patient to the server only.
 */
export async function hiddenOrMissing(tx: Tx, id: string): Promise<never> {
  const result = await tx.execute<{ patient: string | null }>(
    sql`select app.prescription_probe(${id}::uuid) as patient`,
  );
  const patientId = result.rows[0]?.patient;
  if (patientId) {
    throw new PrescriptionDenied('prescription_not_readable', { prescriptionId: id, patientId });
  }
  throw new AppError('not_found');
}

/** Decrypts what a prescription says. The plaintext lives in memory for this request only. */
export async function openContent(
  keys: TenantKeys,
  tx: Tx,
  row: PrescriptionRow,
): Promise<PrescriptionContent> {
  const plain = await keys.decryptField(tx, { ...CONTENT_FIELD, rowId: row.id }, row.contentEnc);
  return parseContent(plain.toString('utf8'));
}

async function openCancelReason(
  keys: TenantKeys,
  tx: Tx,
  row: PrescriptionRow,
): Promise<string | null> {
  if (row.cancelReasonEnc === null) return null;
  const plain = await keys.decryptField(
    tx,
    { ...CANCEL_REASON_FIELD, rowId: row.id },
    row.cancelReasonEnc,
  );
  return plain.toString('utf8');
}

/** Statuses of a prescription the provider confirmed and that still has a document to give. */
export const DOCUMENT_STATUSES: readonly PrescriptionStatus[] = ['issued', 'dispensed', 'expired'];

/**
 * Why a prescription that is not issued is not. A refused one (a draft) carries the words of the
 * provider; one that waits for the provider is "unavailable" until a person is needed.
 */
export function failureOf(row: PrescriptionRow): PrescriptionFailureDto | null {
  if (row.status === 'draft' && row.rejectionMessage !== null) {
    return {
      kind: 'rejected',
      message: row.rejectionMessage,
      attempts: row.attempts,
      nextAttemptAt: null,
      awaitingReconciliation: false,
    };
  }
  if (row.status !== 'pending_submission') return null;
  return {
    kind: row.deliveryState === 'needs_attention' ? 'needs_attention' : 'unavailable',
    message: null,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    awaitingReconciliation: row.deliveryState === 'awaiting_reconciliation',
  };
}

/** The prescription as the professionals who may read it see it. */
export async function toDto(
  keys: TenantKeys,
  tx: Tx,
  row: PrescriptionRow,
): Promise<PrescriptionDto> {
  const content = await openContent(keys, tx, row);
  return {
    id: row.id,
    patientId: row.patientId,
    encounterId: row.encounterId,
    status: row.status as PrescriptionStatus,
    date: row.prescriptionDate,
    createdAt: row.createdAt.toISOString(),
    issuedAt: row.issuedAt?.toISOString() ?? null,
    externalId: row.externalId,
    registeredManually: row.registeredManually,
    prescriber: {
      professionalId: row.authorProfessionalId,
      fullName: content.prescriber.fullName,
      matricula: content.prescriber.matricula,
      jurisdiction: content.prescriber.jurisdiction,
      specialty: content.prescriber.specialty,
    },
    patient: {
      fullName: content.patient.fullName,
      documentType: content.patient.documentType,
      documentNumber: content.patient.documentNumber,
      coverage: content.patient.coverage,
    },
    items: content.items,
    cancelReason: await openCancelReason(keys, tx, row),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    failure: failureOf(row),
    simulated: row.simulated,
    documentAvailable:
      row.documentKey !== null && DOCUMENT_STATUSES.includes(row.status as PrescriptionStatus),
  };
}
