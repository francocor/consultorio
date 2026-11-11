import {
  WIZARD_STEPS,
  type OnboardingStateDto,
  type WizardStep,
  type WizardStepDto,
} from '@consultorio/contracts';

/** A screen of the wizard: a step of the API, or the review that closes it (a screen only). */
export type WizardScreen = WizardStep | 'review';

/** Steps the API may list that this build has no screen for. They are left out, not shown broken. */
const WITHOUT_SCREEN: readonly WizardStep[] = ['billing'];

export function isWizardScreen(value: string | undefined): value is WizardScreen {
  return value === 'review' || WIZARD_STEPS.some((step) => step === value);
}

/** The screens of this deployment in order: its steps, then the review. */
export function screensOf(state: OnboardingStateDto): WizardScreen[] {
  const steps = state.wizard.steps
    .map((step) => step.id)
    .filter((id) => !WITHOUT_SCREEN.includes(id));
  return [...steps, 'review'];
}

export function stepOf(state: OnboardingStateDto, id: WizardStep): WizardStepDto | undefined {
  return state.wizard.steps.find((step) => step.id === id);
}

/** The screen after this one, or `null` after the review. */
export function screenAfter(
  screens: readonly WizardScreen[],
  current: WizardScreen,
): WizardScreen | null {
  const index = screens.indexOf(current);
  return index === -1 ? null : (screens[index + 1] ?? null);
}

export function screenBefore(
  screens: readonly WizardScreen[],
  current: WizardScreen,
): WizardScreen | null {
  const index = screens.indexOf(current);
  return index > 0 ? (screens[index - 1] ?? null) : null;
}

/**
 * Where the wizard opens: the screen named in the address if this deployment has it, otherwise
 * where the saved progress resumes. An organization that finished opens on the review.
 */
export function openingScreen(
  state: OnboardingStateDto,
  requested: WizardScreen | undefined,
): WizardScreen {
  const screens = screensOf(state);
  if (requested && screens.includes(requested)) return requested;
  if (state.wizard.completed) return 'review';
  const saved = state.wizard.currentStep;
  if (saved && screens.includes(saved)) return saved;
  return screens[0] ?? 'review';
}

/** True before the person has done or chosen anything: the moment to offer the quick setup. */
export function isFreshStart(state: OnboardingStateDto): boolean {
  const { wizard } = state;
  return (
    !wizard.completed &&
    wizard.answers.path === undefined &&
    wizard.answers.isProfessional === undefined &&
    wizard.steps.every((step) => step.status === 'pending')
  );
}
