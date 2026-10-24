import { asc } from 'drizzle-orm';

import {
  documentShare,
  portalIdentity,
  portalLink,
  portalSession,
} from '../../../db/schema/portal.js';
import type { ExportContributor } from '../../tenancy/index.js';

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * The portal part of the cancellation export (tenancy, "Tenant cancellation export"; JD-S5 R1-B-W8).
 * It is administrative and goes to the owner: who has a portal account (the email as the
 * organization holds it: the export is the organization's own data, like its staff and patients),
 * what each account may read (the links, with the relation and when the representation ends), the
 * documents shared with patients, and the dates of the sessions. The portal owns no clinical table,
 * so it has no clinical part: consents, prescriptions and documents travel with the module that
 * owns them.
 *
 * What it never carries: the token of a session (only its hash is stored, and the hash is not
 * exported either), the address or the browser of a session, the sign-in codes, the activation
 * links, and the text of the verification note a member of the staff wrote about a representative.
 */
export const exportPortal: ExportContributor = async ({ tx }) => {
  const identities = await tx
    .select({
      id: portalIdentity.id,
      email: portalIdentity.email,
      status: portalIdentity.status,
      invitedPatientId: portalIdentity.invitedPatientId,
      createdAt: portalIdentity.createdAt,
      activatedAt: portalIdentity.activatedAt,
      deactivatedAt: portalIdentity.deactivatedAt,
    })
    .from(portalIdentity)
    .orderBy(asc(portalIdentity.createdAt), asc(portalIdentity.id));
  const links = await tx
    .select({
      id: portalLink.id,
      identityId: portalLink.portalIdentityId,
      patientId: portalLink.patientId,
      relationship: portalLink.relationship,
      relation: portalLink.relation,
      status: portalLink.status,
      majorityReviewOn: portalLink.majorityReviewOn,
      createdAt: portalLink.createdAt,
      suspendedAt: portalLink.suspendedAt,
      revokedAt: portalLink.revokedAt,
    })
    .from(portalLink)
    .orderBy(asc(portalLink.createdAt), asc(portalLink.id));
  const sessions = await tx
    .select({
      id: portalSession.id,
      identityId: portalSession.portalIdentityId,
      createdAt: portalSession.createdAt,
      lastSeenAt: portalSession.lastSeenAt,
      expiresAt: portalSession.expiresAt,
      revokedAt: portalSession.revokedAt,
      revokedReason: portalSession.revokedReason,
    })
    .from(portalSession)
    .orderBy(asc(portalSession.createdAt), asc(portalSession.id));
  const shares = await tx
    .select({
      id: documentShare.id,
      documentId: documentShare.documentId,
      patientId: documentShare.patientId,
      createdAt: documentShare.createdAt,
      unsharedAt: documentShare.unsharedAt,
    })
    .from(documentShare)
    .orderBy(asc(documentShare.createdAt), asc(documentShare.id));

  return {
    identities: identities.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      activatedAt: iso(row.activatedAt),
      deactivatedAt: iso(row.deactivatedAt),
    })),
    links: links.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      suspendedAt: iso(row.suspendedAt),
      revokedAt: iso(row.revokedAt),
    })),
    sessions: sessions.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: iso(row.revokedAt),
    })),
    documentShares: shares.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      unsharedAt: iso(row.unsharedAt),
    })),
  };
};
