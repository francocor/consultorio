import { lazySlot } from '../../app/lazy-slot.js';
import type { SlotContribution, SlotProps } from '../../app/registry.js';

// The tab loads when a patient record opens it: the sign-in page does not pay for it.
const PatientPortalTab = lazySlot<SlotProps['patient-detail-tab']>(() =>
  import('./PatientPortalTab.js').then((module) => ({ default: module.PatientPortalTab })),
);

/**
 * What the portal mounts inside screens that other features own: the portal accounts of a patient
 * as a tab of the patient record, for whoever runs the portal accounts (reception, the
 * administration, the owner).
 */
const patientTab: SlotContribution<'patient-detail-tab'> = {
  slot: 'patient-detail-tab',
  id: 'portal.invitation',
  order: 90,
  anyOf: ['portal.manage'],
  labelKey: 'portal:patientTab',
  Component: PatientPortalTab,
};

const slots: readonly SlotContribution<'patient-detail-tab'>[] = [patientTab];

export default slots;
