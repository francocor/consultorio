import type { PortalDownloadLinkResponse } from '@consultorio/contracts';

import { audit } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import { can } from '../../../platform/authz/can.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { FileRefused, type FileResource } from '../../../platform/files/file-resources.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { findInvoiceFileForPatient } from '../../invoicing/index.js';
import { attachmentHeader } from '../domain/attachment-header.js';

import { readSharedDocument } from './document-shares.js';
import {
  isRenderedFile,
  type PortalCall,
  type PortalConsentPort,
  type PortalFile,
  type PortalPrescriptionPort,
} from './ports.js';
import { bindSubject, resolveSubject } from './subject.js';

/** What a patient can download from the portal. One door, four kinds of file. */
export const DOWNLOAD_KINDS = ['document', 'prescription', 'invoice', 'consent'] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];

export function isDownloadKind(value: unknown): value is DownloadKind {
  return DOWNLOAD_KINDS.some((kind) => kind === value);
}

/** The permission of the portal actor that each kind of file needs. */
const PERMISSION = {
  document: 'portal.document.read',
  prescription: 'portal.prescription.read',
  invoice: 'portal.invoice.read',
  consent: 'portal.self.read',
} as const;

export interface DownloadDeps {
  tokens: ActionTokens;
  consent: PortalConsentPort | undefined;
  prescriptions: PortalPrescriptionPort | undefined;
  /** The clock of the application: the day decides whether a representative link is still in force. */
  clock: () => Date;
}

/**
 * A file to hand over: where it is in storage, or the bytes themselves when a module rendered them
 * on demand (a signed consent, a prescription made at the moment). Rendered bytes are streamed from
 * memory and never written to storage, so a failed response leaves nothing behind (JD-S5 R1-S5-8).
 */
export interface DownloadFile {
  objectKey: string;
  contentType: string;
  fileName: string;
  /** The patient it belongs to, for the trail. */
  patientId: string;
  /** Present for a file rendered on demand; `objectKey` is then empty. */
  bytes?: Buffer;
}

/** The type a file is served with. Text says its encoding so a browser never guesses. */
function servedType(contentType: string | null): string {
  if (contentType === null) return 'application/octet-stream';
  return contentType === 'text/plain' ? 'text/plain; charset=utf-8' : contentType;
}

/**
 * Hands a file a module returned over as a `DownloadFile`. A file in storage is served from where
 * it is. A rendered file travels as its bytes, and only when it is going to be delivered
 * (`deliver`); asking for the link only needs to know it exists.
 */
function toDownload(call: PortalCall, file: PortalFile, deliver: boolean): DownloadFile {
  const patientId = call.subject.patientId;
  if (!isRenderedFile(file)) return { ...file, patientId };
  return {
    objectKey: '',
    contentType: file.contentType,
    fileName: file.fileName,
    patientId,
    ...(deliver ? { bytes: file.bytes } : {}),
  };
}

/**
 * Finds the file of a resource FOR THE SUBJECT of the call, or null: it does not exist, it is not
 * the subject's, it is not shared with them any more, or the module that owns it has no file for it.
 * Asking for the link and using the link both come through here, so access is decided again when
 * the link is used (design 5.6): a share can end, a link can be revoked, inside the five minutes.
 */
