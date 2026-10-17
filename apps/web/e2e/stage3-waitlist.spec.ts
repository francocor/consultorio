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
  emailTo,
  horizontalOverflow,
  linkIn,
  localLink,
  originOf,
  stack,
} from './support/stack.js';

/**
 * The waitlist on the real stack (Stage 3, track C; spec "Joining the waitlist", "Matching freed
 * slots", "Offers with expiry"), at 360 px:
 *
 * 1. a visitor who finds no free time on the booking page follows the link to the waitlist, gives
 *    their data and the agreement to be written to, and proves the address with the code;
 * 2. reception sees the entry on the waitlist screen, adds another patient by hand, pauses and
 *    resumes it and closes it with a reason;
 * 3. an appointment is cancelled: the offer arrives in the mailbox, the visitor opens the link and
 *    accepts, the appointment is booked once, and the entry is closed as fulfilled;
 * 4. a second cancellation is declined from the link: the patient stays on the list.
 *
 * The organization is created for the run (a real one, not a demonstration one), so the browser
 * solves the real proof of work and nobody else books the same times. Axe and the width of the
 * page are checked on every screen.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
test.setTimeout(300_000);

const OWNER_PASSWORD = 'una frase larga para la titular 2026';
const HOUR_MS = 3_600_000;
const ZONE = 'America/Argentina/Buenos_Aires';

const PHONE = {
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  locale: 'es-AR',
  timezoneId: ZONE,
  serviceWorkers: 'block' as const,
};

async function visitor(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(PHONE);
  return { context, page: await context.newPage() };
}

/** A confirmation toast fades in; axe reads the colors mid-fade, so let it settle first. */
async function settle(page: Page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-sonner-toast]')].every(
      (toast) => getComputedStyle(toast).opacity === '1',
    ),
  );
}

async function expectFitsAndAccessible(page: Page) {
  await settle(page);
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

const localHour = (iso: string) =>
  Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(iso),
    ),
  );

