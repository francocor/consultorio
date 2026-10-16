import { expect, test as setup } from '@playwright/test';

import { OPERATOR_STATE, signInOperator } from './support/operator.js';

/** One real sign-in of the operator, through the form, shared by every console spec. */
setup('the operator signs in with password and code', async ({ page }) => {
  await signInOperator(page);

  await expect(page.getByRole('heading', { level: 1, name: 'Organizaciones' })).toBeVisible();
  await page.context().storageState({ path: OPERATOR_STATE });
});
