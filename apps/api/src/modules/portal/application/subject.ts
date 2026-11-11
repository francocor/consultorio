import type { PortalMeResponse, PortalRelation } from '@consultorio/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { portalIdentity, portalLink } from '../../../db/schema/portal.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { readPatientContacts } from '../../patients/index.js';
import { readOrganizationName } from '../../tenancy/index.js';

import { linkInForce, organizationToday } from './link-access.js';
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
  /** The day it is in the organization when the subject was resolved (`YYYY-MM-DD`). */
  today: string;
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
export async function resolveSubject(
  tx: Tx,
  actor: PortalActor,
  now: Date,
): Promise<PortalSubject> {
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
  // A dependent who reached the age of majority is no subject from that day, whether or not the
  // daily review has suspended the link yet (JD-S5 R1-S5-7).
  const today = await organizationToday(tx, now);
  if (!linkInForce(link, today)) throw new AppError('portal_subject_required');
  return {
    tenantId: actor.tenantId,
    identityId: actor.identityId,
    linkId: link.id,
    patientId: link.patientId,
    relationship: link.relationship === 'self' ? 'self' : 'representative',
    relation: toRelation(link.relation),
    today,
  };
}

/**
 * Tells the database whose request this is.
 *
 * - `app.actor_kind = 'portal'` makes the transaction NOT the system for the clinical policies: the
 *   portal acts as the nil user (the patient has no user), which those policies let through, so
 *   without the marker it would read every prescription of the organization (JD-S5 R1-S5-2). Every
 *   transaction of a portal request that reads for a patient must carry it; this is the one place
 *   that sets it.
 * - The link, the identity and the day are for the functions that read what a policy hides from a
 *   patient's session (the documents shared with them, their prescriptions). They answer only for
 *   this link and this identity, which they check again against the tables; with nothing bound they
 *   answer nothing.
 */
export async function bindSubject(tx: Tx, subject: PortalSubject): Promise<void> {
  await tx.execute(
    sql`select set_config('app.actor_kind', 'portal', true),
               set_config('app.portal_link_id', ${subject.linkId}, true),
               set_config('app.portal_identity_id', ${subject.identityId}, true),
               set_config('app.portal_today', ${subject.today}, true)`,
  );
}

export type WithPortalSubject = <T>(
  actor: PortalActor,
  work: (tx: Tx, subject: PortalSubject) => Promise<T>,
) => Promise<T>;

/**
 * Runs `work` in the transaction of the organization of the session, for the subject of the
 * session. The portal acts as the nil user inside the database (the patient has no user) and marks
 * the transaction as the portal's, so the isolation between patients is this function plus the
 * functions bound to the link: the work receives the patient to filter by, and the modules it calls
 * take that patient as an argument and never a request parameter.
 */
export function createWithPortalSubject(
  withTenant: WithTenant,
  clock: () => Date = () => new Date(),
): WithPortalSubject {
  return (actor, work) =>
    withTenant({ tenantId: actor.tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
      // The marker first: nothing this transaction reads is read as the system.
      await tx.execute(sql`select set_config('app.actor_kind', 'portal', true)`);
      const subject = await resolveSubject(tx, actor, clock());
      await bindSubject(tx, subject);
      return work(tx, subject);
    });
}

/** The links that matter to the person: those that give access, and those that were suspended. */
export async function readMe(
  tx: Tx,
  input: { actor: PortalActor; capabilities: PortalMeResponse['capabilities']; now: Date },
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
  const today = await organizationToday(tx, input.now);
  // A link whose day of majority has come is suspended already, whether or not the daily review has
  // recorded it.
  const inForce = (link: (typeof links)[number]) =>
    link.status === 'active' && linkInForce(link, today);
  // A link that gives access to nothing does not tell who the person is either: the name of a
  // dependent who became an adult is theirs to share, not the former representative's to read.
  const contacts = await readPatientContacts(tx, [
    ...new Set(links.filter(inForce).map((link) => link.patientId)),
  ]);
  const names = new Map(
    contacts.map((contact) => [contact.id, `${contact.givenNames} ${contact.familyName}`.trim()]),
  );
  const selected = links.find((link) => link.id === input.actor.linkId && inForce(link));
  return {
    email: identity.email,
    organizationName: await readOrganizationName(tx),
    links: links.map((link) => ({
      id: link.id,
      patientId: link.patientId,
      patientName: inForce(link) ? (names.get(link.patientId) ?? '') : '',
      relationship: link.relationship === 'self' ? 'self' : 'representative',
      relation: toRelation(link.relation),
      status: inForce(link) ? 'active' : 'suspended',
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
  input: { actor: PortalActor; sessionId: string; linkId: string; now: Date },
): Promise<'selected' | 'unknown'> {
  const [link] = await tx
    .select({ id: portalLink.id, majorityReviewOn: portalLink.majorityReviewOn })
    .from(portalLink)
    .where(
      and(
        eq(portalLink.id, input.linkId),
        eq(portalLink.portalIdentityId, input.actor.identityId),
        eq(portalLink.status, 'active'),
      ),
    );
  if (!link) return 'unknown';
  if (!linkInForce(link, await organizationToday(tx, input.now))) return 'unknown';
  await deps.sessions.selectLink(tx, input.sessionId, link.id);
  return 'selected';
}
