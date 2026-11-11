import { onboardingState } from '../../../db/schema/onboarding.js';
import { termsAcceptance } from '../../../db/schema/signup.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by onboarding: where the organization stood in its guided first
 * run (the steps done or skipped, what the owner answered, when the wizard was finished and the
 * checklist dismissed). It holds no patient data and no free text. `progress` is `null` when the
 * organization never opened the wizard.
 *
 * It also carries the record of the terms the owner accepted at signup (which version of each
 * document, and when), which the organization is entitled to keep: only versions and instants, no
 * text and no identity beyond the id of the account. An organization the operator created has none.
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
  const accepted = await tx
    .select({
      userId: termsAcceptance.userId,
      termsVersion: termsAcceptance.termsVersion,
      dataProcessingVersion: termsAcceptance.dataProcessingVersion,
      acceptedAt: termsAcceptance.acceptedAt,
    })
    .from(termsAcceptance)
    .orderBy(termsAcceptance.acceptedAt);
  return {
    progress: row ?? null,
    termsAcceptances: accepted.map((entry) => ({
      userId: entry.userId,
      termsVersion: entry.termsVersion,
      dataProcessingVersion: entry.dataProcessingVersion,
      acceptedAt: entry.acceptedAt.toISOString(),
    })),
  };
};
