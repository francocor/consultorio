import { expect, test, type Page } from '@playwright/test';

import { openAs, urlOf } from './support/stack.js';

/** A document number nobody else uses in this run: 8 digits, never one of the demo patients. */
const uniqueDocument = () => `98${String(Date.now()).slice(-6)}`;

async function register(page: Page, input: { family: string; given: string; document: string }) {
  await page.goto(urlOf('aillu', '/patients/new'));
  await page.getByLabel('Apellido').fill(input.family);
  await page.getByLabel('Nombre', { exact: true }).fill(input.given);
  await page.getByLabel('Fecha de nacimiento').fill('1991-07-23');
  await page.getByLabel('Número de documento').fill(input.document);
  await page.getByRole('radio', { name: /El paciente acepta el tratamiento/ }).click();
  await page.getByRole('button', { name: 'Registrar paciente' }).click();
}

test('reception registers a patient, a repeated document is refused, a professional records the anamnesis and reception only sees the alert', async ({
  page,
  browser,
}) => {
  const document = uniqueDocument();
  const family = `Prueba${document.slice(-4)}`;

  // Reception registers the patient and lands on the record.
  await openAs(page, 'reception', '/patients/new');
  await register(page, { family, given: 'Lucrecia', document });
  await expect(page.getByRole('heading', { level: 1, name: `Lucrecia ${family}` })).toBeVisible();

  // The same document cannot be registered twice: the existing record is offered instead.
  await register(page, { family: 'Otra', given: 'Persona', document });
  await expect(page.getByText('Ese documento ya está registrado')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Abrir la ficha' })).toBeVisible();
  await page.getByRole('link', { name: 'Abrir la ficha' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Lucrecia ${family}` })).toBeVisible();
  const recordUrl = page.url();

  // Reception has no anamnesis tab. It assigns the patient to the cardiologist.
  await expect(page.getByRole('tab', { name: 'Anamnesis' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Atención' }).click();
  await page.getByRole('button', { name: 'Asignar a un profesional' }).click();
  const dialog = page.getByRole('dialog', { name: 'Asignar a un profesional' });
  await dialog.getByLabel('Profesional').selectOption({ label: 'Dra. Lucía Paz Ferrer' });
  await dialog.getByRole('button', { name: 'Asignar' }).click();
  await expect(page.getByText('Asignación registrada.')).toBeVisible();

  // The cardiologist, in her own browser, records an allergy.
  const professional = await (await browser.newContext()).newPage();
  await openAs(professional, 'cardiology', new URL(recordUrl).pathname);
  await professional.getByRole('tab', { name: 'Anamnesis' }).click();
  await professional.getByRole('button', { name: 'Agregar alergia' }).click();
  await professional.getByLabel('Sustancia').fill('Penicilina');
  await professional.getByLabel('Gravedad').selectOption('severe');
  await expect(professional.getByText('Alergias registradas')).toBeVisible();
  await professional.getByRole('button', { name: 'Guardar anamnesis' }).click();
  await expect(professional.getByText('Anamnesis guardada.')).toBeVisible();

  // Reception sees only that a professional should be consulted, never what it is about.
  await page.reload();
  await expect(page.getByText('Consultar con el profesional')).toBeVisible();
  await expect(page.getByText(/Penicilina|Alergias registradas/)).toHaveCount(0);
});

test('the patient list searches by document and by name', async ({ page }) => {
  await openAs(page, 'reception', '/patients');
  await expect(page.getByRole('heading', { level: 1, name: 'Pacientes' })).toBeVisible();

  await page.getByRole('searchbox').fill('99000001');
  await expect(page.getByRole('link', { name: /Gómez, Valentina/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Rodríguez, Santiago/ })).toHaveCount(0);

  await page.getByRole('searchbox').fill('rodriguez');
  await expect(page.getByRole('link', { name: /Rodríguez, Santiago/ })).toBeVisible();
});

test('the quick search on the home page opens a record', async ({ page }) => {
  await openAs(page, 'reception', '/');

  await page.getByRole('combobox', { name: 'Buscar paciente por DNI o nombre' }).fill('99000001');
  await page.getByRole('option', { name: /Gómez, Valentina/ }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Valentina Gómez' })).toBeVisible();
});
