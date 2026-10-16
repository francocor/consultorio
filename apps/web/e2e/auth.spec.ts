import { expect, test } from '@playwright/test';

import {
  axeViolations,
  emailOf,
  emailTo,
  linkIn,
  localLink,
  originOf,
  signInWithForm,
  stack,
  totpCode,
  urlOf,
} from './support/stack.js';

/**
 * Sign-in journeys. They change accounts (a second factor, a password, a lock), so each uses an
 * account of the second organization that no other spec touches. Run them on a fresh stack.
 */
test.describe.configure({ mode: 'serial' });

test('a person signs in with the form, sees their organization and signs out', async ({ page }) => {
  await signInWithForm(page, 'aillu', emailOf('reception'));

  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Bienvenido a Centro Médico Aillu',
  );
  await page.getByRole('button', { name: 'Menú de la cuenta' }).click();
  await expect(page.getByText(emailOf('reception'))).toBeVisible();
  await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();

  await expect(page).toHaveURL(/\/login$/);
  // The session is gone: the shell is not reachable any more.
  await page.goto(urlOf('aillu', '/patients'));
  await expect(page).toHaveURL(/\/login\?redirect=%2Fpatients/);
});

test('a wrong password and an unknown account get the same message', async ({ page }) => {
  await signInWithForm(page, 'aillu', emailOf('reception'), 'una-clave-que-no-es');
  const wrongPassword = await page.getByRole('alert').textContent();

  await signInWithForm(page, 'aillu', 'nadie@demo.invalid', 'una-clave-que-no-es');
  const unknownAccount = await page.getByRole('alert').textContent();

  expect(wrongPassword).toContain('El correo o la contraseña no son correctos');
  expect(unknownAccount).toBe(wrongPassword);
});

test('after ten wrong attempts the account is locked and the screen says nothing different', async ({
  page,
  request,
}) => {
  const email = emailOf('psychology', 'norte');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await request.post(urlOf('norte', '/api/auth/login'), {
      data: { email, password: `intento-${String(attempt)}-incorrecto` },
      headers: { origin: originOf('norte') },
    });
  }

  // Even the right password is refused now, and the message is the generic one.
  await signInWithForm(page, 'norte', email);

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('El correo o la contraseña no son correctos');
  await expect(alert).not.toContainText(/bloque/i);
  expect(await axeViolations(page)).toEqual([]);
});

test('the second factor: enroll in the account page, then sign in with a code', async ({
  page,
}) => {
  const email = emailOf('pediatrics', 'norte');
  await signInWithForm(page, 'norte', email);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bienvenido a Clínica Norte');

  await page.goto(urlOf('norte', '/account/security'));
  await page.getByRole('button', { name: 'Activar la verificación' }).click();
  await expect(page.getByRole('img', { name: /Código QR/ })).toBeVisible();
  const secret = (await page.locator('code').first().textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

  await page.getByLabel('Código de verificación').fill(totpCode(secret));
  await page.getByRole('button', { name: 'Confirmar y activar' }).click();
  const codes = page.getByRole('list', { name: 'Lista de códigos de recuperación' });
  await expect(codes.getByRole('listitem')).toHaveCount(10);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Ya los guardé' }).click();
  await expect(page.getByText('Activada')).toBeVisible();

  // Sign out and back in: now the code is asked after the password.
  await page.getByRole('button', { name: 'Menú de la cuenta' }).click();
  await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
  await signInWithForm(page, 'norte', email);
  await expect(page.getByRole('heading', { name: 'Verificación en dos pasos' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The code of the next 30-second step: the one used to enroll cannot be replayed.
  await page.getByLabel('Código de verificación').fill(totpCode(secret, Date.now() + 30_000));
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bienvenido a Clínica Norte');
});

test('recovering access: the email arrives, the link sets a new password and the old one stops working', async ({
  page,
}) => {
  const email = emailOf('reception-north', 'norte');
  const newPassword = 'una nueva frase para entrar 2026';

  await page.goto(urlOf('norte', '/forgot-password'));
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByRole('button', { name: 'Enviar instrucciones' }).click();
  await expect(page.getByRole('heading', { name: 'Revise su correo' })).toBeVisible();

  const body = await emailTo(email, /contraseña/i);
  const link = localLink(linkIn(body, '/reset-password'));
  await page.goto(link);
  await page.getByLabel('Contraseña nueva').fill(newPassword);
  await page.getByLabel('Repetir contraseña').fill(newPassword);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page.getByRole('heading', { name: 'Contraseña actualizada' })).toBeVisible();

  // The link works once.
  await page.goto(link);
  await page.getByLabel('Contraseña nueva').fill(`${newPassword} otra vez`);
  await page.getByLabel('Repetir contraseña').fill(`${newPassword} otra vez`);
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page.getByRole('alert')).toContainText('Este enlace venció o ya se usó');

  await signInWithForm(page, 'norte', email, stack.demoPassword);
  await expect(page.getByRole('alert')).toContainText('El correo o la contraseña no son correctos');
  await signInWithForm(page, 'norte', email, newPassword);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bienvenido a Clínica Norte');
});
