import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import {
  axeViolations,
  emailOf,
  horizontalOverflow,
  localLink,
  openAs,
  originOf,
  signInWithApi,
  stack,
  urlOf,
  type AccountKey,
} from './support/stack.js';

/**
 * Teleconsultation on the real stack, on a phone (S3.15, task 3.70): a virtual appointment gets a
 * room, the patient opens the platform address early and sees when it opens, inside the window the
 * address forwards to the call, the professional joins from the appointment, and when the room
 * cannot be created a manual link takes its place.
 *
 * The two demo organizations use the fake provider (a demonstration organization never reaches a
 * real service), whose addresses end in `.invalid`: no spec ever opens a real video call. The
 * address a reminder would carry comes from the simulator console, which stands in for the
 * messaging module.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
test.setTimeout(180_000);
test.describe.configure({ mode: 'serial' });

const ZONE = 'America/Argentina/Buenos_Aires';
const FAKE_CALL = 'https://video.example.invalid/';
const MINUTE = 60_000;

interface Booked {
  appointmentId: string;
  professionalId: string;
  account: AccountKey;
  startsAt: Date;
}

const localDate = (instant: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(instant);
const clock = (instant: Date) =>
  new Intl.DateTimeFormat('es-AR', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);

const SPECIALTIES: { account: AccountKey; specialty: string }[] = [
  { account: 'cardiology', specialty: 'Cardiología' },
  { account: 'pediatrics', specialty: 'Pediatría' },
  { account: 'psychology', specialty: 'Psicología' },
];

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as T;
}

/** The owner of the demo organization, with a session on a fresh API context. */
async function ownerApi(playwright: { request: { newContext(): Promise<APIRequestContext> } }) {
  const api = await playwright.request.newContext();
  await signInWithApi(api, 'aillu', emailOf('owner'));
  return api;
}

const post = (api: APIRequestContext, path: string, data: unknown) =>
  api.post(urlOf('aillu', `/api${path}`), { data, headers: { origin: originOf('aillu') } });

async function ensureVirtualType(api: APIRequestContext): Promise<string> {
  const name = 'Teleconsulta de prueba';
  const list = await json<{ types: { id: string; name: string }[] }>(
    await api.get(urlOf('aillu', '/api/appointment-types')),
  );
  const found = list.types.find((type) => type.name === name);
  if (found) return found.id;
  const created = await json<{ id: string }>(
    await post(api, '/appointment-types', { name, durationMinutes: 30, mode: 'virtual' }),
  );
  return created.id;
}

/**
 * Books a virtual appointment that STARTS `startOffsets` minutes from now (the first one that is
 * free), for the first professional of the demo that has room. The owner books it over working
 * hours with a stated reason, so the spec does not depend on the weekday or the hour it runs at.
 */
async function bookVirtual(
  api: APIRequestContext,
  typeId: string,
  startOffsets: readonly number[],
): Promise<Booked> {
  const staff = await json<{
    staff: { professional: { id: string; specialties: string[] } | null }[];
  }>(await api.get(urlOf('aillu', '/api/staff')));
  const locations = await json<{ locations: { id: string; name: string }[] }>(
    await api.get(urlOf('aillu', '/api/locations')),
  );
  const location = locations.locations.find((place) => place.name === 'Sede Central');
  if (!location) throw new Error('The demo has no Sede Central');
  const patients = await json<{ patients: { id: string }[] }>(
    await api.get(urlOf('aillu', '/api/patients?q=G%C3%B3mez&status=active')),
  );
  const patient = patients.patients[0];
  if (!patient) throw new Error('The demo has no patient to book');

  for (const { account, specialty } of SPECIALTIES) {
    const member = staff.staff.find((entry) => entry.professional?.specialties.includes(specialty));
    if (!member?.professional) continue;
    for (const offset of startOffsets) {
      const startsAt = new Date(Math.round((Date.now() + offset * MINUTE) / MINUTE) * MINUTE);
      const response = await post(api, '/appointments', {
        patientId: patient.id,
        professionalId: member.professional.id,
        locationId: location.id,
        appointmentTypeId: typeId,
        startsAt: startsAt.toISOString(),
        overrideHours: { reason: 'Prueba automática de la videoconsulta' },
      });
      if (response.status() === 409) continue;
      const created = await json<{ id: string }>(response);
      return {
        appointmentId: created.id,
        professionalId: member.professional.id,
        account,
        startsAt,
      };
    }
  }
  throw new Error('The demo professionals have no free time for a virtual appointment');
}

interface Summary {
  status: string | null;
  pendingReason: string | null;
  hasLink: boolean;
  canJoin: boolean;
  patientOpenedLink: boolean;
}

