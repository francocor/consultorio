import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { apiCall, patientIdByDocument } from './support/clinical.js';
import { acquireErxLock } from './support/erx-lock.js';
import { OPERATOR_STATE } from './support/operator.js';
import {
  axeViolations,
  horizontalOverflow,
  openAs,
  originOf,
  settleToasts,
  urlOf,
} from './support/stack.js';

/**
 * E-prescription from the record of a patient, on the real stack (Stage 5, track A3; spec
 * "e-prescription"), at 360 px. The demonstration organization prescribes through the in-memory
 * provider, which the provider console can put in an outage:
 *
 * 1. a professional whose matricula the platform has not verified is told so and cannot issue;
 * 2. the cardiologist (verified) issues a prescription: the provider confirms it, it is "Emitida",
 *    marked as simulated, and its PDF downloads;
 * 3. the provider goes down: the next prescription stays "Pendiente de envío", is never shown as
 *    valid, and when the provider is back one retry issues it ONCE (the provider holds exactly one);
 * 4. the provider reports the first one dispensed (the console notifies the webhook): the screen shows it;
 * 5. a mistaken prescription is cancelled with a reason and stays visible;
 * 6. reception sees no content: the API refuses and the record has no prescriptions tab.
 *
 * Axe and the width of the page are checked on every screen.
 */
test.use({
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
});
test.setTimeout(240_000);

/** The cardiologist treats patients 99000001 to 99000005 and 99000009; the clinical journeys use the others. */
const PATIENT_DOCUMENT = '99000002';

