import { expect, test, type Page } from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import {
  WEB_PORT,
  axeViolations,
  settleToasts,
  emailTo,
  horizontalOverflow,
  linkIn,
  localLink,
  originOf,
  stack,
} from './support/stack.js';

/**
 * The Stage 2 success criterion for a solo professional (proposal, "a new solo professional books a
 * first appointment within 10 minutes of first login"), on a phone and on the real stack: the
 * platform operator creates the organization, the owner takes the invitation from the mailbox, sets a
 * password, signs in, uses the quick setup, registers the first patient and books the first
 * appointment. The time from the first sign-in to the booked appointment is recorded.
 *
 * The organization is unique to each run, so runs never collide.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
test.setTimeout(240_000);

/** The success criterion: ten minutes, from the first sign-in to the first appointment booked. */
const BUDGET_SECONDS = 600;
const OWNER_PASSWORD = 'una frase larga para la titular 2026';

const orgUrl = (slug: string, path = '/') =>
  `http://${slug}.${stack.baseDomain}:${String(WEB_PORT)}${path}`;

/** The next working day (Monday to Friday) after today, as `YYYY-MM-DD`, in the zone of the stack. */
function nextWorkingDay(): string {
  const zone = 'America/Argentina/Buenos_Aires';
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone });
  const day = new Date(Date.now() + 86_400_000);
  for (let guard = 0; guard < 7; guard += 1) {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(
      day,
    );
    if (weekday !== 'Sat' && weekday !== 'Sun') break;
    day.setTime(day.getTime() + 86_400_000);
  }
  return format.format(day);
}

async function expectFitsAndAccessible(page: Page) {
  // A confirmation toast slides and fades in; axe reads the colors mid-transition, so let it settle first.
  await settleToasts(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

test('a solo professional goes from the invitation to a first appointment, on a phone, in minutes', async ({
  page,
  playwright,
}) => {
  const suffix = String(Date.now() + 7);
  const ownerEmail = `solo.${suffix}@demo.invalid`;
  const family = `Primera${suffix.slice(-4)}`;

  // The operator creates the organization; the owner takes the invitation from the mailbox.
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const created = await operator.post(`${originOf('platform')}/api/operator/tenants`, {
    data: { name: `Consultorio Solo ${suffix.slice(-6)}`, ownerEmail, isDemo: false },
    headers: { origin: originOf('platform') },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const slug = ((await created.json()) as { tenant: { slug: string } }).tenant.slug;

  const invitation = await emailTo(ownerEmail, /invitaci/i);
  await page.goto(localLink(linkIn(invitation, '/accept-invitation')));
  await page.getByLabel('Contraseña', { exact: true }).fill(OWNER_PASSWORD);
  await page.getByLabel('Repetir contraseña').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Activar cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Su cuenta está activa' })).toBeVisible();

  // The clock starts at the first sign-in.
  const started = Date.now();
  await page.goto(orgUrl(slug, '/login'));
  await page.getByLabel('Correo electrónico').fill(ownerEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);

  // The quick setup: one screen, a consultorio ready to book.
  await page.getByRole('button', { name: 'Usar la configuración rápida' }).click();
  await page.getByLabel('Nombre y apellido').fill('Dra. Ana Solera');
  await page.getByLabel('Profesión o especialidad').fill('Nutrición');
  await page.getByLabel('Jurisdicción de la matrícula').selectOption('AR-B');
  await page.getByLabel('Número de matrícula').fill('34567');
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Dejar todo listo' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Su consultorio está listo' }),
  ).toBeVisible();

  // The first patient.
  await page.getByRole('link', { name: 'Registrar un paciente' }).click();
  await expect(page).toHaveURL(/\/patients\/new$/);
  await page.getByLabel('Apellido').fill(family);
  await page.getByLabel('Nombre', { exact: true }).fill('Lucía');
  await page.getByLabel('Fecha de nacimiento').fill('1990-05-17');
  await page.getByLabel('Número de documento').fill(`96${suffix.slice(-6)}`);
  await page.getByRole('radio', { name: /El paciente acepta el tratamiento/ }).click();
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Registrar paciente' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Lucía ${family}` })).toBeVisible();

  // The first appointment, on the next working day, with the first free time.
  const day = nextWorkingDay();
  await page.goto(orgUrl(slug, `/calendar?date=${day}`));
  await page.getByRole('button', { name: 'Nuevo turno' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo turno' });
  const slots = dialog.getByRole('group', { name: 'Horarios disponibles' });
  await expect(slots.getByRole('button').first()).toBeVisible();
  const when = (await slots.getByRole('button').first().textContent())?.trim() ?? '';
  await slots.getByRole('button').first().click();
  await dialog.getByRole('combobox', { name: 'Paciente' }).fill(family);
  await dialog.getByRole('option', { name: new RegExp(family) }).click();
  await expectFitsAndAccessible(page);
  await dialog.getByRole('button', { name: 'Dar turno' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(new RegExp(`Turno asignado a .*${family}`))).toBeVisible();
  const seconds = (Date.now() - started) / 1000;

  // The appointment is real: it is in the agenda of the organization with the patient.
  const from = new Date(`${day}T00:00:00-03:00`).toISOString();
  const to = new Date(`${day}T23:59:59-03:00`).toISOString();
  const feed = await page.request.get(orgUrl(slug, `/api/appointments?from=${from}&to=${to}`));
  expect(feed.ok()).toBe(true);
  const booked = ((await feed.json()) as { appointments: { patientName: string }[] }).appointments;
  expect(booked.some((entry) => entry.patientName.includes(family))).toBe(true);
  await expectFitsAndAccessible(page);

  // The recorded time, against the criterion of ten minutes.
  test.info().annotations.push({ type: 'first-appointment-seconds', description: String(seconds) });
  test.info().annotations.push({ type: 'first-appointment-time', description: when });
  expect(seconds).toBeLessThan(BUDGET_SECONDS);
});
