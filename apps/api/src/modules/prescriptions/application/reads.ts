import type {
  PrescriptionDto,
  PrescriptionExistenceResponse,
  PrescriptionStatus,
} from '@consultorio/contracts';
import { desc, eq, sql } from 'drizzle-orm';

import { prescription } from '../../../db/schema/prescriptions.js';
import { tenant } from '../../../db/schema/tenant.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { CURRENT_TENANT, type PrescriptionDeps } from './common.js';
import type { Caller } from './issue.js';
import { findPrescription, hiddenOrMissing, toDto } from './read-model.js';

/** Most prescriptions one read returns: a patient has a handful, and a screen is not a report. */
const LIMIT = 100;

/**
 * Writes the entry of the audit trail for the prescription a professional opened, with the actor,
 * the patient and the prescription (e-prescription, "Audit of a read"). The reader is the prescriber
 * or a professional who treats the patient; the sharing scope never opens one.
 */
async function auditRead(
  tx: Tx,
  caller: Caller,
  row: { id: string; patientId: string },
): Promise<void> {
  await audit(tx, {
    action: 'prescription.read',
    outcome: 'allow',
    actor: caller.actor,
    resourceType: 'prescription',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: { via: 'record' },
  });
}

/**
 * A list is one read, one entry: who listed, for which patient when there is one, and how many
 * prescriptions it showed (JD-S5 R1-B-S3). An entry per row would turn a screen into a hundred
 * entries of the trail, and the entry of the record is written when one of them is opened.
 */
async function auditList(
  tx: Tx,
  caller: Caller,
  input: { via: 'list' | 'mine'; count: number; patientId?: string },
): Promise<void> {
  await audit(tx, {
    action: 'prescription.read',
    outcome: 'allow',
    actor: caller.actor,
    resourceType: 'prescription',
    ...(input.patientId === undefined ? {} : { patientId: input.patientId }),
    metadata: { via: input.via, count: input.count },
  });
}

/** One prescription, as the professional who may read it sees it. */
export async function getPrescription(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
  prescriptionId: string,
): Promise<PrescriptionDto> {
  // The policies of the database hide what this professional may not read, and a missing one looks the same.
  const row = await findPrescription(tx, prescriptionId);
  if (!row) return hiddenOrMissing(tx, prescriptionId);
  await auditRead(tx, caller, row);
  return toDto(deps.keys, tx, row);
}

/** The prescriptions of a patient the professional may read, newest first. */
export async function listForPatient(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
  patientId: string,
): Promise<PrescriptionDto[]> {
  const rows = await tx
    .select()
    .from(prescription)
    .where(eq(prescription.patientId, patientId))
    .orderBy(desc(prescription.createdAt), desc(prescription.id))
    .limit(LIMIT);
  const dtos: PrescriptionDto[] = [];
  for (const row of rows) dtos.push(await toDto(deps.keys, tx, row));
  await auditList(tx, caller, { via: 'list', count: dtos.length, patientId });
  return dtos;
}

/** The prescriptions the professional wrote, newest first. */
export async function listMine(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
): Promise<PrescriptionDto[]> {
  const rows = await tx
    .select()
    .from(prescription)
    .where(eq(prescription.authorProfessionalId, caller.professionalId))
    .orderBy(desc(prescription.createdAt), desc(prescription.id))
    .limit(LIMIT);
  const dtos: PrescriptionDto[] = [];
  for (const row of rows) dtos.push(await toDto(deps.keys, tx, row));
  await auditList(tx, caller, { via: 'mine', count: dtos.length });
  return dtos;
}

/**
 * That a prescription exists, for reception, when the organization lets it (the setting
 * `reception_sees_clinical_metadata`). The database function decides (setting on, and the caller is
 * an active reception member); this service never calls it for anyone else. The answer carries the
 * id, the status and the day, and nothing of the prescription.
 */
export async function receptionExistence(
  tx: Tx,
  input: { patientId: string },
): Promise<PrescriptionExistenceResponse> {
  const [setting] = await tx
    .select({
      on: sql<boolean>`(${tenant.settings} -> 'reception_sees_clinical_metadata') = 'true'::jsonb`,
    })
    .from(tenant)
    .where(eq(tenant.id, CURRENT_TENANT));
  const result = await tx.execute<{
    id: string;
    status: PrescriptionStatus;
    created_at: string | Date;
  }>(
    sql`select id, status, created_at from app.reception_prescription_existence(${input.patientId}::uuid)`,
  );
  return {
    visible: setting?.on === true,
    prescriptions: result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}
