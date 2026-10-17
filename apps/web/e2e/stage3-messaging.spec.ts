import { expect, test, type Page } from '@playwright/test';

import { clockTime } from './support/agenda.js';
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
 * Messages to the patient on a phone (Stage 3, track A; spec "Automatic reminders", "Confirmation
 * by the patient", "Opt-out and consent"), end to end on the real stack at 360 px.
 *
 * The demo organizations never send anything (decision D17), so the journey creates a real one:
 *
 * 1. the owner sets up the consultorio, registers a patient with an email and a mobile number and
 *    records, in person, that the patient accepts WhatsApp;
 * 2. Settings > Mensajes sets two reminder times; booking an appointment days ahead queues them;
 * 3. the owner resends the reminder from the appointment: it arrives in Mailpit (with the links)
 *    and on the phone of the local WhatsApp simulator, in the provider console;
 * 4. the patient confirms with the link, with no account, and the appointment is confirmed;
 * 5. the patient replies BAJA on the simulator: the pending WhatsApp reminders are cancelled and
 *    the record says so, and only the patient can switch the channel back on.
 *
 * The organization and the patient are unique to each run. Axe runs on every new screen.
 */
// An action that cannot find its element fails in seconds with its name, not at the test timeout.
test.use({
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  actionTimeout: 15_000,
});
test.setTimeout(300_000);

const OWNER_PASSWORD = 'una frase larga para la titular 2026';
const HOUR_MS = 3_600_000;
const ZONE = 'America/Argentina/Buenos_Aires';

const orgUrl = (slug: string, path = '/') =>
  `http://${slug}.${stack.baseDomain}:${String(WEB_PORT)}${path}`;

async function settle(page: Page) {
  // A confirmation toast fades in; axe reads the colors mid-fade, so let it settle first.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-sonner-toast]')].every(
      (toast) => getComputedStyle(toast).opacity === '1',
    ),
  );
}

/** The screen fits a 360 px phone and passes axe in a real browser (contrast included). */
async function expectFitsAndAccessible(page: Page) {
  await settle(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

interface Slot {
  startsAt: string;
  date: string;
}

const localHour = (iso: string) =>
  Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(iso),
    ),
  );

