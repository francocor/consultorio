import type { DocumentClassification } from '@consultorio/contracts';

import type { Actor } from '../../../platform/authz/actor.js';
import { can } from '../../../platform/authz/can.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { documentDecision } from '../domain/access.js';

import { loadForAction } from './lookup.js';
import { DocumentRefused } from './refusal.js';

/** What the patient portal needs to know about a document to share it with the patient. */
export interface DocumentForSharing {
  id: string;
  patientId: string;
  classification: DocumentClassification;
}

/**
 * Finds the document a member of the staff wants to share with its patient, and says whether they
 * may (patient-portal "Documents shared with the patient"):
 *
 * - A clinical document is shared only by a health professional who can read it: the same rule as
 *   downloading it, so an owner, an admin or reception cannot share what they cannot open (the
 *   database hides it from them anyway, and the denial is audited like any other).
 * - An administrative one by whoever administers patients: reception, the administration, the owner.
 * - Only a document that passed its scan is offered to a patient.
 *
 * A document that does not exist (or that the viewer cannot see) is a plain not found.
 */
export async function loadDocumentForSharing(
  tx: Tx,
  actor: Actor,
  documentId: string,
): Promise<DocumentForSharing> {
  const row = await loadForAction(tx, documentId);
  const classification = row.classification as DocumentClassification;
  const decision =
    classification === 'clinical'
      ? documentDecision(actor, classification, 'read', { tenantId: actor.tenantId })
      : can(actor, 'patients.administer', { tenantId: actor.tenantId });
  if (!decision.allowed) {
    throw new DocumentRefused(`document_share_${decision.reason}`, {
      resourceId: row.id,
      patientId: row.patientId,
    });
  }
  if (row.status !== 'available') throw new AppError('conflict');
  return { id: row.id, patientId: row.patientId, classification };
}
