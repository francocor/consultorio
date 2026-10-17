import { expect, test } from '@playwright/test';

import { busyDay } from './support/agenda.js';
import { axeViolations, horizontalOverflow, openAs, urlOf } from './support/stack.js';

const STATUS_WORDS =
  /Programado|Confirmado|En sala|En consulta|Atendido|Ausente|Pendiente de aprobación/;

/**
 * The agenda at 360 px and at 1280 px (SCH-01, SHL-02): the day opens as a list on a phone, as a
 * column per professional on a desktop, never scrolls sideways, and passes WCAG 2.2 AA.
 */
test('the agenda opens on the day, fits the screen and is accessible', async ({ page }) => {
  await openAs(page, 'reception', '/');
  const day = await busyDay(page);
  await page.goto(urlOf('aillu', `/calendar?date=${day}`));
  const phone = (page.viewportSize()?.width ?? 1280) < 768;

  await expect(page.getByRole('heading', { level: 1, name: 'Agenda' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Día', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  if (phone) {
    const list = page.getByRole('region', { name: /^Agenda del / });
    await expect(list).toBeVisible();
    const items = list.getByRole('listitem');
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThan(1);
    // The status is a word on every row, not only a color.
    await expect(items.first()).toContainText(STATUS_WORDS);
    await expect(page.getByRole('group', { name: /^Agenda de / })).toHaveCount(0);
  } else {
    const columns = page.getByRole('group', { name: /^Agenda de / });
    await expect(columns.first()).toBeVisible();
    expect(await columns.count()).toBeGreaterThan(1);
    await expect(
      page
        .getByRole('button', {
          name: /,.*(Programado|Confirmado|En sala|En consulta|Atendido|Ausente)/,
        })
        .first(),
    ).toBeVisible();
  }

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('the week and the month fit the screen and are accessible', async ({ page }) => {
  await openAs(page, 'reception', '/');
  const day = await busyDay(page);

  await page.goto(urlOf('aillu', `/calendar?view=week&date=${day}`));
  await expect(page.getByRole('region', { name: /^Agenda de la semana/ })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Mes', exact: true }).click();
  await expect(page.getByRole('region', { name: /^Agenda de [a-z]+ de \d{4}$/ })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});
