import { expect, test, type Page } from '@playwright/test';

import { bookableProfessional, clockTime } from './support/agenda.js';
import { apiCall } from './support/clinical.js';
import { expectFitsAndAccessible, uniqueDocument, visitor } from './support/public-booking.js';
import {
  emailTo,
  linkIn,
  localLink,
  settleToasts,
  signInWithApi,
  emailOf,
  urlOf,
} from './support/stack.js';

/**
 * The patient portal on the real stack (Stage 5, track B), as a patient on a phone of 360 px: the
 * consultorio invites the patient, who activates the access with the link of the email, signs in
 * with a code read from the mailbox, sees the appointment and confirms it, downloads a document the
 * staff shared (through a link bound to the session), looks at the sections that have nothing yet
 * (invoices, prescriptions and consents show their empty state until their modules are wired),
 * changes the contact data and signs out. A patient cannot reach staff pages, and a staff session
 * is not a portal session.
 *
 * Axe and the width of the page are checked on every screen.
 */
test.setTimeout(240_000);

const DESKTOP = {
  viewport: { width: 1280, height: 800 },
  locale: 'es-AR',
  timezoneId: 'America/Argentina/Buenos_Aires',
  serviceWorkers: 'block' as const,
};

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% Documento del portal\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);

/** The six digits of a code email: the code is alone on its line. */
function codeIn(message: string): string {
  const code = /^\s*(\d{6})\s*$/m.exec(message)?.[1];
  expect(code, 'the email carries a six digit code').toBeDefined();
  return code ?? '';
}

async function uploadAdministrativeFile(staff: Page, name: string) {
  await staff.getByRole('button', { name: 'Subir archivos' }).first().click();
  const dialog = staff.getByRole('dialog', { name: 'Subir archivos' });
  await dialog.getByLabel('Tipo de documento').selectOption({
    label: 'Copia de documento de identidad',
  });
  await dialog
    .getByLabel('Elegir archivos')
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: PDF });
  await dialog.getByRole('button', { name: 'Subir', exact: true }).click();
  await expect(dialog.getByText(/Se subió 1 archivo/)).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Cerrar' }).first().click();
  await expect(dialog).toBeHidden();
}

