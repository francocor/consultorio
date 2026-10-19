export { CONSENT_ERRORS, CONSENT_AUDIT_ACTIONS } from './consent-catalog.js';

/**
 * Contracts of the consent module (informed consent: versioned templates, requests, signatures and
 * revocations). This file holds what is certain from the design and the spec; the consent track
 * (S5.02, S5.03, S5.11) adds its request and response shapes below, in this file only. The consent
 * to the processing of personal data (Ley 25.326) is a different thing and lives in `patients.ts`.
 */

/** A template is edited as a draft, published as a numbered version, and retired when replaced. */
export const CONSENT_TEMPLATE_STATUSES = ['draft', 'published', 'retired'] as const;
export type ConsentTemplateStatus = (typeof CONSENT_TEMPLATE_STATUSES)[number];

/** Where a request stands. A signature is immutable: `revoked` is a new event beside it. */
export const CONSENT_REQUEST_STATUSES = [
  'pending',
  'signed',
  'declined',
  'expired',
  'revoked',
] as const;
export type ConsentRequestStatus = (typeof CONSENT_REQUEST_STATUSES)[number];

/** How a consent is collected: on a device at the practice, or by the patient in the portal. */
export const CONSENT_METHODS = ['in_person', 'portal'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/** Who signs: the patient, or the representative of a patient who cannot (a minor). */
export const CONSENT_SIGNER_KINDS = ['patient', 'representative'] as const;
export type ConsentSignerKind = (typeof CONSENT_SIGNER_KINDS)[number];
