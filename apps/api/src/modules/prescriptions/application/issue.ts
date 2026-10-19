import type { CorrectPrescriptionRequest, IssuePrescriptionRequest } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';

import { encounter } from '../../../db/schema/clinical.js';
import { patient } from '../../../db/schema/patients.js';
import { prescription } from '../../../db/schema/prescriptions.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { AppError } from '../../../platform/http/problem.js';
import { isTreating, readPatientPayerPlan } from '../../patients/index.js';
import { readPrescriberProfile, type PrescriberProfile } from '../../staff/index.js';
import {
  documentDate,
  issueKeyOf,
  serializeContent,
  type PrescriptionContent,
} from '../domain/prescription.js';

import {
  CONTENT_FIELD,
  CURRENT_TENANT,
  DEFAULT_TIME_ZONE,
  UNIQUE_VIOLATION,
  constraintOf,
  isSimulated,
  sqlState,
  type PrescriptionDeps,
} from './common.js';
import { requireProvider } from './connection.js';
import { PrescriptionConflict, PrescriptionDenied } from './errors.js';
import { ERX_SUBMIT_JOB } from './job-names.js';
import { hiddenOrMissing, lockPrescription } from './read-model.js';

/** Who is acting: the professional the permission guard let through. */
export interface Caller {
  actor: AuditActor & { userId: string };
  professionalId: string;
}

/** How long the request waits before the queue also tries a prescription (the request tries first). */
const QUEUE_DELAY_SECONDS = 45;

/** The professional may prescribe now: active, with a registration the platform operator verified. */
function assertMayPrescribe(
  profile: PrescriberProfile | null,
): asserts profile is PrescriberProfile & { matricula: string; jurisdiction: string } {
  if (
    profile?.status !== 'active' ||
    profile.matriculaStatus !== 'verified' ||
    profile.matricula === null ||
    profile.jurisdiction === null
  ) {
    throw new AppError('prescription_matricula_unverified');
  }
}

/** Reads the patient, the coverage and the prescriber and builds what the prescription says. */
async function buildContent(
  tx: Tx,
  deps: PrescriptionDeps,
  input: { caller: Caller; patientId: string; items: IssuePrescriptionRequest['items'] },
): Promise<PrescriptionContent> {
  const profile = await readPrescriberProfile(tx, input.caller.professionalId);
  assertMayPrescribe(profile);

  const [found] = await tx
    .select({
      familyName: patient.familyName,
      givenNames: patient.givenNames,
      documentType: patient.nationalIdType,
      documentNumber: patient.nationalId,
      status: patient.status,
    })
    .from(patient)
    .where(eq(patient.id, input.patientId));
  // A patient who is not registered in the organization (or was deactivated) is not one to prescribe to.
  if (found?.status !== 'active') throw new AppError('not_found');
  if (!(await isTreating(tx, input.caller.professionalId, input.patientId))) {
    throw new PrescriptionDenied('prescription_requires_relationship', {
      patientId: input.patientId,
    });
  }
  if (
    (found.documentType !== 'dni' && found.documentType !== 'passport') ||
    found.documentNumber === null
  ) {
    throw new AppError('prescription_patient_document_required');
  }

  const date = documentDate(deps.clock(), deps.timeZone ?? DEFAULT_TIME_ZONE);
  const plan = await readPatientPayerPlan(tx, input.patientId, date);
  return {
    patient: {
      fullName: `${found.givenNames} ${found.familyName}`,
      documentType: found.documentType,
      documentNumber: found.documentNumber,
      coverage: plan === null ? null : { payerName: plan.payerName, planName: plan.planName },
    },
    prescriber: {
      fullName: profile.fullName,
      matricula: profile.matricula,
      jurisdiction: profile.jurisdiction,
      specialty: profile.specialties[0] ?? null,
    },
    date,
    items: [...input.items],
  };
}

/** The encounter a prescription names is one of this patient, written by this professional. */
async function assertEncounter(
  tx: Tx,
  input: { caller: Caller; patientId: string; encounterId: string },
): Promise<void> {
  const [found] = await tx
    .select({ patientId: encounter.patientId, author: encounter.authorProfessionalId })
    .from(encounter)
    .where(eq(encounter.id, input.encounterId));
  if (
    !found ||
    found.patientId !== input.patientId ||
    found.author !== input.caller.professionalId
  ) {
    throw new PrescriptionDenied('prescription_encounter_mismatch', { patientId: input.patientId });
  }
}

