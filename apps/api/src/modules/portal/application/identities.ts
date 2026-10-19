import type {
  PatientPortalResponse,
  PortalIdentityDto,
  PortalLinkDto,
  PortalRelation,
} from '@consultorio/contracts';
import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';

import { actionToken } from '../../../db/schema/action-token.js';
import {
  portalIdentity,
  portalLink,
  type PortalIdentityRow,
  type PortalLinkRow,
} from '../../../db/schema/portal.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { readPatientBasics, readPatientContacts } from '../../patients/index.js';
import { majorityReviewDate } from '../domain/majority.js';

import type { PortalSessions } from './sessions.js';

const UNIQUE_VIOLATION = '23505';

/** Who does it, when a member of the staff does: the request's audit actor and their user id. */
export type StaffAuditActor = AuditActor & { userId: string };

/** The patient's side of an activation: nobody is signed in, but the entry says who it was. */
export function patientAuditActor(actor: AuditActor): AuditActor {
  return { ...actor, userId: null, actingRole: 'patient' };
}

export interface IdentityDeps {
  tokens: ActionTokens;
  sessions: PortalSessions;
  clock: () => Date;
  /** The age of majority of the organization's country. */
  majorityAge: (country: string) => number;
}

function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string }; code?: string } | null) ?? {};
  return cause.cause?.code ?? cause.code;
}

function nameOf(contact: { givenNames: string; familyName: string }): string {
  return `${contact.givenNames} ${contact.familyName}`.trim();
}

// Reading -----------------------------------------------------------------------------------------

async function toDtos(
  tx: Tx,
  identities: readonly PortalIdentityRow[],
  options: { onlyPatientId?: string } = {},
): Promise<PortalIdentityDto[]> {
  if (identities.length === 0) return [];
  const links: PortalLinkRow[] = await tx
    .select()
    .from(portalLink)
    .where(
      and(
        inArray(
          portalLink.portalIdentityId,
          identities.map((row) => row.id),
        ),
        options.onlyPatientId === undefined
          ? undefined
          : eq(portalLink.patientId, options.onlyPatientId),
      ),
    )
    .orderBy(asc(portalLink.createdAt), asc(portalLink.id));
  const contacts = await readPatientContacts(tx, [...new Set(links.map((link) => link.patientId))]);
  const names = new Map(contacts.map((contact) => [contact.id, nameOf(contact)]));
  return identities.map((row) => ({
    id: row.id,
    email: row.email,
    status: row.status === 'active' || row.status === 'deactivated' ? row.status : 'invited',
    activatedAt: row.activatedAt?.toISOString() ?? null,
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
    links: links
      .filter((link) => link.portalIdentityId === row.id)
      .map((link): PortalLinkDto => ({
        id: link.id,
        patientId: link.patientId,
        patientName: names.get(link.patientId) ?? '',
        relationship: link.relationship === 'self' ? 'self' : 'representative',
        relation: toRelation(link.relation),
        status: link.status === 'suspended' || link.status === 'revoked' ? link.status : 'active',
        majorityReviewOn: link.majorityReviewOn,
        createdAt: link.createdAt.toISOString(),
      })),
  }));
}

function toRelation(value: string | null): PortalRelation | null {
  return value === 'mother' || value === 'father' || value === 'guardian' || value === 'other'
    ? value
    : null;
}

async function identityDto(tx: Tx, id: string): Promise<PortalIdentityDto> {
  const rows = await tx.select().from(portalIdentity).where(eq(portalIdentity.id, id));
  const [dto] = await toDtos(tx, rows);
  if (!dto) throw new AppError('not_found');
  return dto;
}

/** The portal accounts that reach one patient, and the invitations still waiting for them. */
export async function listPortalOfPatient(
  tx: Tx,
  patientId: string,
): Promise<PatientPortalResponse> {
  if (!(await readPatientBasics(tx, patientId))) throw new AppError('not_found');
  const linked = tx
    .select({ id: portalLink.portalIdentityId })
    .from(portalLink)
    .where(and(eq(portalLink.patientId, patientId), ne(portalLink.status, 'revoked')));
  const rows = await tx
    .select()
    .from(portalIdentity)
    .where(
      or(
        inArray(portalIdentity.id, linked),
        and(eq(portalIdentity.invitedPatientId, patientId), eq(portalIdentity.status, 'invited')),
      ),
    )
    .orderBy(asc(portalIdentity.createdAt), asc(portalIdentity.id));
  return { identities: await toDtos(tx, rows, { onlyPatientId: patientId }) };
}

