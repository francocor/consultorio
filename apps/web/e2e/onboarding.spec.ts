import { expect, test, type Page } from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import {
  WEB_PORT,
  axeViolations,
  emailTo,
  horizontalOverflow,
  linkIn,
  localLink,
  originOf,
  stack,
} from './support/stack.js';

/**
 * The guided first run on a phone (tenant-onboarding, Part A; app-shell-ux, "Guided first run
 * hook"), end to end on the real stack at 360 px. A brand-new organization is created by the
 * platform operator, the owner receives the invitation by email, sets a password and signs in: the
 * wizard opens by itself. The journey is one test because every step depends on the one before.
 *
 * The organization is unique to each run (a new name and address), so runs never collide.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
test.setTimeout(180_000);

const OWNER_PASSWORD = 'una frase larga para la titular 2026';
const RECEPTION_PASSWORD = 'una frase larga para recepcion 2026';

const orgUrl = (slug: string, path = '/') =>
  `http://${slug}.${stack.baseDomain}:${String(WEB_PORT)}${path}`;

/** Sets the password the emailed invitation asks for, in a browser of its own. */
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

/** The screen fits a 360 px phone and passes axe in a real browser (contrast included). */
async function expectFitsAndAccessible(page: Page) {
  // A confirmation toast fades in; axe reads the colors mid-fade, so let it settle first.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-sonner-toast]')].every(
      (toast) => getComputedStyle(toast).opacity === '1',
    ),
  );
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