/**
 * Makes a prescription and leaves it waiting for the provider (e-prescription, "Prescriber
 * eligibility", "Authorized provider connection", "Prescription content"). It is not valid until the
 * provider confirms it: `submit.ts` asks, in the next transaction, and the queue asks again if that
 * never happens.
 *
 * - the connection and its switch must be on, the matricula must be verified NOW, the patient must
 *   belong to the organization and be treated by the prescriber, and have a document;
 * - the key the form made answers a double submission with the prescription it already made;
 * - the provider key is derived here from the organization and the prescription, never from the
 *   client; the patient, the prescriber and the date are copied from the records, never accepted.
 */
export async function createPrescription(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
  request: IssuePrescriptionRequest,
): Promise<{ id: string; created: boolean }> {
  const [again] = await tx
    .select({ id: prescription.id })
    .from(prescription)
    .where(eq(prescription.clientKey, request.clientKey));
  if (again) return { id: again.id, created: false };

  const { provider, organization } = await requireProvider(tx, deps);
  const content = await buildContent(tx, deps, {
    caller,
    patientId: request.patientId,
    items: request.items,
  });
  if (request.encounterId !== undefined) {
    await assertEncounter(tx, {
      caller,
      patientId: request.patientId,
      encounterId: request.encounterId,
    });
  }

  const id = uuidv7();
  const blob = await deps.keys.encryptField(
    tx,
    { ...CONTENT_FIELD, rowId: id },
    serializeContent(content),
  );
  try {
    // A savepoint: a double submission that raced this one must not abort the whole request.
    await tx.transaction((inner) =>
      inner.insert(prescription).values({
        id,
        tenantId: CURRENT_TENANT,
        patientId: request.patientId,
        authorProfessionalId: caller.professionalId,
        encounterId: request.encounterId ?? null,
        clientKey: request.clientKey,
        contentEnc: blob,
        prescriptionDate: content.date,
        idempotencyKey: issueKeyOf(organization.id, id),
        simulated: isSimulated(provider),
      }),
    );
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION && constraintOf(error) === 'prescription_client_key') {
      const [raced] = await tx
        .select({ id: prescription.id })
        .from(prescription)
        .where(eq(prescription.clientKey, request.clientKey));
      if (raced) return { id: raced.id, created: false };
    }
    throw error;
  }
  // The queue is the second chance: if the process dies before the request submits it, the worker does.
  await deps.jobs?.enqueue(
    tx,
    ERX_SUBMIT_JOB,
    { tenantId: organization.id, prescriptionId: id },
    { startAfter: QUEUE_DELAY_SECONDS },
  );
  return { id, created: true };
}

/**
 * Corrects a prescription the provider refused (a draft) and puts it back to wait for the provider.
 * Nothing else is edited: an issued prescription is cancelled and a new one is made. The attempt to
 * edit one leaves a trace in the audit trail (the route writes it).
 */
export async function correctPrescription(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
  input: { prescriptionId: string; request: CorrectPrescriptionRequest },
): Promise<void> {
  const row = await lockPrescription(tx, input.prescriptionId);
  if (!row) return hiddenOrMissing(tx, input.prescriptionId);
  const entry = { prescriptionId: row.id, patientId: row.patientId };
  if (row.authorProfessionalId !== caller.professionalId) {
    throw new PrescriptionDenied('prescription_not_author', entry);
  }
  // An issued prescription (or one cancelled, dispensed or expired) never changes; one that waits
  // for the provider is what the provider is about to be sent.
  if (row.status !== 'draft') {
    throw new PrescriptionConflict('prescription_not_editable', 'prescription_immutable', entry);
  }

  const { organization } = await requireProvider(tx, deps);
  const content = await buildContent(tx, deps, {
    caller,
    patientId: row.patientId,
    items: input.request.items,
  });
  const blob = await deps.keys.encryptField(
    tx,
    { ...CONTENT_FIELD, rowId: row.id },
    serializeContent(content),
  );
  await tx
    .update(prescription)
    .set({
      contentEnc: blob,
      prescriptionDate: content.date,
      status: 'pending_submission',
      rejectionMessage: null,
      deliveryState: null,
      attempts: 0,
      nextAttemptAt: null,
      version: row.version + 1,
    })
    .where(and(eq(prescription.id, row.id), eq(prescription.status, 'draft')));
  await deps.jobs?.enqueue(
    tx,
    ERX_SUBMIT_JOB,
    { tenantId: organization.id, prescriptionId: row.id },
    { startAfter: QUEUE_DELAY_SECONDS },
  );
}
