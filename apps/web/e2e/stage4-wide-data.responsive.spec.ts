import { expect, test, type Page, type Route } from '@playwright/test';

import { layoutProblems } from './support/layout.js';
import { axeViolations, openAs } from './support/stack.js';

/**
 * Stage 4 screens with the widest data they can be given, on a phone (360 px).
 *
 * The demonstration check (`stage4-demo`) reads the data the seed leaves, and that data moves with
 * the day: a long name or a payment a day later can push a row past the screen on one day and not on
 * the next. This one does not depend on the day. The API answers the cash register and the list of
 * charges with fixed, deliberately wide objects (long names that wrap only at spaces, a reason with
 * no space at all, every method of payment, amounts in the tens of millions) and the page must still
 * fit the phone, with nothing cut off, and stay accessible.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });

const id = (suffix: number) => `0190a000-0000-7000-8000-${String(suffix).padStart(12, '0')}`;

const LOCATION = id(0xe1);
const OPEN_SESSION = id(0xe9);
const CLOSED_SESSIONS = [id(0xe2), id(0xe3)];
const USER = id(0x01);

const LONG_NAME = 'María de los Ángeles Fernández de la Vega y Rodríguez-Castellanos';
const LONG_PLACE = 'Consultorios Externos del Hospital Universitario de la Ciudad Autónoma';
const NO_SPACES = 'Diferenciaporvueltoentregadodemásalpacienteyregistradaenlacajadelasucursal';
const BIG = 1_234_567_890;

const METHODS = ['cash', 'debit', 'credit', 'transfer', 'wallet', 'payment_link'] as const;

function session(overrides: Record<string, unknown>) {
  return {
    id: OPEN_SESSION,
    locationId: LOCATION,
    locationName: LONG_PLACE,
    status: 'open',
    openedAt: '2026-10-19T11:00:00.000Z',
    openedBy: USER,
    openingCents: BIG,
    closedAt: null,
    closedBy: null,
    expectedCents: BIG * 2,
    countedCents: null,
    differenceCents: null,
    differenceReason: null,
    cashInCents: BIG,
    cashOutCents: BIG,
    byMethod: METHODS.map((method) => ({
      method,
      count: 40,
      paymentsCents: BIG,
      refundsCents: BIG,
      netCents: BIG,
    })),
    ...overrides,
  };
}

const OPEN = session({});
const CLOSED = CLOSED_SESSIONS.map((closedId, index) =>
  session({
    id: closedId,
    status: 'closed',
    openedAt: `2026-10-${String(17 - index)}T11:00:00.000Z`,
    closedAt: `2026-10-${String(17 - index)}T21:00:00.000Z`,
    closedBy: USER,
    countedCents: BIG,
    differenceCents: -BIG,
    differenceReason: NO_SPACES,
  }),
);

const ENTRIES = (['payment', 'refund', 'correction'] as const).flatMap((kind, kindIndex) =>
  METHODS.map((method, index) => ({
    kind,
    id: id(0x1000 + kindIndex * 10 + index),
    paymentId: id(0x2000 + kindIndex * 10 + index),
    chargeId: id(0xc1),
    patientName: LONG_NAME,
    method,
    amountCents: BIG,
    reason: kind === 'payment' ? null : NO_SPACES,
    at: '2026-10-19T13:10:00.000Z',
  })),
);

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** The cash register answers with the wide objects above, whatever the day. */
async function serveWideCash(page: Page) {
  await page.route(/\/api\/billing\/cash\//, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith('/cash/current')) return json(route, { session: OPEN });
    if (pathname.endsWith('/cash/sessions')) return json(route, { sessions: CLOSED });
    const wanted = pathname.split('/').pop();
    const found = [OPEN, ...CLOSED].find((candidate) => candidate.id === wanted);
    if (!found) return route.fallback();
    return json(route, { session: found, entries: ENTRIES });
  });
}

function charge(index: number) {
  return {
    id: id(0x3000 + index),
    appointmentId: id(0x4000 + index),
    appointmentTypeName: 'Consulta de control posterior a la intervención quirúrgica',
    startsAt: '2026-10-19T13:00:00.000Z',
    patientId: id(0x5000 + index),
    patientName: LONG_NAME,
    professionalId: id(0x6000 + index),
    professionalName: 'Dr. Alejandro Sebastián Montenegro Villalobos',
    locationId: LOCATION,
    locationName: LONG_PLACE,
    tenantPayerId: null,
    payerName: null,
    planName: null,
    status: 'pending',
    explicitAmount: false,
    needsReview: index % 2 === 0,
    reviewReason: null,
    flaggedAt: null,
    voidReason: null,
    voidedAt: null,
    lines: [
      {
        id: id(0x7000 + index),
        position: 1,
        kind: 'service',
        portion: 'patient',
        description: 'Consulta',
        amountCents: BIG,
        invoicedCents: 0,
      },
    ],
    payments: [],
    totalCents: BIG,
    patientCents: BIG,
    payerCents: 0,
    paidCents: 0,
    outstandingCents: BIG,
    creditCents: 0,
    invoicedCents: 0,
    invoicing: 'not_invoiced',
    snapshot: {
      quote: null,
      explicitAmountCents: null,
      appointmentTypeName: 'Consulta',
      serviceDate: '2026-10-19',
    },
    capturedBy: USER,
    capturedAt: '2026-10-19T12:55:00.000Z',
  };
}

async function expectFitsAndAccessible(page: Page, where: string) {
  expect(await layoutProblems(page), `${where}: layout`).toEqual([]);
  expect(await axeViolations(page), `${where}: accessibility`).toEqual([]);
}

test('the open cash register fits a phone with the widest data', async ({ page }) => {
  await serveWideCash(page);
  await openAs(page, 'owner', '/cash');

  await expect(page.getByRole('heading', { name: `Caja de ${LONG_PLACE}` })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Movimientos de la caja' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cajas anteriores' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  await expectFitsAndAccessible(page, 'open cash register');
});

test('a closed cash register opened from the history fits a phone with the widest data', async ({
  page,
}) => {
  await serveWideCash(page);
  await openAs(page, 'owner', '/cash');

  await page
    .getByRole('button', { name: /^Ver la caja del / })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Caja cerrada' });
  await expect(dialog.getByRole('list', { name: 'Movimientos de la caja' })).toBeVisible();

  await expectFitsAndAccessible(page, 'closed cash register');
});

test('the closing dialog fits a phone with the widest data', async ({ page }) => {
  await serveWideCash(page);
  await openAs(page, 'owner', '/cash');

  await page.getByRole('button', { name: 'Cerrar caja' }).click();
  await page.getByLabel('Efectivo contado').fill('1');
  await expect(page.getByLabel('Motivo de la diferencia')).toBeVisible();

  await expectFitsAndAccessible(page, 'closing the register');
});

test('the list of charges fits a phone with long names and large amounts', async ({ page }) => {
  await page.route(/\/api\/billing\/charges\?/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, { charges: [1, 2, 3, 4].map(charge) });
  });
  await openAs(page, 'owner', '/charges');

  await expect(page.getByRole('list', { name: 'Cobros del período' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  await expectFitsAndAccessible(page, 'charges');
});
