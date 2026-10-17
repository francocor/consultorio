import { expect, test, type Page } from '@playwright/test';

import { apiCall, patientIdByDocument } from './support/clinical.js';
import { axeViolations, horizontalOverflow, openAs, urlOf } from './support/stack.js';

/**
 * The clinical screens on a phone (360 px) and on a desktop: no horizontal overflow of the page and
 * WCAG 2.2 AA with axe. Read-only checks, so both projects can run side by side.
 */
async function expectFitsAndAccessible(page: Page) {
  // A hovered primary button is a different state with its own contrast; check the resting one.
  await page.mouse.move(0, 0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

test('the clinical chart is accessible and fits the screen', async ({ page }) => {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, '99000001');
  await page.goto(urlOf('aillu', `/patients/${patientId}?tab=chart`));

  await expect(page.getByRole('heading', { name: 'Historia clínica' })).toBeVisible();
  await expect(page.getByText('Control de hipertensión arterial')).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('the chart with the search results is accessible', async ({ page }) => {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, '99000001');
  await page.goto(urlOf('aillu', `/patients/${patientId}?tab=chart`));
  await page.getByLabel('Texto a buscar').fill('hipertension');
  await page.getByRole('button', { name: 'Buscar' }).click();

  await expect(page.getByRole('region', { name: 'Resultados de la búsqueda' })).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('a signed note with its addendum is accessible', async ({ page }) => {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, '99000001');
  const timeline = await apiCall<{ entries: { noteId: string; headline: string | null }[] }>(
    page,
    'GET',
    `/patients/${patientId}/clinical/timeline`,
  );
  const signed = timeline.body.entries.find((entry) =>
    entry.headline?.startsWith('Control de hipertensión'),
  );
  await page.goto(urlOf('aillu', `/notes/${signed?.noteId ?? ''}`));

  await expect(page.getByRole('heading', { name: 'Nota original' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Addendas' })).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('the drafts view is accessible', async ({ page }) => {
  await openAs(page, 'cardiology', '/drafts');

  await expect(page.getByRole('heading', { level: 1, name: 'Borradores' })).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('the addendum dialog is accessible', async ({ page }) => {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, '99000002');
  const timeline = await apiCall<{ entries: { noteId: string }[] }>(
    page,
    'GET',
    `/patients/${patientId}/clinical/timeline`,
  );
  await page.goto(urlOf('aillu', `/notes/${timeline.body.entries[0]?.noteId ?? ''}`));
  await page.getByRole('button', { name: 'Agregar addenda' }).click();

  await expect(page.getByRole('dialog', { name: 'Agregar una addenda' })).toBeVisible();
  await expectFitsAndAccessible(page);
});

for (const [account, document, template, heading] of [
  ['psychology', '99000007', 'psychology', /Fecha de la sesión/],
  ['cardiology', '99000003', 'general', /Motivo de la consulta/],
] as const) {
  test(`the ${template} editor is accessible and fits the screen`, async ({ page }) => {
    await openAs(page, account, '/');
    const patientId = await patientIdByDocument(page, document);
    const opened = await apiCall<{ id: string }>(page, 'POST', '/encounters', {
      patientId,
      templateKind: template,
    });
    await page.goto(urlOf('aillu', `/notes/${opened.body.id}`));

    await expect(page.getByLabel(heading)).toBeVisible();
    await expectFitsAndAccessible(page);
  });
}

test('the odontogram editor is accessible and scrolls inside its own frame on a phone', async ({
  page,
}) => {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, '99000002');
  const opened = await apiCall<{ id: string }>(page, 'POST', '/encounters', {
    patientId,
    templateKind: 'odontology',
  });
  await page.goto(urlOf('aillu', `/notes/${opened.body.id}`));
  await expect(page.getByRole('group', { name: 'Odontograma' })).toBeVisible();

  await page.getByRole('button', { name: 'Pieza 16: sin registro' }).click();
  await expect(page.getByRole('heading', { name: 'Pieza 16' })).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('the physiotherapy and nutrition editors are accessible', async ({ page }) => {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, '99000009');
  for (const [templateKind, label] of [
    ['physiotherapy', /Región afectada/],
    ['nutrition', /Peso \(kg\)/],
  ] as const) {
    const opened = await apiCall<{ id: string }>(page, 'POST', '/encounters', {
      patientId,
      templateKind,
    });
    await page.goto(urlOf('aillu', `/notes/${opened.body.id}`));
    await expect(page.getByLabel(label)).toBeVisible();
    await expectFitsAndAccessible(page);
  }
});
