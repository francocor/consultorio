import { expect, test, type Page } from '@playwright/test';

import { bookableProfessional, clockTime } from './support/agenda.js';
import { apiCall } from './support/clinical.js';
import { axeViolations, horizontalOverflow, openAs, urlOf } from './support/stack.js';

/**
 * A full day in a multi-professional center, across roles (Stage 2 gate; scheduling, clinical
 * records and documents together on the real stack):
 *
 * 1. reception registers a new patient, books the cardiologist, confirms and registers the arrival;
 * 2. the cardiologist calls the patient in from the agenda, which opens a new encounter tied to the
 *    appointment (decision D20) with the reason already filled in, writes the note and signs it;
 * 3. an addendum corrects the signed note without touching it;
 * 4. documents: the cardiologist uploads a lab result (it is scanned by the worker and becomes
 *    available, then it downloads) and a file the scanner refuses; reception, who may not read
 *    clinical documents, does not see them, and uploads an administrative one;
 * 5. the owner of a demo organization, already set up, is not asked to run the wizard again.
 *
 * Everything the journey creates is its own (a new patient, a free time found through the API), so
 * it never collides with the other specs that run in parallel. Axe runs on every new screen.
 */
test.use({ reducedMotion: 'reduce' });
test.setTimeout(240_000);

/** A document number nobody else uses in this run. */
const uniqueDocument = () => `97${String(Date.now()).slice(-6)}`;

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% Laboratorio de la jornada\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);
// The EICAR antivirus test string, written in parts so this source is not itself flagged.
const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!',
  '$H+H*',
].join('');

