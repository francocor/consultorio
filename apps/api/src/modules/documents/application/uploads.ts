import {
  DOCUMENT_MAX_BYTES,
  classificationOf,
  type CreateUploadsRequest,
  type CreateUploadsResponse,
  type DocumentDto,
} from '@consultorio/contracts';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { document } from '../../../db/schema/documents.js';
import { patient } from '../../../db/schema/patients.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { AppError } from '../../../platform/http/problem.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { tenantKey, type ObjectStorage } from '../../../platform/storage/object-storage.js';
import { AccessRefused } from '../../access/index.js';
import { isTreating } from '../../patients/index.js';
import { documentDecision } from '../domain/access.js';
import { sanitizeFileName } from '../domain/file-name.js';

import { findDocument, loadPatientDocuments, toDocumentDto } from './read-model.js';

/** Name of the queue that scans a document once its upload is confirmed. */
export const SCAN_JOB = 'document.scan';

/** How long the browser has to send the file after asking for the upload. */
export const UPLOAD_LINK_SECONDS = 15 * 60;

const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

export interface UploadService {
  /**
   * Registers the files a user wants to upload and hands out one presigned POST per file. Nothing
   * is visible to anyone yet: a row counts as a document only once the upload is confirmed.
   */
  create(
    tx: Tx,
    input: { actor: Actor; request: CreateUploadsRequest },
  ): Promise<CreateUploadsResponse>;
  /**
   * The uploader confirms the file reached storage. The scan is queued in the same transaction,
   * so a confirmed upload is always scanned and an unconfirmed one never is.
   */
  complete(
    tx: Tx,
    input: { actor: Actor; auditActor: AuditActor; documentId: string },
  ): Promise<DocumentDto>;
}

export interface UploadDeps {
  /** Absent when no bucket is configured: uploads then answer "unavailable". */
  storage: ObjectStorage | undefined;
  /** Absent in a deployment without background jobs; confirming an upload then answers unavailable. */
  jobs: JobClient | undefined;
  clock: () => Date;
}

export function createUploadService(deps: UploadDeps): UploadService {
  /** A replacement must be the next version of an available document of the same patient. */
  async function assertReplaceable(tx: Tx, request: CreateUploadsRequest): Promise<void> {
    if (request.replacesDocumentId === undefined) return;
    const original = await findDocument(tx, request.replacesDocumentId);
    if (!original || original.patientId !== request.patientId) throw new AppError('not_found');
    if (original.status !== 'available') throw new AppError('conflict');
    if (original.classification !== classificationOf(request.category)) {
      throw new AppError('validation_failed', [
        { path: 'category', i18nKey: 'documents.rejection.category_mismatch' },
      ]);
    }
    const [live] = await tx
      .select({ id: document.id })
      .from(document)
      .where(
        and(
          eq(document.replacesDocumentId, original.id),
          ne(document.status, 'rejected'),
          sql`${document.abandonedAt} is null`,
        ),
      );
    if (live) throw new AppError('conflict');
  }

  async function duplicateOf(tx: Tx, patientId: string, sha256: string | undefined) {
    if (sha256 === undefined) return null;
    // Row level security hides clinical documents the viewer may not read, so a duplicate warning
    // never reveals one.
    const [found] = await tx
      .select({ id: document.id, name: document.originalName, uploadedAt: document.createdAt })
      .from(document)
      .where(
        and(
          eq(document.patientId, patientId),
          eq(document.sha256, sha256.toLowerCase()),
          eq(document.status, 'available'),
        ),
      )
      .orderBy(asc(document.createdAt))
      .limit(1);
    return found
      ? { id: found.id, name: found.name, uploadedAt: found.uploadedAt.toISOString() }
      : null;
  }

  return {
    async create(tx, { actor, request }) {
      const storage = deps.storage;
      if (!storage) throw new AppError('service_unavailable');

      const classification = classificationOf(request.category);
      const decision = documentDecision(actor, classification, 'write', {
        tenantId: actor.tenantId,
      });
      if (!decision.allowed) throw new AccessRefused(`document_upload_${decision.reason}`);

      const [found] = await tx
        .select({ id: patient.id })
        .from(patient)
        .where(eq(patient.id, request.patientId));
      if (!found) throw new AppError('not_found');

      if (
        classification === 'clinical' &&
        !(await isTreating(tx, actor.professionalId, request.patientId))
      ) {
        throw new AccessRefused('document_not_treating');
      }
      await assertReplaceable(tx, request);

      const uploads: CreateUploadsResponse['uploads'] = [];
      for (const file of request.files) {
        const id = uuidv7();
        const objectKey = tenantKey(actor.tenantId, 'quarantine', id);
        try {
          await tx.insert(document).values({
            id,
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            patientId: request.patientId,
            encounterId: request.encounterId ?? null,
            appointmentId: request.appointmentId ?? null,
            category: request.category,
            classification,
            originalName: sanitizeFileName(file.name),
            declaredContentType: file.contentType,
            sizeBytes: file.size,
            objectKey,
            uploadedBy: actor.userId,
            authorProfessionalId: classification === 'clinical' ? actor.professionalId : null,
            replacesDocumentId: request.replacesDocumentId ?? null,
          });
        } catch (error) {
          // Two requests for the next version of the same document at once: the second one lost.
          if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('conflict');
          throw error;
        }
        const post = await storage.presignedPost(actor.tenantId, objectKey, {
          contentType: file.contentType,
          maxBytes: DOCUMENT_MAX_BYTES,
          expiresInSeconds: UPLOAD_LINK_SECONDS,
        });
        uploads.push({
          id,
          name: sanitizeFileName(file.name),
          upload: { url: post.url, fields: post.fields, expiresAt: post.expiresAt.toISOString() },
          duplicateOf: await duplicateOf(tx, request.patientId, file.sha256),
        });
      }
      return { uploads };
    },

    async complete(tx, { actor, auditActor, documentId }) {
      const { storage, jobs } = deps;
      if (!storage || !jobs) throw new AppError('service_unavailable');

      const row = await findDocument(tx, documentId);
      // Only the uploader confirms; for anyone else the upload does not exist yet.
      if (!row || row.uploadedBy !== actor.userId) throw new AppError('not_found');
      if (row.uploadCompletedAt !== null || row.abandonedAt !== null)
        throw new AppError('conflict');

      const stored = await storage.head(actor.tenantId, row.objectKey);
      if (!stored || stored.size < 1 || stored.size > DOCUMENT_MAX_BYTES) {
        throw new AppError('conflict');
      }

      const [confirmed] = await tx
        .update(document)
        .set({ uploadCompletedAt: deps.clock(), sizeBytes: stored.size })
        .where(and(eq(document.id, row.id), sql`${document.uploadCompletedAt} is null`))
        .returning();
      // Two confirmations at once: the second finds it already done.
      if (!confirmed) throw new AppError('conflict');

      await audit(tx, {
        action: 'document.uploaded',
        outcome: 'allow',
        actor: auditActor,
        resourceType: 'document',
        resourceId: confirmed.id,
        patientId: confirmed.patientId,
        metadata: {
          category: confirmed.category,
          size: confirmed.sizeBytes,
          replaces: confirmed.replacesDocumentId,
        },
      });
      await jobs.enqueue(tx, SCAN_JOB, { tenantId: actor.tenantId, documentId: confirmed.id });

      return toDocumentDto(await loadPatientDocuments(tx, confirmed.patientId), confirmed);
    },
  };
}
