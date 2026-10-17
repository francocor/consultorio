import type { DocumentClassification, Permission } from '@consultorio/contracts';

import type { Actor } from '../../../platform/authz/actor.js';
import { can, type Decision, type Resource } from '../../../platform/authz/can.js';

export type DocumentAction = 'read' | 'write';

/**
 * The permission each action on a document needs (documents, "Classification and access rules").
 * A clinical document needs a clinical permission, which only a professional holds and only after
 * the professional gate; an administrative one needs the patient permissions that reception and
 * the administration hold. No grant can add a clinical permission, so no setting opens clinical
 * documents to anyone else.
 */
export function permissionFor(
  classification: DocumentClassification,
  action: DocumentAction,
): Permission {
  if (classification === 'clinical') {
    return action === 'read' ? 'clinical.document.read' : 'clinical.document.write';
  }
  return action === 'read' ? 'patients.read' : 'patients.write';
}

/** May this actor read or write a document of this classification? Deny reasons go to the audit. */
export function documentDecision(
  actor: Actor,
  classification: DocumentClassification,
  action: DocumentAction,
  resource: Resource = {},
): Decision {
  return can(actor, permissionFor(classification, action), resource);
}