// Inviting ----------------------------------------------------------------------------------------

export interface InvitationInput {
  actor: StaffAuditActor;
  patientId: string;
  /** Present when the invited person is the representative of the patient, not the patient. */
  representative?: { email: string; relation: PortalRelation; verificationNote: string };
}

export interface PreparedInvitation {
  identity: PortalIdentityDto;
  /** Where the activation link goes. */
  email: string;
  /** The raw token of the link. It exists only here: put it in the email and forget it. */
  token: string;
  expiresAt: Date;
}

async function liveSelfLink(tx: Tx, patientId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: portalLink.id })
    .from(portalLink)
    .where(
      and(
        eq(portalLink.patientId, patientId),
        eq(portalLink.relationship, 'self'),
        ne(portalLink.status, 'revoked'),
      ),
    );
  return row !== undefined;
}

/** True while an invitation of this identity can still be followed. */
async function hasLiveInvitation(tx: Tx, identityId: string, now: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: actionToken.id })
    .from(actionToken)
    .where(
      and(
        eq(actionToken.kind, 'portal_activation'),
        eq(actionToken.subjectId, identityId),
        isNull(actionToken.revokedAt),
        sql`${actionToken.uses} < ${actionToken.maxUses}`,
        sql`${actionToken.expiresAt} > ${now.toISOString()}::timestamptz`,
      ),
    );
  return row !== undefined;
}

/**
 * Invites a patient to the portal (tasks 5.25, patient-portal "Portal account activation and
 * identity linking"). An identity is reserved for the address with the status `invited`, and the
 * activation link is a single-use token that names the patient and the relationship. Nothing is
 * created for a patient that does not exist, has no email, or whose address belongs to another
 * account: the staff are told which of those it was (this is not a public route).
 *
 * The caller emails the link after the transaction commits; the token is returned once.
 */
export async function prepareInvitation(
  tx: Tx,
  deps: IdentityDeps,
  input: InvitationInput,
): Promise<PreparedInvitation> {
  const now = deps.clock();
  const patient = await readPatientBasics(tx, input.patientId);
  if (!patient) throw new AppError('not_found');
  if (patient.status !== 'active') throw new AppError('portal_state_conflict');

  let email: string;
  if (input.representative) {
    email = input.representative.email;
  } else {
    if (patient.email === null || patient.email.trim() === '') {
      throw new AppError('portal_patient_has_no_email');
    }
    email = patient.email.trim().toLowerCase();
    if (await liveSelfLink(tx, patient.id)) throw new AppError('portal_already_linked');
  }

  const [existing] = await tx.select().from(portalIdentity).where(eq(portalIdentity.email, email));
  let identityId: string;
  let created = false;
  if (!existing) {
    const [row] = await tx
      .insert(portalIdentity)
      .values({
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        email,
        status: 'invited',
        invitedPatientId: patient.id,
      })
      .returning({ id: portalIdentity.id });
    if (!row) throw new Error('portal identity insert returned no row');
    identityId = row.id;
    created = true;
  } else if (
    existing.status === 'invited' &&
    (existing.invitedPatientId === patient.id || !(await hasLiveInvitation(tx, existing.id, now)))
  ) {
    // The same person again, or an invitation nobody can follow any more: the address is free.
    await tx
      .update(portalIdentity)
      .set({ invitedPatientId: patient.id })
      .where(eq(portalIdentity.id, existing.id));
    identityId = existing.id;
  } else {
    throw new AppError('portal_email_in_use');
  }

  // A newer link replaces the older one.
  await deps.tokens.revokeForSubject(tx, 'portal_activation', identityId);
  const issued = await deps.tokens.issue(tx, {
    kind: 'portal_activation',
    subjectId: identityId,
    payload: {
      patientId: patient.id,
      relationship: input.representative ? 'representative' : 'self',
      invitedBy: input.actor.userId,
      ...(input.representative
        ? {
            relation: input.representative.relation,
            verificationNote: input.representative.verificationNote,
          }
        : {}),
    },
  });

  if (created) {
    await audit(tx, {
      action: 'portal.identity.created',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'portal_identity',
      resourceId: identityId,
      patientId: patient.id,
      metadata: {
        status: 'invited',
        relationship: input.representative ? 'representative' : 'self',
      },
    });
  }
  return {
    identity: await identityDto(tx, identityId),
    email,
    token: issued.token,
    expiresAt: issued.expiresAt,
  };
}

