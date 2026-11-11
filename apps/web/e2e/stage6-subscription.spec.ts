import { expect, test, type Page } from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import {
  WEB_PORT,
  axeViolations,
  emailTo,
  horizontalOverflow,
  linkIn,
  localLink,
  openAs,
  originOf,
  settleToasts,
  stack,
  urlOf,
} from './support/stack.js';

/**
 * The subscription of an organization on the real stack (Stage 6, track A), on a phone of 360 px: a
 * new organization is created by the platform operator, its owner activates the account, sees the
 * plan and the usage, authorizes the monthly payment on the hosted page of the local Mercado Pago,
 * changes the overage cap, sets it wrong, cancels and takes the cancellation back. The operator sees
 * the subscription and the authorization in the console, and the owner sees what adding a professional
 * costs before inviting one. A demo organization has no billing, and nobody but the owner opens the
 * screen. Axe and the width of the page are checked on every screen.
 *
 * The organization is unique to each run, so runs never collide.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
test.setTimeout(240_000);

const OWNER_PASSWORD = 'una frase larga para la titular 2026';

const orgUrl = (slug: string, path = '/') =>
  `http://${slug}.${stack.baseDomain}:${String(WEB_PORT)}${path}`;

/** The screen fits a 360 px phone and passes axe in a real browser (contrast included). */
async function expectFitsAndAccessible(page: Page) {
  await settleToasts(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

async function activateAccount(page: Page, email: string, password: string) {
  const body = await emailTo(email, /invitaci/i);
  await page.goto(localLink(linkIn(body, '/accept-invitation')));
  await expect(page.getByRole('heading', { name: 'Active su cuenta' })).toBeVisible();
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByLabel('Repetir contraseña').fill(password);
  await page.getByRole('button', { name: 'Activar cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Su cuenta está activa' })).toBeVisible();
}

async function signIn(page: Page, slug: string, email: string, password: string) {
  await page.goto(orgUrl(slug, '/login'));
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
}

/**
 * The links the API writes for the hosted page and for the way back have no port (the stack has no
 * public port), so the browser would look for them on port 80. They are sent to the preview server
 * instead, the way `localLink` does for an email.
 */
async function reachLocalAddresses(page: Page) {
  await page.route(/\.localhost(:\d+)?\/(api\/local-providers|subscription)/, (route) => {
    const url = new URL(route.request().url());
    if (url.port === String(WEB_PORT)) return route.fallback();
    url.port = String(WEB_PORT);
    return route.fulfill({ status: 302, headers: { location: url.toString() } });
  });
}

test('an owner follows the subscription from the trial to the authorization, the cap and the cancellation', async ({
  page,
  playwright,
}) => {
  const suffix = String(Date.now());
  const name = `Clínica Suscripción ${suffix.slice(-6)}`;
  const ownerEmail = `titular.${suffix}@demo.invalid`;

  // The platform operator creates the organization; the owner never gets a password from anyone.
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const created = await operator.post(`${originOf('platform')}/api/operator/tenants`, {
    data: { name, ownerEmail, isDemo: false },
    headers: { origin: originOf('platform') },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const slug = ((await created.json()) as { tenant: { slug: string } }).tenant.slug;

  await activateAccount(page, ownerEmail, OWNER_PASSWORD);
  await signIn(page, slug, ownerEmail, OWNER_PASSWORD);
  await expect(page).toHaveURL(/\/onboarding$/);
  await reachLocalAddresses(page);

  // 1. No subscription yet: the plan it would start on, and the way to authorize the payment.
  await page.goto(orgUrl(slug, '/subscription'));
  await expect(page.getByRole('heading', { level: 1, name: 'Suscripción' })).toBeVisible();
  await expect(page.getByText('Pagos de prueba')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Active su suscripción' })).toBeVisible();
  await expectFitsAndAccessible(page);

  // 2. The provider's own page (simulated) asks the owner to authorize; the card never reaches us.
  await page.getByRole('button', { name: 'Autorizar el pago' }).click();
  await expect(
    page.getByRole('heading', { name: 'Autorizar el pago mensual (simulado)' }),
  ).toBeVisible();
  await expect(page.getByText('Mercado Pago simulado')).toBeVisible();
  await page.getByRole('button', { name: 'Aprobar' }).click();

  // 3. Back in the application: the subscription is active, with the authorized medium of payment.
  await expect(page).toHaveURL(new RegExp(`/subscription`));
  await expect(async () => {
    await page.goto(orgUrl(slug, '/subscription'));
    await expect(page.getByText('Visa terminada en 4242')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  const plan = page.getByRole('region', { name: 'Plan y estado' });
  await expect(plan.getByText('Activa', { exact: true })).toBeVisible();
  await expect(plan.getByText('$ 18.000,00 por profesional activo, por mes')).toBeVisible();
  await expect(plan.getByRole('button', { name: 'Autorizar el pago' })).toHaveCount(0);
  await expectFitsAndAccessible(page);

  // 4. The usage of the month, with counts only, and the statements (none yet).
  const usage = page.getByRole('region', { name: 'Uso de mensajes de WhatsApp' });
  await expect(usage).toBeVisible();
  await expect(usage.getByLabel('Mensajes excedentes por mes')).toHaveValue('300');
  await expect(page.getByText(/Todavía no hay resúmenes/)).toBeVisible();

  // 5. The overage cap: a value above the maximum of the plan is not sent, a valid one is saved.
  const cap = usage.getByLabel('Mensajes excedentes por mes');
  await cap.fill('3001');
  await usage.getByRole('button', { name: 'Guardar el tope' }).click();
  await expect(usage.getByText('Ingrese un número entero entre 0 y 3000.')).toBeVisible();
  await expectFitsAndAccessible(page);
  await cap.fill('120');
  await usage.getByRole('button', { name: 'Guardar el tope' }).click();
  await expect(page.getByText('Guardamos el nuevo tope.')).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Uso de mensajes de WhatsApp' })
      .getByLabel('Mensajes excedentes por mes'),
  ).toHaveValue('120');

  // 6. The platform operator sees the subscription and the authorization in the console.
  const console = await page
    .context()
    .browser()
    ?.newContext({
      storageState: OPERATOR_STATE,
      viewport: { width: 1280, height: 800 },
    });
  if (!console) throw new Error('the browser could not open a context for the operator');
  const operatorPage = await console.newPage();
  await operatorPage.goto(urlOf('platform', '/'));
  await operatorPage.getByRole('tab', { name: 'Suscripciones' }).click();
  const row = operatorPage.getByRole('article', { name });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Activa');
  await expect(row).toContainText('Autorizada');
  await expect(row).toContainText('Tope de excedentes: 120');
  await row.getByRole('button', { name: `Ver el uso de ${name}` }).click();
  await expect(
    row.getByText('Solo se muestran cantidades: ni mensajes ni pacientes.'),
  ).toBeVisible();
  expect(await axeViolations(operatorPage)).toEqual([]);

  // The provider console shows the authorization the simulator holds, for the same amount.
  await operatorPage.getByRole('tab', { name: 'Proveedores' }).click();
  await operatorPage.getByRole('tab', { name: 'Mercado Pago' }).click();
  const authorizations = operatorPage.getByRole('table', { name: 'Autorizaciones del simulador' });
  await expect(authorizations).toBeVisible();
  await expect(authorizations.getByRole('row').nth(1)).toContainText('authorized');
  await console.close();

  // 7. Cancelling asks first, keeps the service until the end of the paid time and can be undone.
  await page.getByRole('button', { name: 'Cancelar la suscripción' }).click();
  const confirmation = page.getByRole('alertdialog', { name: '¿Cancelar la suscripción?' });
  await expect(confirmation).toContainText('No se borra ningún dato');
  await expectFitsAndAccessible(page);
  await confirmation.getByRole('button', { name: 'Sí, cancelar' }).click();
  await expect(page.getByText('En cancelación')).toBeVisible();
  await expect(page.getByText(/El servicio continúa hasta el/)).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Retomar la suscripción' }).click();
  // The cancellation stopped the charges at the provider: the trial goes on, and the payment is authorized again.
  await expect(page.getByRole('button', { name: 'Cancelar la suscripción' })).toBeVisible();
  await expect(plan.getByText('En prueba', { exact: true })).toBeVisible();
  await expect(plan.getByRole('button', { name: 'Autorizar el pago' })).toBeVisible();

  // 8. Adding a professional shows the price before the invitation is sent.
  await page.goto(orgUrl(slug, '/staff'));
  await page.getByRole('button', { name: 'Invitar a una persona' }).click();
  const invite = page.getByRole('dialog', { name: 'Invitar a una persona' });
  await invite.getByRole('checkbox', { name: /Profesional/ }).click();
  await expect(invite.getByText('Qué cambia en su suscripción')).toBeVisible();
  await expect(invite.getByText(/La suscripción pasa de/)).toBeVisible();
  await expectFitsAndAccessible(page);
  await invite.getByRole('button', { name: 'Cancelar' }).click();
});

test('a demonstration organization has no billing, and only its owner opens the screen', async ({
  page,
}) => {
  await openAs(page, 'owner', '/subscription');
  await expect(page.getByRole('heading', { level: 1, name: 'Suscripción' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cuenta sin facturación' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Autorizar el pago' })).toHaveCount(0);
  await expectFitsAndAccessible(page);

  const reception = await page
    .context()
    .browser()
    ?.newContext({
      viewport: { width: 360, height: 740 },
    });
  if (!reception) throw new Error('the browser could not open a second context');
  const other = await reception.newPage();
  await openAs(other, 'reception', '/subscription');
  await expect(other.getByText('No tiene acceso a esta sección')).toBeVisible();
  await expect(other.getByRole('link', { name: 'Suscripción' })).toHaveCount(0);
  await reception.close();
});
