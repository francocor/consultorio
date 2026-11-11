import { expect, test, type Page } from '@playwright/test';

import { axeViolations, horizontalOverflow, openAs } from './support/stack.js';

/** The patient screens on a phone and on a desktop: layout and WCAG 2.2 AA. */
async function expectFitsAndAccessible(page: Page) {
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

test('the patient list is accessible and fits the screen', async ({ page }) => {
  await openAs(page, 'reception', '/patients');

  await expect(page.getByRole('link', { name: /Gómez, Valentina/ })).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('the registration form is accessible and fits the screen', async ({ page }) => {
  await openAs(page, 'reception', '/patients/new');

  await expect(page.getByRole('heading', { level: 1, name: 'Nuevo paciente' })).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('the registration of a minor asks for the representative', async ({ page }) => {
  await openAs(page, 'reception', '/patients/new');
  await page.getByLabel('Fecha de nacimiento').fill('2020-03-14');

  await expect(page.getByRole('group', { name: 'Representante' })).toBeVisible();
  await expectFitsAndAccessible(page);
});

for (const tab of ['Datos', 'Cobertura', 'Privacidad', 'Historial', 'Atención']) {
  test(`the patient record, tab "${tab}", is accessible and does not overflow`, async ({
    page,
  }) => {
    await openAs(page, 'reception', '/patients');
    await page.getByRole('link', { name: /Gómez, Valentina/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Valentina Gómez' })).toBeVisible();
    await page.getByRole('tab', { name: tab }).click();

    if (tab === 'Cobertura') await expect(page.getByText('OSDE')).toBeVisible();
    if (tab === 'Privacidad') {
      await expect(page.getByText('Consentimiento otorgado')).toBeVisible();
    }
    await expectFitsAndAccessible(page);
  });
}

test('the record of a minor shows the representative', async ({ page }) => {
  await openAs(page, 'reception', '/patients');
  await page.getByRole('searchbox').fill('Domínguez');
  await page.getByRole('link', { name: /Domínguez, Isabella/ }).click();

  await expect(page.getByText('Es menor de edad.')).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('the anamnesis tab is accessible for a professional', async ({ page }) => {
  await openAs(page, 'cardiology', '/patients');
  await page.getByRole('link', { name: /Gómez, Valentina/ }).click();
  await page.getByRole('tab', { name: 'Anamnesis' }).click();

  await expect(page.getByRole('heading', { name: 'Anamnesis' })).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('the edit dialog is accessible', async ({ page }) => {
  await openAs(page, 'reception', '/patients');
  await page.getByRole('link', { name: /Gómez, Valentina/ }).click();
  await page.getByRole('button', { name: 'Editar datos' }).click();

  await expect(page.getByRole('dialog', { name: 'Editar datos personales' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