// Activating --------------------------------------------------------------------------------------

/**
 * Following the activation link: the identity becomes active and gets its first link, the patient's
 * own or the representative's. It answers `invalid` (the page of an unknown link) when the
 * identity is no longer waiting, the patient is gone or already has an account of their own.
 */
export async function activateInvitation(
  tx: Tx,
  deps: IdentityDeps,
  input: {
    actor: AuditActor;
    country: string;
    identityId: string;
    payload: Record<string, unknown>;
  },
): Promise<'activated' | 'invalid'> {
  const now = deps.clock();
  const patientId = input.payload['patientId'];
  const relationship = input.payload['relationship'];
  if (typeof patientId !== 'string') return 'invalid';

  const [identity] = await tx
    .select()
    .from(portalIdentity)
    .where(eq(portalIdentity.id, input.identityId))
    .for('update');
  if (identity?.status !== 'invited') return 'invalid';
  const patient = await readPatientBasics(tx, patientId);
  if (patient?.status !== 'active') return 'invalid';

  const relation = toRelation(
    typeof input.payload['relation'] === 'string' ? input.payload['relation'] : null,
  );
  const note =
    typeof input.payload['verificationNote'] === 'string'
      ? input.payload['verificationNote']
      : null;
  const createdBy =
    typeof input.payload['invitedBy'] === 'string' ? input.payload['invitedBy'] : null;
  const asRepresentative = relationship === 'representative';
  if (asRepresentative && (relation === null || note === null)) return 'invalid';
  if (!asRepresentative && (await liveSelfLink(tx, patientId))) return 'invalid';

  try {
    await tx.transaction(async (inner) => {
      await inner
        .update(portalIdentity)
        .set({ status: 'active', activatedAt: now })
        .where(eq(portalIdentity.id, identity.id));
      await inner.insert(portalLink).values({
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        portalIdentityId: identity.id,
        patientId,
        relationship: asRepresentative ? 'representative' : 'self',
        relation: asRepresentative ? relation : null,
        verificationNote: asRepresentative ? note : null,
        majorityReviewOn: asRepresentative
          ? majorityReviewDate({
              birthDate: patient.birthDate,
              majorityAge: deps.majorityAge(input.country),
              today: now,
            })
          : null,
        createdBy,
      });
    });
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) return 'invalid';
    throw error;
  }
  await audit(tx, {
    action: 'portal.identity.linked',
    outcome: 'allow',
    actor: patientAuditActor(input.actor),
    resourceType: 'portal_identity',
    resourceId: identity.id,
    patientId,
    metadata: { relationship: asRepresentative ? 'representative' : 'self', via: 'invitation' },
  });
  return 'activated';
}

// Linking one more dependent ----------------------------------------------------------------------

export async function linkDependent(
  tx: Tx,
  deps: IdentityDeps,
  input: {
    actor: StaffAuditActor;
    country: string;
    identityId: string;
    patientId: string;
    relation: PortalRelation;
    verificationNote: string;
  },
): Promise<PortalIdentityDto> {
  const now = deps.clock();
  const [identity] = await tx
    .select()
    .from(portalIdentity)
    .where(eq(portalIdentity.id, input.identityId))
    .for('update');
  if (!identity) throw new AppError('not_found');
  if (identity.status !== 'active') throw new AppError('portal_state_conflict');
  const patient = await readPatientBasics(tx, input.patientId);
  if (!patient) throw new AppError('not_found');
  if (patient.status !== 'active') throw new AppError('portal_state_conflict');

  try {
    await tx.transaction((inner) =>
      inner.insert(portalLink).values({
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        portalIdentityId: identity.id,
        patientId: patient.id,
        relationship: 'representative',
        relation: input.relation,
        verificationNote: input.verificationNote,
        majorityReviewOn: majorityReviewDate({
          birthDate: patient.birthDate,
          majorityAge: deps.majorityAge(input.country),
          today: now,
        }),
        createdBy: input.actor.userId,
      }),
    );
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('portal_already_linked');
    throw error;
  }
  await audit(tx, {
    action: 'portal.identity.linked',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'portal_identity',
    resourceId: identity.id,
    patientId: patient.id,
    metadata: { relationship: 'representative', relation: input.relation, via: 'staff' },
  });
  return identityDto(tx, identity.id);
}

