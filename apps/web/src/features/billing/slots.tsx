import type { SlotContribution } from '../../app/registry.js';

import { ChargePanel } from './components/ChargePanel.js';
import { PatientChargesTab } from './components/PatientChargesTab.js';

/**
 * What billing mounts inside screens that other features own: the charge of the appointment in the
 * appointment drawer (from check-in on), and the charges of a patient as a tab of the patient record.
 */
const drawer: SlotContribution<'appointment-drawer'> = {
  slot: 'appointment-drawer',
  id: 'billing.charge',
  order: 60,
  anyOf: ['payments.read'],
  Component: ChargePanel,
};

const patientTab: SlotContribution<'patient-detail-tab'> = {
  slot: 'patient-detail-tab',
  id: 'billing.charges',
  order: 60,
  anyOf: ['payments.read'],
  labelKey: 'billing:patientTab',
  Component: PatientChargesTab,
};

const slots: readonly (
  SlotContribution<'appointment-drawer'> | SlotContribution<'patient-detail-tab'>
)[] = [drawer, patientTab];

export default slots;
