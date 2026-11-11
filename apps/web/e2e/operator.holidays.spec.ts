import { expect, test } from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import { axeViolations, openAs, urlOf } from './support/stack.js';

/**
 * The holiday catalog (SCH-07, CTR-05): the operator adds a holiday and every organization sees it
 * at once, with no release; removing it takes it back. The year is far from the demo agenda.
 */
test.use({ storageState: OPERATOR_STATE, reducedMotion: 'reduce' });

const YEAR = 2031;

test('the operator adds a holiday that an organization sees at once, and removes it', async ({
  page,
  browser,
}) => {
  const name = `Feriado de prueba ${String(Date.now())}`;
  await page.goto(urlOf('platform', '/'));
  await page.getByRole('tab', { name: 'Feriados' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Feriados' });
  await expect(panel.getByRole('heading', { level: 1, name: 'Feriados del país' })).toBeVisible();

  for (let year = new Date().getFullYear(); year < YEAR; year += 1) {
    await panel.getByRole('button', { name: 'Año siguiente' }).click();
  }
  await expect(panel.getByText(`AR ${String(YEAR)}`)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await panel.getByRole('button', { name: 'Agregar feriado' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Agregar feriado' });
  await dialog.getByLabel('Fecha').fill(`${String(YEAR)}-05-02`);
  await dialog.getByLabel('Nombre').fill(name);
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Agregar' }).click();
  const row = panel.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText('02/05/2031');
  await expect(row).toContainText('Feriado nacional');

  // An organization reads the new holiday from its own calendar, with nothing deployed.
  const owner = await (await browser.newContext()).newPage();
  await openAs(owner, 'owner', '/');
  const seen = async () => {
    const response = await owner.request.get(urlOf('aillu', `/api/holidays?year=${String(YEAR)}`));
    const body = (await response.json()) as { holidays: { name: string; day: string }[] };
    return body.holidays.filter((holiday) => holiday.name === name);
  };
  expect(await seen()).toEqual([expect.objectContaining({ day: `${String(YEAR)}-05-02` })]);

  await panel.getByRole('button', { name: `Quitar ${name}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Quitar feriado' }).click();
  await expect(row).toHaveCount(0);
  expect(await seen()).toEqual([]);
});
