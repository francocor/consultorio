import { expect, test } from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import { axeViolations, horizontalOverflow, urlOf } from './support/stack.js';

test.use({ storageState: OPERATOR_STATE, reducedMotion: 'reduce' });

test('the catalog fits a phone and is accessible', async ({ page }) => {
  await page.goto(urlOf('platform', '/'));
  await page.getByRole('tab', { name: 'Feriados' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Feriados del país' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});