test('the owner resends a reminder, the patient confirms and then opts out of WhatsApp', async ({
  page,
  browser,
  playwright,
}) => {
  const suffix = String(Date.now());
  const name = `Consultorio Mensajes ${suffix.slice(-6)}`;
  const ownerEmail = `titular.mensajes.${suffix}@demo.invalid`;
  const family = `Mensajes${suffix.slice(-4)}`;
  const given = 'Camila';
  const patientEmail = `paciente.${suffix}@demo.invalid`;
  // An Argentine mobile number nobody else uses in this run: +54 9 11 and eight digits.
  const patientPhone = `+54911${suffix.slice(-8)}`;

  // The platform operator creates a REAL organization (not a demonstration one).
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  const created = await operator.post(`${originOf('platform')}/api/operator/tenants`, {
    data: { name, ownerEmail, isDemo: false },
    headers: { origin: originOf('platform') },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const slug = ((await created.json()) as { tenant: { slug: string } }).tenant.slug;

  // The owner activates the account and uses the quick setup: a consultorio, hours, an agenda.
  const invitation = await emailTo(ownerEmail, /invitaci/i);
  await page.goto(localLink(linkIn(invitation, '/accept-invitation')));
  await page.getByLabel('Contraseña', { exact: true }).fill(OWNER_PASSWORD);
  await page.getByLabel('Repetir contraseña').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Activar cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Su cuenta está activa' })).toBeVisible();

  await page.goto(orgUrl(slug, '/login'));
  await page.getByLabel('Correo electrónico').fill(ownerEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole('button', { name: 'Usar la configuración rápida' }).click();
  await page.getByLabel('Nombre y apellido').fill('Dra. Laura Medina');
  await page.getByLabel('Profesión o especialidad').fill('Clínica médica');
  // A professional needs a registration (D21): the role is not active without one.
  await page.getByLabel('Jurisdicción de la matrícula').selectOption('AR-B');
  await page.getByLabel('Número de matrícula').fill('45678');
  await page.getByRole('button', { name: 'Dejar todo listo' }).click();
  await expect(page.getByRole('heading', { name: 'Su consultorio está listo' })).toBeVisible();

  // 1. The owner registers the patient, with an email and a mobile number.
  await page.goto(orgUrl(slug, '/patients/new'));
  await page.getByLabel('Apellido').fill(family);
  await page.getByLabel('Nombre', { exact: true }).fill(given);
  await page.getByLabel('Fecha de nacimiento').fill('1990-06-21');
  await page.getByLabel('Número de documento').fill(`96${suffix.slice(-6)}`);
  await page.getByLabel('Teléfono', { exact: true }).fill(patientPhone);
  await page.getByLabel('Correo electrónico').fill(patientEmail);
  await page.getByRole('radio', { name: /El paciente acepta el tratamiento/ }).click();
  await page.getByRole('button', { name: 'Registrar paciente' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `${given} ${family}` })).toBeVisible();

  // ...and records, in person, that the patient accepts WhatsApp.
  await page.getByRole('tab', { name: 'Mensajes' }).click();
  const whatsapp = page.getByRole('region', { name: 'WhatsApp' });
  await expect(whatsapp.getByText('No aceptado')).toBeVisible();
  await expectFitsAndAccessible(page);
  await whatsapp
    .getByRole('button', { name: 'Registrar que acepta WhatsApp (en persona)' })
    .click();
  await expect(whatsapp.getByText('Aceptado')).toBeVisible();
  await expectFitsAndAccessible(page);

  // 2. Settings > Mensajes: two reminders, 24 and 2 hours before.
  await page.goto(orgUrl(slug, '/settings/messaging'));
  await expect(page.getByRole('heading', { level: 2, name: 'Mensajes a pacientes' })).toBeVisible();
  const first = page.getByLabel('Recordatorio 1: horas antes del turno');
  await first.fill('24');
  await page.getByRole('button', { name: 'Agregar otro recordatorio' }).click();
  await page.getByLabel('Recordatorio 2: horas antes del turno').fill('2');
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(page.getByText('Configuración guardada.')).toBeVisible();
  await expectFitsAndAccessible(page);

  // The appointment: a free time at least three days ahead, midday, so both reminders are
  // pending outside the quiet hours.
  const staff = (await (await page.request.get(orgUrl(slug, '/api/staff'))).json()) as {
    staff: { professional: { id: string } | null }[];
  };
  const professionalId = staff.staff.find((entry) => entry.professional)?.professional?.id;
  if (!professionalId) throw new Error('The quick setup created no professional');
  const types = (await (await page.request.get(orgUrl(slug, '/api/appointment-types'))).json()) as {
    types: { id: string }[];
  };
  const typeId = types.types[0]?.id;
  if (!typeId) throw new Error('The quick setup created no appointment type');
  const date = (offsetDays: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(
      new Date(Date.now() + offsetDays * 24 * HOUR_MS),
    );
  const query = new URLSearchParams({
    professionalId,
    typeId,
    from: date(0),
    to: date(27),
  });
  const availability = (await (
    await page.request.get(orgUrl(slug, `/api/availability?${query.toString()}`))
  ).json()) as { slots: Slot[] };
  const slot = availability.slots.find(
    (entry) =>
      new Date(entry.startsAt).getTime() > Date.now() + 72 * HOUR_MS &&
      localHour(entry.startsAt) >= 11 &&
      localHour(entry.startsAt) <= 15,
  );
  if (!slot) throw new Error('The new consultorio has no midday free time three days ahead');
  const when = clockTime(slot.startsAt);

  await page.goto(orgUrl(slug, `/calendar?date=${slot.date}&pros=${professionalId}`));
  await page.getByRole('button', { name: 'Nuevo turno' }).click();
  const booking = page.getByRole('dialog', { name: 'Nuevo turno' });
  await booking
    .getByRole('group', { name: 'Horarios disponibles' })
    .getByRole('button', { name: when, exact: true })
    .click();
  await booking.getByRole('combobox', { name: 'Paciente' }).fill(family);
  await booking.getByRole('option', { name: new RegExp(family) }).click();
  await booking.getByRole('button', { name: 'Dar turno' }).click();
  await expect(booking).toBeHidden();

  // The drawer stays open across a reload (its address holds the appointment); open it if not.
  const openAppointment = async (status: string) => {
    const dialog = page.getByRole('dialog');
    const reopened = await dialog
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!reopened) {
      await page
        .getByRole('button', { name: new RegExp(`${when}.*${family}.*${status}`) })
        .first()
        .click();
    }
    return dialog;
  };

  // Each reminder is queued on the patient's preferred channel (WhatsApp, which they accepted);
  // email is the fallback if it fails.
  await page
    .getByRole('button', { name: new RegExp(`${when}.*${family}.*Programado`) })
    .first()
    .click();
  const drawer = page.getByRole('dialog');
  const log = drawer.getByRole('list', { name: 'Mensajes enviados por este turno' });
  await expect(log.getByRole('listitem')).toHaveCount(2);
  await expect(log.getByRole('listitem').filter({ hasText: 'En cola' })).toHaveCount(2);
  await expect(log.getByRole('listitem').filter({ hasText: 'WhatsApp' })).toHaveCount(2);
  await expectFitsAndAccessible(page);

  // 3. The owner resends the reminder on both channels.
  await drawer.getByRole('button', { name: 'Reenviar por email' }).click();
  await expect(drawer.getByText('Reenvíos disponibles: 2 de 3.')).toBeVisible();
  await drawer.getByRole('button', { name: 'Reenviar por WhatsApp' }).click();
  await expect(drawer.getByText('Reenvíos disponibles: 1 de 3.')).toBeVisible();
  await expect(log.getByRole('listitem').filter({ hasText: 'reenvío manual' })).toHaveCount(2);

  // The email arrives, with the links; nothing clinical, and the organization's own name.
  const reminder = await emailTo(patientEmail, /Recordatorio/);
  expect(reminder).toContain(name);
  const confirmLink = localLink(
    /confirmar su asistencia, abra este enlace:\s*(https?:\/\/\S+\/public\/t\/\S+)/i.exec(
      reminder,
    )?.[1] ?? '',
  );
  expect(confirmLink).toContain('/public/t/');

  // The phone of the local WhatsApp simulator, in the provider console, shows the same reminder.
  const console_ = await (
    await browser.newContext({
      storageState: OPERATOR_STATE,
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
    })
  ).newPage();
  await console_.goto(originOf('platform'));
  await console_.getByRole('tab', { name: 'Proveedores' }).click();
  await console_.getByRole('tab', { name: 'WhatsApp (simulador)' }).click();
  const phone = console_.getByRole('list', {
    name: 'Mensajes del teléfono del simulador, el más nuevo primero',
  });
  const message = phone.getByRole('listitem').filter({ hasText: `Para ${patientPhone}` });
  await expect(message).toHaveCount(1, { timeout: 30_000 });
  await expect(message).toContainText(`le recordamos su turno en ${name}`);
  await expect(message).toContainText('Responda 1 para confirmar o 2 para cancelar');
  await expectFitsAndAccessible(console_);

  // 4. The patient opens the confirmation link: no account, no sign-in.
  const visitor = await (
    await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true })
  ).newPage();
  await visitor.goto(confirmLink);
  await expect(visitor.getByRole('heading', { name: 'Confirme su asistencia' })).toBeVisible();
  await expectFitsAndAccessible(visitor);
  // Opening the link only looks: the appointment is still scheduled until the visitor acts.
  await visitor.getByRole('button', { name: 'Confirmar asistencia' }).click();
  await expect(visitor.getByRole('heading', { name: 'Asistencia confirmada' })).toBeVisible();
  await expectFitsAndAccessible(visitor);
  // The link is single-use: opening it again says it is no longer valid.
  await visitor.goto(confirmLink);
  await expect(visitor.getByRole('heading', { name: 'Este enlace no es válido' })).toBeVisible();
  await visitor.context().close();

  // The appointment is confirmed: the drawer, opened again, says so.
  await page.reload();
  const confirmed = await openAppointment('Confirmado');
  await expect(confirmed.getByText('Confirmado', { exact: true })).toBeVisible();

  // 5. The patient replies BAJA from the phone: the pending WhatsApp reminders are cancelled.
  await console_.getByLabel('Número del paciente (formato +549…)').fill(patientPhone);
  await console_.getByLabel('Mensaje', { exact: true }).fill('BAJA');
  await console_.getByRole('button', { name: 'Enviar respuesta' }).click();
  await expect(console_.getByText('La respuesta llegó al webhook.')).toBeVisible();
  // One acknowledgment goes back to the patient, and nothing more.
  // The simulator's phone is shared by every organization of the stack, and other specs write
  // BAJA too: look only at the acknowledgment that went to this patient's number.
  await expect(
    phone
      .getByRole('listitem')
      .filter({ hasText: `Para ${patientPhone}` })
      .filter({ hasText: 'no le enviaremos más mensajes por WhatsApp' }),
  ).toHaveCount(1, { timeout: 30_000 });
  await console_.context().close();

  await page.reload();
  const updated = (await openAppointment('Confirmado')).getByRole('list', {
    name: 'Mensajes enviados por este turno',
  });
  await expect(
    updated.getByRole('listitem').filter({ hasText: 'el paciente dio de baja el canal' }),
  ).toHaveCount(2);
  await expectFitsAndAccessible(page);

  // The record says the patient left WhatsApp, and only the patient can come back.
  await page.goto(orgUrl(slug, '/patients'));
  await page
    .getByRole('link', { name: new RegExp(family) })
    .first()
    .click();
  await page.getByRole('tab', { name: 'Mensajes' }).click();
  const channel = page.getByRole('region', { name: 'WhatsApp' });
  await expect(channel.getByText('Dado de baja')).toBeVisible();
  await expect(
    channel.getByRole('button', { name: 'Registrar que acepta WhatsApp (en persona)' }),
  ).toBeDisabled();
  await expect(
    channel.getByText(
      'El paciente dio de baja este canal. Solo el paciente puede volver a activarlo.',
    ),
  ).toBeVisible();
  await expectFitsAndAccessible(page);
});
