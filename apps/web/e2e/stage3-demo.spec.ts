import type { BookingLinkDto } from '@consultorio/contracts';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { clockTime } from './support/agenda.js';
import { OPERATOR_STATE } from './support/operator.js';
import {
  WEB_PORT,
  axeViolations,
  emailOf,
  emailTo,
  horizontalOverflow,
  linkIn,
  localLink,
  originOf,
  signInWithApi,
  stack,
  urlOf,
} from './support/stack.js';

/**
 * The whole of Stage 3 as one journey on the real stack (task 3.77, the Stage 3 gate), the way a
 * consultorio and its patients live it. Patients are on a phone (360 px) and the staff at a desk
 * (1280 px); axe and the width of the page are checked on both, on every new screen.
 *
 * 1. A patient books online, ticking WhatsApp; the consultorio asks to approve every booking.
 * 2. Reception finds the booking in the pending list and approves it.
 * 3. The patient gets the reminder on the phone of the WhatsApp simulator and by email, confirms
 *    with the link, and writes BAJA on WhatsApp. The next reminder reaches them by email.
 * 4. A virtual appointment is made while the video provider is off. The patient's confirmation says
 *    the link will follow; when reception attaches a link, the message with the link arrives, its
 *    address opens the call, and the professional joins from the appointment.
 * 5. Another patient waits for a time. The first one cancels from the link in the email, the freed
 *    time is offered to the waiting patient, who accepts it from the offer link and is booked once.
 *
 * The organization is a real one (a demonstration organization never sends a message), created for
 * the run. Nothing leaves the machine: email goes to Mailpit, WhatsApp to the simulator, and the
 * video address is answered by a stub.
 */
test.use({ actionTimeout: 15_000 });
test.setTimeout(600_000);

const OWNER_PASSWORD = 'una frase larga para la titular 2026';
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const ZONE = 'America/Argentina/Buenos_Aires';
const MANUAL_CALL = 'https://meet.google.com/abc-defg-hij';

const PHONE = {
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  locale: 'es-AR',
  timezoneId: ZONE,
  serviceWorkers: 'block' as const,
};
const DESK = {
  viewport: { width: 1280, height: 800 },
  locale: 'es-AR',
  timezoneId: ZONE,
  serviceWorkers: 'block' as const,
};

async function settle(page: Page) {
  // A confirmation toast fades in; axe reads the colors mid-fade, so let it settle first.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-sonner-toast]')].every(
      (toast) => getComputedStyle(toast).opacity === '1',
    ),
  );
}

/** The screen fits its width and passes axe in a real browser (contrast included). */
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

