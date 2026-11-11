import type { ChecklistItemId } from '@consultorio/contracts';

import type { WizardScreen } from './wizard-model.js';

export interface ChecklistLink {
  to: string;
  /** A step of the wizard, for the items the wizard completes. */
  step?: WizardScreen;
}

/**
 * The screen that completes each checklist item (tenant-onboarding, "First-run checklist": every
 * item links to the screen that completes it). Configuration that has a screen of its own goes
 * there; the rest goes to the step of the wizard that does it.
 *
 * `/calendar` is the scheduling agenda (the route of the scheduling UI); a test in the router suite
 * keeps these addresses real.
 */
export const CHECKLIST_LINKS: Record<ChecklistItemId, ChecklistLink> = {
  location: { to: '/settings/locations' },
  hours: { to: '/onboarding', step: 'hours' },
  appointment_type: { to: '/onboarding', step: 'appointment_types' },
  first_patient: { to: '/patients/new' },
  first_appointment: { to: '/calendar' },
  matricula: { to: '/onboarding', step: 'profile' },
  invite_staff: { to: '/onboarding', step: 'team' },
  branding: { to: '/settings/branding' },
};
