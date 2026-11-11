import type {
  PortalProfileResponse,
  PortalProfileUpdateRequest,
  PortalRectificationRequest,
  PortalRightsRequestDto,
} from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import {
  createPortalRightsRequest,
  listPortalRightsRequests,
  readPortalProfile,
  updatePortalContact,
  type PortalPatientProfile,
  type PortalRightsRequest,
} from '../../patients/index.js';

import type { PortalSubject } from './subject.js';

function requestDto(request: PortalRightsRequest): PortalRightsRequestDto {
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
  };
}

function toResponse(
  profile: PortalPatientProfile,
  requests: readonly PortalRightsRequest[],
): PortalProfileResponse {
  return {
    givenNames: profile.givenNames,
    familyName: profile.familyName,
    birthDate: profile.birthDate,
    document: profile.document,
    phone: profile.phone,
    email: profile.email,
    address: profile.address,
    emergencyContact: profile.emergencyContact,
    version: profile.version,
    dataProcessing: {
      granted: profile.dataProcessing.granted,
      grantedAt: profile.dataProcessing.grantedAt?.toISOString() ?? null,
    },
    requests: requests.map(requestDto),
  };
}

/** The patient's own data and what they asked the organization about it. */
export async function readProfile(tx: Tx, subject: PortalSubject): Promise<PortalProfileResponse> {
  const profile = await readPortalProfile(tx, subject.patientId);
  if (!profile) throw new AppError('not_found');
  return toResponse(profile, await listPortalRightsRequests(tx, subject.patientId));
}

/**
 * Changes the contact fields of the subject (spec "Personal data access and rectification"). A
 * representative changes the contact data of the dependent they represent; nobody changes a name, a
 * document or a birth date this way.
 */
export async function updateProfile(
  tx: Tx,
  subject: PortalSubject,
  input: { request: PortalProfileUpdateRequest; actor: AuditActor },
): Promise<PortalProfileResponse> {
  const { expectedVersion, ...changes } = input.request;
  const { profile } = await updatePortalContact(tx, {
    patientId: subject.patientId,
    changes,
    expectedVersion,
    actor: input.actor,
  });
  return toResponse(profile, await listPortalRightsRequests(tx, subject.patientId));
}

const FIELD_LABELS: Record<PortalRectificationRequest['field'], string> = {
  familyName: 'Apellido',
  givenNames: 'Nombre',
  birthDate: 'Fecha de nacimiento',
  document: 'Documento',
};

/**
 * A request to correct an identity field. The record is unchanged: it stays open for the staff,
 * who apply it through the versioned update after checking it.
 */
export async function requestRectification(
  tx: Tx,
  subject: PortalSubject,
  input: { request: PortalRectificationRequest; actor: AuditActor },
): Promise<PortalRightsRequest> {
  const note = [
    `${FIELD_LABELS[input.request.field]}: ${input.request.correctValue}`,
    ...(input.request.note ? [input.request.note] : []),
  ].join(' | ');
  return createPortalRightsRequest(tx, {
    patientId: subject.patientId,
    kind: 'rectification',
    note,
    requestedBy: subject.identityId,
    actor: input.actor,
  });
}

/** A request for a copy of the clinical history, which the organization prepares outside the portal. */
export async function requestCopy(
  tx: Tx,
  subject: PortalSubject,
  input: { note: string | undefined; actor: AuditActor },
): Promise<PortalRightsRequest> {
  return createPortalRightsRequest(tx, {
    patientId: subject.patientId,
    kind: 'access',
    note: input.note ?? null,
    requestedBy: subject.identityId,
    actor: input.actor,
  });
}

/** Who in the organization is told that a patient made a request: the owners and the administration. */
export async function organizationRecipients(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ email: userAccount.email })
    .from(membership)
    .innerJoin(userAccount, eq(userAccount.id, membership.userId))
    .where(
      and(
        eq(membership.status, 'active'),
        sql`${membership.roles} && array['owner', 'admin']::text[]`,
      ),
    );
  return [...new Set(rows.map((row) => row.email))];
}