const localDate = (instant: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(instant);

interface Mail {
  Subject: string;
  Created: string;
  To: { Address: string }[];
  ID: string;
}

/**
 * The emails to an address whose subject matches, oldest first, once at least `count` have
 * arrived and (when given) one of them satisfies `ready`. The mailbox is the whole stack's.
 */
async function mailbox(
  address: string,
  subject: RegExp,
  options: { count?: number; ready?: (text: string) => boolean } = {},
): Promise<string[]> {
  const { count = 1, ready } = options;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${stack.mailpitUrl}/api/v1/messages?limit=200`)).json()) as {
      messages: Mail[];
    };
    const mine = list.messages
      .filter(
        (message) =>
          subject.test(message.Subject) &&
          message.To.some((to) => to.Address.toLowerCase() === address.toLowerCase()),
      )
      .sort((a, b) => a.Created.localeCompare(b.Created));
    if (mine.length >= count) {
      const texts = await Promise.all(
        mine.map(async (message) => {
          const full = (await (
            await fetch(`${stack.mailpitUrl}/api/v1/message/${message.ID}`)
          ).json()) as { Text: string };
          return full.Text;
        }),
      );
      if (ready === undefined || texts.some(ready)) return texts;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`The ${String(count)} email(s) "${subject.source}" to ${address} did not arrive`);
}

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
 * A real organization with one professional (the owner, with a complete profile), the booking link
 * of the professional enabled, every booking waiting for approval and no quiet hours (a run at
 * night would otherwise hold every message until the morning).
 */
async function createOrganization(
  playwright: { request: { newContext(options?: object): Promise<APIRequestContext> } },
  suffix: string,
): Promise<Organization> {
  const ownerEmail = `demo.etapa3.${suffix}@demo.invalid`;
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const created = await operator.post(`${originOf('platform')}/api/operator/tenants`, {
    data: { name: `Consultorio Etapa 3 ${suffix.slice(-6)}`, ownerEmail, isDemo: false },
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
  const fast = await owner.call('POST', '/onboarding/fast-path', {
    fullName: 'Dra. Ana Etapa',
    specialties: ['Clínica médica'],
    matricula: { jurisdiction: 'AR-B', number: '45678' },
  });
  expect(fast.status, JSON.stringify(fast.body)).toBe(200);

  const staff = await owner.call<{ staff: { professional: { id: string } | null }[] }>(
    'GET',
    '/staff',
  );
  const professionalId = staff.body.staff.find((entry) => entry.professional)?.professional?.id;
  const types = await owner.call<{ types: { id: string }[] }>('GET', '/appointment-types');
  const typeId = types.body.types[0]?.id;
  const locations = await owner.call<{ locations: { id: string }[] }>('GET', '/locations');
  const locationId = locations.body.locations[0]?.id;
  if (!professionalId || !typeId || !locationId) throw new Error('The quick setup is incomplete');

  const settings = await owner.call('PATCH', '/settings', {
    quietHours: { start: '00:00', end: '00:00' },
    onlineBooking: { requireApproval: true, minLeadHours: 72 },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
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

/** A browser context of the staff, signed in as the owner of the organization. */
async function staffContext(browser: Browser, org: Organization): Promise<BrowserContext> {
  const context = await browser.newContext(DESK);
  const login = await context.request.post(`${org.origin}/api/auth/login`, {
    data: { email: org.ownerEmail, password: OWNER_PASSWORD },
    headers: { origin: org.origin },
  });
  expect(login.ok(), await login.text()).toBe(true);
  return context;
}

interface FeedEntry {
  id: string;
  version: number;
  startsAt: string;
  status: string;
  patientName: string;
}

async function appointmentOf(org: Organization, family: string): Promise<FeedEntry> {
  const from = new Date(Date.now() - HOUR_MS).toISOString();
  const to = new Date(Date.now() + 40 * 24 * HOUR_MS).toISOString();
  const feed = await org.owner.call<{ appointments: FeedEntry[] }>(
    'GET',
    `/appointments?from=${from}&to=${to}`,
  );
  const found = feed.body.appointments.find(
    (entry) => entry.patientName.includes(family) && entry.status !== 'cancelled',
  );
  if (!found) throw new Error(`No live appointment of ${family}`);
  return found;
}

const calendarPath = (appointment: FeedEntry) =>
  `/calendar?view=day&date=${localDate(new Date(appointment.startsAt))}&appointment=${appointment.id}`;

test('a patient books online, is reminded and confirms, has a video visit, and a freed time reaches the waitlist', async ({
  browser,
  playwright,
}) => {
  const suffix = String(Date.now());
  const org = await createOrganization(playwright, suffix);
  const family = `Etapa${suffix.slice(-5)}`;
  const given = 'Lucía';
  const email = `paciente.etapa.${suffix}@demo.invalid`;
  // An Argentine mobile number nobody else uses in this run: +54 9 11 and eight digits.
  const phone = `+54911${suffix.slice(-8)}`;

  const patient = await browser.newContext(PHONE);
  const phonePage = await patient.newPage();
  const desk = await staffContext(browser, org);
  const staff = await desk.newPage();

  // 1. The patient books online and asks for WhatsApp.
  await test.step('a patient books online, ticking WhatsApp', async () => {
    await phonePage.goto(`${org.origin}${org.bookingPath}`);
    await expect(
      phonePage.getByRole('heading', { level: 1, name: /Reserve su turno/ }),
    ).toBeVisible();
    const time = phonePage.getByRole('button', { name: /a las \d\d:\d\d$/ }).first();
    await expect(time).toBeVisible();
    await expectFitsAndAccessible(phonePage);
    await time.click();

    await expect(phonePage.getByRole('heading', { name: 'Sus datos' })).toBeVisible();
    await phonePage.getByLabel('Nombres').fill(given);
    await phonePage.getByLabel('Apellido').fill(family);
    await phonePage.getByLabel('DNI').fill(`94${suffix.slice(-6)}`);
    await phonePage.getByLabel('Fecha de nacimiento').fill('1990-04-02');
    await phonePage.getByLabel('Correo electrónico').fill(email);
    await phonePage.getByLabel('Celular (opcional)').fill(phone);
    await phonePage
      .getByRole('checkbox', { name: /Quiero recibir recordatorios y confirmaciones por WhatsApp/ })
      .click();
    await phonePage.getByRole('checkbox', { name: /Acepto que el consultorio trate/ }).click();
    await expectFitsAndAccessible(phonePage);
    await phonePage.getByRole('button', { name: 'Continuar' }).click();

    await expect(phonePage.getByRole('heading', { name: 'Confirme su correo' })).toBeVisible();
    await expectFitsAndAccessible(phonePage);
    const [message] = await mailbox(email, /código/i);
    const code = /^\s*(\d{6})\s*$/m.exec(message ?? '')?.[1];
    expect(code, 'the email carries a six digit code').toBeDefined();
    await phonePage.getByLabel('Código de 6 dígitos').fill(code ?? '');
    await phonePage.getByRole('button', { name: 'Confirmar el turno' }).click();

    // The consultorio approves every booking: the patient is told their request arrived.
    await expect(
      phonePage.getByRole('heading', { level: 1, name: 'Recibimos su pedido de turno' }),
    ).toBeVisible();
    await expectFitsAndAccessible(phonePage);
  });

  // 2. Reception finds it in the pending list and approves it.
  await test.step('reception approves the booking from the pending list', async () => {
    await staff.goto(`${org.origin}/worklist`);
    await expect(staff.getByRole('heading', { level: 1, name: 'Pendientes' })).toBeVisible();
    await expect(staff.getByText('Reserva por aprobar').first()).toBeVisible();
    await expectFitsAndAccessible(staff);
    await staff.getByRole('button', { name: 'Aprobar turno' }).click();
    await expect(staff.getByText('No hay pendientes. Todo está al día.')).toBeVisible();
    await expectFitsAndAccessible(staff);
  });

  const booked = await appointmentOf(org, family);
  expect(booked.status).toBe('scheduled');
  const when = clockTime(booked.startsAt);

  // 3. The reminder reaches the phone of the simulator and the mailbox; the patient confirms.
  const operator = await browser.newContext({ ...PHONE, storageState: OPERATOR_STATE });
  const console_ = await operator.newPage();
  await test.step('the reminder reaches WhatsApp and email, and the patient confirms with the link', async () => {
    await staff.goto(`${org.origin}${calendarPath(booked)}`);
    const drawer = staff.getByRole('dialog');
    await expect(
      drawer.getByRole('list', { name: 'Mensajes enviados por este turno' }),
    ).toBeVisible();
    await expectFitsAndAccessible(staff);
    await drawer.getByRole('button', { name: 'Reenviar por email' }).click();
    await expect(drawer.getByText('Reenvíos disponibles: 2 de 3.')).toBeVisible();
    await drawer.getByRole('button', { name: 'Reenviar por WhatsApp' }).click();
    await expect(drawer.getByText('Reenvíos disponibles: 1 de 3.')).toBeVisible();
    await expectFitsAndAccessible(staff);

    // The phone of the WhatsApp simulator, in the console of the platform.
    await console_.goto(originOf('platform'));
    await console_.getByRole('tab', { name: 'Proveedores' }).click();
    await console_.getByRole('tab', { name: 'WhatsApp (simulador)' }).click();
    const inbox = console_.getByRole('list', {
      name: 'Mensajes del teléfono del simulador, el más nuevo primero',
    });
    const reminder = inbox.getByRole('listitem').filter({ hasText: `Para ${phone}` });
    await expect(reminder).toHaveCount(1, { timeout: 30_000 });
    await expect(reminder).toContainText('le recordamos su turno en');
    await expect(reminder).toContainText('Responda 1 para confirmar o 2 para cancelar');
    await expectFitsAndAccessible(console_);

    // The email, with the link that confirms.
    const [text] = await mailbox(email, /Recordatorio/);
    const confirmLink = localLink(
      /confirmar su asistencia, abra este enlace:\s*(https?:\/\/\S+\/public\/t\/\S+)/i.exec(
        text ?? '',
      )?.[1] ?? '',
    );
    await phonePage.goto(confirmLink);
    await expect(phonePage.getByRole('heading', { name: 'Confirme su asistencia' })).toBeVisible();
    await expectFitsAndAccessible(phonePage);
    await phonePage.getByRole('button', { name: 'Confirmar asistencia' }).click();
    await expect(phonePage.getByRole('heading', { name: 'Asistencia confirmada' })).toBeVisible();
    await expectFitsAndAccessible(phonePage);
  });

  await test.step('the patient writes BAJA on WhatsApp and the next reminder comes by email', async () => {
    await console_.getByLabel('Número del paciente (formato +549…)').fill(phone);
    await console_.getByLabel('Mensaje', { exact: true }).fill('BAJA');
    await console_.getByRole('button', { name: 'Enviar respuesta' }).click();
    await expect(console_.getByText('La respuesta llegó al webhook.')).toBeVisible();
    await expect(
      console_
        .getByRole('listitem')
        .filter({ hasText: 'no le enviaremos más mensajes por WhatsApp' }),
    ).toHaveCount(1, { timeout: 30_000 });

    // The consultorio's screen now shows the channel as left, and the reminder goes by email.
    await staff.goto(`${org.origin}${calendarPath(booked)}`);
    const drawer = staff.getByRole('dialog');
    await expect(
      drawer
        .getByRole('list', { name: 'Mensajes enviados por este turno' })
        .getByRole('listitem')
        .filter({ hasText: 'el paciente dio de baja el canal' })
        .first(),
    ).toBeVisible();
    await expectFitsAndAccessible(staff);
    await drawer.getByRole('button', { name: 'Reenviar por email' }).click();
    await expect(drawer.getByText('Ya se usaron los 3 reenvíos de este turno.')).toBeVisible();
    expect(await mailbox(email, /Recordatorio/, { count: 2 })).toHaveLength(2);
  });

  // 4. A virtual appointment: the link follows the confirmation.
  const call =
    await test.step('a virtual appointment gets its link after the confirmation said it would follow', async () => {
      const virtualType = await org.owner.call<{ id: string }>('POST', '/appointment-types', {
        name: 'Videoconsulta',
        durationMinutes: 30,
        mode: 'virtual',
      });
      expect(virtualType.status, JSON.stringify(virtualType.body)).toBe(201);
      const patients = await org.owner.call<{ patients: { id: string }[] }>(
        'GET',
        `/patients?q=${family}&status=active`,
      );
      const patientId = patients.body.patients[0]?.id;
      if (!patientId) throw new Error('The patient of the booking is not in the list');

      // The video integration is off while the appointment is made, so it has no room: the
      // confirmation says the link follows.
      const setVideo = (video: boolean) =>
        org.owner.call('PATCH', '/settings', { integrations: { video } });
      expect((await setVideo(false)).status).toBe(200);
      let virtual: FeedEntry | undefined;
      try {
        for (const offset of [10, 5, 15, 20, 25]) {
          const startsAt = new Date(
            Math.round((Date.now() + offset * MINUTE_MS) / MINUTE_MS) * MINUTE_MS,
          );
          const response = await org.owner.call<FeedEntry>('POST', '/appointments', {
            patientId,
            professionalId: org.professionalId,
            locationId: org.locationId,
            appointmentTypeId: virtualType.body.id,
            startsAt: startsAt.toISOString(),
            overrideHours: { reason: 'Prueba automática de la videoconsulta' },
          });
          if (response.status === 409) continue;
          expect(response.status, JSON.stringify(response.body)).toBe(201);
          virtual = response.body;
          break;
        }
      } finally {
        expect((await setVideo(true)).status).toBe(200);
      }
      if (!virtual) throw new Error('No free time for the virtual appointment');
      const visit = virtual;

      // The confirmation reaches the patient, and tells them the link will be sent separately.
      const confirmations = await mailbox(email, /está confirmado/, {
        ready: (text) => text.includes('le enviaremos el enlace por separado'),
      });
      expect(confirmations.some((text) => text.includes('Modalidad: Videollamada'))).toBe(true);

      // Reception attaches the link of a call made elsewhere.
      await staff.goto(`${org.origin}${calendarPath(visit)}`);
      const drawer = staff.getByRole('dialog');
      const panel = drawer.getByRole('region', { name: 'Videoconsulta' });
      await expect(panel.getByText('Falta el enlace de la videoconsulta')).toBeVisible();
      await expectFitsAndAccessible(staff);
      await panel.getByRole('button', { name: 'Adjuntar enlace manual' }).click();
      const dialog = staff.getByRole('dialog', { name: 'Enlace manual' });
      await dialog.getByLabel('Dirección de la videollamada').fill(MANUAL_CALL);
      await dialog.getByRole('button', { name: 'Adjuntar enlace' }).click();
      await expect(staff.getByRole('dialog', { name: 'Enlace manual' })).toHaveCount(0);
      await expect(panel.getByText('Manual', { exact: true })).toBeVisible();

      // The message that keeps the promise arrives, with the address of the platform.
      const [followUp] = await mailbox(email, /El enlace de su videoconsulta/);
      expect(followUp).toContain('Modalidad: Videollamada');
      expect(followUp).not.toContain(MANUAL_CALL);
      return { visit, link: localLink(linkIn(followUp ?? '', '/public/v/')) };
    });

  await test.step('the address opens the call, and the professional joins from the appointment', async () => {
    const anonymous = await playwright.request.newContext();
    const opened = await anonymous.get(call.link, { maxRedirects: 0 });
    expect(opened.status()).toBe(302);
    expect(opened.headers()['location']).toBe(MANUAL_CALL);

    // Never reach a real video service from a spec.
    await desk.route(/^https:\/\/meet\.google\.com\//, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Sala de prueba</p>' }),
    );
    await staff.goto(`${org.origin}${calendarPath(call.visit)}`);
    const panel = staff.getByRole('dialog').getByRole('region', { name: 'Videoconsulta' });
    await expect(panel.getByText(/El paciente abrió el enlace a las/)).toBeVisible();
    await expectFitsAndAccessible(staff);
    const popup = desk.waitForEvent('page');
    await panel.getByRole('button', { name: 'Entrar a la videoconsulta' }).click();
    await (await popup).waitForURL(MANUAL_CALL);
  });

  // 5. Another patient waits; the first cancels from the email; the freed time is offered.
  await test.step('a cancellation is offered to the waitlist and accepted from the link', async () => {
    const waiting = {
      familyName: `Espera${suffix.slice(-5)}`,
      givenNames: 'Mauro',
      email: `espera.etapa.${suffix}@demo.invalid`,
    };
    const created = await org.owner.call<{ patient: { id: string } }>('POST', '/patients', {
      familyName: waiting.familyName,
      givenNames: waiting.givenNames,
      birthDate: '1985-02-02',
      document: { type: 'dni', number: `93${suffix.slice(-6)}` },
      email: waiting.email,
      dataProcessingConsent: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const entry = await org.owner.call('POST', '/waitlist', {
      patientId: created.body.patient.id,
      appointmentTypeId: org.typeId,
      offersOptIn: true,
      channels: ['email'],
    });
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);

    await staff.goto(`${org.origin}/waitlist`);
    const row = staff
      .getByRole('listitem')
      .filter({ hasText: `${waiting.givenNames} ${waiting.familyName}` });
    await expect(row).toContainText('En espera');
    await expectFitsAndAccessible(staff);

    // The patient who booked online cancels from the link in the email they were sent.
    const [pending] = await mailbox(email, /Recibimos su pedido de turno/);
    const manageLink = localLink(linkIn(pending ?? '', '/book/manage/'));
    await phonePage.goto(manageLink);
    await expect(phonePage.getByRole('heading', { level: 1, name: 'Su turno' })).toBeVisible();
    await expectFitsAndAccessible(phonePage);
    await phonePage.getByRole('button', { name: 'Cancelar el turno' }).click();
    await phonePage.getByRole('button', { name: 'Sí, cancelar el turno' }).click();
    await expect(
      phonePage.getByRole('heading', { name: 'Su turno quedó cancelado' }),
    ).toBeVisible();
    await expectFitsAndAccessible(phonePage);

    // The freed time is offered to the patient who waits, by email.
    const [offer] = await mailbox(waiting.email, /Hay un turno disponible/);
    expect(offer).toContain('Lugar:');
    expect(offer).toContain(`Hora: ${when}`);
    const offerLink = localLink(linkIn(offer ?? '', '/public/t/'));
    const waitingPhone = await browser.newContext(PHONE);
    const waitingPage = await waitingPhone.newPage();
    await waitingPage.goto(offerLink);
    await expect(
      waitingPage.getByRole('heading', { level: 1, name: 'Hay un turno disponible' }),
    ).toBeVisible();
    await expectFitsAndAccessible(waitingPage);
    await waitingPage.getByRole('button', { name: 'Aceptar el turno' }).click();
    await expect(
      waitingPage.getByRole('heading', { level: 1, name: 'Turno confirmado' }),
    ).toBeVisible();
    await expectFitsAndAccessible(waitingPage);

    // Booked once, for the patient who waited; the entry is closed as fulfilled.
    const accepted = await appointmentOf(org, waiting.familyName);
    expect(accepted.startsAt).toBe(booked.startsAt);
    await staff.goto(`${org.origin}/waitlist`);
    await staff.getByLabel('Mostrar').selectOption('Cerrada');
    const fulfilled = staff
      .getByRole('listitem')
      .filter({ hasText: `${waiting.givenNames} ${waiting.familyName}` });
    await expect(fulfilled).toContainText('Turno asignado');
    await expectFitsAndAccessible(staff);
    await waitingPhone.close();
  });

  await Promise.all([patient.close(), desk.close(), operator.close()]);
});

test('the demonstration organization opens on its Stage 3 data, and a visitor can use its public booking page', async ({
  browser,
  playwright,
}) => {
  const owner = await playwright.request.newContext();
  await signInWithApi(owner, 'aillu', emailOf('owner'));
  const api = apiOf(owner, originOf('aillu'));

  // The booking links are enabled, with an address a QR code can carry.
  const links = await api.call<{ links: BookingLinkDto[] }>('GET', '/booking-links');
  expect(links.body.links).toHaveLength(4);
  expect(links.body.links.every((link) => link.enabled)).toBe(true);
  const organization = links.body.links.find((link) => link.professionalId === null);
  expect(organization?.path).toMatch(/^\/book\/[a-z0-9]{12}$/);

  // A visitor on a phone opens the page of the organization and sees its professionals.
  const phone = await browser.newContext(PHONE);
  const visitorPage = await phone.newPage();
  await visitorPage.goto(urlOf('aillu', organization?.path ?? '/'));
  await expect(visitorPage.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(visitorPage.getByRole('button', { name: /^Elegir a / })).toHaveCount(3);
  await expectFitsAndAccessible(visitorPage);

  // Reception finds, waiting for a person: a booking to approve and identities to confirm.
  const desk = await browser.newContext(DESK);
  await signInWithApi(desk.request, 'aillu', emailOf('reception'));
  const staff = await desk.newPage();
  await staff.goto(urlOf('aillu', '/worklist'));
  await expect(staff.getByRole('heading', { level: 1, name: 'Pendientes' })).toBeVisible();
  await expect(staff.getByText('Reserva por aprobar').first()).toBeVisible();
  await expect(staff.getByText('Identidad por confirmar').first()).toBeVisible();
  await expectFitsAndAccessible(staff);

  // The waitlist has an entry with an open offer and entries kept for calling.
  await staff.goto(urlOf('aillu', '/waitlist'));
  await expect(staff.getByRole('heading', { level: 1, name: 'Lista de espera' })).toBeVisible();
  await expect(
    staff.getByRole('listitem').filter({ hasText: 'Con oferta abierta' }).first(),
  ).toBeVisible();
  await expect(
    staff.getByRole('listitem').filter({ hasText: 'Solo contacto manual' }).first(),
  ).toBeVisible();
  // ... and the freed times that could not be offered by message are shown to be filled by phone.
  await expect(
    staff.getByRole('heading', { name: 'Turnos para ofrecer por teléfono' }),
  ).toBeVisible();
  await expectFitsAndAccessible(staff);

  await Promise.all([phone.close(), desk.close()]);
});
