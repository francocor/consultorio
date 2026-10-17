import type { ChecklistItemId, WizardStep } from '@consultorio/contracts';

/**
 * Parts of the product the first run can depend on. A deployment that lacks one never shows the
 * wizard steps and checklist items that belong to it (tenant-onboarding, "Step for an unavailable
 * capability"). Stage 2 has patients, scheduling and branding; billing arrives with Stage 4.
 */
export type Capability = 'patients' | 'scheduling' | 'branding' | 'billing';

export type Capabilities = ReadonlySet<Capability>;

export const DEFAULT_CAPABILITIES: Capabilities = new Set<Capability>([
  'patients',
  'scheduling',
  'branding',
]);

/** The capability a wizard step needs, or `null` when the step is always there. */
export const STEP_CAPABILITY: Record<WizardStep, Capability | null> = {
  profile: null,
  location: null,
  hours: 'scheduling',
  appointment_types: 'scheduling',
  team: null,
  branding: 'branding',
  billing: 'billing',
};

/** The capability a checklist item needs, or `null` when the item is always there. */
export const ITEM_CAPABILITY: Record<ChecklistItemId, Capability | null> = {
  location: null,
  hours: 'scheduling',
  appointment_type: 'scheduling',
  first_patient: 'patients',
  first_appointment: 'scheduling',
  matricula: null,
  invite_staff: null,
  branding: 'branding',
};
