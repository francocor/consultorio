import type { PortalRelation, PortalRepresentativeDto } from '@consultorio/contracts';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';

import { portalIdentity, portalLink } from '../../../db/schema/portal.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { readPatientBasics } from '../../patients/index.js';
import { maskEmail } from '../domain/mask.js';

import {
  majorityStanding,
  patientAuditActor,
  type IdentityDeps,
  type StaffAuditActor,
} from './identities.js';
import { organizationToday } from './link-access.js';
import { assertMayGiveAccess } from './staff-gate.js';
import type { PortalSubject } from './subject.js';

/** The system as the author of what the daily review does: no user, no role, no address. */
const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

function toRelation(value: string | null): PortalRelation | null {
  return value === 'mother' || value === 'father' || value === 'guardian' || value === 'other'
    ? value
    : null;
}

/**
 * The daily review of the representative links (patient-portal "Legal representatives and
 * dependents", task 5.36): a dependent who reached the age of majority is no longer represented.
 * The link is SUSPENDED, not ended, until the adult authorizes it from their own account. It is a
 * protection of the patient and runs whatever the state of the subscription. A suspended link is no
 * subject: the representative sees nothing of that person at their next request.
 *
 * This job only records it: the access itself is refused from the day on by every read of the portal
 * (`linkInForce`, and the definer functions of the database), so a job that did not run, or ran late,
 * leaves nothing open. The day is the one of the organization, not the UTC one.
 */
export async function suspendMajorityLinks(tx: Tx, input: { now: Date }): Promise<number> {
  const today = await organizationToday(tx, input.now);
  const rows = await tx
    .update(portalLink)
    .set({ status: 'suspended', suspendedAt: input.now })
    .where(
      and(
        eq(portalLink.status, 'active'),
        eq(portalLink.relationship, 'representative'),
        lte(portalLink.majorityReviewOn, today),
      ),
    )
    .returning({
      id: portalLink.id,
      identityId: portalLink.portalIdentityId,
      patientId: portalLink.patientId,
    });
  for (const row of rows) {
    await audit(tx, {
      action: 'portal.identity.deactivated',
      outcome: 'allow',
      actor: SYSTEM_ACTOR,
      resourceType: 'portal_identity',
      resourceId: row.identityId,
      patientId: row.patientId,
      metadata: { scope: 'link', reason: 'majority' },
    });
  }
  return rows.length;
}

/** The people who represent the subject, for the subject to see when they are an adult in their own right. */
export async function listRepresentatives(
  tx: Tx,
  subject: PortalSubject,
): Promise<PortalRepresentativeDto[]> {
  // Only the person themselves sees who represents them; a representative does not list the others.
  if (subject.relationship !== 'self') return [];
  const links = await tx
    .select({
      id: portalLink.id,
      identityId: portalLink.portalIdentityId,
      relation: portalLink.relation,
      status: portalLink.status,
      majorityReviewOn: portalLink.majorityReviewOn,
    })
    .from(portalLink)
    .where(
      and(
        eq(portalLink.patientId, subject.patientId),
        eq(portalLink.relationship, 'representative'),
        inArray(portalLink.status, ['active', 'suspended']),
      ),
    )
    .orderBy(asc(portalLink.createdAt), asc(portalLink.id));
  if (links.length === 0) return [];
  const identities = await tx
    .select({ id: portalIdentity.id, email: portalIdentity.email })
    .from(portalIdentity)
    .where(
      inArray(
        portalIdentity.id,
        links.map((link) => link.identityId),
      ),
    );
  const emails = new Map(identities.map((identity) => [identity.id, identity.email]));
  return links.map((link) => ({
    id: link.id,
    relation: toRelation(link.relation) ?? 'other',
    status: link.status === 'suspended' ? 'suspended' : 'active',
    maskedEmail: maskEmail(emails.get(link.identityId) ?? ''),
    majorityReviewOn: link.majorityReviewOn,
  }));
}

async function representativeLinkOf(tx: Tx, subject: PortalSubject, linkId: string) {
  if (subject.relationship !== 'self') return undefined;
  const [link] = await tx
    .select()
    .from(portalLink)
    .where(
      and(
        eq(portalLink.id, linkId),
        eq(portalLink.patientId, subject.patientId),
        eq(portalLink.relationship, 'representative'),
        inArray(portalLink.status, ['active', 'suspended']),
      ),
    )
    .for('update');
  return link;
}

/**
 * The adult authorizes a representative whose link was suspended when they turned 18, from their
 * own account. The link is active again and has no date of majority any more.
 */
