import { expect, test, type Page } from '@playwright/test';

import { apiCall, patientIdByDocument, signedNoteVia } from './support/clinical.js';
import { openAs, urlOf } from './support/stack.js';

/**
 * The clinical record end to end (clinical-records): the editor with its autosave, the conflict
 * between two tabs, signing and the lock that follows, the chart, the search, the dialogs and who is
 * refused. Everything runs against the real stack with the demo organization.
 *
 * Each journey uses its own patient so the specs, which run in parallel, never write to the same
 * record: the cardiologist treats patients 99000001 to 99000005 and 99000009.
 */
const DOC = {
  valentina: '99000001', // hypertension, signed note with an addendum (demo story)
  martina: '99000003', // routine control
  lopez: '99000004', // chest pain
  belen: '99000005', // pregnant, draft in the demo story
  diaz: '99000009', // a note entered in error in the demo story
} as const;

async function startConsultation(page: Page) {
  await page.getByRole('button', { name: 'Nueva consulta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nueva consulta' });
  await dialog.getByRole('button', { name: 'Empezar la consulta' }).click();
  await expect(page.getByRole('button', { name: 'Firmar nota' })).toBeVisible();
}

test('autosave, a conflict between two tabs, signing and the lock that follows', async ({
  page,
  context,
}) => {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, DOC.martina);
  await page.goto(urlOf('aillu', `/patients/${patientId}?tab=chart`));
  await expect(page.getByRole('heading', { name: 'Historia clínica' })).toBeVisible();

  // A new consultation opens a draft, and what is typed saves by itself.
  await startConsultation(page);
  const reason = page.getByLabel(/Motivo de la consulta/);
  await reason.fill('Dolor torácico de esfuerzo');
  await expect(page.getByText('Guardado')).toBeVisible();
  const noteUrl = page.url();

  // The same draft open in a second tab: the second tab saves first.
  const second = await context.newPage();
  await second.goto(noteUrl);
  await second
    .getByLabel(/Motivo de la consulta/)
    .fill('Dolor torácico de esfuerzo, desde hace una semana');
  await expect(second.getByText('Guardado')).toBeVisible();

  // The first tab is now behind: it is told, and nothing is overwritten.
  await reason.fill('Dolor torácico de esfuerzo y disnea');
  await expect(page.getByText('Esta nota se guardó desde otra pantalla')).toBeVisible();
  await page.getByRole('button', { name: 'Ver la versión guardada' }).click();
  await expect(page.getByLabel(/Motivo de la consulta/)).toHaveValue(
    'Dolor torácico de esfuerzo, desde hace una semana',
  );
  await expect(page.getByText('Esta nota se guardó desde otra pantalla')).toHaveCount(0);

  // Signing asks for confirmation, and warns that it cannot be undone.
  await page.getByRole('button', { name: 'Firmar nota' }).click();
  const confirm = page.getByRole('alertdialog', { name: '¿Firmar esta nota?' });
  await expect(confirm).toContainText('no se puede modificar ni borrar');
  await confirm.getByRole('button', { name: 'Firmar definitivamente' }).click();
  await expect(page.getByText('Nota firmada.')).toBeVisible();
  await expect(page.getByText('Firmada', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel(/Motivo de la consulta/)).toHaveCount(0);

  // Locked: the other tab cannot save any more, and the API refuses every edit.
  const noteId = noteUrl.split('/').pop() ?? '';
  const signedNote = await apiCall<{ encounterId: string; draftRevision: number }>(
    page,
    'GET',
    `/notes/${noteId}`,
  );
  const afterSign = await apiCall(
    page,
    'PUT',
    `/encounters/${signedNote.body.encounterId}/note/draft`,
    {
      content: { reasonForConsultation: 'Cambio posterior' },
      baseRevision: signedNote.body.draftRevision,
    },
  );
  expect(afterSign.status).toBe(409);
  await second.reload();
  await expect(second.getByLabel(/Motivo de la consulta/)).toHaveCount(0);
  await expect(second.getByText('Dolor torácico de esfuerzo, desde hace una semana')).toBeVisible();
  await expect(second.getByRole('button', { name: 'Agregar addenda' })).toBeVisible();
});

