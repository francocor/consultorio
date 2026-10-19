import type {
  PortalConsentDetailDto,
  PortalConsentDto,
  PortalConsentStatus,
} from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import type { PortalCall, PortalConsentPort } from './ports.js';

/**
 * The portal entry points of the consent module (`createConsentPortal` of `modules/consent`), as
 * the portal sees them. They are written out here, structurally, so the portal does not import the
 * consent module: the integrator hands the object that `createConsentPortal({ keys })` returns to
 * `adaptConsentModule`, and the compiler checks that the two agree.
 *
 * Every function takes the transaction of the portal request, the `PortalActor`, and the
 * `patientId` that is the SUBJECT the portal resolved from the session. Another patient's request
 * is an `AppError('not_found')`.
 */
export interface ConsentModulePortal {
  list(tx: Tx, input: { actor: PortalActor; patientId: string }): Promise<ModuleListItem[]>;
  signingView(
    tx: Tx,
    input: { actor: PortalActor; patientId: string; requestId: string },
  ): Promise<ModuleSigningView>;
  sign(
    tx: Tx,
    input: {
      actor: PortalActor;
      auditActor: AuditActor;
      patientId: string;
      requestId: string;
      request: ModuleSignRequest;
    },
  ): Promise<{ id: string }>;
  revoke(
    tx: Tx,
    input: {
      actor: PortalActor;
      auditActor: AuditActor;
      patientId: string;
      requestId: string;
      request: { reason?: string | undefined };
    },
  ): Promise<{ id: string }>;
  document(
    tx: Tx,
    input: { actor: PortalActor; auditActor: AuditActor; patientId: string; requestId: string },
  ): Promise<{ bytes: Buffer; fileName: string }>;
}

/** `ConsentListItemDto` of the consent module, for the fields the portal reads. */
export interface ModuleListItem {
  id: string;
  status: PortalConsentStatus;
  method: 'in_person' | 'portal';
  createdAt: string;
  expiresAt: string;
  signedAt: string | null;
  revokedAt: string | null;
  title: string | null;
  /** Whether the viewer may open the signed record. */
  canOpen: boolean;
}

/** `ConsentSigningViewDto` of the consent module, for the fields the portal reads. */
export interface ModuleSigningView {
  requiresRepresentative: boolean;
  version: { id: string; title: string; body: string };
}

/** `SignConsentRequest` of the consent module. */
export interface ModuleSignRequest {
  versionId: string;
  accepted: boolean;
  signer: 'patient' | 'representative';
  representative?: { name: string; nationalId: string; relation: string };
  mark: { kind: 'typed'; name: string } | { kind: 'drawn'; imageDataUrl: string };
}

/** What the screens call a consent whose title the viewer may not read. */
const NEUTRAL_TITLE = 'Consentimiento';

const isNotFound = (error: unknown): boolean =>
  error instanceof AppError && error.code === 'not_found';

/** "This is not the subject's" is a `null` for the portal; every other refusal goes up as it is. */
async function orNull<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * A request the patient is asked to sign in the portal can be signed here; one made for the device
 * at the practice cannot, and while it waits there it is not the patient's business.
 */
const visibleInPortal = (item: ModuleListItem): boolean =>
  !(item.method === 'in_person' && item.status === 'pending');

function toPortalConsent(item: ModuleListItem): PortalConsentDto {
  const pending = item.status === 'pending' && item.method === 'portal';
  return {
    id: item.id,
    title: item.title ?? NEUTRAL_TITLE,
    status: item.status,
    requestedAt: item.createdAt,
    signedAt: item.signedAt,
    revokedAt: item.revokedAt,
    expiresAt: item.status === 'pending' ? item.expiresAt : null,
    canSign: pending,
    canRevoke: item.status === 'signed',
    // A record exists from the signature on, and stays after a revocation.
    hasDocument: item.canOpen && item.signedAt !== null,
  };
}

/**
 * Wires the consent module into the portal: the `PortalConsentPort` the sections and the download
 * door use. The mapping, in one place:
 *
 * - list: `list`, without the requests made for the device at the practice that still wait there.
 * - read: that item, plus the full text from `signingView` while it is open for signing. A consent
 *   that is signed, revoked or expired has no text here: the signed record is its PDF.
 * - sign: asks `signingView` for the version the request is bound to and signs against exactly that
 *   one (a request is bound to one version when it is made), with the typed name or the drawing as
 *   the mark and the representative when the subject is a minor.
 * - revoke: `revoke`, with the reason when there is one.
 * - document: `document`, as rendered bytes the portal keeps for one download only.
 */
export function adaptConsentModule(module: ConsentModulePortal): PortalConsentPort {
  const subject = (call: PortalCall) => ({ actor: call.actor, patientId: call.subject.patientId });

  async function items(tx: Tx, call: PortalCall): Promise<ModuleListItem[]> {
    return (await module.list(tx, subject(call))).filter(visibleInPortal);
  }

  async function current(tx: Tx, call: PortalCall, id: string): Promise<PortalConsentDto | null> {
    const found = (await items(tx, call)).find((item) => item.id === id);
    return found ? toPortalConsent(found) : null;
  }

  return {
    async list(tx, call) {
      return (await items(tx, call)).map(toPortalConsent);
    },

    async read(tx, call) {
      const consent = await current(tx, call, call.consentId);
      if (!consent) return null;
      if (!consent.canSign) {
        return {
          ...consent,
          body: '',
          requiresRepresentative: false,
        } satisfies PortalConsentDetailDto;
      }
      const view = await orNull(() =>
        module.signingView(tx, { ...subject(call), requestId: call.consentId }),
      );
      if (!view) return null;
      return {
        ...consent,
        title: view.version.title,
        body: view.version.body,
        requiresRepresentative: view.requiresRepresentative,
      };
    },

    async sign(tx, call) {
      const view = await orNull(() =>
        module.signingView(tx, { ...subject(call), requestId: call.consentId }),
      );
      if (!view) return null;
      const { request } = call;
      const signed = await orNull(() =>
        module.sign(tx, {
          ...subject(call),
          auditActor: call.auditActor,
          requestId: call.consentId,
          request: {
            versionId: view.version.id,
            accepted: request.accepted,
            signer: request.representative ? 'representative' : 'patient',
            ...(request.representative
              ? {
                  representative: {
                    name: request.representative.fullName,
                    nationalId: request.representative.nationalId,
                    relation: request.representative.relation,
                  },
                }
              : {}),
            mark:
              request.signature.kind === 'typed'
                ? { kind: 'typed', name: request.signature.value }
                : { kind: 'drawn', imageDataUrl: request.signature.value },
          },
        }),
      );
      return signed ? current(tx, call, call.consentId) : null;
    },

    async revoke(tx, call) {
      const revoked = await orNull(() =>
        module.revoke(tx, {
          ...subject(call),
          auditActor: call.auditActor,
          requestId: call.consentId,
          request: call.request.reason === undefined ? {} : { reason: call.request.reason },
        }),
      );
      return revoked ? current(tx, call, call.consentId) : null;
    },

    async document(tx, call) {
      const rendered = await orNull(() =>
        module.document(tx, {
          ...subject(call),
          auditActor: call.auditActor,
          requestId: call.consentId,
        }),
      );
      return rendered
        ? { bytes: rendered.bytes, fileName: rendered.fileName, contentType: 'application/pdf' }
        : null;
    },
  };
}