export async function authorizeByAdult(
  tx: Tx,
  input: { subject: PortalSubject; linkId: string; actor: AuditActor },
): Promise<'authorized' | 'unknown'> {
  const link = await representativeLinkOf(tx, input.subject, input.linkId);
  if (!link) return 'unknown';
  if (link.status !== 'suspended') throw new AppError('portal_state_conflict');
  await tx
    .update(portalLink)
    .set({ status: 'active', suspendedAt: null, majorityReviewOn: null })
    .where(eq(portalLink.id, link.id));
  await audit(tx, {
    action: 'portal.identity.linked',
    outcome: 'allow',
    actor: patientAuditActor(input.actor),
    resourceType: 'portal_identity',
    resourceId: link.portalIdentityId,
    patientId: link.patientId,
    metadata: { relationship: 'representative', via: 'adult_authorization' },
  });
  return 'authorized';
}

/** The adult ends the access of a representative. Their sessions end with it. */
export async function revokeByAdult(
  tx: Tx,
  deps: IdentityDeps,
  input: { subject: PortalSubject; linkId: string; actor: AuditActor },
): Promise<'revoked' | 'unknown'> {
  const link = await representativeLinkOf(tx, input.subject, input.linkId);
  if (!link) return 'unknown';
  const now = deps.clock();
  await tx
    .update(portalLink)
    .set({ status: 'revoked', revokedAt: now, revokedBy: null })
    .where(eq(portalLink.id, link.id));
  await deps.sessions.revokeAllForIdentity(tx, link.portalIdentityId, 'link_revoked', now);
  await audit(tx, {
    action: 'portal.identity.deactivated',
    outcome: 'allow',
    actor: patientAuditActor(input.actor),
    resourceType: 'portal_identity',
    resourceId: link.portalIdentityId,
    patientId: link.patientId,
    metadata: { scope: 'link', relationship: 'representative', by: 'patient' },
  });
  return 'revoked';
}

/**
 * The organization verifies a suspended link again: the new note replaces the old one. It is for a
 * person who is still a minor (a link suspended by mistake, a birth date corrected); the date of
 * majority is set again. Once the person is an adult the organization can NOT restore the link:
 * only the adult does, from their own account (`authorizeByAdult`) — a member of the staff must
 * not be able to give themselves, or anybody, the record of an adult (JD-S5 R1-A-C1).
 */
export async function reverifyLink(
  tx: Tx,
  deps: Pick<IdentityDeps, 'clock' | 'majorityAge'>,
  input: {
    actor: StaffAuditActor;
    ownerOrAdmin: boolean;
    linkId: string;
    verificationNote: string;
  },
): Promise<{ identityId: string; recordEmail: string | null }> {
  const [link] = await tx
    .select()
    .from(portalLink)
    .where(eq(portalLink.id, input.linkId))
    .for('update');
  if (!link) throw new AppError('not_found');
  if (link.relationship !== 'representative' || link.status !== 'suspended') {
    throw new AppError('portal_state_conflict');
  }
  const patient = await readPatientBasics(tx, link.patientId);
  if (!patient) throw new AppError('not_found');
  const standing = await majorityStanding(tx, deps, patient.birthDate);
  if (!standing.minor) throw new AppError('portal_representation_requires_minor');
  // Restoring a representative is giving access again: the same gate as the first time (JD-S5 R2-2).
  const gate = await assertMayGiveAccess(tx, {
    patientId: patient.id,
    ownerOrAdmin: input.ownerOrAdmin,
    representative: true,
    recordEmail: patient.email,
  });
  await tx
    .update(portalLink)
    .set({
      status: 'active',
      suspendedAt: null,
      majorityReviewOn: standing.reviewOn,
      verificationNote: input.verificationNote,
    })
    .where(eq(portalLink.id, link.id));
  await audit(tx, {
    action: 'portal.identity.linked',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'portal_identity',
    resourceId: link.portalIdentityId,
    patientId: link.patientId,
    metadata: {
      relationship: 'representative',
      via: 'staff_reverification',
      ...(gate.afterRecordChange ? { afterRecordChange: true } : {}),
    },
  });
  // The address on the record is told that a representative has access again, like the first time
  // (JD-S5 R3): the caller queues the notice in this transaction.
  const recordEmail = patient.email?.trim().toLowerCase() ?? '';
  return {
    identityId: link.portalIdentityId,
    recordEmail: recordEmail === '' ? null : recordEmail,
  };
}