async function uploadFile(
  page: Page,
  input: { category: string; name: string; mimeType: string; buffer: Buffer },
) {
  await page.getByRole('button', { name: 'Subir archivos' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Subir archivos' });
  await dialog.getByLabel('Tipo de documento').selectOption({ label: input.category });
  await dialog.getByLabel('Elegir archivos').setInputFiles({
    name: input.name,
    mimeType: input.mimeType,
    buffer: input.buffer,
  });
  await dialog.getByRole('button', { name: 'Subir', exact: true }).click();
  await expect(dialog.getByText(/Se subió 1 archivo/)).toBeVisible({ timeout: 30_000 });
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Cerrar' }).first().click();
  await expect(dialog).toBeHidden();
}

test('a day in the center: reception, the professional and the documents, role by role', async ({
  page,
  browser,
}) => {
  const document = uniqueDocument();
  const family = `Jornada${document.slice(-4)}`;
  const given = 'Marcela';

  // 1. Reception registers the patient and books the cardiologist.
  await openAs(page, 'reception', '/patients/new');
  await page.getByLabel('Apellido').fill(family);
  await page.getByLabel('Nombre', { exact: true }).fill(given);
  await page.getByLabel('Fecha de nacimiento').fill('1984-03-12');
  await page.getByLabel('Número de documento').fill(document);
  await page.getByRole('radio', { name: /El paciente acepta el tratamiento/ }).click();
  await page.getByRole('button', { name: 'Registrar paciente' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `${given} ${family}` })).toBeVisible();
  const patientPath = new URL(page.url()).pathname;

  const target = await bookableProfessional(page, { specialty: 'Cardiología' });
  // Another free time than the first ones, which the other specs of the suite take.
  const slot = target.slots[Math.min(target.slots.length - 1, 6)];
  if (!slot) throw new Error('The cardiologist has no free time in the next four weeks');
  const when = clockTime(slot.startsAt);
  const agenda = `/calendar?date=${slot.date}&pros=${target.professionalId}`;

  await page.goto(urlOf('aillu', agenda));
  await page.getByRole('button', { name: 'Nuevo turno' }).click();
  const booking = page.getByRole('dialog', { name: 'Nuevo turno' });
  await booking
    .getByRole('group', { name: 'Horarios disponibles' })
    .getByRole('button', { name: when, exact: true })
    .click();
  await booking.getByRole('combobox', { name: 'Paciente' }).fill(family);
  await booking.getByRole('option', { name: new RegExp(family) }).click();
  await booking.getByRole('button', { name: 'Dar turno' }).click();
  await expect(booking).toBeHidden();

  const card = (status: string) => new RegExp(`${when}.*${family}.*${status}`);
  await page
    .getByRole('button', { name: card('Programado') })
    .first()
    .click();
  let drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: 'Confirmar turno' }).click();
  await expect(drawer.getByText('Confirmado', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Registrar llegada' }).click();
  await expect(drawer.getByText('En sala', { exact: true })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // 2. The cardiologist calls the patient in: the new encounter opens, tied to the appointment.
  const clinician = await (await browser.newContext()).newPage();
  await openAs(clinician, 'cardiology', agenda);
  await clinician
    .getByRole('button', { name: card('En sala') })
    .first()
    .click();
  drawer = clinician.getByRole('dialog');
  await drawer.getByRole('button', { name: 'Iniciar consulta' }).click();
  await expect(clinician).toHaveURL(/\/encounters\/new\?.*appointmentId=/);
  // The page says which appointment it comes from, and the reason will start as its type.
  const linked = clinician.getByText(/^Turno: /);
  await expect(linked).toBeVisible();
  const appointmentType =
    ((await linked.textContent()) ?? '').replace('Turno: ', '').split('. ')[0] ?? '';
  expect(appointmentType).not.toBe('');
  expect(await axeViolations(clinician)).toEqual([]);
  await clinician.getByRole('button', { name: 'Empezar la consulta' }).click();

  // The reason of the note starts as the type of the appointment; the rest is written and saved.
  const reason = clinician.getByLabel(/Motivo de la consulta/);
  await expect(reason).toHaveValue(appointmentType);
  await reason.fill('Dolor de pecho de esfuerzo desde hace dos semanas');
  await clinician.getByLabel(/Síntomas o hallazgos/).fill('Cede con el reposo en pocos minutos.');
  await clinician.getByLabel('Diagnóstico').fill('Angina de esfuerzo a confirmar');
  await clinician.getByLabel(/Tratamiento o plan/).fill('Prueba ergométrica y laboratorio.');
  await expect(clinician.getByText('Guardado')).toBeVisible();
  expect(await axeViolations(clinician)).toEqual([]);

  await clinician.getByRole('button', { name: 'Firmar nota' }).click();
  await clinician
    .getByRole('alertdialog', { name: '¿Firmar esta nota?' })
    .getByRole('button', { name: 'Firmar definitivamente' })
    .click();
  await expect(clinician.getByText('Nota firmada.')).toBeVisible();
  await expect(clinician.getByLabel(/Motivo de la consulta/)).toHaveCount(0);
  const noteUrl = clinician.url();

  // 3. An addendum corrects the signed note; the original stays.
  await clinician.getByRole('button', { name: 'Agregar addenda' }).click();
  const addendum = clinician.getByRole('dialog', { name: 'Agregar una addenda' });
  await addendum.getByLabel('Motivo').fill('Dato aportado por la paciente');
  await addendum
    .getByLabel('Texto de la addenda')
    .fill('Refiere además antecedentes familiares de cardiopatía.');
  await addendum.getByRole('button', { name: 'Agregar addenda' }).click();
  await expect(clinician.getByText('Addenda agregada.')).toBeVisible();
  await expect(
    clinician.getByText('Dolor de pecho de esfuerzo desde hace dos semanas'),
  ).toBeVisible();
  expect(await axeViolations(clinician)).toEqual([]);

  // The visit is still in progress in the agenda: the professional finishes it there.
  await clinician.goto(urlOf('aillu', agenda));
  await clinician
    .getByRole('button', { name: card('En consulta') })
    .first()
    .click();
  await clinician.getByRole('dialog').getByRole('button', { name: 'Finalizar consulta' }).click();
  await expect(clinician.getByRole('dialog').getByText('Atendido', { exact: true })).toBeVisible();

  // 4. Documents. The lab result goes up from the chart; the worker scans it and releases it.
  await clinician.goto(urlOf('aillu', patientPath));
  await clinician.getByRole('tab', { name: 'Documentos' }).click();
  await expect(clinician.getByText('Todavía no hay documentos')).toBeVisible();
  expect(await axeViolations(clinician)).toEqual([]);
  await uploadFile(clinician, {
    category: 'Resultado de laboratorio',
    name: 'laboratorio-jornada.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  const lab = clinician.getByRole('listitem').filter({ hasText: 'laboratorio-jornada.pdf' });
  await expect(lab).toContainText('Disponible', { timeout: 60_000 });
  await expect(lab).toContainText('Clínico');
  expect(await axeViolations(clinician)).toEqual([]);

  // It downloads through a single-use link, with the bytes that went up.
  const download = clinician.waitForEvent('download');
  await lab.getByRole('button', { name: 'Descargar laboratorio-jornada.pdf' }).click();
  const received = await download;
  expect(received.suggestedFilename()).toBe('laboratorio-jornada.pdf');

  // A file the scanner refuses is shown as refused, with the reason, and cannot be downloaded.
  await uploadFile(clinician, {
    category: 'Otro documento clínico',
    name: 'archivo-sospechoso.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(EICAR, 'latin1'),
  });
  const refused = clinician.getByRole('listitem').filter({ hasText: 'archivo-sospechoso.txt' });
  await expect(refused).toContainText('Rechazado', { timeout: 60_000 });
  await expect(refused).toContainText('El archivo contiene software malicioso');
  await expect(refused.getByRole('button', { name: /Descargar/ })).toHaveCount(0);

  // Reception does not see the clinical documents, and uploads an administrative one.
  await page.goto(urlOf('aillu', patientPath));
  await page.getByRole('tab', { name: 'Documentos' }).click();
  await expect(page.getByText('laboratorio-jornada.pdf')).toHaveCount(0);
  await uploadFile(page, {
    category: 'Copia de documento de identidad',
    name: 'dni-jornada.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  const idCopy = page.getByRole('listitem').filter({ hasText: 'dni-jornada.pdf' });
  await expect(idCopy).toContainText('Disponible', { timeout: 60_000 });
  await expect(idCopy).toContainText('Administrativo');
  expect(await axeViolations(page)).toEqual([]);
  // The API says the same: the clinical file is not in what reception can list.
  const listing = await apiCall<{ documents: { name: string }[] }>(
    page,
    'GET',
    `${patientPath}/documents`,
  );
  expect(listing.status).toBe(200);
  expect(listing.body.documents.map((entry) => entry.name)).not.toContain(
    'laboratorio-jornada.pdf',
  );

  // The note the professional signed is there for the professional only.
  const asReception = await apiCall(page, 'GET', `/notes/${noteUrl.split('/').pop() ?? ''}`);
  expect(asReception.status).toBe(403);

  // 5. The owner of an organization that is already set up is not asked to run the wizard again.
  const owner = await (await browser.newContext()).newPage();
  await openAs(owner, 'owner', '/');
  await expect(owner).not.toHaveURL(/\/onboarding/);
  await expect(owner.getByRole('region', { name: 'Primeros pasos' })).toHaveCount(0);
  const state = await apiCall<{ wizard: { completed: boolean } }>(
    owner,
    'GET',
    '/onboarding/state',
  );
  expect(state.body.wizard.completed).toBe(true);
  expect(await horizontalOverflow(owner)).toBeLessThanOrEqual(0);
});
