import { expect, test } from '@playwright/test';

import {
  axeViolations,
  emailTo,
  linkIn,
  localLink,
  openAs,
  signInWithForm,
  urlOf,
} from './support/stack.js';

/**
 * The team journeys: the owner invites a person, the person accepts and signs in, and reception
 * cannot open the team page. The invited person is unique to each run.
 */
test('the owner invites reception; the invitation arrives, is accepted and the person signs in with the role they were given', async ({
  page,
  browser,
}) => {
  const email = `nuevo.${String(Date.now())}@demo.invalid`;
  const password = 'una frase larga para recepción 2026';

  await openAs(page, 'owner', '/staff');
  await expect(page.getByRole('heading', { level: 1, name: 'Equipo' })).toBeVisible();
  await page.getByRole('button', { name: 'Invitar a una persona' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invitar a una persona' });
  await dialog.getByLabel('Correo electrónico').fill(email);
  await dialog.getByLabel('Nombre para mostrar').fill('Nora Gil');
  await dialog.getByRole('checkbox', { name: /Recepción/ }).click();
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Enviar invitación' }).click();
  await expect(
    page.getByText(new RegExp(`Invitación enviada a ${email.replace('.', '\\.')}`)),
  ).toBeVisible();

  // The person opens the emailed link in their own browser, chooses a password and signs in.
  const invitee = await (await browser.newContext()).newPage();
  const body = await emailTo(email, /invitación|invitaci/i);
  await invitee.goto(localLink(linkIn(body, '/accept-invitation')));
  await expect(invitee.getByRole('heading', { name: 'Active su cuenta' })).toBeVisible();
  await invitee.getByLabel('Contraseña', { exact: true }).fill(password);
  await invitee.getByLabel('Repetir contraseña').fill(password);
  await invitee.getByRole('button', { name: 'Activar cuenta' }).click();
  await expect(invitee.getByRole('heading', { name: 'Su cuenta está activa' })).toBeVisible();

  await signInWithForm(invitee, 'aillu', email, password);
  await expect(invitee.getByRole('heading', { level: 1 })).toContainText(
    'Bienvenido a Centro Médico Aillu',
  );
  const navigation = invitee.getByRole('navigation', { name: 'Navegación principal' });
  await expect(navigation.getByRole('link', { name: 'Pacientes' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Equipo' })).toHaveCount(0);

  // The new person is in the owner's directory with the role they were given.
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: 'Nora Gil' });
  await expect(row).toContainText('Recepción');

  // And reception cannot open the team page by typing its address.
  await invitee.goto(urlOf('aillu', '/staff'));
  await expect(
    invitee.getByRole('heading', { name: 'No tiene acceso a esta sección' }),
  ).toBeVisible();
});

test('reception opening the staff page sees the forbidden state', async ({ page }) => {
  await openAs(page, 'reception', '/staff');

  await expect(page.getByRole('heading', { name: 'No tiene acceso a esta sección' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ir al inicio' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test('an administrator cannot offer the owner role', async ({ page }) => {
  await openAs(page, 'admin', '/staff');
  await page.getByRole('button', { name: 'Invitar a una persona' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invitar a una persona' });

  await expect(dialog.getByRole('checkbox', { name: /Administración/ })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /Propietario/ })).toHaveCount(0);
});
