import { randomUUID } from 'node:crypto';

import type { ConsentRequestDto, RevokeConsentRequest } from '@consultorio/contracts';

import { consentRevocation } from '../../../db/schema/consent.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { REVOCATION_REASON_FIELD, requireRequest, tenantId, toRequestDto } from './records.js';

/** Who withdraws: the staff user who records it in person, or the portal identity of the patient. */
export type RevocationActor =
  { kind: 'staff'; userId: string } | { kind: 'portal'; identityId: string };

export interface RevocationService {
  /**
   * Withdraws a signed consent. The signature stays as it was: the revocation is a new row beside
   * it, and the request becomes `revoked` (by the trigger of the revocation). It does not undo
   * what was done while the consent was valid.
   */
  revoke(
    tx: Tx,
    input: {
      requestId: string;
      by: RevocationActor;
      auditActor: AuditActor;
      request: RevokeConsentRequest;
      /** The patient the caller serves (the portal's subject): another patient's consent is not found. */
      patientId?: string;
    },
  ): Promise<ConsentRequestDto>;
}

/**
 * Revocation (informed-consent, "Revocation"; tasks 5.14). A patient or representative revokes
 * from the portal, and a member of the staff records a revocation asked for in person, with the
 * reason, so the recording user is identified. It is a patient-protective write: it works in a
 * read-only organization (the routes are categorized so; the portal's are too).
 */
export function createRevocationService(deps: {
  keys: TenantKeys;
  clock: () => Date;
}): RevocationService {
  return {
    async revoke(tx, { requestId, by, auditActor, request, patientId }) {
      const now = deps.clock();
      const found = await requireRequest(tx, requestId, { lock: true });
      if (patientId !== undefined && found.request.patientId !== patientId) {
        throw new AppError('not_found');
      }
      if (found.request.status === 'revoked') throw new AppError('consent_already_revoked');
      if (found.request.status !== 'signed') throw new AppError('consent_not_signed');

      const id = randomUUID();
      const reasonEnc =
        request.reason === undefined
          ? null
          : await deps.keys.encryptField(
              tx,
              { ...REVOCATION_REASON_FIELD, rowId: id },
              request.reason,
            );
      await tx.insert(consentRevocation).values({
        id,
        tenantId,
        requestId: found.request.id,
        patientId: found.request.patientId,
        channel: by.kind === 'staff' ? 'in_person' : 'portal',
        actorUserId: by.kind === 'staff' ? by.userId : null,
        portalIdentityId: by.kind === 'portal' ? by.identityId : null,
        reasonEnc,
        revokedAt: now,
      });

      await audit(tx, {
        action: 'consent.revoked',
        outcome: 'allow',
        actor: auditActor,
        resourceType: 'consent_request',
        resourceId: found.request.id,
        patientId: found.request.patientId,
        // The reason is free text about a patient: it stays encrypted in its row, not in the trail.
        metadata: {
          templateId: found.version.templateId,
          version: found.version.versionNumber,
          channel: by.kind === 'staff' ? 'in_person' : 'portal',
          withReason: request.reason !== undefined,
          ...(by.kind === 'portal' ? { identityId: by.identityId } : {}),
        },
      });

      const refreshed = await requireRequest(tx, found.request.id);
      return toRequestDto(refreshed.request, refreshed.version, now);
    },
  };
}
