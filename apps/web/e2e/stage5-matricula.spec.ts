import { expect, test, type Browser, type Page } from '@playwright/test';

import { acquireErxLock } from './support/erx-lock.js';
import { OPERATOR_STATE } from './support/operator.js';
import { axeViolations, openAs, urlOf } from './support/stack.js';

/**
 * Matricula verification (STF-04, S5.01): only the platform operator verifies a registration, the
 * organization sees the result in its team page, and the operator can withdraw it. The journey ends
 * where it started (unverified), so the rest of the suite finds the demo as it was.
 *
 * The professional of the first journey is the pediatrician, whom the e-prescription journey expects
 * unverified; the cardiologist, whom that journey needs verified, is verified when the stack starts
 * and is not touched here. The first journey takes the lock that the e-prescription journey holds, so
 * the two never overlap on two workers.
 */
test.use({ storageState: OPERATOR_STATE, reducedMotion: 'reduce' });

const PROFESSIONAL = 'Dr. Mateo Rivas Ibarra';
const ORGANIZATION = 'Centro Médico Aillu';

test('the operator verifies a registration, the organization sees it, and the operator withdraws it', async ({
  page,
  browser,
}) => {
  const release = await acquireErxLock();
  try {
    await journey(page, browser);
  } finally {
    release();
  }
});

async function journey(page: Page, browser: Browser) {
  await page.goto(urlOf('platform', '/'));
  await page.getByRole('tab', { name: 'Matrículas' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Matrículas' });
  await expect(
    panel.getByRole('heading', { level: 1, name: 'Verificación de matrículas' }),
  ).toBeVisible();

  // The registration waits in the queue with what the operator needs to check it, and no more.
  const pending = panel
    .getByRole('row')
    .filter({ hasText: PROFESSIONAL })
    .filter({ hasText: ORGANIZATION });
  await expect(pending).toContainText('AR-B');
  await expect(pending).toContainText('188204');
  await expect(pending).toContainText('Sin verificar');
  expect(await axeViolations(page)).toEqual([]);

  // The organization's owner sees the same registration as unverified.
  const owner = await (await browser.newContext()).newPage();
  await openAs(owner, 'owner', '/staff');
  const card = owner.getByRole('listitem').filter({ hasText: PROFESSIONAL });
  await expect(card).toContainText('Sin verificar');

  await pending.getByRole('button', { name: `Verificar matrícula de ${PROFESSIONAL}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Verificar matrícula' });
  await expect(dialog).toContainText('188204');
  await dialog.getByLabel('Nota (opcional)').fill('Vigente según el colegio de médicos.');
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Verificar matrícula' }).click();
  await expect(pending).toHaveCount(0);

  // It moved to the verified list, with the day, and the owner sees it verified.
  await panel.getByRole('button', { name: 'Verificadas' }).click();
  const verified = panel
    .getByRole('row')
    .filter({ hasText: PROFESSIONAL })
    .filter({ hasText: ORGANIZATION });
  await expect(verified).toContainText('Verificada');
  await expect(verified).toContainText('Vigente según el colegio de médicos.');
  await owner.reload();
  await expect(card).toContainText('Verificada');

  // Withdrawing it puts the professional back in the queue and closes prescribing again.
  await verified
    .getByRole('button', { name: `Retirar la verificación de ${PROFESSIONAL}` })
    .click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Retirar verificación' }).click();
  await expect(verified).toHaveCount(0);
  await owner.reload();
  await expect(card).toContainText('Sin verificar');
  await panel.getByRole('button', { name: 'Pendientes' }).click();
  await expect(pending).toBeVisible();
}

test('the note is saved on its own and stays with the registration', async ({ page }) => {
  await page.goto(urlOf('platform', '/'));
  await page.getByRole('tab', { name: 'Matrículas' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Matrículas' });
  const row = panel
    .getByRole('row')
    .filter({ hasText: 'Julia Costa Maidana' })
    .filter({ hasText: ORGANIZATION });

  await row.getByRole('button', { name: 'Editar la nota de Lic. Julia Costa Maidana' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nota de la matrícula' });
  await dialog.getByLabel('Nota', { exact: true }).fill('Se consultó al colegio, falta respuesta.');
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Guardar nota' }).click();
  await expect(row).toContainText('Se consultó al colegio, falta respuesta.');

  await page.reload();
  await page.getByRole('tab', { name: 'Matrículas' }).click();
  await expect(row).toContainText('Se consultó al colegio, falta respuesta.');

  // Leave the demo as it was.
  await row.getByRole('button', { name: 'Editar la nota de Lic. Julia Costa Maidana' }).click();
  await page
    .getByRole('dialog', { name: 'Nota de la matrícula' })
    .getByLabel('Nota', { exact: true })
    .fill('');
  await page.getByRole('button', { name: 'Guardar nota' }).click();
  await expect(row).toContainText('Sin nota');
});
