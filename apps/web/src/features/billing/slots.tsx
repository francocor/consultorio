import { lazySlot } from '../../app/lazy-slot.js';
import type { SlotContribution, SlotProps } from '../../app/registry.js';

// The panels load when a drawer or a patient record opens them: the sign-in page does not pay for them.
const ChargePanel = lazySlot<SlotProps['appointment-drawer']>(() =>
  import('./components/ChargePanel.js').then((module) => ({ default: module.ChargePanel })),
);

const PatientChargesTab = lazySlot<SlotProps['patient-detail-tab']>(() =>
  import('./components/PatientChargesTab.js').then((module) => ({
    default: module.PatientChargesTab,
  })),
);

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
