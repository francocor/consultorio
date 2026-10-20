import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { apiCall } from './support/clinical.js';
import { OPERATOR_STATE } from './support/operator.js';
import { uniqueDocument } from './support/public-booking.js';
import {
  axeViolations,
  emailTo,
  linkIn,
  localLink,
  originOf,
  settleToasts,
  stack,
  totpCode,
  urlOf,
  type Organization,
} from './support/stack.js';
import { readZip, textOf } from './support/zip.js';

/**
 * Retention on the real stack (Stage 6, track C), the whole life of an organization that leaves:
 *
 * 1. the platform operator cancels a real organization whose owner is also a professional with a
 *    patient and a signed note;
 * 2. the owner downloads the administrative package (no clinical content in it), and as a professional
 *    the clinical package with the record of the patient;
 * 3. the archive is written (the stack archives at once) and the operator sees its state, never its
 *    content;
 * 4. a patient asks for their records: one operator records the request and verifies the identity,
 *    a DIFFERENT operator approves (the first one is told another person approves);
 * 5. the patient receives a single-use link by email, opens it without any session, downloads their
 *    records once, and the second visit finds nothing.
 *
 * Axe runs on every screen. The organization is unique to each run.
 */
test.setTimeout(420_000);

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const OWNER_PASSWORD = 'una frase larga para la titular 2026';

const orgUrl = (slug: string, path = '/') => urlOf(slug as Organization, path);

async function activateAccount(page: Page, email: string, password: string) {
  const body = await emailTo(email, /invitaci/i);
  await page.goto(localLink(linkIn(body, '/accept-invitation')));
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByLabel('Repetir contraseña').fill(password);
  await page.getByRole('button', { name: 'Activar cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Su cuenta está activa' })).toBeVisible();
}

/** A second operator, signed in through the API: a different person from the one of the console. */
async function secondOperator(playwright: {
  request: { newContext: () => Promise<APIRequestContext> };
}) {
  const context = await playwright.request.newContext();
  const login = await context.post(`${originOf('platform')}/api/operator/auth/login`, {
    data: {
      email: stack.operatorTwo.email,
      password: stack.operatorTwo.password,
      code: totpCode(stack.operatorTwo.totpSecret),
    },
    headers: { origin: originOf('platform') },
  });
  expect(login.ok(), await login.text()).toBe(true);
  return context;
}

const operatorCall = (
  context: APIRequestContext,
  method: 'GET' | 'POST',
  path: string,
  data?: unknown,
) =>
  context.fetch(`${originOf('platform')}/api${path}`, {
    method,
    headers: { origin: originOf('platform') },
    ...(data === undefined ? {} : { data }),
  });

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

async function expectAccessible(page: Page) {
  await settleToasts(page);
  expect(await axeViolations(page)).toEqual([]);
}

async function downloadZip(page: Page, button: string) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: button }).click();
  const download = await downloading;
  const path = await download.path();
  return { name: download.suggestedFilename(), files: readZip(path) };
}

