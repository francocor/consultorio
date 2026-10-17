import { expect, test } from '@playwright/test';

import {
  axeViolations,
  horizontalOverflow,
  openAs,
  urlOf,
  type AccountKey,
} from './support/stack.js';

/**
 * The shell for each role, on a phone (360 px: bottom bar) and on a desktop (1280 px: sidebar).
 * Read-only: it signs in and looks.
 */
const ROLES: { account: AccountKey; sees: string[]; hidden: string[] }[] = [
  {
    account: 'owner',
    sees: ['Inicio', 'Pacientes', 'Equipo', 'Auditoría', 'Configuración'],
    hidden: ['Recetas', 'Borradores', 'Caja'],
  },
  {
    account: 'admin',
    sees: ['Inicio', 'Pacientes', 'Equipo', 'Auditoría', 'Configuración'],
    hidden: ['Recetas', 'Borradores'],
  },
  {
    account: 'reception',
    sees: ['Inicio', 'Pacientes'],
    hidden: ['Equipo', 'Auditoría', 'Configuración', 'Recetas'],
  },
  {
    account: 'cardiology',
    sees: ['Inicio', 'Pacientes'],
    hidden: ['Equipo', 'Auditoría', 'Configuración'],
  },
];

for (const role of ROLES) {
  test(`${role.account}: navigation matches the role and the page is accessible`, async ({
    page,
  }) => {
    await openAs(page, role.account);
    const phone = (page.viewportSize()?.width ?? 1280) < 768;
    const navigation = page.getByRole('navigation', {
      name: phone ? 'Navegación inferior' : 'Navegación principal',
    });

    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Bienvenido a Centro Médico Aillu',
    );
    for (const label of role.sees) {
      await expect(navigation.getByRole('link', { name: label })).toBeVisible();
    }
    for (const label of role.hidden) {
      await expect(navigation.getByRole('link', { name: label })).toHaveCount(0);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('a direct address the role cannot use shows "no access" and no data', async ({ page }) => {
  await openAs(page, 'reception', '/staff');

  await expect(page.getByRole('heading', { name: 'No tiene acceso a esta sección' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('an unknown address keeps the shell around a calm message', async ({ page }) => {
  await openAs(page, 'owner', '/no-existe');

  await expect(page.getByRole('heading', { name: 'No encontramos esta página' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test('the sign-in screen redirects a visitor and remembers where they were going', async ({
  page,
}) => {
  await page.goto(urlOf('aillu', '/patients'));

  await expect(page).toHaveURL(/\/login\?redirect=%2Fpatients/);
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
});
