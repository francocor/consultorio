import type { DocumentDto, DocumentRejectionReason } from '@consultorio/contracts';
import { asc, eq, inArray } from 'drizzle-orm';

import { document, type DocumentRow } from '../../../db/schema/documents.js';
import { membership } from '../../../db/schema/identity.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * Everything the transaction can see about the documents of one patient, plus the names of the
 * people who uploaded them. Row level security has already removed what the viewer may not read,
 * so a document missing from `rows` is simply not theirs to know about.
 */
export interface PatientDocuments {
  rows: DocumentRow[];
  byId: Map<string, DocumentRow>;
  uploaderNames: Map<string, string>;
}

/** Documents whose upload was confirmed and that nobody abandoned, oldest first. */
export async function loadPatientDocuments(tx: Tx, patientId: string): Promise<PatientDocuments> {
  const rows = await tx
    .select()
    .from(document)
    .where(eq(document.patientId, patientId))
    .orderBy(asc(document.createdAt), asc(document.id));
  const visible = rows.filter((row) => row.uploadCompletedAt !== null && row.abandonedAt === null);

  const uploaders = [...new Set(visible.map((row) => row.uploadedBy))];
  const names =
    uploaders.length === 0
      ? []
      : await tx
          .select({ userId: membership.userId, name: membership.displayName })
          .from(membership)
          .where(inArray(membership.userId, uploaders));
  return {
    rows: visible,
    byId: new Map(visible.map((row) => [row.id, row])),
    uploaderNames: new Map(
      names.flatMap((entry) => (entry.name === null ? [] : [[entry.userId, entry.name] as const])),
    ),
  };
}

/** How many versions the chain ending at this document has (itself and everything it replaced). */
export function versionCountOf(view: PatientDocuments, row: DocumentRow): number {
  let count = 1;
  const seen = new Set<string>([row.id]);
  let cursor = row.replacesDocumentId === null ? undefined : view.byId.get(row.replacesDocumentId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    count += 1;
    cursor =
      cursor.replacesDocumentId === null ? undefined : view.byId.get(cursor.replacesDocumentId);
  }
  return count;
}

/** The one-row query used when a document is read on its own. */
export async function findDocument(tx: Tx, id: string): Promise<DocumentRow | undefined> {
  const [row] = await tx.select().from(document).where(eq(document.id, id));
  return row;
}

/** Rows whose upload was never confirmed: invisible to everyone but the cleanup job. */
export function isUnfinished(row: DocumentRow): boolean {
  return row.uploadCompletedAt === null;
}

export function toDocumentDto(
  view: PatientDocuments,
  row: DocumentRow,
  options: { metadataOnly?: boolean } = {},
): DocumentDto {
  const duplicate = row.duplicateOfId === null ? undefined : view.byId.get(row.duplicateOfId);
  return {
    id: row.id,
    patientId: row.patientId,
    name: row.originalName,
    category: row.category as DocumentDto['category'],
    classification: row.classification as DocumentDto['classification'],
    status: row.status as DocumentDto['status'],
    contentType: row.contentType as DocumentDto['contentType'],
    size: row.sizeBytes,
    uploadedAt: row.createdAt.toISOString(),
    uploadedByName: view.uploaderNames.get(row.uploadedBy) ?? null,
    rejectionReason: row.rejectionReason as DocumentRejectionReason | null,
    encounterId: row.encounterId,
    appointmentId: row.appointmentId,
    replacesDocumentId: row.replacesDocumentId,
    versionCount: versionCountOf(view, row),
    duplicateOf: duplicate
      ? {
          id: duplicate.id,
          name: duplicate.originalName,
          uploadedAt: duplicate.createdAt.toISOString(),
        }
      : null,
    hidden:
      row.hiddenAt !== null && row.hiddenReason !== null
        ? { at: row.hiddenAt.toISOString(), reason: row.hiddenReason }
        : null,
    metadataOnly: options.metadataOnly ?? false,
  };
}
