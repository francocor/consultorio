import type {
  DocumentCategory,
  DocumentClassification,
  DocumentContentType,
  DocumentDto,
  DocumentListResponse,
  DocumentVersionsResponse,
} from '@consultorio/contracts';
import { eq, inArray, sql } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { patient } from '../../../db/schema/patients.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { documentDecision } from '../domain/access.js';

import { loadForAction } from './lookup.js';
import { loadPatientDocuments, toDocumentDto, type PatientDocuments } from './read-model.js';
import { DocumentRefused } from './refusal.js';

export interface ListingService {
  /** The documents of a patient the viewer may see, latest versions first, metadata only. */
  list(
    tx: Tx,
    input: { actor: Actor; patientId: string; includeHidden: boolean },
  ): Promise<DocumentListResponse>;
  /** A document and the versions it replaced, newest first. */
  versions(tx: Tx, input: { actor: Actor; documentId: string }): Promise<DocumentVersionsResponse>;
}

/** What `app.reception_clinical_documents` returns: the metadata of a clinical document. */
type MetadataRow = {
  id: string;
  patient_id: string;
  category: string;
  original_name: string;
  size_bytes: number;
  content_type: string | null;
  created_at: string | Date;
  uploaded_by: string;
  replaces_document_id: string | null;
};

export function createListingService(): ListingService {
  /**
   * Reception may see the name and category of a clinical document when the organization allows it.
   * The database function decides (setting on, and the caller is reception); the service never
   * asks for it from anyone else, so it also never even calls it for the administration.
   */
  async function receptionMetadata(
    tx: Tx,
    actor: Actor,
    patientId: string,
  ): Promise<MetadataRow[]> {
    if (!actor.roles.includes('reception') || actor.professionalId !== null) return [];
    const result = await tx.execute<MetadataRow>(
      sql`select id, patient_id, category, original_name, size_bytes, content_type, created_at, uploaded_by, replaces_document_id
            from app.reception_clinical_documents(${patientId}::uuid)`,
    );
    return result.rows;
  }

  async function namesOf(tx: Tx, userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await tx
      .select({ userId: membership.userId, name: membership.displayName })
      .from(membership)
      .where(inArray(membership.userId, [...userIds]));
    return new Map(
      rows.flatMap((row) => (row.name === null ? [] : [[row.userId, row.name] as const])),
    );
  }

  function metadataDto(
    row: MetadataRow,
    names: Map<string, string>,
    versionCount: number,
  ): DocumentDto {
    return {
      id: row.id,
      patientId: row.patient_id,
      name: row.original_name,
      category: row.category as DocumentCategory,
      classification: 'clinical' satisfies DocumentClassification,
      status: 'available',
      contentType: row.content_type as DocumentContentType | null,
      size: row.size_bytes,
      uploadedAt: new Date(row.created_at).toISOString(),
      uploadedByName: names.get(row.uploaded_by) ?? null,
      rejectionReason: null,
      encounterId: null,
      appointmentId: null,
      replacesDocumentId: row.replaces_document_id,
      versionCount,
      duplicateOf: null,
      hidden: null,
      metadataOnly: true,
    };
  }

  function chainLength(byId: Map<string, MetadataRow>, row: MetadataRow): number {
    let count = 1;
    const seen = new Set([row.id]);
    let cursor = row.replaces_document_id === null ? undefined : byId.get(row.replaces_document_id);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      count += 1;
      cursor =
        cursor.replaces_document_id === null ? undefined : byId.get(cursor.replaces_document_id);
    }
    return count;
  }

  return {
    async list(tx, { actor, patientId, includeHidden }) {
      const [found] = await tx
        .select({ id: patient.id })
        .from(patient)
        .where(eq(patient.id, patientId));
      if (!found) throw new AppError('not_found');

      const view = await loadPatientDocuments(tx, patientId);
      // A newer version that is available replaces the older one in the list. One still being
      // scanned, refused or hidden does not: the previous version stays the latest.
      const superseded = new Set(
        view.rows.flatMap((row) =>
          row.status === 'available' && row.replacesDocumentId !== null
            ? [row.replacesDocumentId]
            : [],
        ),
      );
      const own = view.rows.filter((row) => {
        // A refused file is shown to whoever uploaded it, so they see what happened.
        if (row.status === 'rejected') return row.uploadedBy === actor.userId;
        if (row.status === 'hidden' && !includeHidden) return false;
        return !superseded.has(row.id);
      });

      const metadata = (await receptionMetadata(tx, actor, patientId)).filter(
        (row) => !view.byId.has(row.id),
      );
      const metadataById = new Map(metadata.map((row) => [row.id, row]));
      const metadataSuperseded = new Set(
        metadata.flatMap((row) =>
          row.replaces_document_id === null ? [] : [row.replaces_document_id],
        ),
      );
      const extraNames = await namesOf(
        tx,
        metadata.map((row) => row.uploaded_by),
      );
      const shown: DocumentDto[] = [
        ...own.map((row) => toDocumentDto(view, row)),
        ...metadata
          .filter((row) => !metadataSuperseded.has(row.id))
          .map((row) => metadataDto(row, extraNames, chainLength(metadataById, row))),
      ];
      shown.sort(
        (left, right) =>
          right.uploadedAt.localeCompare(left.uploadedAt) || right.id.localeCompare(left.id),
      );
      return { documents: shown };
    },

    async versions(tx, { actor, documentId }) {
      const row = await loadForAction(tx, documentId);
      const decision = documentDecision(
        actor,
        row.classification as DocumentClassification,
        'read',
        {
          tenantId: actor.tenantId,
        },
      );
      if (!decision.allowed) {
        throw new DocumentRefused(`document_versions_${decision.reason}`, {
          resourceId: row.id,
          patientId: row.patientId,
        });
      }

      const view: PatientDocuments = await loadPatientDocuments(tx, row.patientId);
      const chain = [row];
      const seen = new Set([row.id]);
      let cursor =
        row.replacesDocumentId === null ? undefined : view.byId.get(row.replacesDocumentId);
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        chain.push(cursor);
        cursor =
          cursor.replacesDocumentId === null ? undefined : view.byId.get(cursor.replacesDocumentId);
      }
      return { versions: chain.map((entry) => toDocumentDto(view, entry)) };
    },
  };
}
