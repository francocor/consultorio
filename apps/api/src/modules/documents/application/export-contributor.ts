import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { careRelationship } from '../../../db/schema/care.js';
import { document, type DocumentRow } from '../../../db/schema/documents.js';
import {
  afterStamp,
  pagedByStamp,
  stampText,
  type ExportContributor,
} from '../../tenancy/index.js';

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
 * never leave through this part. They are read a page at a time (a document per visit), in the
 * order they were uploaded.
 */
export const exportAdministrativeDocuments: ExportContributor = ({ tx, pageSize }) =>
  Promise.resolve({
    documents: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select({
            row: document,
            cursorAt: stampText(document.createdAt),
            cursorId: document.id,
          })
          .from(document)
          .where(
            and(
              real,
              eq(document.classification, 'administrative'),
              afterStamp(document.createdAt, document.id, after),
            ),
          )
          .orderBy(asc(document.createdAt), asc(document.id))
          .limit(limit),
      project: ({ row }) => exported(row),
    }),
  });

/**
 * Clinical part, one package per professional: the clinical documents that professional wrote,
 * and those of the patients they treat. Row level security (the export runs as that professional)
 * already limits it to what they may read; authorship or the care relationship narrows it to
 * their own work, the same rule as the notes. A document the professional wrote is theirs even if
 * no relationship is active any more.
 */
export const exportClinicalDocuments: ExportContributor = ({ tx, professionalId, pageSize }) => {
  if (professionalId === undefined) return Promise.resolve({ documents: [] });
  const treated = tx
    .select({ patientId: careRelationship.patientId })
    .from(careRelationship)
    .where(
      and(eq(careRelationship.professionalId, professionalId), eq(careRelationship.active, true)),
    );
  return Promise.resolve({
    documents: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select({
            row: document,
            cursorAt: stampText(document.createdAt),
            cursorId: document.id,
          })
          .from(document)
          .where(
            and(
              real,
              eq(document.classification, 'clinical'),
              or(
                eq(document.authorProfessionalId, professionalId),
                inArray(document.patientId, treated),
              ),
              afterStamp(document.createdAt, document.id, after),
            ),
          )
          .orderBy(asc(document.createdAt), asc(document.id))
          .limit(limit),
      project: ({ row }) => exported(row),
    }),
  });
};
