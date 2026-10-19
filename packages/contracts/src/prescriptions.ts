export { PRESCRIPTION_ERRORS, PRESCRIPTION_AUDIT_ACTIONS } from './prescriptions-catalog.js';

/**
 * Contracts of the prescriptions module (e-prescription under Ley 27.553). This file holds what is
 * certain from the design and the spec; the e-Rx track (S5.04, S5.05) adds its request and response
 * shapes below, in this file only. The provider port is `PrescriptionProvider` in `ports.ts`.
 */

/**
 * Where a prescription stands. `pending_submission` is a prescription the provider has not
 * confirmed (an outage): it is never shown as a valid prescription.
 */
export const PRESCRIPTION_STATUSES = [
  'draft',
  'pending_submission',
  'issued',
  'cancelled',
  'dispensed',
  'expired',
] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

/**
 * The modes the local e-prescription provider (a simulator) can be put in from the provider
 * console: working, down, or having issued the prescription and then lost the answer.
 */
export const ERX_SIMULATOR_MODES = ['ok', 'down', 'timeout_after_issue'] as const;
export type ErxSimulatorMode = (typeof ERX_SIMULATOR_MODES)[number];
