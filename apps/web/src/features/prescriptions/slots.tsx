import { lazySlot } from '../../app/lazy-slot.js';
import type { SlotContribution, SlotProps } from '../../app/registry.js';

// The tab loads when a patient record opens it: the sign-in page does not pay for it.
const PatientPrescriptionsTab = lazySlot<SlotProps['patient-detail-tab']>(() =>
  import('./PatientPrescriptionsTab.js').then((module) => ({
    default: module.PatientPrescriptionsTab,
  })),
);

/**
 * What prescriptions mounts inside screens that other features own: the prescriptions of a patient
 * as a tab of the patient record, for whoever may read prescriptions (professionals only).
 */
const patientTab: SlotContribution<'patient-detail-tab'> = {
  slot: 'patient-detail-tab',
  id: 'prescriptions.list',
  order: 70,
  anyOf: ['clinical.prescription.read'],
  labelKey: 'prescriptions:patientTab',
  Component: PatientPrescriptionsTab,
};

const slots: readonly SlotContribution<'patient-detail-tab'>[] = [patientTab];

export default slots;
