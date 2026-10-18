import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { acquireAfipLock } from './support/afip-lock.js';
import { bookableProfessional, clockTime } from './support/agenda.js';
import { apiCall } from './support/clinical.js';
import { OPERATOR_STATE } from './support/operator.js';
import {
  axeViolations,
  emailOf,
  horizontalOverflow,
  originOf,
  signInWithApi,
  urlOf,
} from './support/stack.js';

/**
 * Electronic invoices from the front desk, on the real stack (Stage 4, track C; spec
 * "e-invoicing-afip"), at 360 px. The demonstration organization issues through the fake issuer,
 * which the provider console can put in an outage, so the journey is the whole one:
 *
 * 1. reception checks the patient in, generates the charge and invoices a part of it from the
 *    drawer: the invoice is issued with its CAE and marked as a test document;
 * 2. the AFIP service goes down (the provider console): the rest of the charge is requested, it
 *    stays "Pendiente" and nothing is invented;
 * 3. the service recovers: the invoice is issued by itself, once, with no new request;
 * 4. reception sees the invoices and cannot create a credit note (the screen offers none and the
 *    API refuses); the owner credits the first invoice and the note is issued with its own CAE.
 *
 * The fiscal configuration the owner would do in Settings is done through the API (the settings
 * screens have their own journeys). Everything the journey creates is its own (a new patient, a free
 * time found through the API). Axe and the width of the page are checked on every screen.
 */
test.use({
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
});
// The recovery waits for the clock of the retries (the shortest wait is a minute).
test.setTimeout(360_000);

const ZONE = 'America/Argentina/Buenos_Aires';
const PRICE_CENTS = 98_000;
const FIRST_PART_CENTS = 50_000;

