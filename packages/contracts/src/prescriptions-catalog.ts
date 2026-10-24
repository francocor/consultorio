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
export const PRESCRIPTION_ERRORS = {
  // The organization has no provider (the deployment serves none, or its switch is off): nothing
  // can be issued until it is connected.
  prescription_provider_not_connected: {
    status: 409,
    i18nKey: 'errors.prescription_provider_not_connected',
  },
  // Only the platform operator verifies a registration; until then a professional cannot prescribe.
  prescription_matricula_unverified: {
    status: 409,
    i18nKey: 'errors.prescription_matricula_unverified',
  },
  // The provider asks for the document of the patient: a patient without one cannot be prescribed to.
  prescription_patient_document_required: {
    status: 422,
    i18nKey: 'errors.prescription_patient_document_required',
  },
  // An issued prescription is never edited: it is cancelled and a new one is issued.
  prescription_not_editable: { status: 409, i18nKey: 'errors.prescription_not_editable' },
  // Dispensed, expired and cancelled prescriptions stay as they are.
  prescription_not_cancellable: { status: 409, i18nKey: 'errors.prescription_not_cancellable' },
  // The provider answered, and refused to cancel.
  prescription_cancel_refused: { status: 409, i18nKey: 'errors.prescription_cancel_refused' },
  // The provider could not be reached: nothing changed, try again later.
  prescription_provider_unavailable: {
    status: 503,
    i18nKey: 'errors.prescription_provider_unavailable',
  },
  // The request may have been answered and the answer is not known yet: no manual identifier or
  // local cancellation until the provider is asked.
  prescription_awaiting_reconciliation: {
    status: 409,
    i18nKey: 'errors.prescription_awaiting_reconciliation',
  },
  // An attempt to send the prescription is in progress: it can be cancelled or registered by hand
  // once that attempt ends, not while the provider is being asked.
  prescription_attempt_in_progress: {
    status: 409,
    i18nKey: 'errors.prescription_attempt_in_progress',
  },
  // A request to send the prescription may still be running at the provider (it was sent and its
  // outcome is not known): it can be cancelled or registered by hand once the pin ends, in minutes.
  prescription_provider_in_flight: {
    status: 409,
    i18nKey: 'errors.prescription_provider_in_flight',
  },
  // Only a prescription the provider has not confirmed can be retried or registered by hand.
  prescription_not_pending: { status: 409, i18nKey: 'errors.prescription_not_pending' },
  // The identifier belongs to another prescription of the organization.
  prescription_identifier_taken: {
    status: 409,
    i18nKey: 'errors.prescription_identifier_taken',
  },
  // The document exists once the provider confirmed the prescription and it was rendered.
  prescription_document_not_ready: {
    status: 409,
    i18nKey: 'errors.prescription_document_not_ready',
  },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

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
