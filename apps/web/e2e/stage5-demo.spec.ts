import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { apiCall, patientIdByDocument } from './support/clinical.js';
import { acquireErxLock } from './support/erx-lock.js';
import { OPERATOR_STATE } from './support/operator.js';
import { axeViolations, horizontalOverflow, openAs, settleToasts, urlOf } from './support/stack.js';

/**
 * The Stage 5 demonstration, end to end on the real stack at 360 px (S5.13; spec "e-prescription",
 * "informed consent" and "patient portal"). It is the walk a person does with the seeded
 * demonstration organization, in the order of the product:
 *
 * 1. the platform operator opens the queue of matriculas: the cardiologist's is verified (the seed
 *    asked the platform for it through the same function the console uses), the operator withdraws
 *    it, the professional is told she cannot prescribe, and the operator verifies it again;
 * 2. the professional prescribes to Valentina, who has portal access in the demonstration: the
 *    provider (the in-memory fake) confirms it;
 * 3. Valentina opens the portal and asks for a sign-in code; nothing is sent, so the operator reads
 *    the code in the demo outbox of the provider console, and Valentina signs in with it;
 * 4. she reads and signs, on the pad, the consent that waits for her (version 2 of the template: the
 *    one she revoked was version 1), and downloads the signed record;
 * 5. she downloads the prescription that was just issued from the list of her prescriptions.
 *
 * Axe and the width of the page are checked on every screen. The journey takes the e-prescription
 * lock for its whole length (it changes the matricula of the cardiologist, which the e-prescription
 * journey expects verified), and it consumes the consent that waits in the portal: like the other
 * Stage 5 journeys, it needs a fresh stack.
 */
test.use({
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
  storageState: OPERATOR_STATE,
});
test.setTimeout(420_000);

const ORGANIZATION = 'Centro Médico Aillu';
const CARDIOLOGIST = 'Dra. Lucía Paz Ferrer';
/** Valentina Gómez: a patient of the cardiologist, with the portal access the seed gave her. */
const PATIENT_DOCUMENT = '99000001';
const PATIENT_EMAIL = 'valentina.gomez@demo.invalid';
const PATIENT_NAME = 'Valentina Gómez';

const PHONE = {
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce' as const,
  locale: 'es-AR',
  timezoneId: 'America/Argentina/Buenos_Aires',
  serviceWorkers: 'block' as const,
};

