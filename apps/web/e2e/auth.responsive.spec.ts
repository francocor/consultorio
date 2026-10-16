import { expect, test } from '@playwright/test';

import { axeViolations, horizontalOverflow, openAs, urlOf } from './support/stack.js';

/** Every public auth screen and the security page: no horizontal scroll and no axe violations. */
const PUBLIC_SCREENS: { name: string; path: string; heading: string }[] = [
  { name: 'sign in', path: '/login', heading: 'Iniciar sesión' },
  { name: 'forgot password', path: '/forgot-password', heading: 'Recuperar la contraseña' },
  {
    name: 'reset password',
    path: '/reset-password?token=prueba',
    heading: 'Crear una contraseña nueva',
  },
  {
    name: 'accept invitation',
    path: '/accept-invitation?token=prueba',
    heading: 'Active su cuenta',
  },
  { name: 'reset without a token', path: '/reset-password', heading: 'Crear una contraseña nueva' },
];

for (const screen of PUBLIC_SCREENS) {
  test(`${screen.name} fits the screen and is accessible`, async ({ page }) => {
    await page.goto(urlOf('aillu', screen.path));

    await expect(page.getByRole('heading', { level: 1, name: screen.heading })).toBeVisible();
    await expect(page.getByText('Centro Médico Aillu').first()).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('the sign-in screen already wears the organization theme at DOMContentLoaded', async ({
  page,
}) => {
  await page.goto(urlOf('norte', '/login'));
  // First visit: the first paint waits for the boot payload, then the variables are there.
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();

  const primary = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--primary'),
  );
  expect(primary).toBe('#1e40af');

  // Second visit: the cached theme is applied synchronously, before any script of the app runs.
  const early = await page.evaluate(async () => {
    const response = await fetch(window.location.href);
    return response.ok;
  });
  expect(early).toBe(true);
  await page.reload({ waitUntil: 'commit' });
  const atCommit = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--primary'),
  );
  expect(atCommit).toBe('#1e40af');
});

test('the security page lists the open sessions and fits a phone', async ({ page }) => {
  await openAs(page, 'reception', '/account/security');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Seguridad de la cuenta' }),
  ).toBeVisible();
  await expect(page.getByText('Esta sesión', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sesiones abiertas' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});
