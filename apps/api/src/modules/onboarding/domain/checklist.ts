import {
  CHECKLIST_ITEMS,
  type ChecklistItemDto,
  type ChecklistItemId,
} from '@consultorio/contracts';

import { ITEM_CAPABILITY, type Capabilities } from './capabilities.js';
import type { OnboardingFacts } from './facts.js';

const DONE: Record<ChecklistItemId, (facts: OnboardingFacts) => boolean> = {
  location: (facts) => facts.locations > 0,
  hours: (facts) => facts.professionalsWithHours > 0,
  appointment_type: (facts) => facts.appointmentTypes > 0,
  first_patient: (facts) => facts.patients > 0,
  first_appointment: (facts) => facts.appointments > 0,
  matricula: (facts) => facts.professionalsWithMatricula > 0,
  invite_staff: (facts) => facts.staffInvited,
  branding: (facts) => facts.brandingConfigured,
};

/**
 * The first-run checklist (tenant-onboarding, "First-run checklist"): every item the deployment
 * has, each marked done from the organization's real data.
 */
export function buildChecklist(
  facts: OnboardingFacts,
  capabilities: Capabilities,
): ChecklistItemDto[] {
  return CHECKLIST_ITEMS.filter((id) => {
    const needed = ITEM_CAPABILITY[id];
    return needed === null || capabilities.has(needed);
  }).map((id) => ({ id, done: DONE[id](facts) }));
}