const uniqueDocument = () => `95${String(Date.now()).slice(-6)}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());

/** An amount in cents as the screens write it ("$ 1.234,50"). */
const pesos = (cents: number) =>
  `$ ${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)}`;

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

interface InvoiceRow {
  id: string;
  kind: 'invoice' | 'credit_note';
  type: string;
  status: 'pending' | 'issued' | 'rejected' | 'manual';
  number: number | null;
  cae: string | null;
  totalCents: number;
  testDocument: boolean;
}

const invoicesOf = async (page: Page, chargeId: string) =>
  (await apiCall<{ invoices: InvoiceRow[] }>(page, 'GET', `/invoices?chargeId=${chargeId}`)).body
    .invoices;

/** The provider console puts the issuer of the demonstration organizations in a mode. */
async function setAfipMode(operator: APIRequestContext, mode: 'ok' | 'down') {
  const response = await operator.put(urlOf('platform', '/api/operator/dev/afip/mode'), {
    data: { mode },
    headers: { origin: originOf('platform') },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** The fiscal data of the organization, as the owner enters it in Settings. */
async function configureInvoicing(owner: Page) {
  const call = async (method: 'PUT' | 'POST' | 'PATCH', path: string, data: unknown) => {
    const response = await owner.request.fetch(urlOf('aillu', `/api${path}`), {
      method,
      headers: { origin: originOf('aillu') },
      data,
    });
    return { status: response.status(), text: await response.text() };
  };
  const switched = await call('PATCH', '/settings', { integrations: { einvoicing: true } });
  expect(switched.status, switched.text).toBe(200);
  const profile = await call('PUT', '/invoicing/profile', {
    cuit: '20-12345678-6',
    taxCondition: 'monotributo',
    businessName: 'Centro Médico Aillu',
    address: 'Av. Corrientes 1234, CABA',
    activityStartedOn: '2020-03-01',
  });
  expect(profile.status, profile.text).toBe(200);
  const point = await call('POST', '/invoicing/points-of-sale', { number: 1 });
  expect([201, 409], point.text).toContain(point.status);
}

test('the front desk invoices a charge, rides out an AFIP outage and the owner credits it', async ({
  page,
  browser,
  playwright,
}) => {
  // The issuer of the demonstration is one for the whole stack: no other journey may change its mode meanwhile.
  const release = await acquireAfipLock();
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  await setAfipMode(operator, 'ok');
  try {
    const admin = await (await browser.newContext()).newPage();
    await signInWithApi(admin.request, 'aillu', emailOf('admin'));
    await configureInvoicing(admin);

    await signInWithApi(page.request, 'aillu', emailOf('reception'));
    const target = await bookableProfessional(page, { specialty: 'Pediatría' });
    const priced = await apiCall(admin, 'POST', '/billing/prices', {
      appointmentTypeId: target.typeId,
      professionalId: target.professionalId,
      amountCents: PRICE_CENTS,
      effectiveFrom: today(),
    });
    expect([201, 409], JSON.stringify(priced.body)).toContain(priced.status);

    const document = uniqueDocument();
    const family = `Factura${document.slice(-4)}`;
    const patient = await apiCall<{ patient: { id: string } }>(page, 'POST', '/patients', {
      familyName: family,
      givenNames: 'Marta',
      birthDate: '1982-04-12',
      document: { type: 'dni', number: document },
      dataProcessingConsent: true,
    });
    expect(patient.status, JSON.stringify(patient.body)).toBe(201);

    // The later half of the free times: the first ones are the ones the other specs take.
    const later = target.slots.slice(Math.floor(target.slots.length / 2));
    const offset = Math.floor(Math.random() * later.length);
    let slot = later[offset];
    let booked: { status: number; body: { id?: string } } | undefined;
    for (const candidate of [...later.slice(offset), ...later.slice(0, offset)]) {
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

    const when = clockTime(slot.startsAt);
    const agenda = `/calendar?date=${slot.date}&pros=${target.professionalId}`;
    const card = (status: string) => new RegExp(`${when}.*${family}.*${status}`);

    // 1. Arrival, charge, and an invoice for a part of it.
    await page.goto(urlOf('aillu', agenda));
    await page
      .getByRole('button', { name: card('Programado') })
      .first()
      .click();
    const drawer = page.getByRole('dialog').first();
    await drawer.getByRole('button', { name: 'Registrar llegada' }).click();
    await expect(drawer.getByText('En sala', { exact: true })).toBeVisible();
    const charge = drawer.getByRole('region', { name: 'Cobro' });
    await charge.getByRole('button', { name: 'Generar el cobro' }).click();
    await expect(charge.getByText('Pendiente', { exact: true })).toBeVisible();

    const billing = drawer.getByRole('region', { name: 'Facturación' });
    await expect(billing.getByText('Este cobro todavía no tiene facturas.')).toBeVisible();
    await expectFitsAndAccessible(page);

    await billing.getByRole('button', { name: 'Facturar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Facturar' });
    await expect(dialog.getByText('Se emitirá una Factura C.')).toBeVisible();
    await expect(dialog.getByLabel(/Importe a facturar de/)).toHaveValue(
      pesos(PRICE_CENTS).replace('$ ', ''),
    );
    await dialog.getByLabel(/Importe a facturar de/).fill('500');
    await expect(dialog.getByText(`Queda por facturar ${pesos(PRICE_CENTS)}`)).toBeVisible();
    await expectFitsAndAccessible(page);
    await dialog.getByRole('button', { name: 'Pedir la factura' }).click();
    await expect(dialog).toBeHidden();

    const list = billing.getByRole('list', { name: 'Facturas del cobro' });
    await expect(list.getByText('Emitida')).toBeVisible({ timeout: 60_000 });
    await expect(list.getByText(pesos(FIRST_PART_CENTS))).toBeVisible();
    await expectFitsAndAccessible(page);

    const charges = await apiCall<{ charges: { id: string }[] }>(
      page,
      'GET',
      `/billing/charges?patientId=${patient.body.patient.id}`,
    );
    const chargeId = charges.body.charges[0]?.id;
    if (!chargeId) throw new Error('The charge should exist');
    const first = (await invoicesOf(page, chargeId)).find((row) => row.status === 'issued');
    expect(first?.type).toBe('FC');
    expect(first?.cae).toMatch(/^\d{14}$/);
    expect(first?.testDocument).toBe(true);

    // 2. The AFIP service goes down: the rest of the charge is requested and stays pending.
    await setAfipMode(operator, 'down');
    await billing.getByRole('button', { name: 'Facturar' }).click();
    const rest = page.getByRole('dialog', { name: 'Facturar' });
    await expect(rest.getByLabel(/Importe a facturar de/)).toHaveValue(
      pesos(PRICE_CENTS - FIRST_PART_CENTS).replace('$ ', ''),
    );
    await rest.getByRole('button', { name: 'Pedir la factura' }).click();
    await expect(rest).toBeHidden();
    await expect(list.getByText('Pendiente')).toBeVisible();
    // The submission has had its turn: the outage leaves the invoice pending, with no CAE.
    await page.waitForTimeout(12_000);
    const waiting = (await invoicesOf(page, chargeId)).find((row) => row.status === 'pending');
    expect(waiting?.cae).toBeNull();
    expect(waiting?.number).toBeNull();
    expect(waiting?.totalCents).toBe(PRICE_CENTS - FIRST_PART_CENTS);

    // The invoices screen says so, and reception can see it and credit nothing.
    await page.goto(urlOf('aillu', '/invoices'));
    await expect(page.getByRole('heading', { level: 1, name: 'Facturas' })).toBeVisible();
    const pendingCard = page.getByRole('listitem').filter({ hasText: 'Todavía no se emitió' });
    await expect(pendingCard.first()).toBeVisible();
    await expectFitsAndAccessible(page);

    // 3. The service recovers: the clock of the retries issues it, once, with no new request.
    await setAfipMode(operator, 'ok');
    await expect
      .poll(
        async () => (await invoicesOf(page, chargeId)).filter((row) => row.status === 'issued'),
        { timeout: 180_000, intervals: [3000] },
      )
      .toHaveLength(2);
    const issued = (await invoicesOf(page, chargeId)).filter((row) => row.status === 'issued');
    expect(issued.map((row) => row.totalCents).sort((a, b) => a - b)).toEqual(
      [FIRST_PART_CENTS, PRICE_CENTS - FIRST_PART_CENTS].sort((a, b) => a - b),
    );
    expect(new Set(issued.map((row) => row.number)).size).toBe(2);
    expect((await invoicesOf(page, chargeId)).some((row) => row.status === 'pending')).toBe(false);

    // 4. Reception sees the invoice with its CAE and cannot credit it.
    await page.goto(urlOf('aillu', '/invoices'));
    await page
      .getByRole('button', { name: /^Ver detalle de Factura C/ })
      .first()
      .click();
    const detail = page.getByRole('dialog', { name: /^Factura C/ });
    await expect(detail.getByText('Emitida')).toBeVisible();
    await expect(detail.getByText(/^\d{14}$/)).toBeVisible();
    await expect(detail.getByText('Documento de prueba sin validez fiscal')).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Emitir nota de crédito' })).toHaveCount(0);
    await expectFitsAndAccessible(page);
    const refused = await apiCall(page, 'POST', `/invoices/${first?.id ?? ''}/credit-notes`, {
      idempotencyKey: randomUUID(),
      reason: 'No corresponde',
    });
    expect(refused.status).toBe(403);
    await page.keyboard.press('Escape');

    // The owner credits the first invoice, in full, from the same screens.
    const ownerContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    const owner = await ownerContext.newPage();
    await signInWithApi(owner.request, 'aillu', emailOf('owner'));
    await owner.goto(urlOf('aillu', '/invoices'));
    await owner
      .getByRole('button', { name: /^Ver detalle de Factura C/ })
      .filter({ hasText: /./ })
      .first()
      .click();
    const ownerDetail = owner.getByRole('dialog', { name: /^Factura C/ });
    await ownerDetail.getByRole('button', { name: 'Emitir nota de crédito' }).click();
    const note = owner.getByRole('dialog', { name: 'Nota de crédito' });
    await expect(note.getByText(/Se emitirá una Nota de crédito C/)).toBeVisible();
    await note.getByLabel('Motivo').fill('Error de importe en el cobro');
    await expectFitsAndAccessible(owner);
    await note.getByRole('button', { name: 'Emitir nota de crédito' }).click();
    await expect(note).toBeHidden();

    await expect
      .poll(
        async () =>
          (await invoicesOf(owner, chargeId)).filter(
            (row) => row.kind === 'credit_note' && row.status === 'issued',
          ).length,
        { timeout: 60_000, intervals: [2000] },
      )
      .toBe(1);
    const credit = (await invoicesOf(owner, chargeId)).find((row) => row.kind === 'credit_note');
    expect(credit?.type).toBe('NCC');
    expect(credit?.cae).toMatch(/^\d{14}$/);
    expect(credit?.cae).not.toBe(first?.cae);
    await owner.reload();
    await expect(
      owner.getByRole('button', { name: /^Ver detalle de Nota de crédito C/ }).first(),
    ).toBeVisible();
    await expectFitsAndAccessible(owner);
  } finally {
    await setAfipMode(operator, 'ok');
    await operator.dispose();
    release();
  }
});
