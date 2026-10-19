/**
 * The error codes and audit actions of the prescriptions module (e-prescription), apart from its
 * schemas (see `billing-catalog.ts` for why they live apart).
 */

/**
 * Error codes of the prescriptions module, with their status and the key of the es-AR message.
 * They join the API catalog (errors.ts); the messages go in
 * `locales/es-AR/errors.prescriptions.json`, keyed by the code. The e-Rx track (Track A3) adds its
 * codes here and nowhere else.
 */
export const PRESCRIPTION_ERRORS = {} as const satisfies Record<
  string,
  { status: number; i18nKey: string }
>;

/**
 * Audit actions of prescriptions. They are registered in the shared catalogue. The metadata of an
 * entry never carries the medications: the prescription content is clinical.
 */
export const PRESCRIPTION_AUDIT_ACTIONS = [
  'prescription.issued',
  'prescription.cancelled',
  'prescription.read',
  'prescription.downloaded',
  'prescription.failed',
  'prescription.registered_manually',
] as const;
