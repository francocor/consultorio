import { expect, test } from '@playwright/test';

import { axeViolations, horizontalOverflow, openAs } from './support/stack.js';

/** Settings > Turnos at 360 px and at 1280 px: every section fits the screen and passes axe. */
const SECTIONS = [
  { tab: 'Tipos de turno', visible: 'Primera consulta' },
  { tab: 'Bloqueos', visible: 'Bloqueos' },
  { tab: 'Feriados y días no laborables', visible: 'Año siguiente' },
  { tab: 'Sobreturnos', visible: 'Sobreturnos' },
] as const;

test('every section of Settings > Turnos fits the screen and is accessible', async ({ page }) => {
  await openAs(page, 'owner', '/settings/scheduling');
  await expect(page.getByRole('heading', { level: 1, name: 'Configuración' })).toBeVisible();

  for (const section of SECTIONS) {
    await page.getByRole('tab', { name: section.tab }).click();
    const panel = page.getByRole('tabpanel', { name: section.tab });
    await expect(panel).toBeVisible();
    await expect(
      panel
        .getByText(section.visible, { exact: true })
        .or(panel.getByRole('button', { name: section.visible }))
        .first(),
    ).toBeVisible();
    expect(await horizontalOverflow(page), section.tab).toBeLessThanOrEqual(0);
    expect(await axeViolations(page), section.tab).toEqual([]);
  }
});

test('the new type dialog and the new block dialog are accessible', async ({ page }) => {
  await openAs(page, 'owner', '/settings/scheduling');

  await page.getByRole('button', { name: 'Nuevo tipo de turno' }).click();
  await expect(page.getByRole('dialog', { name: 'Nuevo tipo de turno' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Bloqueos' }).click();
  await page.getByRole('button', { name: 'Nuevo bloqueo' }).click();
  await expect(page.getByRole('dialog', { name: 'Nuevo bloqueo' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