const localDate = (offsetDays: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(
    new Date(Date.now() + offsetDays * 24 * HOUR_MS),
  );

interface Organization {
  slug: string;
  origin: string;
  owner: Api;
  ownerEmail: string;
  professionalId: string;
  locationId: string;
  typeId: string;
  /** The public address of the professional's booking page. */
  bookingPath: string;
}

/**
 * A real organization with one professional, a mailbox for the owner and the professional's
 * booking link enabled. Online booking is set so that nothing is ever free for a visitor (a week
 * of lead time and a one day horizon): the visitor reaches the waitlist the way a real one does,
 * through the page that has nothing to offer. The quiet hours are off, so an offer is not held
 * back until the morning when the run happens at night.
 */
async function createOrganization(
  playwright: { request: { newContext(options?: object): Promise<APIRequestContext> } },
  suffix: string,
): Promise<Organization> {
  const ownerEmail = `espera.${suffix}@demo.invalid`;
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const created = await operator.post(`${originOf('platform')}/api/operator/tenants`, {
    data: { name: `Consultorio Espera ${suffix.slice(-6)}`, ownerEmail, isDemo: false },
    headers: { origin: originOf('platform') },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const slug = ((await created.json()) as { tenant: { slug: string } }).tenant.slug;
  const origin = `http://${slug}.${stack.baseDomain}:${String(WEB_PORT)}`;

  const owner = apiOf(await playwright.request.newContext(), origin);
  const invitation = await emailTo(ownerEmail, /invitaci/i);
  const token = new URL(linkIn(invitation, '/accept-invitation')).searchParams.get('token');
  expect(
    (await owner.call('POST', '/auth/invitations/accept', { token, password: OWNER_PASSWORD }))
      .status,
  ).toBe(204);
  expect(
    (await owner.call('POST', '/auth/login', { email: ownerEmail, password: OWNER_PASSWORD }))
      .status,
  ).toBe(200);
  expect(
    (
      await owner.call('POST', '/onboarding/fast-path', {
        fullName: 'Dra. Ana Espera',
        specialties: ['Nutrición'],
      })
    ).status,
  ).toBe(200);

  const staff = await owner.call<{
    staff: { professional: { id: string } | null }[];
  }>('GET', '/staff');
  const professionalId = staff.body.staff.find((entry) => entry.professional)?.professional?.id;
  const types = await owner.call<{ types: { id: string }[] }>('GET', '/appointment-types');
  const typeId = types.body.types[0]?.id;
  const locations = await owner.call<{ locations: { id: string }[] }>('GET', '/locations');
  const locationId = locations.body.locations[0]?.id;
  if (!professionalId || !typeId || !locationId) throw new Error('The quick setup is incomplete');

  expect(
    (
      await owner.call('PATCH', '/settings', {
        quietHours: { start: '00:00', end: '00:00' },
        onlineBooking: { minLeadHours: 336, horizonDays: 1 },
      })
    ).status,
  ).toBe(200);
  const listed = await owner.call<{ links: BookingLinkDto[] }>('GET', '/booking-links');
  const existing = listed.body.links.find((link) => link.professionalId === null);
  const organizationLink = existing
    ? await owner.call<BookingLinkDto>('PATCH', `/booking-links/${existing.id}`, { enabled: true })
    : await owner.call<BookingLinkDto>('POST', '/booking-links', { enabled: true });
  expect(organizationLink.status).toBeLessThan(300);
  const professionalLink = await owner.call<BookingLinkDto>('POST', '/booking-links', {
    professionalId,
    enabled: true,
    typeIds: [typeId],
  });
  expect(professionalLink.status).toBe(201);

  return {
    slug,
    origin,
    owner,
    ownerEmail,
    professionalId,
    locationId,
    typeId,
    bookingPath: professionalLink.body.path ?? '',
  };
}

interface Slot {
  startsAt: string;
  date: string;
}

/** Free times at midday, at least three days ahead, as staff see them. */
async function middayTimes(org: Organization, count: number): Promise<Slot[]> {
  const query = new URLSearchParams({
    professionalId: org.professionalId,
    typeId: org.typeId,
    from: localDate(0),
    to: localDate(27),
  });
  const availability = await org.owner.call<{ slots: Slot[] }>(
    'GET',
    `/availability?${query.toString()}`,
  );
  const slots = availability.body.slots.filter(
    (entry) =>
      new Date(entry.startsAt).getTime() > Date.now() + 72 * HOUR_MS &&
      localHour(entry.startsAt) >= 11 &&
      localHour(entry.startsAt) <= 15,
  );
  // The grid steps by a few minutes: keep times that cannot overlap each other.
  const apart: Slot[] = [];
  for (const entry of slots) {
    const last = apart[apart.length - 1];
    if (
      !last ||
      new Date(entry.startsAt).getTime() - new Date(last.startsAt).getTime() >= 2 * HOUR_MS
    ) {
      apart.push(entry);
    }
  }
  if (apart.length < count) throw new Error('The new consultorio has too few midday free times');
  return apart.slice(0, count);
}

interface Booked {
  id: string;
  version: number;
  startsAt: string;
}

/** Staff register a patient with an email and book them at a time: the appointment to cancel. */
async function bookSomeone(org: Organization, slot: Slot, suffix: string): Promise<Booked> {
  const patient = await org.owner.call<{ patient: { id: string } }>('POST', '/patients', {
    familyName: `Reserva${suffix.slice(-5)}`,
    givenNames: 'Mauro',
    birthDate: '1985-02-02',
    document: { type: 'dni', number: `97${suffix.slice(-6)}` },
    email: `reserva.${suffix}@demo.invalid`,
    dataProcessingConsent: true,
  });
  expect(patient.status, JSON.stringify(patient.body)).toBe(201);
  const booked = await org.owner.call<Booked>('POST', '/appointments', {
    patientId: patient.body.patient.id,
    professionalId: org.professionalId,
    locationId: org.locationId,
    appointmentTypeId: org.typeId,
    startsAt: slot.startsAt,
  });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  return booked.body;
}

async function cancel(org: Organization, booked: Booked): Promise<void> {
  const response = await org.owner.call('POST', `/appointments/${booked.id}/cancel`, {
    cancelledBy: 'patient',
    reasonCode: 'patient_request',
    expectedVersion: booked.version,
  });
  expect(response.status).toBe(200);
}

/** The visitor joins from the booking page that has nothing free, through to the code. */
async function join(page: Page, org: Organization, email: string, family: string) {
  await page.goto(`${org.origin}${org.bookingPath}`);
  await expect(page.getByText('No hay horarios disponibles en estas fechas.')).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByRole('link', { name: 'Anotarme en la lista de espera' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Anótese en la lista de espera' }),
  ).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByLabel('Nombres').fill('Lucía');
  await page.getByLabel('Apellido').fill(family);
  await page.getByLabel('DNI').fill(`95${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Fecha de nacimiento').fill('1990-04-02');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByRole('checkbox', { name: /Acepto que me escriban/ }).click();
  await page.getByRole('checkbox', { name: /Acepto que el consultorio trate/ }).click();
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Anotarme en la lista' }).click();

  await expect(page.getByRole('heading', { name: 'Confirme su correo' })).toBeVisible();
  await expectFitsAndAccessible(page);
  const message = await emailTo(email, /lista de espera/i);
  // The code is alone on its line; the organization's name may well contain six digits.
  const code = /^\s*(\d{6})\s*$/m.exec(message)?.[1];
  expect(code, 'the email carries a six digit code').toBeDefined();
  await page.getByLabel('Código de 6 dígitos').fill(code ?? '');
  await page.getByRole('button', { name: 'Confirmar y anotarme' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Quedó anotado en la lista de espera' }),
  ).toBeVisible();
  await expectFitsAndAccessible(page);
}

test('a visitor joins the waitlist, reception looks after it, and a cancellation is offered, accepted and booked once', async ({
  page,
  browser,
  playwright,
}) => {
  const suffix = String(Date.now());
  const org = await createOrganization(playwright, suffix);
  const [firstSlot, secondSlot] = await middayTimes(org, 2);
  if (!firstSlot || !secondSlot) throw new Error('No free times');
  const family = `Espera${suffix.slice(-5)}`;
  const email = `visita.espera.${suffix}@demo.invalid`;

  // 1. The visitor finds no free time and joins the waitlist.
  const guest = await visitor(browser);
  await join(guest.page, org, email, family);

  // 2. Reception (here, the owner) sees the entry, adds another by hand and looks after it.
  await page.request.post(`${org.origin}/api/auth/login`, {
    data: { email: org.ownerEmail, password: OWNER_PASSWORD },
    headers: { origin: org.origin },
  });
  await page.goto(`${org.origin}/waitlist`);
  await expect(page.getByRole('heading', { level: 1, name: 'Lista de espera' })).toBeVisible();
  const joined = page.getByRole('listitem').filter({ hasText: `Lucía ${family}` });
  await expect(joined).toBeVisible();
  await expect(joined).toContainText('En espera');
  await expect(joined).toContainText('Cualquiera');
  await expectFitsAndAccessible(page);

  const patient = await org.owner.call<{ patient: { id: string } }>('POST', '/patients', {
    familyName: `Manual${suffix.slice(-5)}`,
    givenNames: 'Inés',
    birthDate: '1979-09-09',
    document: { type: 'dni', number: `98${suffix.slice(-6)}` },
    email: `manual.${suffix}@demo.invalid`,
    dataProcessingConsent: true,
  });
  expect(patient.status).toBe(201);
  await page.getByRole('button', { name: 'Agregar a la lista' }).click();
  const dialog = page.getByRole('dialog', { name: 'Agregar a la lista de espera' });
  await dialog.getByRole('combobox', { name: 'Paciente' }).fill(`Manual${suffix.slice(-5)}`);
  await dialog.getByRole('option', { name: new RegExp(`Manual${suffix.slice(-5)}`) }).click();
  await dialog.getByLabel('Tipo de turno').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Mañana (8 a 12)' }).click();
  await expectFitsAndAccessible(page);
  await dialog.getByRole('button', { name: 'Agregar a la lista' }).click();
  const manual = page.getByRole('listitem').filter({ hasText: `Inés Manual${suffix.slice(-5)}` });
  await expect(manual).toBeVisible();
  // No agreement was recorded, so the entry is kept for calling.
  await expect(manual).toContainText('Solo contacto manual');
  await expectFitsAndAccessible(page);

  await manual.getByRole('button', { name: 'Pausar' }).click();
  await expect(manual).toContainText('Pausada');
  await manual.getByRole('button', { name: 'Reanudar' }).click();
  await expect(manual).toContainText('En espera');
  await manual.getByRole('button', { name: 'Cerrar' }).click();
  const closing = page.getByRole('dialog', { name: /Cerrar la espera de/ });
  await expectFitsAndAccessible(page);
  await closing.getByRole('button', { name: 'Cerrar la espera' }).click();
  await expect(manual).toBeHidden();

  // 3. An appointment is cancelled: the offer arrives, the visitor accepts, it is booked once.
  const taken = await bookSomeone(org, firstSlot, suffix);
  await cancel(org, taken);
  const offer = await emailTo(email, /Hay un turno disponible/i);
  expect(offer).toContain('Dónde:');
  expect(offer).not.toMatch(/Consulta|motivo/i);
  const offerLink = localLink(linkIn(offer, '/public/t/'));

  await guest.page.goto(offerLink);
  await expect(
    guest.page.getByRole('heading', { level: 1, name: 'Hay un turno disponible' }),
  ).toBeVisible();
  await expectFitsAndAccessible(guest.page);
  await guest.page.getByRole('button', { name: 'Aceptar el turno' }).click();
  await expect(
    guest.page.getByRole('heading', { level: 1, name: 'Turno confirmado' }),
  ).toBeVisible();
  await expectFitsAndAccessible(guest.page);

  // The appointment exists once, for the visitor, and the entry is closed as fulfilled.
  const feed = await org.owner.call<{
    appointments: { startsAt: string; status: string; source: string; patientName: string }[];
  }>(
    'GET',
    `/appointments?from=${new Date(firstSlot.startsAt).toISOString()}&to=${new Date(
      new Date(firstSlot.startsAt).getTime() + HOUR_MS,
    ).toISOString()}`,
  );
  const live = feed.body.appointments.filter((entry) => entry.status !== 'cancelled');
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ source: 'waitlist_offer' });
  expect(live[0]?.patientName).toContain(family);
  await page.goto(`${org.origin}/waitlist`);
  await page.getByLabel('Mostrar').selectOption('Cerrada');
  const fulfilled = page.getByRole('listitem').filter({ hasText: `Lucía ${family}` });
  await expect(fulfilled).toContainText('Cerrada');
  await expect(fulfilled).toContainText('Turno asignado');
  await expectFitsAndAccessible(page);

  // The link is spent: opening it again finds a link that is no longer valid.
  await guest.page.goto(offerLink);
  await expect(guest.page.getByRole('heading', { name: 'Este enlace no es válido' })).toBeVisible();
  await guest.context.close();

  // 4. A patient who declines stays on the list.
  const second = await visitor(browser);
  const secondFamily = `Declina${suffix.slice(-5)}`;
  const secondEmail = `declina.${suffix}@demo.invalid`;
  await join(second.page, org, secondEmail, secondFamily);
  await cancel(org, await bookSomeone(org, secondSlot, `${suffix}9`));
  const declineOffer = await emailTo(secondEmail, /Hay un turno disponible/i);
  await second.page.goto(localLink(linkIn(declineOffer, '/public/t/')));
  await second.page.getByRole('button', { name: 'No me sirve' }).click();
  await expect(
    second.page.getByRole('heading', { level: 1, name: 'Gracias por avisarnos' }),
  ).toBeVisible();
  await expectFitsAndAccessible(second.page);
  await page.goto(`${org.origin}/waitlist`);
  const stays = page.getByRole('listitem').filter({ hasText: `Lucía ${secondFamily}` });
  await expect(stays).toContainText('En espera');
  await second.context.close();
});
