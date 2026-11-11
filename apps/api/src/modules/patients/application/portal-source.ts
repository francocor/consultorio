import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { patient, patientVersion, type PatientRow } from '../../../db/schema/patients.js';
import { dataProcessingConsent, patientRightsRequest } from '../../../db/schema/privacy.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { changedFieldsBetween, snapshotOf } from './mapping.js';

/**
 * What the patient portal (Stage 5, track B) needs from the registry: who a patient is, their own
 * data to show them, the contact fields they may change, and the requests they may make about
 * their data (Ley 25.326). The portal reads and writes patients through here and not through the
 * table; every function takes the patient as an argument, which the portal derives from the
 * session and never from a request.
 */
export interface PatientBasics {
  id: string;
  givenNames: string;
  familyName: string;
  /** `YYYY-MM-DD`. */
  birthDate: string;
  email: string | null;
  status: 'active' | 'inactive';
}

export async function readPatientBasics(tx: Tx, patientId: string): Promise<PatientBasics | null> {
  const [row] = await tx
    .select({
      id: patient.id,
      givenNames: patient.givenNames,
      familyName: patient.familyName,
      birthDate: patient.birthDate,
      email: patient.email,
      status: patient.status,
    })
    .from(patient)
    .where(eq(patient.id, patientId));
  return row ? { ...row, status: row.status === 'active' ? 'active' : 'inactive' } : null;
}

// The patient's own data ---------------------------------------------------------------------------

export interface PortalPatientProfile {
  givenNames: string;
  familyName: string;
  birthDate: string;
  document: { type: string; number: string } | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  emergencyContact: { name: string; phone: string } | null;
  /** Version of the record: the screen sends it back so a stale form is refused. */
  version: number;
  /** The data-processing consent (Ley 25.326): whether it stands and since when. */
  dataProcessing: { granted: boolean; grantedAt: Date | null };
}

function documentOf(row: PatientRow): { type: string; number: string } | null {
  return row.nationalIdType !== null && row.nationalId !== null
    ? { type: row.nationalIdType, number: row.nationalId }
    : null;
}

async function profileOf(tx: Tx, row: PatientRow): Promise<PortalPatientProfile> {
  const [consent] = await tx
    .select({ grantedAt: dataProcessingConsent.grantedAt })
    .from(dataProcessingConsent)
    .where(
      and(eq(dataProcessingConsent.patientId, row.id), isNull(dataProcessingConsent.revokedAt)),
    )
    .orderBy(desc(dataProcessingConsent.grantedAt))
    .limit(1);
  return {
    givenNames: row.givenNames,
    familyName: row.familyName,
    birthDate: row.birthDate,
    document: documentOf(row),
    phone: row.phone,
    email: row.email,
    address: row.address,
    emergencyContact:
      row.emergencyContactName !== null && row.emergencyContactPhone !== null
        ? { name: row.emergencyContactName, phone: row.emergencyContactPhone }
        : null,
    version: row.version,
    dataProcessing: { granted: consent !== undefined, grantedAt: consent?.grantedAt ?? null },
  };
}

/** The demographics and contact data of the patient, as the patient sees them. */
export async function readPortalProfile(
  tx: Tx,
  patientId: string,
): Promise<PortalPatientProfile | null> {
  const [row] = await tx.select().from(patient).where(eq(patient.id, patientId));
  return row ? profileOf(tx, row) : null;
}

/** The contact fields a patient may change by themselves. Name, document and birth date are not here. */
export interface PortalContactChanges {
  phone?: string | null;
  address?: string | null;
  emergencyContact?: { name: string; phone: string } | null;
}

/**
 * Changes the contact data of a patient from the portal. It is the versioned update of the
 * registry: the previous state stays in the history, the version moves, and the trail names the
 * fields and the versions (before and after) and never the values. Nothing but the contact fields
 * is touched, so an identity correction cannot go through here (it is a rectification request).
 */