// Ending access -----------------------------------------------------------------------------------

export async function deactivateIdentity(
  tx: Tx,
  deps: IdentityDeps,
  input: { actor: StaffAuditActor; identityId: string },
): Promise<PortalIdentityDto> {
  const now = deps.clock();
  const [identity] = await tx
    .select()
    .from(portalIdentity)
    .where(eq(portalIdentity.id, input.identityId))
    .for('update');
  if (!identity) throw new AppError('not_found');
  if (identity.status === 'deactivated') throw new AppError('portal_state_conflict');

  await tx
    .update(portalIdentity)
    .set({ status: 'deactivated', deactivatedAt: now, deactivatedBy: input.actor.userId })
    .where(eq(portalIdentity.id, identity.id));
  await deps.sessions.revokeAllForIdentity(tx, identity.id, 'deactivated', now, {
    by: input.actor.userId,
  });
  // An invitation nobody followed yet must not bring the account back.
  await deps.tokens.revokeForSubject(tx, 'portal_activation', identity.id);
  await audit(tx, {
    action: 'portal.identity.deactivated',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'portal_identity',
    resourceId: identity.id,
    metadata: { scope: 'identity' },
  });
  return identityDto(tx, identity.id);
}

/** Ends one link of an identity. The patient record, and the identity's other links, stay as they are. */
export async function revokeLink(
  tx: Tx,
  deps: IdentityDeps,
  input: { actor: StaffAuditActor; linkId: string },
): Promise<PortalIdentityDto> {
  const now = deps.clock();
  const [link] = await tx
    .select()
    .from(portalLink)
    .where(eq(portalLink.id, input.linkId))
    .for('update');
  if (!link) throw new AppError('not_found');
  if (link.status === 'revoked') throw new AppError('portal_state_conflict');

  await tx
    .update(portalLink)
    .set({ status: 'revoked', revokedAt: now, revokedBy: input.actor.userId })
    .where(eq(portalLink.id, link.id));
  // The sessions read for the subject they picked: they sign in again and lose this one.
  await deps.sessions.revokeAllForIdentity(tx, link.portalIdentityId, 'link_revoked', now, {
    by: input.actor.userId,
  });
  await audit(tx, {
    action: 'portal.identity.deactivated',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'portal_identity',
    resourceId: link.portalIdentityId,
    patientId: link.patientId,
    metadata: { scope: 'link', relationship: link.relationship },
  });
  return identityDto(tx, link.portalIdentityId);
}

/**
 * Changes the address of an identity. It is staff work after the person was verified out of band
 * (they lost the mailbox); every session of the identity ends, and the entry names the field and
 * never the address.
 */
export async function changeIdentityEmail(
  tx: Tx,
  deps: IdentityDeps,
  input: { actor: StaffAuditActor; identityId: string; email: string },
): Promise<PortalIdentityDto> {
  const now = deps.clock();
  const [identity] = await tx
    .select()
    .from(portalIdentity)
    .where(eq(portalIdentity.id, input.identityId))
    .for('update');
  if (!identity) throw new AppError('not_found');
  if (identity.status === 'deactivated') throw new AppError('portal_state_conflict');
  if (identity.email.toLowerCase() === input.email) return identityDto(tx, identity.id);

  try {
    await tx.transaction((inner) =>
      inner
        .update(portalIdentity)
        .set({ email: input.email })
        .where(eq(portalIdentity.id, identity.id)),
    );
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('portal_email_in_use');
    throw error;
  }
  await deps.sessions.revokeAllForIdentity(tx, identity.id, 'email_changed', now, {
    by: input.actor.userId,
  });
  await audit(tx, {
    action: 'portal.profile.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'portal_identity',
    resourceId: identity.id,
    metadata: { field: 'email', by: 'staff' },
  });
  return identityDto(tx, identity.id);
}

/** For the callers that need the same filter as the reads above, without exposing the table. */
export type IdentityFilter = SQL;
