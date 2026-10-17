import type { BookingLinkDto } from '@consultorio/contracts';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { OPERATOR_STATE } from './support/operator.js';
import {
  WEB_PORT,
  axeViolations,
  emailOf,
  emailTo,
  horizontalOverflow,
  linkIn,
  originOf,
  signInWithApi,
  stack,
} from './support/stack.js';

/**
 * Online booking on the real stack (Stage 3, track B), as a visitor on a phone: opens the link of a
 * professional, picks a time, gives the data, reads the code from the mailbox, and sees the
 * confirmation, in under a minute. Two visitors race for one time (one wins), a disabled link shows
 * the generic page, and the patient cancels from the link in the confirmation. Axe and the width of
 * the page are checked on every screen at 360 px.
 *
 * The demo organization `aillu` uses the fake bot challenge; a second test creates an organization
 * that is NOT a demo one, so the browser solves the real proof of work in a Web Worker.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
test.setTimeout(240_000);

/** The product bar: a patient finishes in under a minute. */
const BUDGET_SECONDS = 60;
const OWNER_PASSWORD = 'una frase larga para la titular 2026';

const PHONE = {
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  locale: 'es-AR',
  timezoneId: 'America/Argentina/Buenos_Aires',
  serviceWorkers: 'block' as const,
};

async function visitor(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(PHONE);
  return { context, page: await context.newPage() };
}

async function expectFitsAndAccessible(page: Page) {
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

interface Api {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller states the shape it expects
  call<T>(method: string, path: string, data?: unknown): Promise<{ status: number; body: T }>;
}

function apiOf(request: APIRequestContext, origin: string): Api {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see Api.call
    async call<T>(method: string, path: string, data?: unknown) {
      const response = await request.fetch(`${origin}/api${path}`, {
        method,
        headers: { origin },
        ...(data === undefined ? {} : { data }),
      });
      const text = await response.text();
      return { status: response.status(), body: (text ? JSON.parse(text) : undefined) as T };
    },
  };
}

/** Enables the organization link and the professional's link, exposing one type of visit. */
async function openLinks(api: Api, professionalId: string, typeId: string) {
  const listed = await api.call<{ links: BookingLinkDto[] }>('GET', '/booking-links');
  expect(listed.status).toBe(200);
  const existingOrganization = listed.body.links.find((link) => link.professionalId === null);
  const organization = existingOrganization
    ? await api.call<BookingLinkDto>('PATCH', `/booking-links/${existingOrganization.id}`, {
        enabled: true,
      })
    : await api.call<BookingLinkDto>('POST', '/booking-links', { enabled: true });
  expect(organization.status).toBeLessThan(300);
  const existingProfessional = listed.body.links.find(
    (link) => link.professionalId === professionalId,
  );
  const professional = existingProfessional
    ? await api.call<BookingLinkDto>('PATCH', `/booking-links/${existingProfessional.id}`, {
        enabled: true,
        typeIds: [typeId],
        locationIds: [],
      })
    : await api.call<BookingLinkDto>('POST', '/booking-links', {
        professionalId,
        enabled: true,
        typeIds: [typeId],
      });
  expect(professional.status).toBeLessThan(300);
  return { organization: organization.body, professional: professional.body, api };
}

/** A document number nobody else uses in this run. */
const uniqueDocument = () => `95${String(Date.now()).slice(-6)}`;

/**
 * Books through the screens, the way a patient does. Returns the seconds it took, from opening the
 * page to the confirmation.
 */