async function expectFitsAndAccessible(page: Page) {
  await settleToasts(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

/** The six digits of a code email: the code is alone on its line. */
function codeIn(text: string): string {
  const code = /^\s*(\d{6})\s*$/m.exec(text)?.[1];
  expect(code, 'the message carries a six digit code').toBeDefined();
  return code ?? '';
}

/** The queue of matriculas in the console of the platform. */
async function openMatriculas(page: Page): Promise<Locator> {
  await page.goto(urlOf('platform', '/'));
  await page.getByRole('tab', { name: 'Matrículas' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Matrículas' });
  await expect(
    panel.getByRole('heading', { level: 1, name: 'Verificación de matrículas' }),
  ).toBeVisible();
  return panel;
}

const rowOf = (panel: Locator) =>
  panel.getByRole('row').filter({ hasText: CARDIOLOGIST }).filter({ hasText: ORGANIZATION });

/** The prescriptions of a patient, as the record of the professional lists them. */
async function prescriptionsOf(page: Page, patientId: string) {
  const response = await apiCall<{ prescriptions: { id: string; status: string }[] }>(
    page,
    'GET',
    `/patients/${patientId}/prescriptions`,
  );
  expect(response.status).toBe(200);
  return response.body.prescriptions;
}

/** Fills the first medication of the form of a prescription and picks the generic name. */
async function fillAmoxicillin(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Emitir receta' });
  await dialog.getByRole('combobox', { name: 'Nombre genérico' }).fill('amox');
  await dialog.getByRole('option', { name: 'Amoxicilina', exact: true }).click();
  await dialog.getByLabel('Dosis').fill('500 mg');
  await dialog.getByLabel('Forma farmacéutica').fill('comprimidos');
  await dialog.getByLabel('Cantidad').fill('21');
  await dialog.getByLabel('Indicaciones').fill('1 cada 8 horas durante 7 días');
  return dialog;
}

async function openPrescriptionsTab(page: Page, patientId: string) {
  await page.goto(urlOf('aillu', `/patients/${patientId}`));
  await page.getByRole('tab', { name: 'Recetas' }).click();
  await expect(page.getByRole('heading', { name: 'Recetas del paciente' })).toBeVisible();
}

/** The operator reads what the demonstration sent to an address, in the provider console. */
async function openDemoOutbox(page: Page, address: string): Promise<Locator> {
  await page.goto(urlOf('platform', '/'));
  await page.getByRole('tab', { name: 'Proveedores' }).click();
  await page.getByRole('tab', { name: 'Correo de la demo' }).click();
  await page.getByRole('searchbox', { name: 'Filtrar por dirección' }).fill(address);
  await page.getByRole('button', { name: 'Filtrar' }).click();
  return page.getByRole('article', { name: /Ingrese al portal de .*: su código/ });
}

test('the operator verifies a matricula, the professional prescribes, and the patient signs a consent and downloads the prescription in the portal', async ({
  page,
  browser,
}) => {
  const release = await acquireErxLock();
  try {
    await journey(page, browser);
  } finally {
    // Whatever happened, the cardiologist ends verified, as the demonstration ships.
    await restoreVerification(page).catch(() => undefined);
    release();
  }
});

/** Puts the cardiologist's verification back if the journey stopped while it was withdrawn. */
async function restoreVerification(page: Page) {
  const panel = await openMatriculas(page);
  await panel.getByRole('button', { name: 'Pendientes' }).click();
  const pending = rowOf(panel);
  if ((await pending.count()) === 0) return;
  await pending.getByRole('button', { name: `Verificar matrícula de ${CARDIOLOGIST}` }).click();
  await page
    .getByRole('dialog', { name: 'Verificar matrícula' })
    .getByRole('button', { name: 'Verificar matrícula' })
    .click();
  await expect(pending).toHaveCount(0);
}

async function journey(page: Page, browser: Browser) {
  // 1. The operator's queue: the seed verified the cardiologist, the operator withdraws and verifies again.
  const panel = await openMatriculas(page);
  await panel.getByRole('button', { name: 'Verificadas' }).click();
  const verified = rowOf(panel);
  await expect(verified).toContainText('Verificada');
  await expect(verified).toContainText('AR-C');
  await expect(verified).toContainText('41258');
  await expect(verified).toContainText('Verificada en la siembra de la demostración.');
  await expectFitsAndAccessible(page);

  await verified
    .getByRole('button', { name: `Retirar la verificación de ${CARDIOLOGIST}` })
    .click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Retirar verificación' }).click();
  await expect(verified).toHaveCount(0);

  // The professional cannot prescribe while the platform has not vouched for the registration.
  const professionalContext = await browser.newContext(PHONE);
  const professional = await professionalContext.newPage();
  await openAs(professional, 'cardiology', '/');
  const patientId = await patientIdByDocument(professional, PATIENT_DOCUMENT);
  await openPrescriptionsTab(professional, patientId);
  await expect(professional.getByText('Su matrícula todavía no está verificada')).toBeVisible();
  await expect(professional.getByRole('button', { name: 'Emitir receta' })).toBeDisabled();
  await expectFitsAndAccessible(professional);

  // The operator checks the registration and verifies it again.
  await panel.getByRole('button', { name: 'Pendientes' }).click();
  const pending = rowOf(panel);
  await expect(pending).toContainText('Sin verificar');
  await pending.getByRole('button', { name: `Verificar matrícula de ${CARDIOLOGIST}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Verificar matrícula' });
  await dialog.getByLabel('Nota (opcional)').fill('Vigente según el colegio de médicos.');
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Verificar matrícula' }).click();
  await expect(pending).toHaveCount(0);

  // 2. The professional prescribes to the patient of the portal.
  await professional.reload();
  await professional.getByRole('tab', { name: 'Recetas' }).click();
  await expect(professional.getByRole('button', { name: 'Emitir receta' })).toBeEnabled();
  const shipped = await prescriptionsOf(professional, patientId);
  await professional.getByRole('button', { name: 'Emitir receta' }).click();
  const form = await fillAmoxicillin(professional);
  await expectFitsAndAccessible(professional);
  await form.getByRole('button', { name: 'Emitir receta' }).click();
  await expect(form).toBeHidden();
  await expect(professional.getByText('Receta emitida.')).toBeVisible();
  const issued = professional
    .getByRole('article')
    .filter({ hasText: 'Amoxicilina 500 mg, comprimidos, cantidad 21' });
  await expect(issued).toHaveCount(1);
  await expect(issued).toContainText('Emitida');
  await expect(issued).toContainText('Simulada');
  await expectFitsAndAccessible(professional);
  // The two the demonstration shipped (one dispensed, one issued) and the one just issued.
  const after = await prescriptionsOf(professional, patientId);
  expect(shipped.map((row) => row.status).sort()).toEqual(['dispensed', 'issued']);
  expect(after.map((row) => row.status).sort()).toEqual(['dispensed', 'issued', 'issued']);
  const justIssued = after.find((row) => !shipped.some((old) => old.id === row.id));
  expect(justIssued, 'the prescription just issued').toBeDefined();
  await professionalContext.close();

  // 3. The patient asks for a sign-in code; nothing is sent, so the operator reads it in the demo outbox.
  const console_ = page;
  const messages = await openDemoOutbox(console_, PATIENT_EMAIL);
  await expect(console_.getByText('La demo todavía no envió ningún correo.')).toBeVisible();
  await expectFitsAndAccessible(console_);

  const patientContext = await browser.newContext(PHONE);
  const patient = await patientContext.newPage();
  await patient.goto(urlOf('aillu', '/portal'));
  await expect(
    patient.getByRole('heading', { level: 1, name: 'Ingresar al portal de pacientes' }),
  ).toBeVisible();
  await expectFitsAndAccessible(patient);
  await patient.getByLabel('Correo electrónico').fill(PATIENT_EMAIL);
  await patient.getByRole('button', { name: 'Enviarme un código' }).click();
  await expect(patient.getByRole('heading', { name: 'Escriba el código' })).toBeVisible();

  await expect(messages).toHaveCount(1, { timeout: 60_000 });
  const code = codeIn(await messages.first().innerText());
  await expectFitsAndAccessible(console_);

  await patient.getByLabel('Código de 6 dígitos').fill(code);
  await patient.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(patient.getByText('Está viendo la información de')).toBeVisible();
  await expect(patient.getByText(PATIENT_NAME).first()).toBeVisible();
  await expectFitsAndAccessible(patient);

  // 4. The consent that waits in the portal: version 2, read in full and signed on the pad.
  await patient.getByRole('link', { name: 'Consentimientos' }).click();
  await expect(patient.getByText('Para firmar')).toBeVisible();
  await expect(patient.getByText('Revocado')).toBeVisible();
  await expectFitsAndAccessible(patient);
  await patient.getByRole('link', { name: /Leer y firmar/ }).click();
  await expect(patient.getByRole('article', { name: 'Texto del consentimiento' })).toContainText(
    'Aclaración de la segunda versión',
  );
  await patient.getByLabel('Escriba su nombre completo').fill(PATIENT_NAME);
  await patient.getByRole('checkbox', { name: /Leí el documento completo/ }).click();
  const pad = patient.getByRole('img', { name: /Espacio para dibujar la firma/ });
  const box = await pad.boundingBox();
  expect(box, 'the pad is on screen').not.toBeNull();
  if (box) {
    await patient.mouse.move(box.x + 20, box.y + 40);
    await patient.mouse.down();
    await patient.mouse.move(box.x + box.width / 2, box.y + 100, { steps: 6 });
    await patient.mouse.move(box.x + box.width - 20, box.y + 50, { steps: 6 });
    await patient.mouse.up();
  }
  await expect(patient.getByRole('img', { name: /Firma dibujada/ })).toBeVisible();
  await expectFitsAndAccessible(patient);
  await patient.getByRole('button', { name: 'Firmar el documento' }).click();
  await expect(patient.getByText('El documento quedó firmado.')).toBeVisible();
  await settleToasts(patient);
  const signedRecord = patient.waitForEvent('download');
  await patient.getByRole('button', { name: /Descargar el consentimiento firmado:/ }).click();
  expect((await signedRecord).suggestedFilename()).toMatch(/\.pdf$/);
  await expectFitsAndAccessible(patient);

  // 5. The prescription, from the list: the newest is the one just issued.
  await patient.getByRole('link', { name: 'Recetas' }).click();
  await expect(patient.getByRole('heading', { level: 1, name: 'Recetas' })).toBeVisible();
  await expect(patient.getByText('Vigente')).toHaveCount(2);
  await expect(patient.getByText('Entregada')).toHaveCount(1);
  await expectFitsAndAccessible(patient);
  const prescription = patient.waitForEvent('download');
  await patient
    .getByRole('button', { name: /Descargar la receta/ })
    .first()
    .click();
  // The file is named after the prescription just issued, which is the newest of the list.
  const named = (await prescription).suggestedFilename();
  expect(named).toMatch(/^receta-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.pdf$/);
  expect(named).toContain((justIssued?.id ?? 'missing').slice(-8));

  // The patient is not staff: the session of the portal opens no staff API.
  const asPatient = await patient.request.get(urlOf('aillu', '/api/patients'));
  expect(asPatient.status()).toBe(401);
  await patient.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(
    patient.getByRole('heading', { level: 1, name: 'Ingresar al portal de pacientes' }),
  ).toBeVisible();
  await patientContext.close();
}
