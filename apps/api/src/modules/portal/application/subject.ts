import type { PortalMeResponse, PortalRelation } from '@consultorio/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { portalIdentity, portalLink } from '../../../db/schema/portal.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { readPatientContacts } from '../../patients/index.js';
import { readOrganizationName } from '../../tenancy/index.js';

import type { PortalSessions } from './sessions.js';

/**
 * Whose data a portal request is about, decided on the server from the session and the database
 * and never from anything the request said (patient-portal "Own-data-only access"). Every portal
 * query runs through `withPortalSubject`, which hands the work this subject and nothing else to
 * filter by.
 */
export interface PortalSubject {
  tenantId: string;
  identityId: string;
  linkId: string;
  patientId: string;
  relationship: 'self' | 'representative';
  relation: PortalRelation | null;
}

function toRelation(value: string | null): PortalRelation | null {
  return value === 'mother' || value === 'father' || value === 'guardian' || value === 'other'
    ? value
    : null;
}

/**
 * The subject of a request: the link the session picked, which must still belong to the identity
 * and be active. No link picked (or one that ended) is `portal_subject_required`: the person picks.
 */
export async function resolveSubject(tx: Tx, actor: PortalActor): Promise<PortalSubject> {
  if (actor.linkId === null) throw new AppError('portal_subject_required');
  const [link] = await tx
    .select()
    .from(portalLink)
    .where(
      and(
        eq(portalLink.id, actor.linkId),
        eq(portalLink.portalIdentityId, actor.identityId),
        eq(portalLink.status, 'active'),
      ),
    );
  if (!link) throw new AppError('portal_subject_required');
  return {
    tenantId: actor.tenantId,
    identityId: actor.identityId,
    linkId: link.id,
    patientId: link.patientId,
    relationship: link.relationship === 'self' ? 'self' : 'representative',
    relation: toRelation(link.relation),
  };
}

export type WithPortalSubject = <T>(
  actor: PortalActor,
  work: (tx: Tx, subject: PortalSubject) => Promise<T>,
) => Promise<T>;

/**
 * Runs `work` in the transaction of the organization of the session, for the subject of the
 * session. The portal acts as the system user inside the database (the patient has no user), so
 * the isolation between patients is this function: the work receives the patient to filter by, and
 * the modules it calls take that patient as an argument and never a request parameter.
 */
export function createWithPortalSubject(withTenant: WithTenant): WithPortalSubject {
  return (actor, work) =>
    withTenant({ tenantId: actor.tenantId, userId: SYSTEM_USER_ID }, async (tx) =>
      work(tx, await resolveSubject(tx, actor)),
    );
}

/** The links that matter to the person: those that give access, and those that were suspended. */
export async function readMe(
  tx: Tx,
  input: { actor: PortalActor; capabilities: PortalMeResponse['capabilities'] },
): Promise<PortalMeResponse> {
  const [identity] = await tx
    .select({ email: portalIdentity.email })
    .from(portalIdentity)
    .where(eq(portalIdentity.id, input.actor.identityId));
  if (!identity) throw new AppError('unauthenticated');
  const links = await tx
    .select()
    .from(portalLink)
    .where(
      and(
        eq(portalLink.portalIdentityId, input.actor.identityId),
        inArray(portalLink.status, ['active', 'suspended']),
      ),
    )
    .orderBy(asc(portalLink.createdAt), asc(portalLink.id));
  const contacts = await readPatientContacts(tx, [...new Set(links.map((link) => link.patientId))]);
  const names = new Map(
    contacts.map((contact) => [contact.id, `${contact.givenNames} ${contact.familyName}`.trim()]),
  );
  const selected = links.find((link) => link.id === input.actor.linkId && link.status === 'active');
  return {
    email: identity.email,
    organizationName: await readOrganizationName(tx),
    links: links.map((link) => ({
      id: link.id,
      patientId: link.patientId,
      patientName: names.get(link.patientId) ?? '',
      relationship: link.relationship === 'self' ? 'self' : 'representative',
      relation: toRelation(link.relation),
      status: link.status === 'suspended' ? 'suspended' : 'active',
      majorityReviewOn: link.majorityReviewOn,
      createdAt: link.createdAt.toISOString(),
    })),
    selectedLinkId: selected?.id ?? null,
    capabilities: input.capabilities,
  };
}

/**
 * Picks the record that is shown. Only an active link of the identity of the session can be
 * picked; any other id answers as if it did not exist, and the caller records the attempt.
 */
export async function selectSubject(
  tx: Tx,
  deps: { sessions: PortalSessions },
  input: { actor: PortalActor; sessionId: string; linkId: string },
): Promise<'selected' | 'unknown'> {
  const [link] = await tx
    .select({ id: portalLink.id })
    .from(portalLink)
    .where(
      and(
        eq(portalLink.id, input.linkId),
        eq(portalLink.portalIdentityId, input.actor.identityId),
        eq(portalLink.status, 'active'),
      ),
    );
  if (!link) return 'unknown';
  await deps.sessions.selectLink(tx, input.sessionId, link.id);
  return 'selected';
}
