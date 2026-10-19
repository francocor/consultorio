import { lazySlot } from '../../app/lazy-slot.js';
import type { SlotContribution, SlotProps } from '../../app/registry.js';

// The tab and the warning load when a patient record or a drawer opens them: the sign-in page does not pay for them.
const PatientConsentsTab = lazySlot<SlotProps['patient-detail-tab']>(() =>
  import('./PatientConsentsTab.js').then((module) => ({ default: module.PatientConsentsTab })),
);

const AppointmentConsentWarning = lazySlot<SlotProps['appointment-drawer']>(() =>
  import('./components/AppointmentConsentWarning.js').then((module) => ({
    default: module.AppointmentConsentWarning,
  })),
);

/**
 * What consent mounts inside screens that other features own: the consents of a patient as a tab
 * of the patient record, for whoever asks for consents (reception, professionals) or runs the
 * templates (administration, who see states under a neutral label, never a title or a text), and
 * the warning in the appointment drawer when the type of the appointment requires a consent the
 * patient does not hold.
 */
const patientTab: SlotContribution<'patient-detail-tab'> = {
  slot: 'patient-detail-tab',
  id: 'consent.list',
  order: 80,
  anyOf: ['consent.request', 'consent.template.manage', 'clinical.consent.read'],
  labelKey: 'consent:patientTab',
  Component: PatientConsentsTab,
};

const warning: SlotContribution<'appointment-drawer'> = {
  slot: 'appointment-drawer',
  id: 'consent.warning',
  // Right under the data of the appointment, before the pieces that act on it.
  order: 20,
  anyOf: ['scheduling.read'],
  Component: AppointmentConsentWarning,
};

const slots: readonly (
  SlotContribution<'patient-detail-tab'> | SlotContribution<'appointment-drawer'>
)[] = [patientTab, warning];

export default slots;