async function expectFitsAndAccessible(page: Page) {
  await settleToasts(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

/** The provider console puts the provider of the demonstration organizations in a mode. */
async function setErxMode(operator: APIRequestContext, mode: 'ok' | 'down') {
  const response = await operator.put(urlOf('platform', '/api/operator/dev/erx/mode'), {
    data: { mode },
    headers: { origin: originOf('platform') },
  });
  expect(response.status(), await response.text()).toBe(200);
}

interface PrescriptionRow {
  id: string;
  status: string;
  externalId: string | null;
  cancelReason: string | null;
}

const prescriptionsOf = async (page: Page, patientId: string) =>
  (
    await apiCall<{ prescriptions: PrescriptionRow[] }>(
      page,
      'GET',
      `/patients/${patientId}/prescriptions`,
    )
  ).body.prescriptions;

/** The prescriptions on screen that wear this state as their badge (exactly: "Emitida el" is a label). */
const withState = (page: Page, state: string) =>
  page.getByRole('article').filter({ has: page.getByText(state, { exact: true }) });

/**
 * Selects a tab of the record. At 360 px the row of tabs scrolls sideways and the tab that a click
 * reaches depends on where the row happens to rest, so a click can select a neighbour. Focusing the
 * tab selects it (automatic activation of the tabs), which does not depend on the pointer.
 */
async function openTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name });
  await expect(async () => {
    await tab.focus({ timeout: 2000 });
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
}

/** Opens the prescriptions tab of the record of a patient. */
async function openPrescriptionsTab(page: Page, patientId: string) {
  await page.goto(urlOf('aillu', `/patients/${patientId}`));
  await openTab(page, 'Recetas');
  await expect(page.getByRole('heading', { name: 'Recetas del paciente' })).toBeVisible();
}

/** Fills the first medication of the form and picks the generic name from the suggestions. */
async function fillAmoxicillin(page: Page, quantity: string) {
  const dialog = page.getByRole('dialog', { name: 'Emitir receta' });
  await dialog.getByRole('combobox', { name: 'Nombre genérico' }).fill('amox');
  await dialog.getByRole('option', { name: 'Amoxicilina', exact: true }).click();
  await dialog.getByLabel('Dosis').fill('500 mg');
  await dialog.getByLabel('Forma farmacéutica').fill('comprimidos');
  await dialog.getByLabel('Cantidad').fill(quantity);
  await dialog.getByLabel('Indicaciones').fill('1 cada 8 horas durante 7 días');
  return dialog;
}

test('a prescription is issued, rides out an outage once, is dispensed and cancelled, and reception sees none of it', async ({
  page,
  browser,
  playwright,
}) => {
  // The provider of the demonstration is one for the whole stack: no other journey may change its mode meanwhile.
  const release = await acquireErxLock();
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  await setErxMode(operator, 'ok');
  try {
    // 1. A professional whose matricula the platform has not verified.
    const pediatrician = await (await browser.newContext()).newPage();
    await openAs(pediatrician, 'pediatrics', '/');
    const patientId = await patientIdByDocument(pediatrician, PATIENT_DOCUMENT);
    await openPrescriptionsTab(pediatrician, patientId);
    await expect(pediatrician.getByText('Su matrícula todavía no está verificada')).toBeVisible();
    await expect(pediatrician.getByRole('button', { name: 'Emitir receta' })).toBeDisabled();
    await expectFitsAndAccessible(pediatrician);
    const refused = await apiCall<{ code: string }>(pediatrician, 'POST', '/prescriptions', {
      clientKey: crypto.randomUUID(),
      patientId,
      items: [
        {
          genericName: 'Amoxicilina',
          dose: '500 mg',
          form: 'comprimidos',
          quantity: 21,
          instructions: '1 cada 8 horas',
        },
      ],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('prescription_matricula_unverified');

    // 2. The cardiologist issues one.
    await openAs(page, 'cardiology', '/');
    await openPrescriptionsTab(page, patientId);
    await expect(page.getByText('Recetas de prueba')).toBeVisible();
    await expectFitsAndAccessible(page);

    await page.getByRole('button', { name: 'Emitir receta' }).click();
    let dialog = await fillAmoxicillin(page, '21');
    await expectFitsAndAccessible(page);
    await dialog.getByRole('button', { name: 'Emitir receta' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Receta emitida.')).toBeVisible();

    const first = withState(page, 'Emitida');
    await expect(first).toHaveCount(1);
    await expect(first).toContainText('Amoxicilina 500 mg, comprimidos, cantidad 21');
    await expect(first).toContainText('Simulada');
    await expect(first).toContainText(/ERX-[0-9A-F]{12}/);
    await expectFitsAndAccessible(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      first.getByRole('button', { name: 'Descargar PDF' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^receta-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.pdf$/);

    const afterFirst = await prescriptionsOf(page, patientId);
    const firstIssued = afterFirst.find((row) => row.status === 'issued');
    expect(firstIssued?.externalId).toMatch(/^ERX-[0-9A-F]{12}$/);

    // 3. The provider goes down: the next prescription is pending, never valid.
    await setErxMode(operator, 'down');
    await page.getByRole('button', { name: 'Emitir receta' }).click();
    dialog = await fillAmoxicillin(page, '14');
    await dialog.getByRole('button', { name: 'Emitir receta' }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText('quedó pendiente y no es válida hasta que lo confirme'),
    ).toBeVisible();

    const waiting = withState(page, 'Pendiente de envío');
    await expect(waiting).toHaveCount(1);
    await expect(waiting).toContainText('El proveedor todavía no la confirmó');
    await expect(waiting.getByRole('button', { name: 'Descargar PDF' })).toHaveCount(0);
    await expectFitsAndAccessible(page);
    const pending = (await prescriptionsOf(page, patientId)).find(
      (row) => row.status === 'pending_submission',
    );
    expect(pending?.externalId).toBeNull();

    // The provider is back: one retry issues it, and the provider holds exactly one more.
    await setErxMode(operator, 'ok');
    await waiting.getByRole('button', { name: 'Reintentar ahora' }).click();
    await expect(withState(page, 'Pendiente de envío')).toHaveCount(0);
    const afterRetry = await prescriptionsOf(page, patientId);
    expect(afterRetry.filter((row) => row.status === 'issued')).toHaveLength(2);
    expect(afterRetry.some((row) => row.status === 'pending_submission')).toBe(false);
    expect(new Set(afterRetry.map((row) => row.externalId)).size).toBe(afterRetry.length);
    await expectFitsAndAccessible(page);

    // 4. The provider reports the first one dispensed; the console notifies the webhook.
    const advanced = await operator.post(urlOf('platform', '/api/operator/dev/erx/advance'), {
      data: { externalId: firstIssued?.externalId, to: 'dispensed' },
      headers: { origin: originOf('platform') },
    });
    expect(advanced.status(), await advanced.text()).toBe(200);
    await expect
      .poll(
        async () =>
          (await prescriptionsOf(page, patientId)).find((row) => row.id === firstIssued?.id)
            ?.status,
        { timeout: 60_000, intervals: [2000] },
      )
      .toBe('dispensed');
    await page.reload();
    await openTab(page, 'Recetas');
    await expect(withState(page, 'Dispensada')).toHaveCount(1);
    await expectFitsAndAccessible(page);

    // 5. A mistaken prescription is cancelled with a reason, through the provider, and stays visible.
    const mistaken = withState(page, 'Emitida').first();
    await mistaken.getByRole('button', { name: 'Anular' }).click();
    const cancel = page.getByRole('dialog', { name: 'Anular receta' });
    await expect(cancel.getByRole('button', { name: 'Anular receta' })).toBeDisabled();
    await cancel.getByLabel('Motivo de la anulación').fill('Error en la dosis');
    await expectFitsAndAccessible(page);
    await cancel.getByRole('button', { name: 'Anular receta' }).click();
    await expect(cancel).toBeHidden();
    const cancelled = withState(page, 'Anulada');
    await expect(cancelled).toHaveCount(1);
    await expect(cancelled).toContainText('Error en la dosis');
    expect((await prescriptionsOf(page, patientId)).some((row) => row.status === 'cancelled')).toBe(
      true,
    );
    await expectFitsAndAccessible(page);

    // 6. Reception sees no content.
    const reception = await (await browser.newContext()).newPage();
    await openAs(reception, 'reception', '/');
    const list = await apiCall(reception, 'GET', `/patients/${patientId}/prescriptions`);
    expect(list.status).toBe(403);
    await reception.goto(urlOf('aillu', `/patients/${patientId}`));
    await expect(reception.getByRole('tablist')).toBeVisible();
    await expect(reception.getByRole('tab', { name: 'Recetas' })).toHaveCount(0);
    await reception.goto(urlOf('aillu', '/prescriptions'));
    await expect(reception.getByText('No tiene acceso a esta sección')).toBeVisible();
    await expectFitsAndAccessible(reception);
  } finally {
    await setErxMode(operator, 'ok').catch(() => undefined);
    await operator.dispose();
    release();
  }
});