/** A patient of the demo with an email, registered by reception through the API of the screens. */
async function registerPatient(staff: Page, email: string) {
  const document = uniqueDocument();
  const created = await apiCall<{ patient: { id: string } }>(staff, 'POST', '/patients', {
    familyName: `Portal${document.slice(-4)}`,
    givenNames: 'Lucía',
    birthDate: '1990-04-02',
    document: { type: 'dni', number: document },
    email,
    dataProcessingConsent: true,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { id: created.body.patient.id, document, family: `Portal${document.slice(-4)}` };
}

/** Books the first free time that other specs left, in the later half of the free times. */
async function bookAppointment(staff: Page, patientId: string) {
  const target = await bookableProfessional(staff);
  const later = target.slots.slice(Math.floor(target.slots.length / 2));
  const offset = Math.floor(Math.random() * later.length);
  for (const candidate of [...later.slice(offset), ...later.slice(0, offset)]) {
    const booked = await apiCall<{ id?: string }>(staff, 'POST', '/appointments', {
      patientId,
      professionalId: target.professionalId,
      locationId: candidate.locationId,
      appointmentTypeId: target.typeId,
      startsAt: candidate.startsAt,
    });
    if (booked.status === 201) return { typeName: target.typeName, startsAt: candidate.startsAt };
  }
  throw new Error('No free time could be booked');
}

test('a patient is invited, activates the access, signs in with a code, uses the portal and cannot reach staff pages', async ({
  browser,
}) => {
  const staffContext = await browser.newContext(DESKTOP);
  const staff = await staffContext.newPage();
  await signInWithApi(staff.request, 'aillu', emailOf('reception'));

  const email = `paciente.${String(Date.now())}@demo.invalid`;
  const patient = await registerPatient(staff, email);
  const appointment = await bookAppointment(staff, patient.id);
  const fileName = `informe-portal-${patient.document.slice(-4)}.pdf`;

  // 1. Reception shares a document and invites the patient from the record.
  await test.step('reception uploads a document, shares it and invites the patient', async () => {
    await staff.goto(urlOf('aillu', `/patients/${patient.id}`));
    await staff.getByRole('tab', { name: 'Documentos' }).click();
    await uploadAdministrativeFile(staff, fileName);
    const row = staff.getByRole('listitem').filter({ hasText: fileName });
    await expect(row).toContainText('Disponible', { timeout: 60_000 });

    const listing = await apiCall<{ documents: { id: string; name: string }[] }>(
      staff,
      'GET',
      `/patients/${patient.id}/documents`,
    );
    const document = listing.body.documents.find((entry) => entry.name === fileName);
    expect(document, 'the uploaded document is listed').toBeDefined();
    const shared = await apiCall<{ shared: boolean }>(
      staff,
      'POST',
      `/documents/${document?.id ?? ''}/portal-share`,
      {},
    );
    expect(shared.status, JSON.stringify(shared.body)).toBeLessThan(300);
    expect(shared.body.shared).toBe(true);

    await staff.getByRole('tab', { name: 'Portal' }).click();
    await expect(staff.getByText('Nadie tiene acceso al portal')).toBeVisible();
    await staff.getByRole('button', { name: 'Invitar al paciente' }).click();
    await expect(staff.getByText('Invitación pendiente')).toBeVisible();
    await expect(
      staff.getByRole('button', { name: 'El paciente ya tiene acceso o una invitación' }),
    ).toBeDisabled();
  });

  // 2. The patient, on a phone, activates the access with the link of the invitation.
  const { context, page } = await visitor(browser);
  await test.step('the patient activates the access with the link of the email', async () => {
    const invitation = await emailTo(email, /Active su acceso al portal de pacientes/);
    // The invitation says nothing clinical: not a specialty, not a document name.
    expect(invitation).not.toContain(fileName);
    await page.goto(localLink(linkIn(invitation, '/public/t/')));
    await page.getByRole('button', { name: 'Activar mi acceso' }).click();
    await expect(page.getByText('Su acceso está activo')).toBeVisible();
  });

  // 3. Sign in with a code.
  await test.step('the patient signs in with the email and the code of the mailbox', async () => {
    await page.goto(urlOf('aillu', '/portal'));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Ingresar al portal de pacientes' }),
    ).toBeVisible();
    await expectFitsAndAccessible(page);
    // No staff navigation on the portal.
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toHaveCount(0);

    await page.getByLabel('Correo electrónico').fill(email);
    await page.getByRole('button', { name: 'Enviarme un código' }).click();
    await expect(page.getByRole('heading', { name: 'Escriba el código' })).toBeVisible();
    await expectFitsAndAccessible(page);

    // A wrong code says one thing, and the right one comes next.
    await page.getByLabel('Código de 6 dígitos').fill('000000');
    await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
    await expect(
      page.getByText('El código no es válido o ya venció. Pida uno nuevo e inténtelo otra vez.'),
    ).toBeVisible();

    const message = await emailTo(email, /Ingrese al portal de .*: su código/);
    await page.getByLabel('Código de 6 dígitos').fill(codeIn(message));
    await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
    await expect(page.getByText('Está viendo la información de')).toBeVisible();
    await expect(page.getByText(`Lucía ${patient.family}`).first()).toBeVisible();
  });

  // 4. Appointments.
  await test.step('the patient sees the appointment and confirms it', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Mis turnos' })).toBeVisible();
    await expect(page.getByText(appointment.typeName).first()).toBeVisible();
    await expect(
      page.locator('time').filter({ hasText: clockTime(appointment.startsAt) }),
    ).toBeVisible();
    await expectFitsAndAccessible(page);
    await page.getByRole('button', { name: 'Confirmar asistencia' }).click();
    await expect(page.getByText('Confirmado', { exact: true })).toBeVisible();
    await settleToasts(page);
    await expectFitsAndAccessible(page);
  });

  // 5. Documents: the shared one, downloaded through a link for this session.
  await test.step('the patient downloads the document that was shared', async () => {
    await page.getByRole('link', { name: 'Documentos' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Documentos' })).toBeVisible();
    await expect(page.getByText(fileName)).toBeVisible();
    await expectFitsAndAccessible(page);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: `Descargar ${fileName}` }).click();
    expect((await download).suggestedFilename()).toBe(fileName);
  });

  // 6. The sections that have nothing yet say so in plain words.
  await test.step('invoices, prescriptions and consents show their empty state', async () => {
    await page.getByRole('link', { name: 'Facturas' }).click();
    await expect(page.getByText('Todavía no hay facturas')).toBeVisible();
    await expectFitsAndAccessible(page);

    await page.getByRole('link', { name: 'Recetas' }).click();
    await expect(page.getByText('Todavía no hay recetas')).toBeVisible();
    await expectFitsAndAccessible(page);

    await page.getByRole('link', { name: 'Consentimientos' }).click();
    await expect(page.getByText('No tiene consentimientos')).toBeVisible();
    await expectFitsAndAccessible(page);
  });

  // 7. Own data and sessions.
  await test.step('the patient changes the contact data and sees where the account is open', async () => {
    await page.getByRole('link', { name: 'Mis datos' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Mis datos' })).toBeVisible();
    await expect(page.getByText(patient.document)).toBeVisible();
    await expectFitsAndAccessible(page);
    await page.getByLabel('Domicilio').fill('Calle Falsa 123');
    await page.getByRole('button', { name: 'Guardar los cambios' }).click();
    await expect(page.getByText('Guardamos sus datos de contacto.')).toBeVisible();
    await settleToasts(page);
    await expectFitsAndAccessible(page);

    await page.getByRole('link', { name: 'Sesiones' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sesiones' })).toBeVisible();
    await expect(page.getByText('Este dispositivo')).toBeVisible();
    await expectFitsAndAccessible(page);
  });

  // 8. A patient is not staff, and a staff session is not a portal session.
  await test.step('a patient cannot reach staff pages, and staff cannot use the portal', async () => {
    const asPatient = await page.request.get(urlOf('aillu', '/api/patients'));
    expect(asPatient.status()).toBe(401);
    const asPatientAgenda = await page.request.get(urlOf('aillu', '/api/appointments'));
    expect(asPatientAgenda.status()).toBe(401);
    await page.goto(urlOf('aillu', '/patients'));
    await expect(page).toHaveURL(/\/login/);

    const staffOnPortal = await staff.request.get(urlOf('aillu', '/api/portal/me'));
    expect(staffOnPortal.status()).toBe(401);
  });

  // 9. Signing out ends the session for good.
  await test.step('signing out closes the session', async () => {
    await page.goto(urlOf('aillu', '/portal'));
    await expect(page.getByText('Está viendo la información de')).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Ingresar al portal de pacientes' }),
    ).toBeVisible();
    const after = await page.request.get(urlOf('aillu', '/api/portal/me'));
    expect(after.status()).toBe(401);
    await expectFitsAndAccessible(page);
  });

  await context.close();
  await staffContext.close();
});

test('a patient registers with the DNI and the email on the record, and a mismatch looks exactly the same', async ({
  browser,
}) => {
  const staffContext = await browser.newContext(DESKTOP);
  const staff = await staffContext.newPage();
  await signInWithApi(staff.request, 'aillu', emailOf('reception'));
  const email = `registro.${String(Date.now())}@demo.invalid`;
  const patient = await registerPatient(staff, email);

  const { context, page } = await visitor(browser);
  await page.goto(urlOf('aillu', '/portal'));
  await page.getByRole('button', { name: 'Activar mi acceso' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Activar mi acceso' })).toBeVisible();
  await expectFitsAndAccessible(page);

  // A DNI that is not on the record: the same page, the same words, and no email.
  await page.getByLabel('DNI').fill('10200300');
  await page.getByLabel('Correo electrónico que le dio al consultorio').fill(email);
  await page.getByRole('button', { name: 'Enviarme un código' }).click();
  await expect(page.getByRole('heading', { name: 'Escriba el código' })).toBeVisible();
  await expect(page.getByText(/Si los datos coinciden con una ficha/)).toBeVisible();
  await expectFitsAndAccessible(page);

  // The data that match: the code arrives and opens the portal.
  await page.getByRole('button', { name: 'Cambiar los datos' }).click();
  await page.getByLabel('DNI').fill(patient.document);
  await page.getByLabel('Correo electrónico que le dio al consultorio').fill(email);
  await page.getByRole('button', { name: 'Enviarme un código' }).click();
  await expect(page.getByRole('heading', { name: 'Escriba el código' })).toBeVisible();
  const message = await emailTo(email, /Active su acceso al portal de .*: su código/);
  await page.getByLabel('Código de 6 dígitos').fill(codeIn(message));
  await page.getByRole('button', { name: 'Activar mi acceso' }).click();

  await expect(page.getByText('Está viendo la información de')).toBeVisible();
  await expect(page.getByText(`Lucía ${patient.family}`).first()).toBeVisible();
  await expectFitsAndAccessible(page);

  await context.close();
  await staffContext.close();
});
