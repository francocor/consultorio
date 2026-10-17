import { expect, test } from '@playwright/test';

import { openAs, urlOf } from './support/stack.js';

test('the owner reads the audit trail, filters it and exports it', async ({ page }) => {
  await openAs(page, 'owner', '/audit');

  await expect(page.getByRole('heading', { level: 1, name: 'Auditoría' })).toBeVisible();
  const table = page.getByRole('table', { name: 'Eventos de auditoría' });
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  // Signing in just now is the first thing the trail should show.
  await expect(table.getByText('Ingreso correcto').first()).toBeVisible();

  await page.getByLabel('Acción').selectOption({ label: 'Ingreso correcto' });
  await expect(table.getByText('Ingreso correcto').first()).toBeVisible();
  await expect(table.getByText('Cierre de sesión')).toHaveCount(0);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.csv$/);
  await expect(page.getByText('Exportación lista.')).toBeVisible();
});

test('a patient record shows who accessed it', async ({ page }) => {
  await openAs(page, 'owner', '/patients');
  await page.getByRole('link', { name: /Gómez, Valentina/ }).click();
  await page.getByRole('tab', { name: 'Accesos' }).click();

  await expect(page.getByRole('heading', { name: 'Accesos a esta ficha' })).toBeVisible();
  await expect(page.getByText('Consulta de la ficha').first()).toBeVisible();
});

test('reception cannot read the audit trail', async ({ page }) => {
  await openAs(page, 'reception', '/audit');

  await expect(page.getByRole('heading', { name: 'No tiene acceso a esta sección' })).toBeVisible();
  await page.goto(urlOf('aillu', '/'));
  await expect(page.getByRole('link', { name: 'Auditoría' })).toHaveCount(0);
});
