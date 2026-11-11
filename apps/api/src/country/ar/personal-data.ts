import type { PersonalDataRules } from '../../platform/country/country-pack.js';

/**
 * Ley 25.326 (personal data) and Ley 26.529 (patient rights) as data the core can ask for. The
 * consent text lives in the locale files under `textKey`; `version` changes whenever the text does,
 * so each recorded consent stays tied to the exact text the patient accepted.
 */
export const AR_PERSONAL_DATA: PersonalDataRules = {
  dataProcessingConsent: { required: true, textKey: 'consent.data_processing.ar', version: '1' },
  rights: ['access', 'rectification', 'update', 'suppression', 'formal_copy'],
  // Appointment reminders and confirmations are service communications: no consent is needed.
  serviceMessages: ['appointment_reminder', 'appointment_confirmation'],
  // WhatsApp and waitlist offers need an explicit opt-in.
  explicitOptIn: ['whatsapp', 'waitlist_offer'],
  internationalTransferDisclosureKey: 'consent.international_transfer.ar',
};
