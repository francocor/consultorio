import { and, asc, eq, sql } from 'drizzle-orm';

import { careRelationship } from '../../../db/schema/care.js';
import { document, type DocumentRow } from '../../../db/schema/documents.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * What the cancellation export needs to rebuild a document: its metadata, and the storage key and
 * hash so the exporter can fetch the file and check it. Hidden documents, rejected ones and
 * previous versions are all included (documents, "Retention, export and tenant lifecycle").
 */
function exported(row: DocumentRow) {
  return {
    id: row.id,
    patientId: row.patientId,
    name: row.originalName,
    category: row.category,
    classification: row.classification,
    status: row.status,
    contentType: row.contentType,
    size: row.sizeBytes,
    sha256: row.sha256,
    objectKey: row.objectKey,
    uploadedAt: row.createdAt,
    uploadedBy: row.uploadedBy,
    replacesDocumentId: row.replacesDocumentId,
    duplicateOfId: row.duplicateOfId,
    encounterId: row.encounterId,
    appointmentId: row.appointmentId,
    hiddenAt: row.hiddenAt,
    hiddenReason: row.hiddenReason,
    rejectionReason: row.rejectionReason,
  };
}

/** A document that exists as far as the organization is concerned: confirmed and not abandoned. */
const real = and(
  sql`${document.uploadCompletedAt} is not null`,
  sql`${document.abandonedAt} is null`,
);

/**
 * Administrative part: the administrative documents of every patient. The export runs as the
 * organization, so row level security gives it administrative documents only: a clinical one can
 * never leave through this part.
 */
export const exportAdministrativeDocuments: ExportContributor = async ({ tx }) => {
  const rows = await tx
    .select()
    .from(document)
    .where(and(real, eq(document.classification, 'administrative')))
    .orderBy(asc(document.createdAt), asc(document.id));
  return { documents: rows.map(exported) };
};

/**
 * Clinical part, one package per professional: the clinical documents of the patients that
 * professional treats. Row level security (the export runs as that professional) already limits it
 * to what they may read; the care relationship narrows it to their own patients.
 */
export const exportClinicalDocuments: ExportContributor = async ({ tx, professionalId }) => {
  if (professionalId === undefined) return { documents: [] };
  const rows = await tx
    .select({ row: document })
    .from(document)
    .innerJoin(
      careRelationship,
      and(
        eq(careRelationship.patientId, document.patientId),
        eq(careRelationship.professionalId, professionalId),
        eq(careRelationship.active, true),
      ),
    )
    .where(and(real, eq(document.classification, 'clinical')))
    .orderBy(asc(document.createdAt), asc(document.id));
  return { documents: rows.map((entry) => exported(entry.row)) };
};
