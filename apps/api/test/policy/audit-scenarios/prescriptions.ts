import type { PRESCRIPTION_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of prescriptions are proven. Track A3 (e-Rx) replaces each `pending`
 * with the integration test that names the action, in this file only.
 */
export const PRESCRIPTION_SCENARIOS: Record<
  (typeof PRESCRIPTION_AUDIT_ACTIONS)[number],
  AuditScenario
> = {
  'prescription.issued': { pending: 'S5.04 (task 5.17): issue a prescription' },
  'prescription.cancelled': { pending: 'S5.04 (task 5.19): cancel through the provider' },
  'prescription.read': { pending: 'S5.04 (task 5.20): every read of a prescription' },
  'prescription.downloaded': { pending: 'S5.09 (task 5.35): the patient downloads the document' },
  'prescription.failed': { pending: 'S5.04 (task 5.20): a failure at the provider' },
  'prescription.registered_manually': { pending: 'S5.04 (task 5.19): manual registration' },
};