export async function updatePortalContact(
  tx: Tx,
  input: {
    patientId: string;
    changes: PortalContactChanges;
    /** The version the screen showed: a form that is out of date is refused. */
    expectedVersion?: number | undefined;
    actor: AuditActor;
  },
): Promise<{ profile: PortalPatientProfile; changed: string[] }> {
  const [row] = await tx
    .select()
    .from(patient)
    .where(eq(patient.id, input.patientId))
    .for('update');
  if (!row) throw new AppError('not_found');
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
    throw new AppError('stale_revision');
  }

  const values: Partial<typeof patient.$inferInsert> = {};
  const { changes } = input;
  if (changes.phone !== undefined) values.phone = changes.phone === '' ? null : changes.phone;
  if (changes.address !== undefined) {
    values.address = changes.address === '' ? null : changes.address;
  }
  if (changes.emergencyContact !== undefined) {
    values.emergencyContactName = changes.emergencyContact?.name ?? null;
    values.emergencyContactPhone = changes.emergencyContact?.phone ?? null;
  }
  const changed = changedFieldsBetween(snapshotOf(row), snapshotOf({ ...row, ...values }));
  if (changed.length === 0) return { profile: await profileOf(tx, row), changed };

  const [updated] = await tx
    .update(patient)
    .set({ ...values, version: row.version + 1 })
    .where(eq(patient.id, row.id))
    .returning();
  if (!updated) throw new AppError('not_found');
  await tx.insert(patientVersion).values({
    tenantId: sql`current_setting('app.tenant_id')::uuid`,
    patientId: updated.id,
    version: updated.version,
    // The patient changed it: there is no staff user to name. The trail names the identity.
    changedBy: null,
    changedFields: changed,
    snapshot: snapshotOf(updated),
  });
  await audit(tx, {
    action: 'portal.profile.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'patient',
    resourceId: updated.id,
    patientId: updated.id,
    // Field names and the versions on both sides of the change; the values are in the history.
    metadata: { fields: changed, versionBefore: row.version, versionAfter: updated.version },
  });
  return { profile: await profileOf(tx, updated), changed };
}

// Requests about the data ---------------------------------------------------------------------------

export interface PortalRightsRequest {
  id: string;
  kind: 'access' | 'rectification';
  status: 'open' | 'fulfilled';
  requestedAt: Date;
}

/**
 * Logs a request of the patient about their own data: a copy of their clinical history (kind
 * `access`, fulfilled by the organization outside the portal) or the correction of an identity
 * field (kind `rectification`, which stays open until staff apply it through the versioned update).
 * The record is unchanged. The note is the patient's own short words; the caller limits it.
 */
export async function createPortalRightsRequest(
  tx: Tx,
  input: {
    patientId: string;
    kind: 'access' | 'rectification';
    note: string | null;
    /** The portal identity that asked: it takes the place of the staff user of the record. */
    requestedBy: string;
    actor: AuditActor;
  },
): Promise<PortalRightsRequest> {
  const [existing] = await tx
    .select({ id: patient.id })
    .from(patient)
    .where(eq(patient.id, input.patientId));
  if (!existing) throw new AppError('not_found');
  const [row] = await tx
    .insert(patientRightsRequest)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      patientId: input.patientId,
      kind: input.kind,
      requestedBy: input.requestedBy,
      note: input.note,
    })
    .returning();
  if (!row) throw new Error('rights request insert returned no row');
  await audit(tx, {
    action: 'patient.rights_request.created',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'patient',
    resourceId: input.patientId,
    patientId: input.patientId,
    metadata: { kind: row.kind, via: 'portal' },
  });
  return {
    id: row.id,
    kind: row.kind === 'rectification' ? 'rectification' : 'access',
    status: 'open',
    requestedAt: row.createdAt,
  };
}

/** The requests the patient made about their data, newest first, with whether the organization closed them. */
export async function listPortalRightsRequests(
  tx: Tx,
  patientId: string,
): Promise<PortalRightsRequest[]> {
  const rows = await tx
    .select()
    .from(patientRightsRequest)
    .where(eq(patientRightsRequest.patientId, patientId))
    .orderBy(desc(patientRightsRequest.createdAt), desc(patientRightsRequest.id));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind === 'rectification' ? 'rectification' : 'access',
    status: row.status === 'fulfilled' ? 'fulfilled' : 'open',
    requestedAt: row.createdAt,
  }));
}
