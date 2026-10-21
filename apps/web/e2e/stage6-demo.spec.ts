import { readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { apiCall } from './support/clinical.js';
import { OPERATOR_STATE } from './support/operator.js';
import { orgUrl, platformOrg, reachLocalAddresses, signInTo } from './support/platform-demo.js';
import {
  axeViolations,
  emailTo,
  horizontalOverflow,
  linkIn,
  localLink,
  originOf,
  settleToasts,
  urlOf,
  type Organization,
} from './support/stack.js';

/**
 * The Stage 6 gate on the real stack (tasks 6.48 and 6.49), as a person on a phone of 360 px, with axe
 * and the width of the page checked on every screen.
 *
 * 1. A stranger signs up, activates the organization from the emailed link, authorizes the monthly
 *    payment in the hosted page of the local Mercado Pago, and uses the product the same day (registers
 *    a patient, sees the usage of the month). They leave through the subscription: the owner cancels it
 *    from the product, and the platform refuses to cancel a billed organization by hand. The export and
 *    the archive of an organization that ends are the journey of `stage6-archive.spec.ts`.
 * 2. The owner of an active subscription reads the statement of the month that closed, with the days of
 *    each professional, and downloads it.
 * 3. The owner of an organization whose charge failed sees the state, the date it becomes read-only and
 *    pays what is due in the hosted page; the organization is active again.
 *
 * The organizations of 2 and 3 are the ones `pnpm demo:platform` makes (a clock of the seed built
 * their dates); 3 changes the one it uses, so it runs once per stack.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
test.setTimeout(420_000);

const PASSWORD = 'una frase larga y propia 2026';

/** The screen fits a 360 px phone and passes axe in a real browser (contrast included). */
async function expectFitsAndAccessible(page: Page) {
  await settleToasts(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

async function operatorCall(
  context: APIRequestContext,
  method: 'GET' | 'POST',
  path: string,
  data?: unknown,
) {
  return context.fetch(`${originOf('platform')}/api${path}`, {
    method,
    headers: { origin: originOf('platform') },
    ...(data === undefined ? {} : { data }),
  });
}

/** A signed general note, written with the calls of the clinical screens, in this organization. */
async function signNote(
  page: Page,
  slug: string,
  patientId: string,
  content: Record<string, unknown>,
) {
  const organization = slug as Organization;
  const opened = await apiCall<{ id: string; encounterId: string }>(
    page,
    'POST',
    '/encounters',
    { patientId, templateKind: 'general' },
    organization,
  );
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const saved = await apiCall(
    page,
    'PUT',
    `/encounters/${opened.body.encounterId}/note/draft`,
    { content, baseRevision: 0 },
    organization,
  );
  expect(saved.status).toBe(200);
  const signed = await apiCall(
    page,
    'POST',
    `/notes/${opened.body.id}/sign`,
    { expectedRevision: 1 },
    organization,
  );
  expect(signed.status).toBe(200);
}

test('a stranger signs up, pays in the local checkout, uses the product the same day and leaves through the subscription', async ({
  page,
  playwright,
}) => {
  const stamp = `${String(Date.now())}${String(Math.floor(Math.random() * 1000))}`;
  const email = `titular.gate.${stamp}@demo.invalid`;
  const name = `Consultorio Gate ${stamp.slice(-8)}`;
  const reason = `Control de la rodilla ${stamp.slice(-8)}`;
  const document = `97${stamp.slice(-6)}`;
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });

  // 1. Signs up on the platform host, at 360 px.
  await page.goto(urlOf('platform', '/signup'));
  await expect(page.getByRole('heading', { level: 1, name: 'Cree su cuenta' })).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByLabel('Nombre de la organización').fill(name);
  await page.getByLabel('Su nombre y apellido').fill('Laura Medina');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Revise su correo' })).toBeVisible();
  await expectFitsAndAccessible(page);

  // 2. The emailed link activates the organization and starts the trial the same day.
  const link = linkIn(await emailTo(email, /Confirme su correo/), '/signup/verify');
  const slug = new URL(link).hostname.split('.')[0] ?? '';
  expect(slug).not.toBe('');
  await page.goto(localLink(link));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Active su organización' }),
  ).toBeVisible();
  // The owner chooses the password and accepts the terms here, on the page of the link.
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox', { name: 'Acepto los términos del servicio.' }).check();
  await page.getByRole('checkbox', { name: /Acepto los términos de tratamiento de datos/ }).check();
  await page.getByRole('button', { name: 'Activar mi organización' }).click();
  await page.waitForURL(/\/onboarding/);
  const trial = page.getByRole('region', { name: 'Su período de prueba' });
  await expect(trial).toBeVisible();
  await expect(trial).toContainText('Termina el');
  await expectFitsAndAccessible(page);

  // 3. Authorizes the payment in the hosted page of the (simulated) provider; the card never reaches us.
  await reachLocalAddresses(page);
  await trial.getByRole('button', { name: 'Autorizar el pago ahora' }).click();
  await expect(
    page.getByRole('heading', { name: 'Autorizar el pago mensual (simulado)' }),
  ).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page).toHaveURL(/\/subscription/);
  await expect(async () => {
    await page.goto(orgUrl(slug, '/subscription'));
    await expect(page.getByText('Visa terminada en 4242')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  const plan = page.getByRole('region', { name: 'Plan y estado' });
  await expect(plan.getByText('Activa', { exact: true })).toBeVisible();
  await expectFitsAndAccessible(page);

  // 4. Uses the product the same day: the owner is also a professional, registers a patient and signs a note.
  const fast = await apiCall(
    page,
    'POST',
    '/onboarding/fast-path',
    {
      fullName: 'Dra. Laura Medina',
      specialties: ['Kinesiología'],
      matricula: { jurisdiction: 'AR-B', number: '12345' },
    },
    slug as Organization,
  );
  expect(fast.status, JSON.stringify(fast.body)).toBe(200);
  await page.goto(orgUrl(slug, '/patients/new'));
  await page.getByLabel('Apellido').fill('Retiro');
  await page.getByLabel('Nombre', { exact: true }).fill('Mariana');
  await page.getByLabel('Fecha de nacimiento').fill('1988-03-14');
  await page.getByLabel('Número de documento').fill(document);
  await expectFitsAndAccessible(page);
  await page.getByRole('radio', { name: /El paciente acepta el tratamiento/ }).click();
  await page.getByRole('button', { name: 'Registrar paciente' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mariana Retiro' })).toBeVisible();
  const patientId = new URL(page.url()).pathname.split('/').pop() ?? '';
  await signNote(page, slug, patientId, { reasonForConsultation: reason, diagnosis: 'Gonalgia' });

  // 5. The usage of the month: counts only, with the professional that now takes a seat.
  await page.goto(orgUrl(slug, '/subscription'));
  const usage = page.getByRole('region', { name: 'Uso de mensajes de WhatsApp' });
  await expect(usage).toBeVisible();
  // The quota is prorated by the days of the month that are left, whatever day it is.
  await expect(usage).toContainText(/0 de \d+ mensajes/);
  await expect(usage).not.toContainText('Retiro');
  await expect(page.getByText(/Todavía no hay resúmenes/)).toBeVisible();
  await expectFitsAndAccessible(page);

  // 6. They leave through the subscription: the owner cancels from the product, the service goes on
  // until the end of the paid time, and the platform does NOT end a billed organization behind the
  // provider's back (the operator's cancel is for an organization nobody bills; JD-S6 R1-S6-2). The
  // export and the archive of an organization that ends are proven in `stage6-archive.spec.ts`.
  const tenants = await operatorCall(operator, 'GET', '/operator/tenants');
  const tenant = (
    (await tenants.json()) as { tenants: { id: string; slug: string }[] }
  ).tenants.find((entry) => entry.slug === slug);
  expect(tenant, 'the new organization is in the console').toBeDefined();
  const refused = await operatorCall(
    operator,
    'POST',
    `/operator/tenants/${tenant?.id ?? ''}/cancel`,
    { reason: 'Prueba de la guarda: tiene una suscripción' },
  );
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { code: string }).code).toBe(
    'operator_cancel_has_subscription',
  );

  await page.goto(orgUrl(slug, '/subscription'));
  await page.getByRole('button', { name: 'Cancelar la suscripción' }).click();
  const confirmation = page.getByRole('alertdialog', { name: '¿Cancelar la suscripción?' });
  await expect(confirmation).toContainText('No se borra ningún dato');
  await expectFitsAndAccessible(page);
  await confirmation.getByRole('button', { name: 'Sí, cancelar' }).click();
  await expect(page.getByText('En cancelación')).toBeVisible();
  await expect(page.getByText(/El servicio continúa hasta el/)).toBeVisible();
  await expectFitsAndAccessible(page);
});

test('the owner of an active subscription reads the statement of the month that closed and downloads it', async ({
  page,
}) => {
  const org = platformOrg('active');
  await signInTo(page, org.slug, org.ownerEmail);

  await page.goto(orgUrl(org.slug, '/subscription'));
  await expect(page.getByRole('heading', { level: 1, name: 'Suscripción' })).toBeVisible();
  const plan = page.getByRole('region', { name: 'Plan y estado' });
  await expect(plan.getByText('Activa', { exact: true })).toBeVisible();
  const statements = page.getByRole('region', { name: 'Resúmenes' });
  await expect(statements.getByText(/Resumen de /)).toBeVisible();
  await expect(statements).toContainText('1 profesional contado');
  await expectFitsAndAccessible(page);

  await statements.getByRole('button', { name: 'Ver el detalle' }).click();
  await expect(statements.getByText(/Dr\. Ignacio Prueba: \d+ de \d+ días/)).toBeVisible();
  // Counts and names of the team, never a patient.
  await expect(statements).not.toContainText(/paciente/i);
  await expectFitsAndAccessible(page);

  const downloading = page.waitForEvent('download');
  await statements.getByRole('button', { name: /Descargar el resumen de/ }).click();
  const download = await downloading;
  const path = await download.path();
  expect(readFileSync(path).subarray(0, 4).toString('latin1')).toBe('%PDF');
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);

  // The professional of that organization does not open the billing.
  const other = await (
    await page
      .context()
      .browser()
      ?.newContext({ viewport: { width: 360, height: 740 } })
  )?.newPage();
  if (!other) throw new Error('the browser could not open a second context');
  await signInTo(other, org.slug, org.professionalEmail ?? '');
  await other.goto(orgUrl(org.slug, '/subscription'));
  await expect(other.getByText('No tiene acceso a esta sección')).toBeVisible();
  await expect(other.getByRole('link', { name: 'Suscripción' })).toHaveCount(0);
  await other.context().close();
});

test('a charge that failed: the owner sees the date the account becomes read-only, pays what is due and the organization is active again', async ({
  page,
}) => {
  const org = platformOrg('past_due');
  await signInTo(page, org.slug, org.ownerEmail);
  await reachLocalAddresses(page);

  await page.goto(orgUrl(org.slug, '/subscription'));
  const plan = page.getByRole('region', { name: 'Plan y estado' });
  await expect(plan.getByText('Pago pendiente', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Si el pago no se regulariza, el .* la cuenta pasa a solo lectura/),
  ).toBeVisible();
  await expectFitsAndAccessible(page);

  // Pays what is due in the hosted page of the provider (a link of one use).
  await plan.getByRole('button', { name: 'Pagar lo adeudado' }).click();
  await expect(page.getByRole('heading', { name: 'Pagar (simulado)' })).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Pagar', exact: true }).click();
  await expect(page).toHaveURL(/\/subscription/);

  // The provider confirmed the payment: the subscription is active again, with nothing due.
  await expect(async () => {
    await page.goto(orgUrl(org.slug, '/subscription'));
    await expect(
      page.getByRole('region', { name: 'Plan y estado' }).getByText('Activa', { exact: true }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Pagar lo adeudado' })).toHaveCount(0);
  await expectFitsAndAccessible(page);
});