async function summaryOf(api: APIRequestContext, appointmentId: string): Promise<Summary> {
  return json<Summary>(await api.get(urlOf('aillu', `/api/appointments/${appointmentId}/video`)));
}

/** Waits for the worker to create the room. */
async function waitUntilReady(api: APIRequestContext, appointmentId: string) {
  await expect
    .poll(async () => (await summaryOf(api, appointmentId)).status, { timeout: 30_000 })
    .toBe('ready');
}

/** The platform join address a reminder would carry, from the simulator console of the stack. */
async function patientLink(
  playwright: { request: { newContext(options: object): Promise<APIRequestContext> } },
  appointmentId: string,
): Promise<string> {
  const tenantId = stack.tenants['aillu']?.id;
  if (!tenantId) throw new Error('The stack has no aillu organization');
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const response = await operator.post(urlOf('platform', '/api/operator/dev/video/links'), {
    data: { tenantId, appointmentId },
    headers: { origin: originOf('platform') },
  });
  const body = await json<{ kind: string; url: string | null }>(response);
  expect(body.kind).toBe('link');
  if (!body.url) throw new Error('The console gave no address');
  return localLink(body.url);
}

/** Where the call opens, without following it: the address of the redirect. */
async function redirectOf(api: APIRequestContext, link: string): Promise<string | null> {
  const response = await api.get(link, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  return response.headers()['location'] ?? null;
}

async function expectFitsAndAccessible(page: Page) {
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

/** Never lets a spec reach a video service: the fake provider's and the manual hosts' calls end here. */
async function stubCalls(context: BrowserContext) {
  await context.route(/^https:\/\/(video\.example\.invalid|meet\.google\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Sala de prueba</p>' }),
  );
}

let typeId = '';
let inWindow: Booked;
let later: Booked;

test.beforeAll(async ({ playwright }) => {
  const owner = await ownerApi(playwright);
  typeId = await ensureVirtualType(owner);
  // One appointment that is in its join window right now, and one that opens in a few hours.
  inWindow = await bookVirtual(owner, typeId, [10, 5, -10, -25, -40, -55, -70]);
  later = await bookVirtual(owner, typeId, [180, 240, 300, 360, 420]);
  await waitUntilReady(owner, inWindow.appointmentId);
  await waitUntilReady(owner, later.appointmentId);
});

test('the patient who opens the address early sees when the session starts, and nothing of the call', async ({
  page,
  playwright,
}) => {
  const link = await patientLink(playwright, later.appointmentId);

  await page.goto(link);

  const opens = clock(new Date(later.startsAt.getTime() - 15 * MINUTE));
  await expect(
    page.getByRole('heading', { name: 'Su videoconsulta todavía no comenzó' }),
  ).toBeVisible();
  await expect(page.getByText(new RegExp(`a las ${opens}`))).toBeVisible();
  await expect(page.getByText(/servicio de videollamada de terceros/)).toBeVisible();
  await expect(page.getByText(/no graba ni guarda el audio ni el video/)).toBeVisible();
  expect(page.url()).toBe(link);
  expect(await page.content()).not.toContain('video.example.invalid');
  await expectFitsAndAccessible(page);
});

test('inside the window the address forwards to the call, and the link opened is recorded', async ({
  playwright,
}) => {
  const owner = await ownerApi(playwright);
  const link = await patientLink(playwright, inWindow.appointmentId);
  expect((await summaryOf(owner, inWindow.appointmentId)).patientOpenedLink).toBe(false);

  const anonymous = await playwright.request.newContext();
  const location = await redirectOf(anonymous, link);

  expect(location).toMatch(new RegExp(`^${FAKE_CALL.replaceAll('.', '\\.')}[0-9a-f]{32}$`));
  expect((await summaryOf(owner, inWindow.appointmentId)).patientOpenedLink).toBe(true);
});

test('a link that does not exist looks the same as an old one, on a phone', async ({ page }) => {
  await page.goto(urlOf('aillu', `/public/v/${'a'.repeat(43)}`));

  await expect(page.getByRole('heading', { name: 'Este enlace no está disponible' })).toBeVisible();
  await expect(page.getByText(/videollamada de terceros/)).toHaveCount(0);
  await expectFitsAndAccessible(page);
});

test('the professional sees the video panel in the appointment, and joins while the window is open', async ({
  page,
  context,
}) => {
  await stubCalls(context);
  await openAs(
    page,
    inWindow.account,
    `/calendar?date=${localDate(inWindow.startsAt)}&pros=${inWindow.professionalId}&appointment=${inWindow.appointmentId}`,
  );

  const drawer = page.getByRole('dialog');
  const panel = drawer.getByRole('region', { name: 'Videoconsulta' });
  await expect(panel.getByText('Virtual', { exact: true })).toBeVisible();
  await expect(panel.getByText(/El paciente abrió el enlace a las/)).toBeVisible();
  await expect(panel.getByText(/La sala se habilita a las/)).toBeVisible();
  // The panel shows that a link exists, never the link.
  expect(await drawer.innerText()).not.toContain('video.example.invalid');
  expect(await axeViolations(page)).toEqual([]);

  const popup = context.waitForEvent('page');
  await panel.getByRole('button', { name: 'Entrar a la videoconsulta' }).click();
  const call = await popup;
  await call.waitForURL(/video.example.invalid/);
  expect(call.url()).toMatch(new RegExp(`^${FAKE_CALL.replaceAll('.', '\\.')}[0-9a-f]{32}$`));
});

test('the professional is offered no join action before the window opens', async ({ page }) => {
  await openAs(
    page,
    later.account,
    `/calendar?date=${localDate(later.startsAt)}&pros=${later.professionalId}&appointment=${later.appointmentId}`,
  );

  const panel = page.getByRole('dialog').getByRole('region', { name: 'Videoconsulta' });
  await expect(panel.getByText('Virtual', { exact: true })).toBeVisible();
  await expect(panel.getByText(/El paciente todavía no abrió el enlace/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Entrar a la videoconsulta' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Adjuntar enlace manual' })).toBeVisible();
});

test('without a room the appointment waits for a manual link, which takes its place', async ({
  page,
  context,
  playwright,
}) => {
  await stubCalls(context);
  const owner = await ownerApi(playwright);
  // The integration is switched off only while the appointment is made, and back on at once.
  const setIntegration = (video: boolean) =>
    owner.patch(urlOf('aillu', '/api/settings'), {
      data: { integrations: { video } },
      headers: { origin: originOf('aillu') },
    });
  expect((await setIntegration(false)).ok()).toBe(true);
  let waiting: Booked;
  try {
    waiting = await bookVirtual(owner, typeId, [12, 7, -8, -23, -38, -53, -68]);
  } finally {
    expect((await setIntegration(true)).ok()).toBe(true);
  }
  expect(await summaryOf(owner, waiting.appointmentId)).toMatchObject({
    status: 'link_pending',
    pendingReason: 'integration_off',
    hasLink: false,
  });

  await openAs(
    page,
    waiting.account,
    `/calendar?date=${localDate(waiting.startsAt)}&pros=${waiting.professionalId}&appointment=${waiting.appointmentId}`,
  );
  const drawer = page.getByRole('dialog');
  const panel = drawer.getByRole('region', { name: 'Videoconsulta' });
  await expect(panel.getByText('Falta el enlace de la videoconsulta')).toBeVisible();
  await expect(panel.getByText(/desactivada en esta organización/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Entrar a la videoconsulta' })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // A link from a service the platform does not allow is refused next to the field.
  await panel.getByRole('button', { name: 'Adjuntar enlace manual' }).click();
  const dialog = page.getByRole('dialog', { name: 'Enlace manual' });
  await dialog.getByLabel('Dirección de la videollamada').fill('https://evil.example/sala');
  await dialog.getByRole('button', { name: 'Adjuntar enlace' }).click();
  await expect(dialog.getByText(/Ese servicio no está permitido/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // An allowed one is attached, and the professional can join it.
  await dialog
    .getByLabel('Dirección de la videollamada')
    .fill('https://meet.google.com/abc-defg-hij');
  await dialog.getByRole('button', { name: 'Adjuntar enlace' }).click();
  await expect(page.getByRole('dialog', { name: 'Enlace manual' })).toHaveCount(0);
  await expect(panel.getByText('Manual', { exact: true })).toBeVisible();
  await expect(panel.getByText('Falta el enlace de la videoconsulta')).toHaveCount(0);

  const popup = context.waitForEvent('page');
  await panel.getByRole('button', { name: 'Entrar a la videoconsulta' }).click();
  const call = await popup;
  await call.waitForURL('https://meet.google.com/abc-defg-hij');

  // The patient's platform address wraps the same manual link.
  const patient = await playwright.request.newContext();
  const link = await patientLink(playwright, waiting.appointmentId);
  expect(await redirectOf(patient, link)).toBe('https://meet.google.com/abc-defg-hij');
});

test('the owner sees the video integration in the scheduling settings', async ({ page }) => {
  await openAs(page, 'owner', '/settings/scheduling');

  const section = page.getByRole('region', { name: 'Videoconsulta' });
  await expect(
    section.getByRole('switch', { name: 'Crear las salas automáticamente' }),
  ).toBeChecked();
  await expect(section.getByText('Salas automáticas activadas')).toBeVisible();
  await expect(section.getByLabel('La sala se habilita (minutos antes del turno)')).toHaveValue(
    '15',
  );
  await section.scrollIntoViewIfNeeded();
  await expectFitsAndAccessible(page);
});
