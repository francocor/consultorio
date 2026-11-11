import { expect, test } from '@playwright/test';

import { axeViolations, horizontalOverflow, openAs } from './support/stack.js';

/** Today, the front desk and the worklist at 360 px and at 1280 px: layout and WCAG 2.2 AA. */
test('Hoy (a professional) fits the screen and is accessible', async ({ page }) => {
  await openAs(page, 'cardiology', '/today');

  await expect(page.getByRole('heading', { level: 1, name: 'Hoy' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('Llegadas (reception) fits the screen and is accessible', async ({ page }) => {
  await openAs(page, 'reception', '/check-in');

  await expect(page.getByRole('heading', { level: 1, name: 'Llegadas' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('Pendientes (reception) fits the screen and is accessible', async ({ page }) => {
  await openAs(page, 'reception', '/worklist');

  await expect(page.getByRole('heading', { level: 1, name: 'Pendientes' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Identidad por confirmar' }).first(),
  ).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});
