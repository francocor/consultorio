import { expect, test } from '@playwright/test';

import { axeViolations, openAs, urlOf } from './support/stack.js';

/**
 * The Stage 1 gate, seen from the outside: the demonstration organizations as a visitor and as
 * each role meet them. It leans on the content of the demo seed (docs/demo.md).
 */

test('two organizations, two looks: each host paints its own name and colors', async ({
  browser,
}) => {
  const aillu = await (await browser.newContext()).newPage();
  const norte = await (await browser.newContext()).newPage();
  await aillu.goto(urlOf('aillu', '/login'));
  await norte.goto(urlOf('norte', '/login'));

  await expect(aillu.getByText(/Centro Médico Aillu/).first()).toBeVisible();
  await expect(norte.getByText(/Clínica Norte/).first()).toBeVisible();
  const primary = (page: typeof aillu) =>
    page.evaluate(() => document.documentElement.style.getPropertyValue('--primary'));
  const [green, blue] = [await primary(aillu), await primary(norte)];
  expect(green).not.toBe('');
  expect(blue).not.toBe('');
  expect(green).not.toBe(blue);
  expect(await axeViolations(aillu)).toEqual([]);
  expect(await axeViolations(norte)).toEqual([]);
});

test('each role sees its own navigation and nothing it should not', async ({ browser }) => {
  const visibleLinks = async (account: 'owner' | 'reception' | 'cardiology') => {
    const page = await (await browser.newContext()).newPage();
    await openAs(page, account, '/');
    const navigation = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(navigation.getByRole('link', { name: 'Inicio' })).toBeVisible();
    const names = await navigation.getByRole('link').allInnerTexts();
    await page.close();
    return names.map((name) => name.trim());
  };

  const owner = await visibleLinks('owner');
  const reception = await visibleLinks('reception');
  const professional = await visibleLinks('cardiology');

  expect(owner).toEqual(
    expect.arrayContaining(['Pacientes', 'Equipo', 'Auditoría', 'Configuración']),
  );
  expect(reception).toContain('Pacientes');
  for (const forbidden of ['Equipo', 'Auditoría', 'Configuración']) {
    expect(reception).not.toContain(forbidden);
    expect(professional).not.toContain(forbidden);
  }
});

test('the clinical story: the professional sees the allergy, reception only "consult the professional"', async ({
  browser,
}) => {
  const professional = await (await browser.newContext()).newPage();
  await openAs(professional, 'cardiology', '/patients');
  await professional.getByRole('searchbox').fill('99000001');
  await professional.getByRole('link', { name: /Gómez, Valentina/ }).click();
  await expect(
    professional.getByRole('heading', { level: 1, name: 'Valentina Gómez' }),
  ).toBeVisible();
  await expect(professional.getByText('Consultar con el profesional')).toBeVisible();
  await professional.getByRole('tab', { name: 'Anamnesis' }).click();
  await expect(professional.getByLabel('Sustancia').first()).toHaveValue('Penicilina');
  await expect(professional.getByText('Alergias registradas')).toBeVisible();

  const reception = await (await browser.newContext()).newPage();
  await openAs(reception, 'reception', '/patients');
  await reception.getByRole('searchbox').fill('99000001');
  await reception.getByRole('link', { name: /Gómez, Valentina/ }).click();
  await expect(reception.getByRole('heading', { level: 1, name: 'Valentina Gómez' })).toBeVisible();
  await expect(reception.getByText('Consultar con el profesional')).toBeVisible();
  await expect(reception.getByRole('tab', { name: 'Anamnesis' })).toHaveCount(0);
  await expect(reception.getByText(/Penicilina/)).toHaveCount(0);
});

test('the audit trail shows the activity of the demo, and the people who generated it', async ({
  page,
}) => {
  await openAs(page, 'owner', '/audit');

  const table = page.getByRole('table', { name: 'Eventos de auditoría' });
  await expect(table.getByText('Ingreso correcto').first()).toBeVisible();
  await page.getByLabel('Acción').selectOption({ label: 'Paciente registrado' });
  await expect(table.getByText('Camila Duarte').first()).toBeVisible();
  await page.getByLabel('Acción').selectOption({ label: 'Anamnesis guardada' });
  await expect(table.getByText('Dra. Lucía Paz Ferrer').first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test('an organization never shows the content of the other one', async ({ page }) => {
  // The same person has accounts in both; each host shows only its own organization.
  await openAs(page, 'owner', '/staff', 'norte');

  await expect(page.getByRole('heading', { level: 1, name: 'Equipo' })).toBeVisible();
  await expect(page.getByText(/Clínica Norte/).first()).toBeVisible();
  await expect(page.getByText(/Centro Médico Aillu/)).toHaveCount(0);
});
