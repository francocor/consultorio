import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { acquireAfipLock } from './support/afip-lock.js';
import { apiCall } from './support/clinical.js';
import { layoutProblems, unreachableContent } from './support/layout.js';
import { OPERATOR_STATE } from './support/operator.js';
import {
  axeViolations,
  emailOf,
  originOf,
  settleToasts,
  signInWithApi,
  urlOf,
  type AccountKey,
  type Organization,
} from './support/stack.js';

/**
 * The Stage 4 demonstration on the real stack (tasks 4.65; BIL-09, INV-05, INV-09; DEM-04): the
 * organization is the one the seed leaves, with its prices, payers, charges, payments, cash
 * registers and invoices, and the screens are looked at on a phone (360 px) with that data in them.
 *
 * 1. Every screen of billing, cash, invoicing and reports fits the phone and is accessible with real
 *    data in it (wide tables, long lists, charges with several payments, vouchers of every kind),
 *    and nothing is cut off by a box that does not scroll.
 * 2. Reception closes the register of the day (the open one the seed leaves, with the cash it
 *    counts), cash can no longer be taken, and the day is in the history. Then it invoices a paid
 *    visit through the AFIP of the demonstration: the voucher is issued with a number that follows
 *    the seeded ones and the PDF is built; the service goes down, the next invoice waits and nothing
 *    is invented; the service recovers and the invoice is issued by itself, once.
 *
 * The first journey only reads. The second works in the second organization ("norte"), which no
 * other journey of the suite touches, and takes the lock of the AFIP mode with the other journey
 * that puts the issuer in an outage.
 */
test.use({
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
});
test.setTimeout(420_000);

const ZONE = 'America/Argentina/Buenos_Aires';
const day = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(
    new Date(Date.now() + offset * 86_400_000),
  );

async function expectFitsAndAccessible(page: Page, where: string) {
  await settleToasts(page);
  expect(await layoutProblems(page), `${where}: layout`).toEqual([]);
  expect(await axeViolations(page), `${where}: accessibility`).toEqual([]);
}