async function bookAsPatient(page: Page, url: string, email: string): Promise<number> {
  const started = Date.now();
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: /Reserve su turno/ })).toBeVisible();
  const time = page.getByRole('button', { name: /a las \d\d:\d\d$/ }).first();
  await expect(time).toBeVisible();
  await expectFitsAndAccessible(page);
  await time.click();

  await expect(page.getByRole('heading', { name: 'Sus datos' })).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByLabel('Nombres').fill('Lucía');
  await page.getByLabel('Apellido').fill(`Visita${String(Date.now()).slice(-5)}`);
  await page.getByLabel('DNI').fill(uniqueDocument());
  await page.getByLabel('Fecha de nacimiento').fill('1990-04-02');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByRole('checkbox', { name: /Acepto que el consultorio trate/ }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();

  await expect(page.getByRole('heading', { name: 'Confirme su correo' })).toBeVisible();
  await expectFitsAndAccessible(page);
  const message = await emailTo(email, /código/i);
  // The code is alone on its line; the organization's name may well contain six digits.
  const code = /^\s*(\d{6})\s*$/m.exec(message)?.[1];
  expect(code, 'the email carries a six digit code').toBeDefined();
  await page.getByLabel('Código de 6 dígitos').fill(code ?? '');
  await page.getByRole('button', { name: 'Confirmar el turno' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Su turno está reservado' }),
  ).toBeVisible();
  await expectFitsAndAccessible(page);
  return (Date.now() - started) / 1000;
}

/**
 * The psychologist of the demo organization. The other specs book the cardiologist and the
 * pediatrician; a professional of its own keeps this spec from taking the times they look for when
 * they run in parallel.
 */
async function demoProfessional(request: APIRequestContext) {
  const origin = originOf('aillu');
  const api = apiOf(request, origin);
  const staff = await api.call<{
    staff: { professional: { id: string; specialties: string[] } | null }[];
  }>('GET', '/staff');
  const professional = staff.body.staff.find((entry) =>
    entry.professional?.specialties.includes('Psicología'),
  )?.professional;
  if (!professional) throw new Error('No psychologist in the demo');
  const types = await api.call<{ types: { id: string; name: string }[] }>(
    'GET',
    '/appointment-types',
  );
  const type = types.body.types.find((entry) => entry.name === 'Sesión de terapia');
  if (!type) throw new Error('No "Sesión de terapia" type in the demo');
  return { api, origin, professionalId: professional.id, typeId: type.id };
}

test('a visitor books in under a minute, two visitors race for one time, and the patient cancels from the link', async ({
  page,
  browser,
}) => {
  await signInWithApi(page.request, 'aillu', emailOf('owner'));
  const { api, origin, professionalId, typeId } = await demoProfessional(page.request);
  const links = await openLinks(api, professionalId, typeId);
  const professionalUrl = `${origin}${links.professional.path ?? ''}`;

  // 1. The journey, on a phone, against the clock.
  const first = await visitor(browser);
  const email = `visita.${String(Date.now())}@demo.invalid`;
  const seconds = await bookAsPatient(first.page, professionalUrl, email);
  test.info().annotations.push({ type: 'booking-seconds', description: String(seconds) });
  expect(seconds).toBeLessThan(BUDGET_SECONDS);

  // The confirmation email names the place and carries the link to change the appointment.
  const confirmation = await emailTo(email, /confirmado/i);
  expect(confirmation).toMatch(/Dónde:/);
  expect(linkIn(confirmation, '/book/manage/')).toContain('/book/manage/');

  // 2. The patient opens the link of the confirmation and cancels.
  await first.page.getByRole('link', { name: 'Cambiar o cancelar el turno' }).click();
  await expect(first.page.getByRole('heading', { level: 1, name: 'Su turno' })).toBeVisible();
  await expectFitsAndAccessible(first.page);
  await first.page.getByRole('button', { name: 'Cancelar el turno' }).click();
  await expectFitsAndAccessible(first.page);
  await first.page.getByRole('button', { name: 'Sí, cancelar el turno' }).click();
  await expect(
    first.page.getByRole('heading', { level: 1, name: 'Su turno quedó cancelado' }),
  ).toBeVisible();
  await first.context.close();

  // 3. Two visitors look at the same times; the first to choose one gets it, the other is told.
  const one = await visitor(browser);
  const two = await visitor(browser);
  await one.page.goto(professionalUrl);
  await two.page.goto(professionalUrl);
  const timeOf = (page: Page) => page.getByRole('button', { name: /a las \d\d:\d\d$/ }).first();
  await expect(timeOf(one.page)).toBeVisible();
  await expect(timeOf(two.page)).toBeVisible();
  const name = (await timeOf(one.page).getAttribute('aria-label')) ?? '';
  await timeOf(one.page).click();
  await expect(one.page.getByRole('heading', { name: 'Sus datos' })).toBeVisible();

  await two.page.getByRole('button', { name, exact: true }).click();
  await expect(
    two.page.getByText('Alguien reservó ese horario un momento antes. Elija otro, por favor.'),
  ).toBeVisible();
  await expectFitsAndAccessible(two.page);
  await one.context.close();
  await two.context.close();
});

test('a disabled link shows the generic page, and nothing about the organization', async ({
  page,
  browser,
}) => {
  await signInWithApi(page.request, 'aillu', emailOf('owner'));
  const { api, origin, professionalId, typeId } = await demoProfessional(page.request);
  const links = await openLinks(api, professionalId, typeId);
  const professionalUrl = `${origin}${links.professional.path ?? ''}`;
  const patch = (enabled: boolean) =>
    api.call('PATCH', `/booking-links/${links.professional.id}`, { enabled });

  expect((await patch(false)).status).toBe(200);
  try {
    const { context, page: visitorPage } = await visitor(browser);
    await visitorPage.goto(professionalUrl);

    await expect(
      visitorPage.getByRole('heading', { level: 1, name: 'Este enlace no está disponible' }),
    ).toBeVisible();
    await expectFitsAndAccessible(visitorPage);
    // An address that never existed looks the same.
    await visitorPage.goto(`${origin}/book/${'z'.repeat(12)}`);
    await expect(
      visitorPage.getByRole('heading', { level: 1, name: 'Este enlace no está disponible' }),
    ).toBeVisible();
    await context.close();
  } finally {
    await patch(true);
  }
});

test('an organization that is not a demo one solves the real proof of work in the browser', async ({
  browser,
  playwright,
}) => {
  const suffix = String(Date.now() + 11);
  const ownerEmail = `reserva.${suffix}@demo.invalid`;
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const created = await operator.post(`${originOf('platform')}/api/operator/tenants`, {
    data: { name: `Consultorio Reserva ${suffix.slice(-6)}`, ownerEmail, isDemo: false },
    headers: { origin: originOf('platform') },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const slug = ((await created.json()) as { tenant: { slug: string } }).tenant.slug;
  const origin = `http://${slug}.${stack.baseDomain}:${String(WEB_PORT)}`;

  // The owner takes the invitation, signs in and sets the practice up, all through the API.
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
        fullName: 'Dra. Ana Reserva',
        specialties: ['Nutrición'],
        // A professional needs a registration (D21): the role is not active without one.
        matricula: { jurisdiction: 'AR-B', number: 'MP 45671' },
      })
    ).status,
  ).toBe(200);
  const staff = await ownerApi.call<{ staff: { professional: { id: string } | null }[] }>(
    'GET',
    '/staff',
  );
  const professionalId = staff.body.staff.find((entry) => entry.professional)?.professional?.id;
  const types = await ownerApi.call<{ types: { id: string }[] }>('GET', '/appointment-types');
  const typeId = types.body.types[0]?.id;
  expect(professionalId && typeId).toBeTruthy();
  const links = await openLinks(ownerApi, professionalId ?? '', typeId ?? '');

  const { context, page } = await visitor(browser);
  const seconds = await bookAsPatient(
    page,
    `${origin}${links.professional.path ?? ''}`,
    `visita.${suffix}@demo.invalid`,
  );
  test.info().annotations.push({ type: 'booking-seconds', description: String(seconds) });
  expect(seconds).toBeLessThan(BUDGET_SECONDS);
  await context.close();
});
