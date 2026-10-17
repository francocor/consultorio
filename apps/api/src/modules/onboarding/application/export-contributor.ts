import { onboardingState } from '../../../db/schema/onboarding.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by onboarding: where the organization stood in its guided first
 * run (the steps done or skipped, what the owner answered, when the wizard was finished and the
 * checklist dismissed). It holds no patient data and no free text. `progress` is `null` when the
 * organization never opened the wizard.
 */
export const exportOnboarding: ExportContributor = async ({ tx }) => {
  const [row] = await tx
    .select({
      stepProgress: onboardingState.stepProgress,
      currentStep: onboardingState.currentStep,
      answers: onboardingState.answers,
      wizardCompletedAt: onboardingState.wizardCompletedAt,
      checklistDismissedAt: onboardingState.checklistDismissedAt,
    })
    .from(onboardingState);
  return { progress: row ?? null };
};
