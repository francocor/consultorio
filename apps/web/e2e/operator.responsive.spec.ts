import { expect, test } from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import { axeViolations, horizontalOverflow, urlOf } from './support/stack.js';

test('the console sign-in fits the screen and is accessible', async ({ page }) => {
  await page.goto(urlOf('platform', '/'));

  await expect(
    page.getByRole('heading', { level: 1, name: 'Consola de la plataforma' }),
  ).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test.describe('signed in', () => {
  test.use({ storageState: OPERATOR_STATE });

  test('the organizations fit the screen and are accessible', async ({ page }) => {
    await page.goto(urlOf('platform', '/'));

    await expect(page.getByRole('table', { name: 'Organizaciones' })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
  });

  test('the create dialog is accessible', async ({ page }) => {
    await page.goto(urlOf('platform', '/'));
    await page.getByRole('button', { name: 'Crear una organización' }).click();

    await expect(page.getByRole('dialog', { name: 'Crear una organización' })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
});
