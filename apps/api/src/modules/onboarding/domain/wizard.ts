import {
  WIZARD_STEPS,
  isRequiredStep,
  type OnboardingStateDto,
  type WizardAnswers,
  type WizardPrerequisite,
  type WizardStep,
  type WizardStepStatus,
} from '@consultorio/contracts';

import { STEP_CAPABILITY, type Capabilities } from './capabilities.js';
import type { OnboardingFacts } from './facts.js';

/** What is saved for the organization, as the service reads it from `onboarding_state`. */
export interface WizardRecord {
  /** A step missing from the map is pending. */
  progress: Readonly<Partial<Record<WizardStep, 'done' | 'skipped'>>>;
  answers: WizardAnswers;
  currentStep: WizardStep | null;
  completedAt: Date | null;
}

type WizardView = OnboardingStateDto['wizard'];

/** The steps this deployment has, in the order a person meets them. */
export function stepsFor(capabilities: Capabilities): WizardStep[] {
  return WIZARD_STEPS.filter((step) => {
    const needed = STEP_CAPABILITY[step];
    return needed === null || capabilities.has(needed);
  });
}

/** Only the steps that are not needed to book a first appointment can be skipped. */
export function canSkip(step: WizardStep): boolean {
  return !isRequiredStep(step);
}

/**
 * What stops the wizard from being finished: a location, a professional with working hours and an
 * appointment type (tenant-onboarding, "Required step"). The scheduling pieces are asked for only
 * when the deployment has scheduling.
 */
export function missingPrerequisites(
  facts: OnboardingFacts,
  capabilities: Capabilities,
): WizardPrerequisite[] {
  const missing: WizardPrerequisite[] = [];
  if (facts.locations === 0) missing.push('location');
  if (facts.professionals === 0) missing.push('professional');
  if (capabilities.has('scheduling')) {
    if (facts.professionals > 0 && facts.professionalsWithHours === 0) missing.push('hours');
    if (facts.appointmentTypes === 0) missing.push('appointment_type');
  }
  return missing;
}

/** A step whose data already exists is done, whatever the person clicked. */
function doneFromData(step: WizardStep, record: WizardRecord, facts: OnboardingFacts): boolean {
  switch (step) {
    case 'profile':
      return record.answers.isProfessional !== undefined;
    case 'location':
      return facts.locations > 0;
    case 'hours':
      return facts.professionalsWithHours > 0;
    case 'appointment_types':
      return facts.appointmentTypes > 0;
    case 'team':
      return facts.staffInvited;
    case 'branding':
      return facts.brandingConfigured;
    case 'billing':
      return false;
  }
}

function statusOf(
  step: WizardStep,
  record: WizardRecord,
  facts: OnboardingFacts,
): WizardStepStatus {
  if (doneFromData(step, record, facts)) return 'done';
  // A required step is done only by its data: the client cannot declare it done or skip it.
  if (!canSkip(step)) return 'pending';
  return record.progress[step] ?? 'pending';
}

/** The wizard as the owner sees it now: steps, where it resumes and what is still missing. */
export function buildWizard(
  record: WizardRecord,
  facts: OnboardingFacts,
  capabilities: Capabilities,
): WizardView {
  const available = stepsFor(capabilities);
  const steps = available.map((id) => ({
    id,
    status: statusOf(id, record, facts),
    required: isRequiredStep(id),
  }));

  const completed = record.completedAt !== null;
  let currentStep: WizardStep | null = null;
  if (!completed) {
    const saved = record.currentStep;
    currentStep =
      saved !== null && available.includes(saved)
        ? saved
        : (steps.find((step) => step.status === 'pending')?.id ?? available.at(-1) ?? null);
  }

  return {
    completed,
    completedAt: record.completedAt?.toISOString() ?? null,
    currentStep,
    answers: record.answers,
    steps,
    missing: missingPrerequisites(facts, capabilities),
  };
}