/** The screen has finished loading what it asks for. */
async function loaded(page: Page) {
  await expect(page.getByRole('heading', { level: 1 }).first(), page.url()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** A screen with a period opens on today; the demonstration has a week of data behind it. */
async function widenToLastWeek(page: Page) {
  await page.getByLabel('Desde').fill(day(-8));
  await page.waitForLoadState('networkidle');
}

/** Visits every tab of a screen, one after the other, and checks each. */
async function everyTab(page: Page, where: string) {
  const tabs = await page.getByRole('tab').all();
  for (const tab of tabs) {
    const name = (await tab.textContent())?.trim() ?? '';
    await tab.click();
    await page.waitForLoadState('networkidle');
    await expectFitsAndAccessible(page, `${where} / ${name}`);
  }
}

interface Screen {
  account: AccountKey;
  path: string;
  /** Visit every tab of the screen as well. */
  tabs?: boolean;
  /** The screen opens on today: widen it to the last week, where the demonstration has its data. */
  lastWeek?: boolean;
}

const SCREENS: readonly Screen[] = [
  { account: 'owner', path: '/charges', tabs: true, lastWeek: true },
  { account: 'owner', path: '/cash' },
  { account: 'owner', path: '/invoices', tabs: true },
  { account: 'owner', path: '/reports', tabs: true },
  { account: 'owner', path: '/reports/financial', tabs: true },
  { account: 'owner', path: '/reports/cash', tabs: true },
  { account: 'admin', path: '/settings/prices' },
  { account: 'admin', path: '/settings/invoicing' },
  { account: 'reception', path: '/charges', tabs: true, lastWeek: true },
  { account: 'reception', path: '/cash' },
  { account: 'reception', path: '/invoices', tabs: true },
  { account: 'reception', path: '/reports/financial', tabs: true },
  { account: 'reception', path: '/reports/cash', tabs: true },
];

test('every screen of Stage 4 fits a phone with the demonstration data in it', async ({
  browser,
}) => {
  const sessions = new Map<AccountKey, Page>();
  const pageOf = async (account: AccountKey) => {
    const known = sessions.get(account);
    if (known) return known;
    const context = await browser.newContext({
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await signInWithApi(page.request, 'aillu', emailOf(account));
    sessions.set(account, page);
    return page;
  };

  for (const screen of SCREENS) {
    const page = await pageOf(screen.account);
    const where = `${screen.account} ${screen.path}`;
    await page.goto(urlOf('aillu', screen.path));
    await loaded(page);
    if (screen.lastWeek) await widenToLastWeek(page);
    await expectFitsAndAccessible(page, where);
    if (screen.tabs) await everyTab(page, where);
  }

  // The charges list opens a charge with its lines, payments and reversals; the invoices list opens
  // vouchers of every kind. Each dialog is checked, one by one.
  const owner = await pageOf('owner');
  await owner.goto(urlOf('aillu', '/charges'));
  await loaded(owner);
  await widenToLastWeek(owner);
  await expect(owner.getByRole('button', { name: /^Ver cobro de / }).first()).toBeVisible();
  const wide = await owner.getByRole('button', { name: /^Ver cobro de / }).all();
  expect(wide.length, 'the demonstration has charges to open').toBeGreaterThan(8);
  for (const [index, button] of wide.slice(0, 12).entries()) {
    await button.click();
    const dialog = owner.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    await expectFitsAndAccessible(owner, `charge ${String(index + 1)}`);
    await owner.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }

  await owner.goto(urlOf('aillu', '/invoices'));
  await loaded(owner);
  await expect(owner.getByRole('button', { name: /^Ver detalle de / }).first()).toBeVisible();
  const vouchers = await owner.getByRole('button', { name: /^Ver detalle de / }).all();
  expect(vouchers.length, 'the demonstration has vouchers to open').toBeGreaterThan(10);
  for (const [index, button] of vouchers.slice(0, 14).entries()) {
    await button.click();
    const dialog = owner.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    await expectFitsAndAccessible(owner, `voucher ${String(index + 1)}`);
    await owner.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
});

test('the layout check sees what a phone cannot reach, and lets a box that scrolls be', async ({
  page,
}) => {
  await page.setContent(`<main>
    <div style="width:200px;overflow:hidden"><div style="width:400px">cut-box-content</div></div>
    <div style="width:200px;overflow-x:auto"><div style="width:400px">scroll-box-content</div></div>
    <div style="width:200px;overflow:hidden"><div style="width:150px">fits-box-content</div></div>
  </main>`);

  const found = await unreachableContent(page);

  expect(found).toHaveLength(1);
  expect(found[0]).toContain('cut-box-content');
});

// The journey of the day ------------------------------------------------------------------------

const ORG: Organization = 'norte';

/** A call to the API of the second organization with the session of the page. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function callOrg<T = unknown>(
  page: Page,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  data?: unknown,
) {
  return apiCall<T>(page, method, path, data, ORG);
}

/** The provider console puts the issuer of the demonstration organizations in a mode. */
async function setAfipMode(operator: APIRequestContext, mode: 'ok' | 'down') {
  const response = await operator.put(urlOf('platform', '/api/operator/dev/afip/mode'), {
    data: { mode },
    headers: { origin: originOf('platform') },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** `$ 1.234,50` as whole cents. */
function centsOf(text: string): number {
  const digits = text.replace(/[^0-9,-]/g, '').replace(',', '.');
  return Math.round(Number(digits) * 100);
}

/** An amount in cents as the screens write it ("$ 1.234,50"). */
const pesos = (cents: number) =>
  `$ ${new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)}`;

interface ChargeRow {
  id: string;
  patientName: string;
  status: string;
  invoicing: 'not_invoiced' | 'partly_invoiced' | 'invoiced';
  startsAt: string;
  locationId: string;
  patientCents: number;
  lines: { portion: string; amountCents: number; invoicedCents: number }[];
}

interface InvoiceRow {
  id: string;
  kind: 'invoice' | 'credit_note';
  type: string;
  status: 'pending' | 'issued' | 'rejected' | 'manual';
  number: number | null;
  cae: string | null;
  totalCents: number;
  hasPdf: boolean;
  testDocument: boolean;
}

const invoicesOf = async (page: Page, chargeId: string) =>
  (await callOrg<{ invoices: InvoiceRow[] }>(page, 'GET', `/invoices?chargeId=${chargeId}`)).body
    .invoices;

/** Paid visits of the last days that nobody has invoiced yet and reception may invoice. */
async function chargesToInvoice(page: Page): Promise<ChargeRow[]> {
  const listed = await callOrg<{ charges: ChargeRow[] }>(
    page,
    'GET',
    `/billing/charges?status=paid&from=${day(-6)}&to=${day(0)}`,
  );
  expect(listed.status).toBe(200);
  return listed.body.charges.filter(
    (charge) =>
      charge.invoicing === 'not_invoiced' &&
      charge.patientCents > 0 &&
      charge.lines.some((line) => line.portion === 'patient' && line.invoicedCents === 0),
  );
}

test('reception closes the register of the day and invoices through the local AFIP, rides out an outage and gets the PDF', async ({
  page,
  playwright,
}) => {
  const release = await acquireAfipLock();
  const operator = await playwright.request.newContext({ storageState: OPERATOR_STATE });
  try {
    await setAfipMode(operator, 'ok');
    await signInWithApi(page.request, ORG, emailOf('reception', ORG));

    // 1. The register of the day: the seed leaves one open at each desk. Reception counts the cash
    // and closes it; the day goes to the history and cash is refused until a new register opens.
    await page.goto(urlOf(ORG, '/cash'));
    await loaded(page);
    const places = await page.getByLabel('Sede').locator('option').allTextContents();
    expect(places.length).toBeGreaterThanOrEqual(2);
    let closedPlace = '';
    for (const place of places) {
      await page.getByLabel('Sede').selectOption({ label: place });
      await page.waitForLoadState('networkidle');
      if (await page.getByRole('button', { name: 'Cerrar caja' }).isVisible()) {
        closedPlace = place;
        break;
      }
    }
    expect(closedPlace, 'a register is open at one of the desks').not.toBe('');
    await expect(page.getByRole('heading', { name: `Caja de ${closedPlace}` })).toBeVisible();
    await expectFitsAndAccessible(page, 'the open register');

    const summary = page.getByText('Efectivo que debería haber', { exact: true }).first();
    const expectedCents = centsOf(await summary.locator('xpath=following-sibling::dd').innerText());
    expect(expectedCents).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Cerrar caja' }).click();
    const closing = page.getByRole('dialog', { name: 'Cerrar la caja' });
    await closing.getByLabel('Efectivo contado').fill(pesos(expectedCents).replace('$ ', ''));
    await expect(closing.getByText(/Faltan|Sobran/)).toHaveCount(0);
    await expectFitsAndAccessible(page, 'closing the register');
    await closing.getByRole('button', { name: 'Cerrar caja' }).click();
    await expect(closing).toBeHidden();
    await expect(
      page.getByText(new RegExp(`La caja de ${closedPlace} está cerrada`)),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cajas anteriores' })).toBeVisible();
    await expectFitsAndAccessible(page, 'the closed register');

    const sessions = await callOrg<{
      sessions: { status: string; locationName: string; countedCents: number | null }[];
    }>(page, 'GET', `/billing/cash/sessions?status=closed&from=${day(0)}&to=${day(0)}`);
    expect(sessions.status, JSON.stringify(sessions.body)).toBe(200);
    const today = sessions.body.sessions.find(
      (entry) => entry.locationName === closedPlace && entry.countedCents === expectedCents,
    );
    expect(today, 'the closed register of today is in the history').toBeDefined();

    // Cash is refused now: a closed register never takes another entry.
    const owing = (
      await callOrg<{ charges: ChargeRow[] }>(
        page,
        'GET',
        `/billing/charges?status=pending&from=${day(-6)}&to=${day(0)}`,
      )
    ).body.charges;
    const places2 = await callOrg<{ locations: { id: string; name: string }[] }>(
      page,
      'GET',
      '/locations',
    );
    const closedId = places2.body.locations.find((entry) => entry.name === closedPlace)?.id;
    const target = owing.find((charge) => charge.locationId === closedId);
    if (target) {
      const refused = await callOrg<{ code?: string }>(
        page,
        'POST',
        `/billing/charges/${target.id}/payments`,
        { method: 'cash', amountCents: 100, idempotencyKey: randomUUID() },
      );
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('cash_register_required');
    }

    // 2. Invoices through the AFIP of the demonstration. The vouchers the seed left are numbered
    // first; the new ones follow them, with the PDF built by the worker.
    const seeded = (await callOrg<{ invoices: InvoiceRow[] }>(page, 'GET', '/invoices?limit=200'))
      .body.invoices;
    const highest = Math.max(
      0,
      ...seeded
        .filter((row) => row.type === 'FC' && row.number !== null)
        .map((row) => row.number ?? 0),
    );
    expect(highest, 'the seed left issued vouchers').toBeGreaterThan(5);

    const toInvoice = await chargesToInvoice(page);
    expect(toInvoice.length, 'the seed leaves paid visits to invoice').toBeGreaterThanOrEqual(2);
    const [first, second] = toInvoice;
    if (!first || !second) throw new Error('Two charges to invoice are needed');

    await page.goto(urlOf(ORG, '/invoices'));
    await loaded(page);
    await page.getByRole('tab', { name: 'Cobros por facturar' }).click();
    await expect(page.getByRole('list', { name: 'Cobros por facturar' })).toBeVisible();
    await expectFitsAndAccessible(page, 'the charges to invoice');

    const issue = async (charge: ChargeRow) => {
      await page
        .getByRole('button', { name: `Facturar el cobro de ${charge.patientName}` })
        .first()
        .click();
      const dialog = page.getByRole('dialog', { name: 'Facturar' });
      await expect(dialog.getByText('Se emitirá una Factura C.')).toBeVisible();
      await expectFitsAndAccessible(page, 'the issue dialog');
      await dialog.getByRole('button', { name: 'Pedir la factura' }).click();
      await expect(dialog).toBeHidden();
    };

    // 2a. With the service up: issued, numbered after the seeded ones, with its PDF.
    await issue(first);
    await expect
      .poll(
        async () => (await invoicesOf(page, first.id)).filter((row) => row.status === 'issued'),
        {
          timeout: 60_000,
          intervals: [1500],
        },
      )
      .toHaveLength(1);
    const issuedFirst = (await invoicesOf(page, first.id)).find((row) => row.status === 'issued');
    expect(issuedFirst?.type).toBe('FC');
    expect(issuedFirst?.cae).toMatch(/^\d{14}$/);
    expect(issuedFirst?.testDocument).toBe(true);
    expect(issuedFirst?.number, 'numbered after the vouchers of the seed').toBe(highest + 1);

    // The worker builds the PDF: the voucher says so, and the file is a real PDF.
    await expect
      .poll(
        async () =>
          (await invoicesOf(page, first.id)).find((row) => row.status === 'issued')?.hasPdf,
        {
          timeout: 90_000,
          intervals: [2000],
        },
      )
      .toBe(true);
    const link = await callOrg<{ url: string }>(
      page,
      'GET',
      `/invoices/${issuedFirst?.id ?? ''}/pdf-link`,
    );
    expect(link.status).toBe(200);
    const file = await page.request.get(urlOf(ORG, `/api${link.body.url}`));
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toContain('application/pdf');
    const bytes = await file.body();
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(3_000);

    // The same file through the screen: the detail of the voucher downloads it.
    await page.goto(urlOf(ORG, '/invoices'));
    await loaded(page);
    await page
      .getByRole('button', { name: /^Ver detalle de Factura C/ })
      .filter({ hasText: /./ })
      .first()
      .click();
    const detail = page.getByRole('dialog', { name: /^Factura C/ });
    const downloading = page.waitForEvent('download');
    await detail.getByRole('button', { name: 'Descargar PDF' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^factura-c-\d{4}-\d{8}\.pdf$/);
    await page.keyboard.press('Escape');

    // 2b. The service goes down: the next invoice waits, with no number and no CAE.
    await setAfipMode(operator, 'down');
    await page.goto(urlOf(ORG, '/invoices'));
    await loaded(page);
    await page.getByRole('tab', { name: 'Cobros por facturar' }).click();
    await issue(second);
    await page.waitForTimeout(12_000);
    const waiting = (await invoicesOf(page, second.id)).find((row) => row.status === 'pending');
    expect(waiting?.cae).toBeNull();
    expect(waiting?.number).toBeNull();
    await page.getByRole('tab', { name: 'Facturas' }).click();
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Todavía no se emitió' }).first(),
    ).toBeVisible();
    await expectFitsAndAccessible(page, 'a pending invoice');

    // 2c. The service recovers: the clock of the retries issues it, once, after the first one.
    await setAfipMode(operator, 'ok');
    await expect
      .poll(
        async () => (await invoicesOf(page, second.id)).filter((row) => row.status === 'issued'),
        {
          timeout: 180_000,
          intervals: [3000],
        },
      )
      .toHaveLength(1);
    const all = await invoicesOf(page, second.id);
    expect(all.filter((row) => row.status === 'issued')).toHaveLength(1);
    expect(all.some((row) => row.status === 'pending')).toBe(false);
    expect(all.find((row) => row.status === 'issued')?.number).toBe(highest + 2);
  } finally {
    await setAfipMode(operator, 'ok').catch(() => undefined);
    await operator.dispose();
    release();
  }
});
