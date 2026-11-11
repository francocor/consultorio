import { expect, test, type Page } from '@playwright/test';

import { axeViolations, openAs, urlOf, type AccountKey } from './support/stack.js';

/**
 * Who sees which scheduling screen (SHL-01, SCH-11). The navigation is a convenience; each row
 * also tries the address, because the API and the route guard are the protection.
 */
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Navegación principal' });

interface Row {
  account: AccountKey;
  sees: string[];
  hidden: string[];
}

const MATRIX: Row[] = [
  { account: 'reception', sees: ['Agenda', 'Llegadas', 'Pendientes'], hidden: ['Hoy'] },
  { account: 'cardiology', sees: ['Hoy', 'Agenda'], hidden: ['Llegadas', 'Pendientes'] },
  { account: 'owner', sees: ['Agenda', 'Pendientes'], hidden: ['Hoy', 'Llegadas'] },
];

for (const row of MATRIX) {
  test(`${row.account} sees ${row.sees.join(', ')} and not ${row.hidden.join(', ')}`, async ({
    page,
  }) => {
    await openAs(page, row.account, '/');
    const nav = navigation(page);
    await expect(nav.getByRole('link', { name: 'Inicio' })).toBeVisible();

    for (const name of row.sees) {
      await expect(nav.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    for (const name of row.hidden) {
      await expect(nav.getByRole('link', { name: new RegExp(`^${name}`) })).toHaveCount(0);
    }
  });
}

test('the professional works from Hoy and cannot open the front desk worklist', async ({
  page,
}) => {
  await openAs(page, 'cardiology', '/today');
  await expect(page.getByRole('heading', { level: 1, name: 'Hoy' })).toBeVisible();
  // The demo agenda follows "now": the day either has patients or says it is empty.
  await expect(
    page
      .getByRole('region', { name: /Siguiente paciente|Por llegar|En sala|En consulta|Terminados/ })
      .first()
      .or(page.getByText('No hay turnos para hoy.')),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.goto(urlOf('aillu', '/worklist'));
  await expect(page.getByRole('heading', { name: 'No tiene acceso a esta sección' })).toBeVisible();
});

test('reception works from Llegadas and Pendientes, and Hoy is not for them', async ({ page }) => {
  await openAs(page, 'reception', '/check-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Llegadas' })).toBeVisible();
  await expect(
    page.getByRole('searchbox', { name: 'Buscar entre los turnos de hoy' }),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.goto(urlOf('aillu', '/worklist'));
  await expect(page.getByRole('heading', { level: 1, name: 'Pendientes' })).toBeVisible();
  // The demo has a visit booked by a professional for an existing patient: its identity is pending.
  await expect(
    page.getByRole('heading', { name: 'Identidad por confirmar' }).first(),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.goto(urlOf('aillu', '/today'));
  await expect(page.getByText('Esta vista es para profesionales de la salud.')).toBeVisible();
});

test('the badge of Pendientes counts the open items and the page lists them', async ({ page }) => {
  await openAs(page, 'reception', '/');
  const link = navigation(page).getByRole('link', { name: /^Pendientes/ });

  await expect(link).toHaveAccessibleName(/Pendientes, \d+ abiert/);
  await page.goto(urlOf('aillu', '/worklist'));
  const items = page
    .getByRole('list')
    .filter({ has: page.getByRole('heading', { level: 2 }) })
    .first();
  await expect(items.getByRole('listitem').first()).toBeVisible();
});
