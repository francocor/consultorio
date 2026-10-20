import { expect, test, type Page } from '@playwright/test';

import { expectFitsAndAccessible } from './support/public-booking.js';
import { emailOf, emailTo, linkIn, localLink, stack, urlOf } from './support/stack.js';

/**
 * Self-service signup on the real stack (Stage 6, track B), as a visitor on a phone: opens the form
 * on the platform host, signs up, reads the link from the mailbox, opens it on the host of the new
 * organization and activates it. The page is checked with axe and for horizontal scroll at 360 px on
 * every screen. Asking for a new link, and signing up with an address that already has an account
 * (which must look exactly the same), are journeys of their own.
 *
 * The subscription half of the journey (approve in the local checkout, tenant active the same day)
 * joins this file when the subscriptions track (S6.04 and S6.07) lands.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
test.setTimeout(240_000);

const PASSWORD = 'una frase larga y propia 2026';

interface Signup {
  email: string;
  name: string;
}

/** An address and a name nobody else used in this run (the mailbox is shared by every spec). */
function newSignup(): Signup {
  const stamp = `${String(Date.now())}${String(Math.floor(Math.random() * 1000))}`;
  return { email: `duena.${stamp}@demo.invalid`, name: `Centro Registro ${stamp.slice(-8)}` };
}

async function fillForm(page: Page, signup: Signup) {
  await page.getByLabel('Nombre de la organización').fill(signup.name);
  await page.getByLabel('Su nombre y apellido').fill('Lucía Méndez');
  await page.getByLabel('Correo electrónico').fill(signup.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox', { name: 'Acepto los términos del servicio.' }).check();
  await page.getByRole('checkbox', { name: /Acepto los términos de tratamiento de datos/ }).check();
}

/** Opens the form on the platform host and sends it; ends on the "check your email" screen. */
async function signUp(page: Page, signup: Signup) {
  await page.goto(urlOf('platform', '/signup'));
  await expect(page.getByRole('heading', { level: 1, name: 'Cree su cuenta' })).toBeVisible();
  await fillForm(page, signup);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Revise su correo' })).toBeVisible();
}

test('a visitor signs up, opens the emailed link on the new organization and activates it', async ({
  page,
}) => {
  const signup = newSignup();

  // The form fits a phone and has no accessibility violations.
  await page.goto(urlOf('platform', '/signup'));
  await expect(page.getByRole('heading', { level: 1, name: 'Cree su cuenta' })).toBeVisible();
  await expectFitsAndAccessible(page);
  await fillForm(page, signup);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Revise su correo' })).toBeVisible();
  await expect(page.getByText(signup.email)).toBeVisible();
  await expectFitsAndAccessible(page);

  // The link points at the host of the new organization, never at one the request named.
  const body = await emailTo(signup.email, /Confirme su correo/);
  const link = linkIn(body, '/signup/verify');
  expect(new URL(link).hostname).toMatch(/^[a-z0-9-]+\.localhost$/);
  expect(new URL(link).hostname).not.toBe(stack.platformHost);

  // Opening the link only shows what it is for; the button activates.
  await page.goto(localLink(link));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Active su organización' }),
  ).toBeVisible();
  await expect(page.getByText(new RegExp(`para activar ${signup.name}`))).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Activar mi organización' }).click();

  // The trial starts in the same transaction that activates, and the owner lands in the wizard.
  await page.waitForURL(/\/onboarding/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const me = await page.request.get(new URL('/api/auth/me', page.url()).toString());
  expect(me.ok()).toBe(true);
  const profile = (await me.json()) as {
    roles: string[];
    tenantStatus: string;
    user: { email: string };
  };
  expect(profile).toMatchObject({
    roles: ['owner'],
    tenantStatus: 'active',
    user: { email: signup.email },
  });
});

test('a link that does not work offers a new one, and the new one arrives', async ({ page }) => {
  const signup = newSignup();
  await signUp(page, signup);
  const first = linkIn(await emailTo(signup.email, /Confirme su correo/), '/signup/verify');

  // The same address with a token that never existed.
  const wrong = new URL(localLink(first));
  wrong.searchParams.set('token', 'x'.repeat(43));
  await page.goto(wrong.toString());
  await page.getByRole('button', { name: 'Activar mi organización' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'El enlace no sirve' })).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Pedir un enlace nuevo' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Revise su correo' })).toBeVisible();

  // A new message arrives with a different link, and the first one stopped working.
  await expect
    .poll(async () => linkIn(await emailTo(signup.email, /Confirme su correo/), '/signup/verify'), {
      timeout: 20_000,
    })
    .not.toBe(first);
});

test('the check-your-email screen can ask for the message again', async ({ page }) => {
  const signup = newSignup();
  await signUp(page, signup);
  const first = linkIn(await emailTo(signup.email, /Confirme su correo/), '/signup/verify');

  await page.getByRole('button', { name: 'Enviar el correo de nuevo' }).click();

  await expect(page.getByText(/enviamos un correo nuevo/)).toBeVisible();
  await expect
    .poll(async () => linkIn(await emailTo(signup.email, /Confirme su correo/), '/signup/verify'), {
      timeout: 20_000,
    })
    .not.toBe(first);
});

test('an address that already has an account gets the same screen, and its holder is told, with no link', async ({
  page,
}) => {
  const holder = emailOf('owner');
  await signUp(page, { email: holder, name: `Centro Repetido ${String(Date.now()).slice(-6)}` });
  await expectFitsAndAccessible(page);

  // The page says nothing of the account; the mailbox of the holder gets the notice.
  await expect(page.getByText(/ya existe|ya tiene una cuenta con/i)).toHaveCount(0);
  const notice = await emailTo(holder, /Alguien pidió crear una organización/);
  expect(notice).not.toMatch(/https?:\/\//);
});

test('the form does not send until both documents are accepted', async ({ page }) => {
  const signup = newSignup();
  await page.goto(urlOf('platform', '/signup'));
  await page.getByLabel('Nombre de la organización').fill(signup.name);
  await page.getByLabel('Su nombre y apellido').fill('Lucía Méndez');
  await page.getByLabel('Correo electrónico').fill(signup.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox', { name: 'Acepto los términos del servicio.' }).check();

  await page.getByRole('button', { name: 'Crear cuenta' }).click();

  await expect(page.getByText('Para crear la cuenta debe aceptar este punto.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Cree su cuenta' })).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('the signup does not exist on the host of an organization', async ({ page }) => {
  await page.goto(urlOf('aillu', '/signup'));

  await expect(page.getByRole('heading', { level: 1, name: 'Cree su cuenta' })).toHaveCount(0);
  const response = await page.request.post(urlOf('aillu', '/api/public/signup'), {
    data: {},
    headers: { origin: urlOf('aillu', '') },
  });
  expect(response.status()).toBe(404);
});
