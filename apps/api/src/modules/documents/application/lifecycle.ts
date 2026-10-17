import {
  classificationOf,
  type DocumentClassification,
  type DocumentDto,
  type HideDocumentRequest,
  type ReclassifyDocumentRequest,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { document } from '../../../db/schema/documents.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { isTreating } from '../../patients/index.js';
import { documentDecision } from '../domain/access.js';

import { loadForAction } from './lookup.js';
import { loadPatientDocuments, toDocumentDto } from './read-model.js';
import { DocumentRefused } from './refusal.js';

export interface LifecycleService {
  /** Takes a document out of the default views, with a reason. The file and its metadata stay. */
  hide(
    tx: Tx,
    input: {
      actor: Actor;
      auditActor: AuditActor;
      documentId: string;
      request: HideDocumentRequest;
    },
  ): Promise<DocumentDto>;
  /** Moves a document between clinical and administrative. A health professional's decision. */
  reclassify(
    tx: Tx,
    input: {
      actor: Actor;
      auditActor: AuditActor;
      documentId: string;
      request: ReclassifyDocumentRequest;
    },
  ): Promise<DocumentDto>;
}

export function createLifecycleService(deps: { clock: () => Date }): LifecycleService {
  return {
    async hide(tx, { actor, auditActor, documentId, request }) {
      const row = await loadForAction(tx, documentId);
      const decision = documentDecision(
        actor,
        row.classification as DocumentClassification,
        'write',
        { tenantId: actor.tenantId },
      );
      if (!decision.allowed) {
        throw new DocumentRefused(`document_hide_${decision.reason}`, {
          resourceId: row.id,
          patientId: row.patientId,
        });
      }
      if (row.status !== 'available') throw new AppError('conflict');

      const [hidden] = await tx
        .update(document)
        .set({
          status: 'hidden',
          hiddenAt: deps.clock(),
          hiddenBy: actor.userId,
          hiddenReason: request.reason,
        })
        .where(eq(document.id, row.id))
        .returning();
      if (!hidden) throw new Error('hiding a document returned no row');

      await audit(tx, {
        action: 'document.hidden',
        outcome: 'allow',
        actor: auditActor,
        resourceType: 'document',
        resourceId: hidden.id,
        patientId: hidden.patientId,
        // The reason is free text written about a patient: it stays in the row, not in the trail.
        metadata: { category: hidden.category },
      });
      return toDocumentDto(await loadPatientDocuments(tx, hidden.patientId), hidden);
    },

    async reclassify(tx, { actor, auditActor, documentId, request }) {
      const row = await loadForAction(tx, documentId);
      // Deciding what a document is, is a clinical act whichever way it goes.
      const decision = documentDecision(actor, 'clinical', 'write', { tenantId: actor.tenantId });
      if (!decision.allowed) {
        throw new DocumentRefused(`document_reclassify_${decision.reason}`, {
          resourceId: row.id,
          patientId: row.patientId,
        });
      }
      if (row.status === 'rejected') throw new AppError('conflict');

      const to = classificationOf(request.category);
      if (to === 'clinical' && !(await isTreating(tx, actor.professionalId, row.patientId))) {
        throw new DocumentRefused('document_not_treating', {
          resourceId: row.id,
          patientId: row.patientId,
        });
      }

      const [changed] = await tx
        .update(document)
        .set({
          category: request.category,
          classification: to,
          // The professional who makes a document clinical becomes its clinical owner (set once).
          authorProfessionalId:
            row.authorProfessionalId ?? (to === 'clinical' ? actor.professionalId : null),
        })
        .where(eq(document.id, row.id))
        .returning();
      if (!changed) throw new Error('reclassifying a document returned no row');

      await audit(tx, {
        action: 'document.reclassified',
        outcome: 'allow',
        actor: auditActor,
        resourceType: 'document',
        resourceId: changed.id,
        patientId: changed.patientId,
        metadata: { from: row.classification, to, category: changed.category },
      });
      return toDocumentDto(await loadPatientDocuments(tx, changed.patientId), changed);
    },
  };
}