export async function findDownload(
  tx: Tx,
  deps: DownloadDeps,
  call: PortalCall,
  kind: DownloadKind,
  id: string,
  options: { deliver?: boolean } = {},
): Promise<DownloadFile | null> {
  const deliver = options.deliver ?? false;
  const purpose = deliver ? ('download' as const) : ('link' as const);
  const patientId = call.subject.patientId;
  switch (kind) {
    case 'document': {
      const shared = await readSharedDocument(tx, id);
      return shared
        ? {
            objectKey: shared.objectKey,
            contentType: servedType(shared.contentType),
            fileName: shared.name,
            patientId: shared.patientId,
          }
        : null;
    }
    case 'invoice': {
      const found = await findInvoiceFileForPatient(tx, { invoiceId: id, patientId });
      return found
        ? {
            objectKey: found.objectKey,
            contentType: 'application/pdf',
            fileName: found.fileName,
            patientId,
          }
        : null;
    }
    case 'prescription': {
      const file = await deps.prescriptions?.document(tx, {
        ...call,
        prescriptionId: id,
        purpose,
      });
      return file ? toDownload(call, file, deliver) : null;
    }
    case 'consent': {
      const file = await deps.consent?.document(tx, { ...call, consentId: id, purpose });
      return file ? toDownload(call, file, deliver) : null;
    }
  }
}

/** A link to the file for this session only: five minutes, one use. Null when it is not the subject's. */
export async function issueDownloadLink(
  tx: Tx,
  deps: DownloadDeps,
  call: PortalCall,
  input: { kind: DownloadKind; id: string; sessionId: string },
): Promise<PortalDownloadLinkResponse | null> {
  const file = await findDownload(tx, deps, call, input.kind, input.id);
  if (!file) return null;
  const issued = await deps.tokens.issue(tx, {
    kind: 'document_download',
    subjectId: input.id,
    sessionId: input.sessionId,
    payload: { resourceType: input.kind },
  });
  return { url: `/portal/files/${issued.token}`, expiresAt: issued.expiresAt.toISOString() };
}

/**
 * The portal's part of its door to files: the links of `document_download` redeemed with the
 * `psid` session. There is ONE resource for the kind (the registry holds one per kind) and it
 * dispatches on the `resourceType` the link was issued with. Using a link spends it, checks it was
 * issued to THIS session, finds the session's subject again and authorizes the file for it, and
 * writes the entry of the download in the same transaction.
 *
 * A link that is not a live one of this kind answers `null` (the registry then refuses it like any
 * other); a live link whose owner lost access in the meantime is refused with the reason, which the
 * door audits.
 */
export function createPortalFileResource(deps: DownloadDeps): FileResource<PortalActor> {
  return {
    kind: 'document_download',
    audits: ['portal.download'],
    async redeem(tx, input) {
      const redeemed = await deps.tokens.redeem(tx, 'document_download', input.token, {
        sessionId: input.sessionId,
      });
      // Unknown, spent, expired, another kind's, or issued to another session.
      if (!redeemed) return null;
      const kind = redeemed.payload['resourceType'];
      // A link of the staff door (no resource type) is not the portal's.
      if (!isDownloadKind(kind)) return null;

      const refused = (reason: string, patientId?: string) =>
        new FileRefused(reason, kind, {
          resourceId: redeemed.subjectId,
          ...(patientId === undefined ? {} : { patientId }),
        });
      if (!can(input.actor, PERMISSION[kind], { tenantId: input.actor.tenantId }).allowed) {
        throw refused('portal_download_not_permitted');
      }
      let subject;
      try {
        subject = await resolveSubject(tx, input.actor, deps.clock());
      } catch {
        // The person has no subject any more (the link ended, or they switched to none).
        throw refused('portal_subject_lost');
      }
      await bindSubject(tx, subject);
      const file = await findDownload(
        tx,
        deps,
        { actor: input.actor, subject, auditActor: input.auditActor },
        kind,
        redeemed.subjectId,
        { deliver: true },
      );
      if (!file) throw refused('portal_download_not_available', subject.patientId);

      await audit(tx, {
        action: 'portal.download',
        outcome: 'allow',
        actor: input.auditActor,
        resourceType: kind,
        resourceId: redeemed.subjectId,
        patientId: file.patientId,
        metadata: { resourceType: kind },
      });
      return {
        objectKey: file.objectKey,
        contentType: file.contentType,
        contentDisposition: attachmentHeader(file.fileName),
        ...(file.bytes ? { bytes: file.bytes } : {}),
      };
    },
  };
}
