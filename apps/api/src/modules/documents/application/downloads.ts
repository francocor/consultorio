import type { DocumentClassification, DownloadLinkResponse } from '@consultorio/contracts';

import type { DocumentRow } from '../../../db/schema/documents.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { documentDecision } from '../domain/access.js';

import { loadForAction } from './lookup.js';
import { findDocument } from './read-model.js';
import { DocumentRefused } from './refusal.js';

export interface DownloadService {
  /** Authorizes the read and hands out a link for this session, valid for five minutes. */
  issue(
    tx: Tx,
    input: { actor: Actor; sessionId: string; documentId: string },
  ): Promise<DownloadLinkResponse>;
  /**
   * Spends the link. The authorization is decided AGAIN here, because access can end inside the
   * five minutes: a care relationship can end, the document can be hidden. Returns the document to
   * stream; the audit entry is written in the same transaction as the use of the link.
   */
  redeem(
    tx: Tx,
    input: { actor: Actor; auditActor: AuditActor; sessionId: string; token: string },
  ): Promise<DocumentRow>;
}

export function createDownloadService(deps: { tokens: ActionTokens }): DownloadService {
  function assertReadable(actor: Actor, row: DocumentRow, context: 'issue' | 'redeem'): void {
    const decision = documentDecision(actor, row.classification as DocumentClassification, 'read', {
      tenantId: actor.tenantId,
    });
    if (!decision.allowed) {
      throw new DocumentRefused(`document_${context}_${decision.reason}`, {
        resourceId: row.id,
        patientId: row.patientId,
      });
    }
  }

  return {
    async issue(tx, { actor, sessionId, documentId }) {
      const row = await loadForAction(tx, documentId);
      assertReadable(actor, row, 'issue');
      // Only a file that passed its scan can be offered. A pending, refused or hidden one has no
      // download at all.
      if (row.status !== 'available') throw new AppError('conflict');

      const issued = await deps.tokens.issue(tx, {
        kind: 'document_download',
        subjectId: row.id,
        sessionId,
      });
      return { url: `/files/${issued.token}`, expiresAt: issued.expiresAt.toISOString() };
    },

    async redeem(tx, { actor, auditActor, sessionId, token }) {
      const redeemed = await deps.tokens.redeem(tx, 'document_download', token, { sessionId });
      // Expired, spent, never issued, or issued to another session: one answer for all of them.
      if (!redeemed) throw new DocumentRefused('document_link_invalid');

      const row = await findDocument(tx, redeemed.subjectId);
      if (!row || row.uploadCompletedAt === null || row.abandonedAt !== null) {
        throw new DocumentRefused('document_not_readable', { resourceId: redeemed.subjectId });
      }
      assertReadable(actor, row, 'redeem');
      if (row.status !== 'available') {
        throw new DocumentRefused('document_not_available', {
          resourceId: row.id,
          patientId: row.patientId,
        });
      }

      await audit(tx, {
        action: 'document.downloaded',
        outcome: 'allow',
        actor: auditActor,
        resourceType: 'document',
        resourceId: row.id,
        patientId: row.patientId,
        metadata: { category: row.category, size: row.sizeBytes },
      });
      return row;
    },
  };
}
