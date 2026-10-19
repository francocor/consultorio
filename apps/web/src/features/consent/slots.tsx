import { lazySlot } from '../../app/lazy-slot.js';
import type { SlotContribution, SlotProps } from '../../app/registry.js';

// The tab loads when a patient record opens it: the sign-in page does not pay for it.
const PatientConsentsTab = lazySlot<SlotProps['patient-detail-tab']>(() =>
  import('./PatientConsentsTab.js').then((module) => ({ default: module.PatientConsentsTab })),
);

/**
 * What consent mounts inside screens that other features own: the consents of a patient as a tab
 * of the patient record, for whoever asks for consents (reception, professionals) or runs the
 * templates (administration, who see states under a neutral label, never a title or a text).
 */
const patientTab: SlotContribution<'patient-detail-tab'> = {
  slot: 'patient-detail-tab',
  id: 'consent.list',
  order: 80,
  anyOf: ['consent.request', 'consent.template.manage', 'clinical.consent.read'],
  labelKey: 'consent:patientTab',
  Component: PatientConsentsTab,
};

const slots: readonly SlotContribution<'patient-detail-tab'>[] = [patientTab];

export default slots;
