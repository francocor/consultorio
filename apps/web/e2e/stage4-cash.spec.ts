import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { bookableProfessional, clockTime } from './support/agenda.js';
import { apiCall } from './support/clinical.js';
import {
  axeViolations,
  emailOf,
  horizontalOverflow,
  signInWithApi,
  urlOf,
} from './support/stack.js';

/**
 * The day at the front desk, from the phone (Stage 4, track A; spec "Charges", "Payments",
 * "Cash register"), at 360 px on the real stack:
 *
 * 1. reception checks the patient in; the drawer of the appointment shows the price the system will
 *    charge, in pesos, and reception generates the charge;
 * 2. a payment in cash without an open register is refused with a way to open it; reception opens
 *    the register, takes a partial payment and the charge stays "Pago parcial";
 * 3. reception cannot void the charge or refund the payment (the screen says who can, and the API
 *    refuses the call);
 * 4. at the end of the day reception counts the cash, which is short: the register asks for the
 *    reason of the difference, closes, and keeps the closed day in the history.
 *
 * Everything the journey creates is its own (a new patient, a free time found through the API, the
 * cash register of the place), so it does not collide with the other specs that run in parallel.
 * Axe and the width of the page are checked on every screen.
 */
test.use({
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
});
test.setTimeout(240_000);

const ZONE = 'America/Argentina/Buenos_Aires';
const PRICE_CENTS = 123_450;

/** A document number nobody else uses in this run. */
const uniqueDocument = () => `96${String(Date.now()).slice(-6)}`;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());

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

interface CashSession {
  id: string;
  expectedCents: number;
}

