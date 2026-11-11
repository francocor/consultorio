import type { Permission } from '@consultorio/contracts';

import type { Tx } from '../../../platform/db/tenant-context.js';

import { isWizardCompleted } from './store.js';

export interface WizardGate {
  /**
   * True when the person runs the setup wizard (holds the permission) and their organization has
   * not finished it. The sign-in answer (`/auth/me`) carries it, so the app can take the owner to
   * the wizard on the first sign-in and again, until it is finished, on every sign-in after.
   */
  needsWizard: (tx: Tx, permissions: readonly Permission[]) => Promise<boolean>;
}

export function createWizardGate(): WizardGate {
  return {
    async needsWizard(tx, permissions) {
      if (!permissions.includes('onboarding.manage')) return false;
      return !(await isWizardCompleted(tx));
    },
  };
}
