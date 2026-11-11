import { expect, test } from '@playwright/test';

import { axeViolations, horizontalOverflow, openAs } from './support/stack.js';

/** Identity, security and audit on a phone and on a desktop: layout and WCAG 2.2 AA. */
test('Settings > Identidad visual fits the screen and is accessible', async ({ page }) => {
  await openAs(page, 'owner', '/settings/branding');

  await expect(page.getByLabel('Nombre de la organización')).toBeVisible();
  await expect(page.getByTestId('branding-preview')).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('Settings > Identidad visual with a color that needs adjusting is accessible', async ({
  page,
}) => {
  await openAs(page, 'owner', '/settings/branding');
  await page.getByLabel('Color principal').fill('#ffeb3b');

  await expect(page.getByText(/no tiene contraste suficiente/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test('Settings > Seguridad fits the screen and is accessible', async ({ page }) => {
  await openAs(page, 'owner', '/settings/security');

  await expect(page.getByRole('switch', { name: /Compartir plantillas clínicas/ })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('the audit viewer fits the screen and is accessible', async ({ page }) => {
  await openAs(page, 'owner', '/audit');

  await expect(page.getByRole('table', { name: 'Eventos de auditoría' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('the access report of a patient is accessible', async ({ page }) => {
  await openAs(page, 'owner', '/patients');
  await page.getByRole('link', { name: /Gómez, Valentina/ }).click();
  await page.getByRole('tab', { name: 'Accesos' }).click();

  await expect(page.getByRole('heading', { name: 'Accesos a esta ficha' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});
