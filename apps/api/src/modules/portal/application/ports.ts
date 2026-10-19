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

/** A file the module renders for a download: where it sits in storage and what to call it. */
export interface PortalFile {
  objectKey: string;
  fileName: string;
  contentType: string;
}

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
  document(tx: Tx, call: PortalCall & { consentId: string }): Promise<PortalFile | null>;
}

export interface PortalPrescriptionPort {
  /** The prescriptions issued to the subject. Never one the provider has not confirmed as valid. */
  list(tx: Tx, call: PortalCall): Promise<PortalPrescriptionDto[]>;
  /** The prescription document, or null when it is not theirs or there is none. */
  document(tx: Tx, call: PortalCall & { prescriptionId: string }): Promise<PortalFile | null>;
}
