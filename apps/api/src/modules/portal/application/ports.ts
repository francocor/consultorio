import type {
  PortalConsentDetailDto,
  PortalConsentDto,
  PortalConsentRevokeRequest,
  PortalConsentSignRequest,
  PortalPrescriptionDto,
} from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import type { PortalSubject } from './subject.js';

/**
 * The doors through which the portal reaches the modules that own consents and prescriptions. The
 * portal owns no clinical table: it asks the module that owns the data, with the portal actor of
 * the session and the subject it validated, and shows what the module answers.
 *
 * Both are optional in `PortalOptions`. While a module is not wired the portal's section answers
 * `available: false` and the screen shows its empty state; when the integrator wires one (see
 * `main/wiring/portal.ts`), the section lights up with no change to the portal. A port NEVER receives
 * a patient id from a request: `subject.patientId` comes from the session.
 *
 * A refusal is an `AppError` of the module (an expired request, a consent already revoked); "this
 * one is not the subject's" is a `null`, which the portal turns into a 404 and a `portal.denied`
 * entry. Every function writes its own audit entries (`consent.read`, `prescription.read`, ...) with
 * the `auditActor` it is given, which already says `patient` and carries no user.
 */
export interface PortalCall {
  actor: PortalActor;
  subject: PortalSubject;
  auditActor: AuditActor;
}

/** A file the module keeps in storage: where it sits and what to call it. */
export interface PortalStoredFile {
  objectKey: string;
  fileName: string;
  contentType: string;
}

/**
 * A file the module renders on demand (a PDF made from the signed record, for instance) and hands
 * over as bytes. The portal stores it for the length of one download, under a key of its own that
 * it removes when the response ends, and serves it through the same single-use link as any other.
 */
export interface PortalRenderedFile {
  bytes: Buffer;
  fileName: string;
  contentType: string;
}

export type PortalFile = PortalStoredFile | PortalRenderedFile;

export const isRenderedFile = (file: PortalFile): file is PortalRenderedFile => 'bytes' in file;

/**
 * Why a module is asked for a file. The door asks twice for one download: once to issue the link
 * (`link`: only to know the file exists and is the subject's) and once when the link is used
 * (`download`: the file is going out). Only a `download` is a read of the file for the trail, so a
 * module audits that one and nothing for a `link`.
 */
export type DownloadPurpose = 'link' | 'download';

export interface PortalConsentPort {
  /** The consents of the subject: pending, signed, revoked, expired. */
  list(tx: Tx, call: PortalCall): Promise<PortalConsentDto[]>;
  /** The full text the subject is asked to sign, or null when it is not theirs. */
  read(tx: Tx, call: PortalCall & { consentId: string }): Promise<PortalConsentDetailDto | null>;
  /** Signs against the version the subject was shown, or null when it is not theirs. */
  sign(
    tx: Tx,
    call: PortalCall & { consentId: string; request: PortalConsentSignRequest },
  ): Promise<PortalConsentDto | null>;
  /** Revokes, as a new event beside the signature, or null when it is not theirs. */
  revoke(
    tx: Tx,
    call: PortalCall & { consentId: string; request: PortalConsentRevokeRequest },
  ): Promise<PortalConsentDto | null>;
  /** The signed document, or null when it is not theirs or there is none. */
  document(
    tx: Tx,
    call: PortalCall & { consentId: string; purpose: DownloadPurpose },
  ): Promise<PortalFile | null>;
}

export interface PortalPrescriptionPort {
  /** The prescriptions issued to the subject. Never one the provider has not confirmed as valid. */
  list(tx: Tx, call: PortalCall): Promise<PortalPrescriptionDto[]>;
  /** The prescription document, or null when it is not theirs or there is none. */
  document(
    tx: Tx,
    call: PortalCall & { prescriptionId: string; purpose: DownloadPurpose },
  ): Promise<PortalFile | null>;
}