test('a new owner is guided from the first sign-in to a ready consultorio, on a phone', async ({
  page,
  browser,
  playwright,
}) => {
  const suffix = String(Date.now());
  const name = `Consultorio Sur ${suffix.slice(-6)}`;
  const ownerEmail = `titular.${suffix}@demo.invalid`;
  const receptionEmail = `recepcion.${suffix}@demo.invalid`;

  // The platform operator creates the organization; the owner never gets a password from anyone.
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const created = await operator.post(`${originOf('platform')}/api/operator/tenants`, {
    data: { name, ownerEmail, isDemo: false },
    headers: { origin: originOf('platform') },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const slug = ((await created.json()) as { tenant: { slug: string } }).tenant.slug;

  await activateAccount(page, ownerEmail, OWNER_PASSWORD);

  // 1. The first sign-in lands in the wizard, with the quick setup and the step by step on offer.
  await signIn(page, slug, ownerEmail, OWNER_PASSWORD);
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Configuración inicial' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '¿Cómo quiere empezar?' })).toBeVisible();
  await expectFitsAndAccessible(page);

  // 2. Step by step: the profile, then the consultorio.
  await page.getByRole('button', { name: 'Configurar paso a paso' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Su perfil' })).toBeVisible();
  await page.getByRole('radio', { name: /Sí, soy profesional de la salud/ }).click();
  await page.getByLabel('Nombre y apellido').fill('Dra. Laura Medina');
  await page.getByLabel('Profesión o especialidad').fill('Kinesiología');
  await page.getByLabel('Jurisdicción de la matrícula').selectOption('AR-B');
  await page.getByLabel('Número de matrícula').fill('12345');
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();

  await expect(page.getByRole('heading', { level: 2, name: 'Su consultorio' })).toBeVisible();
  await page.getByLabel('Nombre del consultorio').fill('Consultorio Centro');
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Días y horarios de atención' }),
  ).toBeVisible();

  // 3. Signing in again resumes at step 3 with the earlier answers kept.
  const returning = await (
    await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true })
  ).newPage();
  await signIn(returning, slug, ownerEmail, OWNER_PASSWORD);
  await expect(returning).toHaveURL(/\/onboarding$/);
  await expect(returning.getByText('Paso 3 de 6')).toBeVisible();
  await expect(
    returning.getByRole('heading', { level: 2, name: 'Días y horarios de atención' }),
  ).toBeVisible();
  const steps = returning.getByRole('navigation', { name: 'Pasos de la configuración' });
  await expect(steps.getByRole('button', { name: /Su perfil/ })).toContainText('Hecho');
  await returning.context().close();

  // 4. Working hours (Monday to Friday by default), then the first appointment type.
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Tipo de turno' })).toBeVisible();
  await page.getByLabel('Nombre', { exact: true }).fill('Consulta');
  await page.getByRole('button', { name: 'Agregar tipo de turno' }).click();
  await expect(page.getByRole('list', { name: 'Tipos de turno creados' })).toContainText(
    'Consulta',
  );
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();

  // 5. The team: reception is invited from the wizard.
  await expect(page.getByRole('heading', { level: 2, name: 'Su equipo' })).toBeVisible();
  await page.getByLabel('Correo electrónico').fill(receptionEmail);
  await page.getByLabel('Rol').selectOption('reception');
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Enviar invitación' }).click();
  await expect(page.getByRole('list', { name: 'Invitaciones enviadas' })).toContainText(
    receptionEmail,
  );
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();

  // 6. Branding is optional: skipping it keeps the neutral default.
  await expect(page.getByRole('heading', { level: 2, name: 'Identidad visual' })).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Omitir por ahora' }).click();

  // 7. The review lets the owner finish: everything required exists.
  await expect(page.getByRole('heading', { level: 2, name: 'Revisar y finalizar' })).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Finalizar configuración' }).click();
  await expect(page).toHaveURL(new RegExp(`${slug}\\.${stack.baseDomain}:${String(WEB_PORT)}/$`));

  // The checklist is on the start page: what was done is marked, branding is still on offer.
  const checklist = page.getByRole('region', { name: 'Primeros pasos' });
  await expect(checklist).toBeVisible();
  const done = (label: string) => checklist.getByRole('listitem').filter({ hasText: label });
  await expect(done('Crear un consultorio o sede')).toContainText('Hecho');
  await expect(done('Cargar los horarios de atención')).toContainText('Hecho');
  await expect(done('Crear un tipo de turno')).toContainText('Hecho');
  await expect(done('Elegir el nombre y los colores')).toContainText('Pendiente');
  await expect(done('Registrar el primer paciente')).toContainText('Pendiente');
  await expectFitsAndAccessible(page);
  // The default look is untouched: no identity was saved.
  const boot = await page.request.get(orgUrl(slug, '/api/public/boot'));
  expect(((await boot.json()) as { theme: { primary: string } }).theme.primary).toBe('#0f766e');

  // 8. Dismissing the checklist hides it, and Help (the account menu) still reaches it.
  await checklist.getByRole('button', { name: 'Ocultar' }).click();
  await expect(page.getByRole('region', { name: 'Primeros pasos' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Menú de la cuenta' }).click();
  await page.getByRole('menuitem', { name: 'Primeros pasos' }).click();
  const dialog = page.getByRole('dialog', { name: 'Primeros pasos' });
  await expect(dialog).toContainText('de 8 listos');
  await expect(dialog.getByRole('link', { name: /Registrar el primer paciente/ })).toHaveAttribute(
    'href',
    '/patients/new',
  );
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Cerrar' }).first().click();

  // 9. Reception, invited from the wizard, does not see the checklist and cannot open the wizard.
  const guest = await (
    await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true })
  ).newPage();
  await activateAccount(guest, receptionEmail, RECEPTION_PASSWORD);
  await signIn(guest, slug, receptionEmail, RECEPTION_PASSWORD);
  await expect(guest.getByRole('heading', { level: 1 })).toContainText('Bienvenido a');
  await expect(guest.getByRole('region', { name: 'Primeros pasos' })).toHaveCount(0);
  await guest.goto(orgUrl(slug, '/onboarding'));
  await expect(
    guest.getByRole('heading', { name: 'No tiene acceso a esta sección' }),
  ).toBeVisible();
  await expect(guest.getByRole('heading', { name: '¿Cómo quiere empezar?' })).toHaveCount(0);
  await guest.context().close();
});

test('a required step cannot be skipped, and finishing early says what is missing', async ({
  page,
  playwright,
}) => {
  const suffix = String(Date.now() + 1);
  const ownerEmail = `titular.${suffix}@demo.invalid`;
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const created = await operator.post(`${originOf('platform')}/api/operator/tenants`, {
    data: { name: `Consultorio Norte ${suffix.slice(-6)}`, ownerEmail, isDemo: false },
    headers: { origin: originOf('platform') },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const slug = ((await created.json()) as { tenant: { slug: string } }).tenant.slug;
  await activateAccount(page, ownerEmail, OWNER_PASSWORD);
  await signIn(page, slug, ownerEmail, OWNER_PASSWORD);
  await expect(page).toHaveURL(/\/onboarding$/);

  await page.getByRole('button', { name: 'Configurar paso a paso' }).click();
  await page
    .getByRole('navigation', { name: 'Pasos de la configuración' })
    .getByRole('button', { name: /Su consultorio/ })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: 'Su consultorio' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Omitir por ahora' })).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Pasos de la configuración' })
    .getByRole('button', { name: /Revisar y finalizar/ })
    .click();
  await page.getByRole('button', { name: 'Finalizar configuración' }).click();
  const blocked = page.getByRole('alert');
  await expect(blocked).toContainText('Todavía falta lo necesario para dar el primer turno:');
  await expect(blocked).toContainText('Falta crear un consultorio o sede.');
  await expectFitsAndAccessible(page);
});

test('the solo quick setup leaves a consultorio ready in one screen, on a phone', async ({
  page,
  playwright,
}) => {
  const suffix = String(Date.now() + 2);
  const ownerEmail = `titular.${suffix}@demo.invalid`;
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const created = await operator.post(`${originOf('platform')}/api/operator/tenants`, {
    data: { name: `Consultorio Este ${suffix.slice(-6)}`, ownerEmail, isDemo: false },
    headers: { origin: originOf('platform') },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const slug = ((await created.json()) as { tenant: { slug: string } }).tenant.slug;
  await activateAccount(page, ownerEmail, OWNER_PASSWORD);

  const started = Date.now();
  await signIn(page, slug, ownerEmail, OWNER_PASSWORD);
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole('button', { name: 'Usar la configuración rápida' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Configuración rápida' })).toBeVisible();
  await page.getByLabel('Nombre y apellido').fill('Lic. Mario Gómez');
  await page.getByLabel('Profesión o especialidad').fill('Psicología');
  await page.getByLabel('Jurisdicción de la matrícula').selectOption('AR-B');
  await page.getByLabel('Número de matrícula').fill('23456');
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Dejar todo listo' }).click();

  await expect(
    page.getByRole('heading', { level: 2, name: 'Su consultorio está listo' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ir a la agenda' })).toHaveAttribute(
    'href',
    '/calendar',
  );
  await expectFitsAndAccessible(page);
  // From the sign-in to a consultorio ready to book, with no help: seconds, far under 10 minutes.
  const seconds = (Date.now() - started) / 1000;
  test.info().annotations.push({ type: 'quick-setup-seconds', description: String(seconds) });
  expect(seconds).toBeLessThan(60);

  // Nothing is left for the wizard; the start page lists only what is optional.
  await page.getByRole('link', { name: 'Registrar un paciente' }).click();
  await expect(page).toHaveURL(/\/patients\/new$/);
  const state = await page.request.get(orgUrl(slug, '/api/onboarding/state'));
  const body = (await state.json()) as {
    wizard: { completed: boolean; missing: string[] };
    checklist: { items: { id: string; done: boolean }[] };
  };
  expect(body.wizard).toMatchObject({ completed: true, missing: [] });
  expect(body.checklist.items.filter((item) => !item.done).map((item) => item.id)).toEqual([
    'first_patient',
    'first_appointment',
    'invite_staff',
    'branding',
  ]);
});