test('an organization that leaves exports its records, is archived and releases them to its patient once', async ({
  page,
  browser,
  playwright,
}) => {
  const suffix = String(Date.now());
  const name = `Consultorio Retiro ${suffix.slice(-6)}`;
  const ownerEmail = `titular.retiro.${suffix}@demo.invalid`;
  const patientEmail = `paciente.retiro.${suffix}@demo.invalid`;
  const document = uniqueDocument();
  const reason = `Control de la rodilla ${suffix}`;

  // The first operator is the one of the console; the second is a different person.
  const first = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const second = await secondOperator(playwright);

  // 1. A real organization (a demonstration one cannot be cancelled) whose owner attends patients.
  const created = await operatorCall(first, 'POST', '/operator/tenants', {
    name,
    ownerEmail,
    isDemo: false,
  });
  expect(created.ok(), await created.text()).toBe(true);
  const tenant = ((await created.json()) as { tenant: { id: string; slug: string } }).tenant;

  await activateAccount(page, ownerEmail, OWNER_PASSWORD);
  const login = await page.request.post(orgUrl(tenant.slug, '/api/auth/login'), {
    data: { email: ownerEmail, password: OWNER_PASSWORD },
    headers: { origin: originOf(tenant.slug as Organization) },
  });
  expect(login.ok(), await login.text()).toBe(true);

  const fast = await apiCall(
    page,
    'POST',
    '/onboarding/fast-path',
    {
      fullName: 'Dra. Laura Medina',
      specialties: ['Kinesiología'],
      matricula: { jurisdiction: 'AR-B', number: '12345' },
    },
    tenant.slug as Organization,
  );
  expect(fast.status, JSON.stringify(fast.body)).toBe(200);

  const registered = await apiCall<{ patient: { id: string } }>(
    page,
    'POST',
    '/patients',
    {
      familyName: 'Retiro',
      givenNames: 'Mariana',
      birthDate: '1988-03-14',
      document: { type: 'dni', number: document },
      email: patientEmail,
      dataProcessingConsent: true,
    },
    tenant.slug as Organization,
  );
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  await signNote(page, tenant.slug, registered.body.patient.id, {
    reasonForConsultation: reason,
    diagnosis: 'Gonalgia',
  });

  // 2. The platform cancels the organization.
  const cancelled = await operatorCall(first, 'POST', `/operator/tenants/${tenant.id}/cancel`);
  expect(cancelled.ok(), await cancelled.text()).toBe(true);
  expect(((await cancelled.json()) as { status: string }).status).toBe('cancelled');

  // 3. The owner downloads the administrative package: the organization, no clinical content.
  await page.goto(orgUrl(tenant.slug, '/export'));
  await expect(page.getByRole('heading', { level: 1, name: 'Exportación' })).toBeVisible();
  const administrative = page.getByRole('button', { name: 'Descargar el paquete administrativo' });
  await expect(administrative).toBeVisible({ timeout: 90_000 });
  await expectAccessible(page);
  const adminZip = await downloadZip(page, 'Descargar el paquete administrativo');
  expect(adminZip.name).toMatch(/\.zip$/);
  expect([...adminZip.files.keys()]).toEqual(expect.arrayContaining(['manifiesto.json']));
  expect(textOf(adminZip.files)).toContain('Retiro');
  expect(textOf(adminZip.files)).not.toContain(reason);

  // 4. As a professional, the owner downloads the clinical package with the record of the patient.
  await page.goto(orgUrl(tenant.slug, '/export/clinical'));
  await expect(page.getByRole('heading', { level: 1, name: 'Exportación clínica' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Descargar el paquete clínico' })).toBeVisible({
    timeout: 90_000,
  });
  await expectAccessible(page);
  const clinicalZip = await downloadZip(page, 'Descargar el paquete clínico');
  expect(textOf(clinicalZip.files)).toContain(reason);

  // 5. The archive is written; the console shows its state and never its content.
  await expect
    .poll(
      async () => {
        const response = await operatorCall(first, 'GET', '/operator/archives');
        const body = (await response.json()) as {
          archives: { organization: string; status: string }[];
        };
        return body.archives.find((entry) => entry.organization === tenant.id)?.status;
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .toBe('written');

  const console = await (
    await browser.newContext({ ...DESKTOP, storageState: OPERATOR_STATE })
  ).newPage();
  await console.goto(urlOf('platform', '/'));
  await console.getByRole('tab', { name: 'Archivo' }).click();
  const archives = console.getByRole('table', { name: 'Archivos escritos' });
  await expect(archives.getByRole('row', { name: new RegExp(name) })).toContainText('Escrito');
  expect(await console.content()).not.toContain(reason);

  // 6. A patient asks for their records. This operator records the request and verifies the identity.
  await console.getByRole('button', { name: 'Nueva solicitud' }).click();
  const record = console.getByRole('dialog', { name: 'Nueva solicitud de liberación' });
  await record.getByLabel('Organización cancelada').selectOption({ label: name });
  await record.getByLabel('Nombre completo').fill('Mariana Retiro');
  await record.getByLabel('Correo electrónico').fill(patientEmail);
  await record.getByLabel('Número de documento').fill(document);
  await record.getByLabel('Motivo de la solicitud').fill('Necesito mi historia clínica completa');
  await expectAccessible(console);
  await record.getByRole('button', { name: 'Registrar solicitud' }).click();

  const requests = console.getByRole('table', { name: 'Solicitudes de liberación' });
  const row = requests.getByRole('row', { name: /Mariana Retiro/ });
  await expect(row).toContainText('Solicitada');
  await console.getByRole('button', { name: 'Verificar la identidad de Mariana Retiro' }).click();
  const verify = console.getByRole('dialog', { name: 'Verificar la identidad' });
  const confirm = verify.getByRole('button', { name: 'Confirmar verificación' });
  await expect(confirm).toBeDisabled();
  for (const box of await verify.getByRole('checkbox').all()) await box.check();
  await expectAccessible(console);
  await confirm.click();

  // The same person never approves: the console says another one does.
  await expect(row).toContainText('Identidad verificada');
  await expect(row).toContainText('La aprueba otra persona del equipo.');
  await expect(console.getByRole('button', { name: /Aprobar la solicitud/ })).toHaveCount(0);
  const mine = await operatorCall(first, 'GET', '/operator/archive-releases');
  const requestId = (
    (await mine.json()) as { requests: { id: string; requesterName: string }[] }
  ).requests.find((entry) => entry.requesterName === 'Mariana Retiro')?.id;
  expect(requestId).toBeDefined();
  const refused = await operatorCall(
    first,
    'POST',
    `/operator/archive-releases/${requestId ?? ''}/approve`,
  );
  expect(refused.ok()).toBe(false);

  // 7. A different operator approves; the releaser carries it out and the patient gets the link.
  const approved = await operatorCall(
    second,
    'POST',
    `/operator/archive-releases/${requestId ?? ''}/approve`,
  );
  expect(approved.ok(), await approved.text()).toBe(true);

  const message = await emailTo(patientEmail, /Su copia de los registros archivados/);
  const link = localLink(linkIn(message, '/archive-release/'));

  // 8. The patient opens the link with no session at all: looking does not spend it; downloading does.
  const visitor = await (await browser.newContext(DESKTOP)).newPage();
  await visitor.goto(link);
  await expect(
    visitor.getByRole('heading', { level: 1, name: 'Sus registros están listos' }),
  ).toBeVisible();
  await expectAccessible(visitor);
  await visitor.reload();
  await expect(
    visitor.getByRole('heading', { level: 1, name: 'Sus registros están listos' }),
  ).toBeVisible();

  const records = await downloadZip(visitor, 'Descargar los registros');
  expect(textOf(records.files)).toContain(reason);
  expect(textOf(records.files)).toContain(document);
  await expect(visitor.getByRole('heading', { name: 'Descarga completa' })).toBeVisible();
  await expectAccessible(visitor);

  // 9. The link is spent: the second visit finds nothing, and says nothing about why.
  await visitor.goto(link);
  await expect(
    visitor.getByRole('heading', { level: 1, name: 'Este enlace no está disponible' }),
  ).toBeVisible();
  await expectAccessible(visitor);

  // 10. The console shows the request delivered.
  await console.reload();
  await console.getByRole('tab', { name: 'Archivo' }).click();
  await expect(
    console
      .getByRole('table', { name: 'Solicitudes de liberación' })
      .getByRole('row', { name: /Mariana Retiro/ }),
  ).toContainText('Descargada el');
});
