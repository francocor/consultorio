import type { DocumentPortalShareResponse, PortalDocumentDto } from '@consultorio/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { documentShare, portalIdentity, portalLink } from '../../../db/schema/portal.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { DocumentForSharing } from '../../documents/index.js';

import type { StaffAuditActor } from './identities.js';

export interface ShareOutcome {
  status: DocumentPortalShareResponse;
  /** True when this call is what shared it (an earlier share answers the same without a notice). */
  changed: boolean;
}

function toStatus(row: { createdAt: Date } | undefined): DocumentPortalShareResponse {
  return row
    ? { shared: true, sharedAt: row.createdAt.toISOString() }
    : { shared: false, sharedAt: null };
}

async function liveShare(tx: Tx, documentId: string) {
  const [row] = await tx
    .select()
    .from(documentShare)
    .where(and(eq(documentShare.documentId, documentId), isNull(documentShare.unsharedAt)));
  return row;
}

export async function shareStatus(
  tx: Tx,
  document: DocumentForSharing,
): Promise<DocumentPortalShareResponse> {
  return toStatus(await liveShare(tx, document.id));
}

/**
 * Shares a document with its patient. Sharing twice is the same share: nothing changes and nobody is
 * told again. Every change is in the trail with the document and the patient, never its name.
 */
export async function shareDocument(
  tx: Tx,
  input: { actor: StaffAuditActor; document: DocumentForSharing },
): Promise<ShareOutcome> {
  const existing = await liveShare(tx, input.document.id);
  if (existing) return { status: toStatus(existing), changed: false };
  const [row] = await tx
    .insert(documentShare)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      documentId: input.document.id,
      patientId: input.document.patientId,
      sharedBy: input.actor.userId,
    })
    .returning();
  if (!row) throw new Error('document share insert returned no row');
  await audit(tx, {
    action: 'sharing.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'document',
    resourceId: input.document.id,
    patientId: input.document.patientId,
    metadata: { target: 'portal', shared: true, classification: input.document.classification },
  });
  return { status: toStatus(row), changed: true };
}

/** Stops sharing a document. The patient no longer sees it, and a link they already had stops working. */
export async function unshareDocument(
  tx: Tx,
  input: { actor: StaffAuditActor; document: DocumentForSharing; now: Date },
): Promise<ShareOutcome> {
  const existing = await liveShare(tx, input.document.id);
  if (!existing) return { status: toStatus(undefined), changed: false };
  await tx
    .update(documentShare)
    .set({ unsharedAt: input.now, unsharedBy: input.actor.userId })
    .where(eq(documentShare.id, existing.id));
  await audit(tx, {
    action: 'sharing.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'document',
    resourceId: input.document.id,
    patientId: input.document.patientId,
    metadata: { target: 'portal', shared: false, classification: input.document.classification },
  });
  return { status: toStatus(undefined), changed: true };
}

/**
 * The addresses of the active portal accounts that reach the patient: where the "you have a
 * document" notice goes. It is the address of the ACCOUNT, which the person verified, and not the
 * one on the patient record.
 */
export async function noticeRecipients(tx: Tx, patientId: string): Promise<string[]> {
  const rows = await tx
    .select({ email: portalIdentity.email })
    .from(portalLink)
    .innerJoin(
      portalIdentity,
      and(
        eq(portalIdentity.tenantId, portalLink.tenantId),
        eq(portalIdentity.id, portalLink.portalIdentityId),
      ),
    )
    .where(
      and(
        eq(portalLink.patientId, patientId),
        eq(portalLink.status, 'active'),
        eq(portalIdentity.status, 'active'),
      ),
    );
  return [...new Set(rows.map((row) => row.email))];
}

// What the patient sees -------------------------------------------------------------------------

interface SharedRow {
  id: string;
  category: string;
  original_name: string;
  content_type: string | null;
  size_bytes: number;
  shared_at: string | Date;
  [key: string]: unknown;
}

/**
 * The documents shared with the subject of this request. They come from a function of the database
 * that answers only for the link and the identity that `withPortalSubject` validated: the portal
 * never reads `document`.
 */
export async function listSharedDocuments(tx: Tx): Promise<PortalDocumentDto[]> {
  const result = await tx.execute<SharedRow>(
    sql`select id, category, original_name, content_type, size_bytes, shared_at
          from app.portal_shared_documents()`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.original_name,
    category: row.category,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sharedAt: new Date(row.shared_at).toISOString(),
  }));
}

export interface SharedDocumentFile {
  id: string;
  patientId: string;
  name: string;
  category: string;
  contentType: string | null;
  sizeBytes: number;
  objectKey: string;
}

/** One shared document with what streaming it needs, or null when it is not shared with this subject. */
export async function readSharedDocument(
  tx: Tx,
  documentId: string,
): Promise<SharedDocumentFile | null> {
  const result = await tx.execute<{
    id: string;
    patient_id: string;
    category: string;
    original_name: string;
    content_type: string | null;
    size_bytes: number;
    object_key: string;
    [key: string]: unknown;
  }>(
    sql`select id, patient_id, category, original_name, content_type, size_bytes, object_key
          from app.portal_shared_document(${documentId}::uuid)`,
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        patientId: row.patient_id,
        name: row.original_name,
        category: row.category,
        contentType: row.content_type,
        sizeBytes: row.size_bytes,
        objectKey: row.object_key,
      }
    : null;
}
