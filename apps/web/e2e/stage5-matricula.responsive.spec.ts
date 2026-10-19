import { expect, test } from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import { axeViolations, horizontalOverflow, urlOf } from './support/stack.js';

test.use({ storageState: OPERATOR_STATE, reducedMotion: 'reduce' });

test('the matricula queue fits a phone and is accessible', async ({ page }) => {
  await page.goto(urlOf('platform', '/'));
  await page.getByRole('tab', { name: 'Matrículas' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Verificación de matrículas' }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Matrículas pendientes de verificación' }),
  ).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('the verification dialog fits a phone and is accessible', async ({ page }) => {
  await page.goto(urlOf('platform', '/'));
  await page.getByRole('tab', { name: 'Matrículas' }).click();
  await page
    .getByRole('button', { name: /^Verificar matrícula de / })
    .first()
    .click();

  const dialog = page.getByRole('dialog', { name: 'Verificar matrícula' });
  await expect(dialog).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});
