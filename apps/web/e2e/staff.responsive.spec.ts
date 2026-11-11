import { expect, test } from '@playwright/test';

import { axeViolations, horizontalOverflow, openAs } from './support/stack.js';

/** The team and Settings > Sedes on a phone and on a desktop: layout and accessibility. */
test('the team page fits the screen and is accessible', async ({ page }) => {
  await openAs(page, 'owner', '/staff');

  await expect(page.getByRole('heading', { level: 1, name: 'Equipo' })).toBeVisible();
  await expect(page.getByText('Dra. Lucía Paz Ferrer')).toBeVisible();
  await expect(page.getByText('Sin verificar').first()).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

for (const tab of ['Rol', 'Perfil profesional', 'Permisos', 'Sedes y horarios']) {
  test(`the member sheet, tab "${tab}", is accessible and does not overflow`, async ({ page }) => {
    await openAs(page, 'owner', '/staff');
    await page.getByRole('button', { name: 'Gestionar a Dra. Lucía Paz Ferrer' }).click();
    const sheet = page.getByRole('dialog', { name: 'Dra. Lucía Paz Ferrer' });
    await sheet.getByRole('tab', { name: tab }).click();

    if (tab === 'Perfil profesional') {
      await expect(sheet.getByLabel('Nombre completo')).toBeVisible();
    }
    if (tab === 'Permisos') {
      await expect(sheet.getByRole('switch', { name: /Operar la caja/ })).toBeVisible();
    }
    if (tab === 'Sedes y horarios') {
      await expect(sheet.getByRole('group', { name: /Horarios en Sede Central/ })).toBeVisible();
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('the invitation dialog is accessible', async ({ page }) => {
  await openAs(page, 'owner', '/staff');
  await page.getByRole('button', { name: 'Invitar a una persona' }).click();
  await expect(page.getByRole('dialog', { name: 'Invitar a una persona' })).toBeVisible();

  expect(await axeViolations(page)).toEqual([]);
});

test('Settings > Sedes lists the locations with their time zone', async ({ page }) => {
  await openAs(page, 'owner', '/settings');

  await expect(page).toHaveURL(/\/settings\/locations$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Configuración' })).toBeVisible();
  await expect(page.getByText('Sede Central')).toBeVisible();
  await expect(page.getByText('Sucursal Córdoba')).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});