/** A register left open by an earlier run is closed with the count that matches, so this one starts clean. */
async function closeLeftoverRegister(page: Page, locationId: string) {
  const current = await apiCall<{ session: CashSession | null }>(
    page,
    'GET',
    `/billing/cash/current?locationId=${locationId}`,
  );
  expect(current.status).toBe(200);
  if (current.body.session) {
    const closed = await apiCall(
      page,
      'POST',
      `/billing/cash/sessions/${current.body.session.id}/close`,
      { countedCents: current.body.session.expectedCents },
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }
}

test('the front desk charges, takes a partial payment and closes the cash register', async ({
  page,
  browser,
}) => {
  // The administration has a price for the type of appointment (a new date is a new price).
  const admin = await (await browser.newContext()).newPage();
  await signInWithApi(admin.request, 'aillu', emailOf('admin'));

  await signInWithApi(page.request, 'aillu', emailOf('reception'));
  const target = await bookableProfessional(page, { specialty: 'Cardiología' });
  const priced = await apiCall(admin, 'POST', '/billing/prices', {
    appointmentTypeId: target.typeId,
    professionalId: target.professionalId,
    amountCents: PRICE_CENTS,
    effectiveFrom: today(),
  });
  expect([201, 409], JSON.stringify(priced.body)).toContain(priced.status);

  // Reception registers a patient and books a free time (through the API: the screens for this
  // have their own journeys).
  const document = uniqueDocument();
  const family = `Caja${document.slice(-4)}`;
  const patient = await apiCall<{ patient: { id: string } }>(page, 'POST', '/patients', {
    familyName: family,
    givenNames: 'Elena',
    birthDate: '1979-09-21',
    document: { type: 'dni', number: document },
    dataProcessingConsent: true,
  });
  expect(patient.status, JSON.stringify(patient.body)).toBe(201);

  const offset = Math.floor(Math.random() * Math.max(1, target.slots.length - 1));
  let slot = target.slots[offset];
  let booked: { status: number; body: { id?: string } } | undefined;
  for (const candidate of [...target.slots.slice(offset), ...target.slots.slice(0, offset)]) {
    booked = await apiCall<{ id?: string }>(page, 'POST', '/appointments', {
      patientId: patient.body.patient.id,
      professionalId: target.professionalId,
      locationId: candidate.locationId,
      appointmentTypeId: target.typeId,
      startsAt: candidate.startsAt,
    });
    if (booked.status === 201) {
      slot = candidate;
      break;
    }
  }
  if (!slot || booked?.status !== 201) throw new Error('No free time could be booked');
  const locations = await apiCall<{ locations: { id: string; name: string }[] }>(
    page,
    'GET',
    '/locations',
  );
  const locationName =
    locations.body.locations.find((entry) => entry.id === slot.locationId)?.name ?? '';
  expect(locationName).not.toBe('');
  await closeLeftoverRegister(page, slot.locationId);

  const when = clockTime(slot.startsAt);
  const agenda = `/calendar?date=${slot.date}&pros=${target.professionalId}`;
  const card = (status: string) => new RegExp(`${when}.*${family}.*${status}`);

  // 1. The arrival is registered and the drawer shows the price, in pesos, before charging.
  await page.goto(urlOf('aillu', agenda));
  await page
    .getByRole('button', { name: card('Programado') })
    .first()
    .click();
  const drawer = page.getByRole('dialog').first();
  await drawer.getByRole('button', { name: 'Registrar llegada' }).click();
  await expect(drawer.getByText('En sala', { exact: true })).toBeVisible();

  const charge = drawer.getByRole('region', { name: 'Cobro' });
  await expect(charge.getByRole('list', { name: 'Lo que se va a cobrar' })).toContainText(
    '$ 1.234,50',
  );
  await expectFitsAndAccessible(page);
  await charge.getByRole('button', { name: 'Generar el cobro' }).click();
  await expect(charge.getByText('Pendiente', { exact: true })).toBeVisible();
  await expect(charge.getByText('Falta cobrar').locator('xpath=following-sibling::dd')).toHaveText(
    '$ 1.234,50',
  );
  await expectFitsAndAccessible(page);

  // 2. Cash needs an open register: the refusal says so and leads to opening it.
  await charge.getByRole('button', { name: 'Registrar pago' }).click();
  const payment = page.getByRole('dialog', { name: 'Registrar pago' });
  await expect(payment.getByLabel('Importe')).toHaveValue('1.234,50');
  await payment.getByLabel('Importe').fill('500');
  await expect(payment.getByText('Después de este pago quedan $ 734,50 por cobrar.')).toBeVisible();
  await payment.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(payment.getByText(/No hay una caja abierta en esta sede/)).toBeVisible();
  await expectFitsAndAccessible(page);
  await payment.getByRole('link', { name: 'Abrir la caja de la sede' }).click();

  await expect(page).toHaveURL(/\/cash$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Caja' })).toBeVisible();
  // The organization has several places: the register is the one of the appointment.
  await page.getByLabel('Sede').selectOption({ label: locationName });
  await expect(page.getByText(new RegExp(`La caja de ${locationName} está cerrada`))).toBeVisible();
  await expectFitsAndAccessible(page);
  await page.getByLabel('Efectivo con el que empieza').fill('1000');
  await page.getByRole('button', { name: 'Abrir caja' }).click();
  await expect(page.getByRole('heading', { name: `Caja de ${locationName}` })).toBeVisible();
  await expectFitsAndAccessible(page);

  // The payment goes in now: a part of the charge, so the charge stays partially paid.
  await page.goto(urlOf('aillu', agenda));
  await page
    .getByRole('button', { name: card('En sala') })
    .first()
    .click();
  const sameDrawer = page.getByRole('dialog').first();
  const sameCharge = sameDrawer.getByRole('region', { name: 'Cobro' });
  await sameCharge.getByRole('button', { name: 'Registrar pago' }).click();
  const retry = page.getByRole('dialog', { name: 'Registrar pago' });
  await retry.getByLabel('Importe').fill('500');
  await retry.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(retry).toBeHidden();
  await expect(sameCharge.getByText('Pago parcial', { exact: true })).toBeVisible();
  await expect(
    sameCharge.getByText('Falta cobrar').locator('xpath=following-sibling::dd'),
  ).toHaveText('$ 734,50');
  await expect(sameCharge.getByText('Efectivo')).toBeVisible();
  await expectFitsAndAccessible(page);

  // 3. Reception does not void or refund: the screen says who does, and the API refuses.
  await expect(sameCharge.getByRole('button', { name: 'Anular cobro' })).toHaveCount(0);
  await expect(sameCharge.getByRole('button', { name: 'Devolver' })).toHaveCount(0);
  await expect(
    sameCharge.getByText(
      'Anular un cobro o devolver un pago lo hacen el dueño o la administración.',
    ),
  ).toBeVisible();
  const charges = await apiCall<{ charges: { id: string; payments: { id: string }[] }[] }>(
    page,
    'GET',
    `/billing/charges?patientId=${patient.body.patient.id}`,
  );
  const mine = charges.body.charges[0];
  if (!mine?.payments[0]) throw new Error('The charge and its payment should exist');
  const voided = await apiCall(page, 'POST', `/billing/charges/${mine.id}/void`, {
    reason: 'No corresponde',
  });
  expect(voided.status).toBe(403);
  const refunded = await apiCall(page, 'POST', `/billing/payments/${mine.payments[0].id}/refund`, {
    amountCents: 10_000,
    reason: 'No corresponde',
    idempotencyKey: randomUUID(),
  });
  expect(refunded.status).toBe(403);

  // 4. The day is closed with the cash counted: it is short, so the reason is asked.
  await page.goto(urlOf('aillu', '/cash'));
  await page.getByLabel('Sede').selectOption({ label: locationName });
  const summary = page.getByText('Efectivo que debería haber', { exact: true }).first();
  await expect(summary.locator('xpath=following-sibling::dd')).toHaveText('$ 1.500,00');
  await expectFitsAndAccessible(page);
  await page.getByRole('button', { name: 'Cerrar caja' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cerrar la caja' });
  await dialog.getByLabel('Efectivo contado').fill('1450');
  await expect(dialog.getByText('Faltan $ 50,00 respecto de lo esperado.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cerrar caja' })).toBeDisabled();
  await dialog.getByLabel('Motivo de la diferencia').fill('Vuelto de más a un paciente');
  await expectFitsAndAccessible(page);
  await dialog.getByRole('button', { name: 'Cerrar caja' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('heading', { name: 'Cajas anteriores' })).toBeVisible();
  await expect(page.getByText(/diferencia -\$ 50,00/).first()).toBeVisible();
  await expectFitsAndAccessible(page);
});
