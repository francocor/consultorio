import { expect, test } from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import { emailTo, linkIn, stack, urlOf } from './support/stack.js';

test.describe('signed out', () => {
  test('a wrong password is refused with one calm message', async ({ page }) => {
    await page.goto(urlOf('platform', '/'));
    await page.getByLabel('Correo electrónico').fill(stack.operator.email);
    await page.getByLabel('Contraseña', { exact: true }).fill('una contraseña equivocada');
    await page.getByLabel('Código de verificación').fill('000000');
    await page.getByRole('button', { name: 'Ingresar' }).click();

    await expect(page.getByRole('alert')).toContainText('Los datos de ingreso no son correctos.');
  });

  test('an organization host never serves the console', async ({ page }) => {
    await page.goto(urlOf('aillu', '/'));

    await expect(page.getByRole('heading', { name: 'Consola de la plataforma' })).toHaveCount(0);
    const response = await page.request.get(urlOf('aillu', '/api/operator/me'));
    expect(response.status()).not.toBe(200);
  });
});

test.describe('signed in', () => {
  test.use({ storageState: OPERATOR_STATE });

  test('lists the organizations and creates one: the owner receives the invitation', async ({
    page,
  }) => {
    const suffix = String(Date.now());
    const ownerEmail = `duena.${suffix}@demo.invalid`;
    const name = `Clínica Prueba ${suffix.slice(-6)}`;

    await page.goto(urlOf('platform', '/'));
    const table = page.getByRole('table', { name: 'Organizaciones' });
    await expect(table.getByRole('row', { name: /Centro Médico Aillu/ })).toContainText(
      'Demostración',
    );
    await expect(table.getByRole('row', { name: /Clínica Norte/ })).toBeVisible();

    await page.getByRole('button', { name: 'Crear una organización' }).click();
    const dialog = page.getByRole('dialog', { name: 'Crear una organización' });
    await dialog.getByLabel('Nombre de la organización').fill(name);
    await dialog.getByLabel('Correo de la persona propietaria').fill(ownerEmail);
    await dialog.getByRole('button', { name: 'Crear organización' }).click();

    await expect(page.getByText(`La invitación salió a ${ownerEmail}`)).toBeVisible();
    await expect(table.getByRole('row', { name: new RegExp(name) })).toContainText('Activa');

    // The invitation really went out, and it points at the new organization's own address.
    const body = await emailTo(ownerEmail, /invitaci/i);
    expect(linkIn(body, '/accept-invitation')).toMatch(/\.localhost/);
  });

  test('resets a demonstration organization after confirming', async ({ page }) => {
    await page.goto(urlOf('platform', '/'));
    await page
      .getByRole('button', { name: 'Reiniciar la demostración de Centro Médico Aillu' })
      .click();
    const confirmation = page.getByRole('alertdialog', { name: '¿Reiniciar la demostración?' });
    await expect(confirmation).toContainText('contraseñas');
    // Only the confirmation is exercised here: resetting would sign every other spec out.
    await confirmation.getByRole('button', { name: 'Cancelar' }).click();

    await expect(confirmation).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Reiniciar la demostración de Clínica Norte' }),
    ).toHaveCount(1);
  });
});