test('the chart lists the demo story, hides what was entered in error and links to the anamnesis', async ({
  page,
}) => {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, DOC.valentina);
  await page.goto(urlOf('aillu', `/patients/${patientId}?tab=chart`));

  const entry = page.getByRole('listitem').filter({ hasText: 'Control de hipertensión arterial' });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('1 addenda');
  await expect(entry).toContainText('El enalapril se toma por la mañana, en ayunas.');
  await expect(page.getByRole('button', { name: /Ver la anamnesis/ })).toBeVisible();

  // An entry marked in error is hidden until asked for, then shown struck through.
  const diazId = await patientIdByDocument(page, DOC.diaz);
  await page.goto(urlOf('aillu', `/patients/${diazId}?tab=chart`));
  await expect(page.getByText('La nota se cargó en la paciente equivocada')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Mostrar las entradas marcadas como error' }).click();
  await expect(
    page.getByText('Motivo del error: La nota se cargó en la paciente equivocada'),
  ).toBeVisible();
  await expect(page.getByText('Marcada como error').first()).toBeVisible();

  // The anamnesis link switches tabs.
  await page.goto(urlOf('aillu', `/patients/${patientId}?tab=chart`));
  await page.getByRole('button', { name: /Ver la anamnesis/ }).click();
  await expect(page.getByRole('tab', { name: 'Anamnesis', selected: true })).toBeVisible();
});

test('the search of one record ignores accents and shows the words around the match', async ({
  page,
}) => {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, DOC.valentina);
  await page.goto(urlOf('aillu', `/patients/${patientId}?tab=chart`));

  await page.getByLabel('Texto a buscar').fill('hipertension');
  await page.getByRole('button', { name: 'Buscar' }).click();

  const results = page.getByRole('region', { name: 'Resultados de la búsqueda' });
  await expect(results).toContainText('coincidencia');
  await expect(results).toContainText(/hipertensión/i);
  // It only looks at this patient.
  await expect(page.getByText(/Busca solo en este paciente/)).toBeVisible();
});

test('addenda and entries in error: a reason is required, the original stays and the chart follows', async ({
  page,
}) => {
  await openAs(page, 'cardiology', '/');
  const patientId = await patientIdByDocument(page, DOC.lopez);
  // Unique, so a second run on the same database finds only its own note.
  const reason = `Control posterior al estudio ${String(Date.now())}`;
  const note = await signedNoteVia(page, patientId, {
    reasonForConsultation: reason,
    diagnosis: 'Diagnóstico a corregir',
  });
  await page.goto(urlOf('aillu', `/notes/${note.id}`));

  // An addendum needs a reason and a text.
  await page.getByRole('button', { name: 'Agregar addenda' }).click();
  const dialog = page.getByRole('dialog', { name: 'Agregar una addenda' });
  await dialog.getByRole('button', { name: 'Agregar addenda' }).click();
  await expect(dialog.getByText('Este dato es obligatorio.')).toHaveCount(2);
  await dialog.getByLabel('Motivo').fill('Corrección del diagnóstico');
  await dialog
    .getByLabel('Texto de la addenda')
    .fill('El diagnóstico definitivo es angina estable.');
  await dialog.getByRole('button', { name: 'Agregar addenda' }).click();
  await expect(page.getByText('Addenda agregada.')).toBeVisible();

  // The original is untouched and the addendum comes after it.
  await expect(page.getByText('Diagnóstico a corregir')).toBeVisible();
  const addenda = page
    .getByRole('heading', { name: 'Addendas' })
    .locator('xpath=ancestor::section');
  await expect(addenda).toContainText('El diagnóstico definitivo es angina estable.');
  await expect(addenda).toContainText('Motivo: Corrección del diagnóstico');

  // The history drawer lists the signature and the addendum.
  await page.getByRole('button', { name: 'Ver versiones' }).click();
  const drawer = page.getByRole('dialog', { name: 'Versiones de la nota' });
  await expect(drawer).toContainText('Nota firmada (versión 1)');
  await expect(drawer).toContainText('Addenda: Corrección');
  await page.keyboard.press('Escape');

  // Marking it in error needs a reason; afterwards it leaves the default chart.
  await page.getByRole('button', { name: 'Marcar como error' }).click();
  const errorDialog = page.getByRole('dialog', { name: 'Marcar como error' });
  await errorDialog.getByRole('button', { name: 'Marcar como error' }).click();
  await expect(errorDialog.getByText('Este dato es obligatorio.')).toBeVisible();
  await errorDialog.getByLabel('Motivo').fill('Paciente equivocado');
  await errorDialog.getByRole('button', { name: 'Marcar como error' }).click();
  await expect(page.getByText('La entrada se marcó como error.')).toBeVisible();
  await expect(page.getByText(/Esta entrada se marcó como error por/)).toBeVisible();

  await page.goto(urlOf('aillu', `/patients/${patientId}?tab=chart`));
  await expect(page.getByText(reason)).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Mostrar las entradas marcadas como error' }).click();
  await expect(page.getByText(reason)).toBeVisible();
});

