import { expect, test } from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import {
  apiOf,
  bookAsPatient,
  expectFitsAndAccessible,
  visitor,
} from './support/public-booking.js';
import { WEB_PORT, emailTo, linkIn, originOf, stack } from './support/stack.js';

/**
 * The owner of a new organization opens online booking from Settings, on a phone: creates the
 * link of the organization and the link of a professional, copies the address, looks at the QR
 * code, and then a patient who knows nothing but that address books through it. Axe and the width
 * of the page are checked on every screen at 360 px.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
test.setTimeout(240_000);

const OWNER_PASSWORD = 'una frase larga para la titular 2026';
const PROFESSIONAL = 'Dra. Lucía Enlaces';

test('the owner creates a link in Settings, shares it, and a patient books through it', async ({
  page,
  browser,
  playwright,
}) => {
  const suffix = String(Date.now() + 23);
  const ownerEmail = `enlaces.${suffix}@demo.invalid`;

  // A real organization, with an owner who is also its professional (quick setup, through the API).
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const created = await operator.post(`${originOf('platform')}/api/operator/tenants`, {
    data: { name: `Consultorio Enlaces ${suffix.slice(-6)}`, ownerEmail, isDemo: false },
    headers: { origin: originOf('platform') },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const slug = ((await created.json()) as { tenant: { slug: string } }).tenant.slug;
  const origin = `http://${slug}.${stack.baseDomain}:${String(WEB_PORT)}`;

  const owner = await playwright.request.newContext();
  const ownerApi = apiOf(owner, origin);
  const invitation = await emailTo(ownerEmail, /invitaci/i);
  const token = new URL(linkIn(invitation, '/accept-invitation')).searchParams.get('token');
  expect(
    (await ownerApi.call('POST', '/auth/invitations/accept', { token, password: OWNER_PASSWORD }))
      .status,
  ).toBe(204);
  expect(
    (await ownerApi.call('POST', '/auth/login', { email: ownerEmail, password: OWNER_PASSWORD }))
      .status,
  ).toBe(200);
  expect(
    (
      await ownerApi.call('POST', '/onboarding/fast-path', {
        fullName: PROFESSIONAL,
        specialties: ['Nutrición'],
        matricula: { jurisdiction: 'AR-B', number: 'MP 45672' },
      })
    ).status,
  ).toBe(200);

  // The owner signs in on the phone and opens Settings > Turnos online.
  await page.goto(`${origin}/login`);
  await page.getByLabel('Correo electrónico').fill(ownerEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  await page.goto(`${origin}/settings/online-booking`);
  await expect(page.getByRole('heading', { level: 2, name: 'Turnos online' })).toBeVisible();
  await expectFitsAndAccessible(page);

  // The link of the organization (the general page), switched on.
  const organization = page.getByRole('region', { name: 'Enlace de la organización' });
  await organization.getByRole('button', { name: 'Crear enlace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Crear el enlace de la organización' });
  await expectFitsAndAccessible(page);
  await dialog.getByRole('switch', { name: 'Activar el enlace ahora' }).click();
  await dialog.getByRole('button', { name: 'Crear enlace' }).click();
  await expect(page.getByText('Enlace creado.')).toBeVisible();
  await expect(organization.getByText('Activo', { exact: true })).toBeVisible();

  // The link of the professional.
  const professional = page.getByRole('region', { name: PROFESSIONAL });
  await expect(professional.getByText('Sin enlace', { exact: true })).toBeVisible();
  await professional.getByRole('button', { name: 'Crear enlace' }).click();
  const professionalDialog = page.getByRole('dialog', {
    name: `Crear el enlace de ${PROFESSIONAL}`,
  });
  await professionalDialog.getByRole('checkbox').first().click();
  await professionalDialog.getByRole('switch', { name: 'Activar el enlace ahora' }).click();
  await professionalDialog.getByRole('button', { name: 'Crear enlace' }).click();
  await expect(professional.getByText('Activo', { exact: true })).toBeVisible();
  // The notices fade in and out; the audit looks at the screen once they are gone.
  await expect(page.getByText('Enlace creado.')).toHaveCount(0, { timeout: 15_000 });
  await expectFitsAndAccessible(page);

  // The address to share, and its QR code.
  const address = await professional
    .getByLabel(`Dirección del enlace de ${PROFESSIONAL}`)
    .inputValue();
  expect(address).toMatch(new RegExp(`^${origin}/book/[a-z0-9]+/p/[a-z0-9]+$`));
  await professional.getByRole('button', { name: 'Mostrar código QR' }).click();
  const qr = page.getByRole('dialog', { name: `Código QR de ${PROFESSIONAL}` });
  await expect(
    qr.getByRole('img', { name: `Código QR del enlace de ${PROFESSIONAL}` }),
  ).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.keyboard.press('Escape');
  await expect(qr).toBeHidden();

  // A patient opens that address on a phone and books.
  const patient = await visitor(browser);
  const seconds = await bookAsPatient(patient.page, address, `paciente.${suffix}@demo.invalid`);
  test.info().annotations.push({ type: 'booking-seconds', description: String(seconds) });
  await patient.context.close();

  // The owner switches the link off: the same address now says it is not available.
  await professional.getByRole('switch', { name: 'Recibir reservas' }).click();
  await expect(page.getByText('Enlace desactivado.')).toBeVisible();
  const closed = await visitor(browser);
  await closed.page.goto(address);
  await expect(
    closed.page.getByRole('heading', { level: 1, name: 'Este enlace no está disponible' }),
  ).toBeVisible();
  await closed.context.close();
});
