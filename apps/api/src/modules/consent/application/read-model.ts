import type { ConsentListItemDto, ConsentRequestStatus } from '@consultorio/contracts';
import { desc, eq, sql } from 'drizzle-orm';

import {
  consentRequest,
  consentTemplateVersion,
  type ConsentRequestRow,
  type ConsentTemplateVersionRow,
} from '../../../db/schema/consent.js';
import { tenant } from '../../../db/schema/tenant.js';
import type { Actor, PortalActor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { effectiveStatus, viewOfConsent, type Viewer } from '../domain/visibility.js';

/** Who reads: a member of the staff, or a person signed in to the portal (for their own subject). */
export type ConsentReader = Actor | PortalActor;

function isPortal(reader: ConsentReader): reader is PortalActor {
  return reader.kind === 'portal';
}

/** The organization setting "reception sees clinical metadata" (authorization). Off when unset. */
async function receptionSeesClinicalMetadata(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, sql`current_setting('app.tenant_id')::uuid`));
  return row?.settings['reception_sees_clinical_metadata'] === true;
}

/**
 * May this transaction read the clinical content of the patient? The same predicate as the clinical
 * policies of the database (care relationship, or the sharing scope), asked of the database itself
 * so the two never disagree. False in a transaction that is not a professional's.
 */
async function canReadClinically(tx: Tx, patientId: string): Promise<boolean> {
  const result = await tx.execute<{ ok: boolean }>(
    sql`SELECT app.clinical_readable(${patientId}::uuid, NULL::uuid, 'default', NULL::text) AS ok`,
  );
  return result.rows[0]?.ok === true;
}

/** The facts `viewOfConsent` needs about the reader, gathered once per list. */
export async function viewerOf(tx: Tx, reader: ConsentReader, patientId: string): Promise<Viewer> {
  if (isPortal(reader)) return { kind: 'portal' };
  const professional = reader.professionalId !== null;
  return {
    kind: 'staff',
    roles: reader.roles,
    clinicalRead: professional && (await canReadClinically(tx, patientId)),
    receptionSeesClinicalMetadata: await receptionSeesClinicalMetadata(tx),
  };
}

export function toListItem(
  row: ConsentRequestRow,
  version: Pick<ConsentTemplateVersionRow, 'title' | 'versionNumber'>,
  viewer: Viewer,
  now: Date,
): ConsentListItemDto {
  const status = effectiveStatus(row.status as ConsentRequestStatus, row.expiresAt, now);
  const view = viewOfConsent(viewer, status);
  return {
    id: row.id,
    status,
    method: row.method as ConsentListItemDto['method'],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    signedAt: row.signedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    title: view.titleVisible ? version.title : null,
    versionNumber: view.titleVisible ? version.versionNumber : null,
    canOpen: view.canOpen,
  };
}

/**
 * The consents of one patient, newest first (task 5.10; documented in `docs/stage5-tracks.md`).
 * The only way another module reads a consent: the patient record uses it for staff and the portal
 * for the person signed in, each with the label rules above. It returns status and dates; never the
 * text of a template, never the signature or its evidence.
 *
 * For a portal reader the patient must be the subject the portal resolved from the session (its
 * `withPortalSubject`): the portal never passes an id from a parameter. Another patient's rows are
 * never part of the answer, whoever asks.
 */
export async function listConsentsForPatient(
  tx: Tx,
  input: { actor: ConsentReader; patientId: string; now?: Date },
): Promise<ConsentListItemDto[]> {
  const now = input.now ?? new Date();
  const viewer = await viewerOf(tx, input.actor, input.patientId);
  const rows = await tx
    .select({ request: consentRequest, version: consentTemplateVersion })
    .from(consentRequest)
    .innerJoin(
      consentTemplateVersion,
      sql`${consentTemplateVersion.tenantId} = ${consentRequest.tenantId}
          and ${consentTemplateVersion.id} = ${consentRequest.templateVersionId}`,
    )
    .where(eq(consentRequest.patientId, input.patientId))
    .orderBy(desc(consentRequest.createdAt), desc(consentRequest.id));
  return rows.map((row) => toListItem(row.request, row.version, viewer, now));
}

export type ConsentTemplateState = 'valid' | 'revoked' | 'none';

/**
 * Where a patient stands with a template: `valid` when their latest signed-or-revoked consent of any
 * version of it is signed, `revoked` when that one was revoked, `none` when they never signed
 * (a pending, declined or expired request counts for nothing). A revoked consent is never valid for
 * a later procedure (informed-consent, "Revocation").
 */
export async function consentStateFor(
  tx: Tx,
  patientId: string,
  templateId: string,
): Promise<ConsentTemplateState> {
  const [latest] = await tx
    .select({ status: consentRequest.status })
    .from(consentRequest)
    .innerJoin(
      consentTemplateVersion,
      sql`${consentTemplateVersion.tenantId} = ${consentRequest.tenantId}
          and ${consentTemplateVersion.id} = ${consentRequest.templateVersionId}`,
    )
    .where(
      sql`${consentRequest.patientId} = ${patientId}
          and ${consentTemplateVersion.templateId} = ${templateId}
          and ${consentRequest.status} in ('signed', 'revoked')`,
    )
    .orderBy(desc(consentRequest.signedAt), desc(consentRequest.id))
    .limit(1);
  if (!latest) return 'none';
  return latest.status === 'signed' ? 'valid' : 'revoked';
}

/** True when the patient holds a valid, not revoked consent of the template (task 5.14). */
export async function hasValidConsent(
  tx: Tx,
  patientId: string,
  templateId: string,
): Promise<boolean> {
  return (await consentStateFor(tx, patientId, templateId)) === 'valid';
}