test('the drafts view lists the unsigned notes of the professional and reopens them', async ({
  page,
}) => {
  await openAs(page, 'cardiology', '/drafts');

  await expect(page.getByRole('heading', { level: 1, name: 'Borradores' })).toBeVisible();
  const draft = page.getByRole('listitem').filter({ hasText: 'Martínez, Sofía Belén' });
  await expect(draft).toBeVisible();
  await draft.getByRole('link', { name: 'Continuar' }).click();
  await expect(page.getByLabel(/Motivo de la consulta/)).toHaveValue(
    'Palpitaciones durante el embarazo',
  );
});

test.describe('who is refused', () => {
  test('reception, an administrator and the owner have no tab and see the forbidden state on a note', async ({
    page,
    browser,
  }) => {
    await openAs(page, 'cardiology', '/');
    const patientId = await patientIdByDocument(page, DOC.belen);
    const note = await signedNoteVia(page, patientId, {
      reasonForConsultation: 'Solo para profesionales',
    });

    for (const account of ['reception', 'admin', 'owner'] as const) {
      const context = await browser.newContext();
      const other = await context.newPage();
      await openAs(other, account, `/patients/${patientId}?tab=chart`);
      await expect(other.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(other.getByRole('tab', { name: 'Historia clínica' })).toHaveCount(0);

      await other.goto(urlOf('aillu', `/notes/${note.id}`));
      await expect(other.getByText('No tiene acceso a esta sección')).toBeVisible();
      await expect(other.getByText('Solo para profesionales')).toHaveCount(0);
      // Even the API says no, with nothing in the body.
      const direct = await apiCall<{ code: string }>(other, 'GET', `/notes/${note.id}`);
      expect(direct.status).toBe(403);
      expect(JSON.stringify(direct.body)).not.toContain('Solo para profesionales');
      await context.close();
    }
  });

  test('a professional who does not treat the patient is told they have no access', async ({
    page,
    browser,
  }) => {
    await openAs(page, 'cardiology', '/');
    const patientId = await patientIdByDocument(page, DOC.martina);
    const note = await signedNoteVia(page, patientId, {
      reasonForConsultation: 'Reservada a quien atiende',
    });

    const context = await browser.newContext();
    const pediatrician = await context.newPage();
    await openAs(pediatrician, 'pediatrics', `/patients/${patientId}?tab=chart`);
    await expect(pediatrician.getByText('No tiene acceso a esta historia clínica')).toBeVisible();
    await pediatrician.goto(urlOf('aillu', `/notes/${note.id}`));
    await expect(pediatrician.getByText('No se encontró la nota')).toBeVisible();
    await context.close();
  });
});
