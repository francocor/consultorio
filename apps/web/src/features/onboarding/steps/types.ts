import type { OnboardingStateDto } from '@consultorio/contracts';

import type { WizardScreen } from '../wizard-model.js';

/** What the wizard gives every step. */
export interface StepProps {
  state: OnboardingStateDto;
  /**
   * Saves the progress and opens the next screen. An optional step passes `'done'` to record that
   * it was completed; a required step is finished by its data, so it passes nothing.
   */
  next: (status?: 'done') => Promise<void>;
  /** Present only on optional steps. */
  skip?: (() => Promise<void>) | undefined;
  /** Absent on the first screen. */
  back?: (() => void) | undefined;
  goTo: (screen: WizardScreen) => void;
}
