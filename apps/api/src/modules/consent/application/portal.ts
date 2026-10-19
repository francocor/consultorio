import type {
  ConsentListItemDto,
  ConsentRequestDto,
  ConsentSigningViewDto,
  RevokeConsentRequest,
  SignConsentRequest,
} from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import { can } from '../../../platform/authz/can.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { currentTenantId, type Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { renderSignedDocument, type SignedDocument } from './documents.js';
import { listConsentsForPatient } from './read-model.js';
import { allowPortalSubject } from './records.js';
import { ConsentRefused } from './refusal.js';
import { createRevocationService } from './revoke-consent.js';
import { createSigningService } from './sign-consent.js';
import { auditRead, openSignedRecord } from './signed-record.js';

/**
 * What the portal needs from consent, and the only way it reaches it (docs/stage5-tracks.md, track
 * A2; tasks 5.13, 5.14 and 5.33). Every function takes the transaction of the portal request (opened
 * for the organization of the session), the `PortalActor`, and the `patientId` that is the
 * SUBJECT the portal resolved from the session. The portal never passes an id taken from a
 * parameter as the patient: a request of another patient answers "not found" here, as it does in
 * the portal.
 *
 * - `list` is `listConsentsForPatient` for a portal actor: the patient sees their own consents in
 *   full (title, status, dates).
 * - `signingView` and `sign` need `portal.consent.sign`, `revoke` needs `portal.consent.revoke`
 *   (a patient-protective write: the portal's route is categorized so and works in a read-only
 *   organization), `document` renders the printable record of what the patient signed.
 * - The audit entries are written in the caller's transaction with the actor the portal built
 *   (`actingRole: 'patient'`, no user id; the identity id goes in the metadata).
 */
export interface ConsentPortal {
  list(tx: Tx, input: { actor: PortalActor; patientId: string }): Promise<ConsentListItemDto[]>;
  signingView(
    tx: Tx,
    input: { actor: PortalActor; patientId: string; requestId: string },
  ): Promise<ConsentSigningViewDto>;
  sign(
    tx: Tx,
    input: {
      actor: PortalActor;
      auditActor: AuditActor;
      patientId: string;
      requestId: string;
      request: SignConsentRequest;
    },
  ): Promise<ConsentRequestDto>;
  revoke(
    tx: Tx,
    input: {
      actor: PortalActor;
      auditActor: AuditActor;
      patientId: string;
      requestId: string;
      request: RevokeConsentRequest;
    },
  ): Promise<ConsentRequestDto>;
  document(
    tx: Tx,
    input: {
      actor: PortalActor;
      auditActor: AuditActor;
      patientId: string;
      requestId: string;
      /**
       * `link`: the portal only checks the record exists to issue a link, and nothing is read for the
       * trail. `download` (the default): the record goes out and `consent.read` is written once.
       */
      purpose?: 'link' | 'download';
    },
  ): Promise<SignedDocument>;
}

export function createConsentPortal(deps: { keys: TenantKeys; clock?: () => Date }): ConsentPortal {
  const clock = deps.clock ?? (() => new Date());
  const signing = createSigningService({ keys: deps.keys, clock });
  const revocation = createRevocationService({ keys: deps.keys, clock });

  /** The actor holds the permission, and the transaction is the organization of the actor. */
  async function authorize(
    tx: Tx,
    actor: PortalActor,
    permission:
      'portal.consent.sign' | 'portal.consent.revoke' | 'portal.self.read' | 'portal.document.read',
  ): Promise<void> {
    const decision = can(actor, permission, { tenantId: actor.tenantId });
    if (!decision.allowed) throw new ConsentRefused(`consent_portal_${decision.reason}`);
    if ((await currentTenantId(tx)) !== actor.tenantId) throw new AppError('not_found');
  }

  return {
    async list(tx, { actor, patientId }) {
      await authorize(tx, actor, 'portal.self.read');
      return listConsentsForPatient(tx, { actor, patientId, now: clock() });
    },

    async signingView(tx, { actor, patientId, requestId }) {
      await authorize(tx, actor, 'portal.consent.sign');
      return signing.view(tx, {
        requestId,
        patientId,
        recorder: { kind: 'portal', identityId: actor.identityId },
      });
    },

    async sign(tx, { actor, auditActor, patientId, requestId, request }) {
      await authorize(tx, actor, 'portal.consent.sign');
      return signing.sign(tx, {
        requestId,
        patientId,
        auditActor,
        request,
        recorder: { kind: 'portal', identityId: actor.identityId },
      });
    },

    async revoke(tx, { actor, auditActor, patientId, requestId, request }) {
      await authorize(tx, actor, 'portal.consent.revoke');
      return revocation.revoke(tx, {
        requestId,
        patientId,
        auditActor,
        request,
        by: { kind: 'portal', identityId: actor.identityId },
      });
    },

    async document(tx, { actor, auditActor, patientId, requestId, purpose }) {
      await authorize(tx, actor, 'portal.document.read');
      // The signature of this patient, and no other, is readable from here on.
      await allowPortalSubject(tx, patientId);
      const record = await openSignedRecord(deps.keys, tx, requestId, { patientId });
      if (purpose !== 'link') await auditRead(tx, record, { auditActor, via: 'portal' });
      return renderSignedDocument(tx, record, clock());
    },
  };
}
