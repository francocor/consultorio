import type {
  CashReportResponse,
  FinancialRecordsResponse,
  FinancialReportResponse,
  OperationalReportResponse,
  ReportOptionsResponse,
  ReportRecordsResponse,
} from '@consultorio/contracts';
import { expect, test, type Page } from '@playwright/test';

import {
  axeViolations,
  horizontalOverflow,
  openAs,
  urlOf,
  type AccountKey,
} from './support/stack.js';

/**
 * The reports dashboard on the real stack (Stage 4, track B; spec "Operational reports", "Role-scoped
 * visibility", "Charts with accessible table alternative"), at 360 px, as three people:
 *
 * - the owner reads the whole organization;
 * - a professional reads only their own appointments, and is refused a colleague's;
 * - reception reads the locations it works at, and is never offered revenue by professional.
 *
 * The demonstration data follows "now", so the figures are not fixed: each screen is compared with
 * what the API answers for the same filters, and the empty state is as valid as the full one. Axe and
 * the width of the page are checked on every screen.
 */
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
test.setTimeout(120_000);

const DAY_MS = 86_400_000;

/** A wide period around today, so the demonstration appointments fall inside it. */
function wideRange(): { from: string; to: string } {
  const day = (offset: number) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
  return { from: day(-90), to: day(90) };
}

// The type parameter names the contract the answer is read as (the helper cannot check it).
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
async function apiGet<T>(page: Page, path: string): Promise<{ status: number; body: T }> {
  const response = await page.request.get(urlOf('aillu', `/api${path}`));
  return { status: response.status(), body: (await response.json()) as T };
}

async function applyRange(page: Page, range: { from: string; to: string }): Promise<void> {
  await page.getByLabel('Desde').fill(range.from);
  await page.getByLabel('Hasta').fill(range.to);
  await page.getByRole('button', { name: 'Aplicar filtros' }).click();
}

/** Waits for the figures to show: the tiles when there are appointments, the pointers when not. */
async function figuresShown(page: Page): Promise<void> {
  await expect(
    page
      .locator('dt', { hasText: 'Ausentismo' })
      .or(page.getByRole('link', { name: 'Ir a la agenda' }).first()),
  ).toBeVisible();
}

const query = (range: { from: string; to: string }) => `from=${range.from}&to=${range.to}`;

const ACCOUNTS: { account: AccountKey; scope: string; label: string }[] = [
  { account: 'owner', scope: 'Toda la organización', label: 'owner' },
  { account: 'cardiology', scope: 'Solo sus propios turnos', label: 'professional' },
  { account: 'reception', scope: 'Solo las sedes en las que trabaja', label: 'reception' },
];

for (const { account, scope, label } of ACCOUNTS) {
  test(`${label}: the dashboard shows the figures of the API for their scope, fits 360 px and has no violations`, async ({
    page,
  }) => {
    const range = wideRange();
    await openAs(page, account, '/reports');
    await expect(page.getByRole('heading', { level: 1, name: 'Informes' })).toBeVisible();
    await applyRange(page, range);
    await figuresShown(page);

    const report = await apiGet<OperationalReportResponse>(
      page,
      `/reports/operational?${query(range)}`,
    );
    expect(report.status).toBe(200);
    await expect(page.getByText(/Filtros aplicados/).locator('..')).toContainText(scope);
    expect(report.body.filters.scope).toBe(
      { owner: 'organization', professional: 'professional', reception: 'locations' }[label],
    );

    if (label === 'owner') {
      // The demonstration organization has appointments around today: the full screen is exercised.
      expect(report.body.totalAppointments).toBeGreaterThan(0);
    }

    if (report.body.totalAppointments > 0) {
      const tile = page.locator('dt', { hasText: /^Turnos$/ }).locator('..');
      await expect(tile).toContainText(
        new Intl.NumberFormat('es-AR').format(report.body.totalAppointments),
      );
      // The table of the chart has the same eight statuses.
      const statuses = page
        .getByRole('heading', { name: 'Turnos por estado' })
        .locator('xpath=ancestor::section[1]');
      await statuses.getByRole('tab', { name: 'Tabla' }).click();
      await expect(statuses.getByRole('table').getByRole('row')).toHaveCount(1 + 8);
      await statuses.getByRole('tab', { name: 'Gráfico' }).click();
      await expect(
        statuses.getByRole('img', { name: 'Gráfico de barras: cantidad de turnos por estado' }),
      ).toBeVisible();
    }

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('the drill-down adds up to the total of the report and the page fits 360 px', async ({
  page,
}) => {
  const range = wideRange();
  await openAs(page, 'owner', '/reports');
  await applyRange(page, range);
  await figuresShown(page);

  const report = await apiGet<OperationalReportResponse>(
    page,
    `/reports/operational?${query(range)}`,
  );
  const all = await apiGet<ReportRecordsResponse>(
    page,
    `/reports/operational/records?${query(range)}&group=all&limit=1`,
  );

  expect(all.body.total).toBe(report.body.totalAppointments);
  if (report.body.totalAppointments > 0) {
    const records = page
      .getByRole('heading', { name: 'Turnos del período' })
      .locator('xpath=ancestor::section[1]');
    await expect(records.getByRole('table')).toBeVisible();
    await expect(records.getByText(/^Mostrando 1 a \d+ de/)).toBeVisible();
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('a professional is refused a colleague, and reception a location it does not work at', async ({
  page,
}) => {
  const range = wideRange();

  await openAs(page, 'owner', '/');
  const everything = await apiGet<ReportOptionsResponse>(page, '/reports/options');
  expect(everything.body.canSeeRevenueByProfessional).toBe(true);

  await openAs(page, 'cardiology', '/');
  const own = await apiGet<ReportOptionsResponse>(page, '/reports/options');
  expect(own.body.scope).toBe('professional');
  expect(own.body.professionals).toHaveLength(1);
  const colleague = everything.body.professionals.find(
    (professional) => professional.id !== own.body.professionals[0]?.id,
  );
  expect(colleague).toBeDefined();
  const refusedColleague = await apiGet<{ code: string }>(
    page,
    `/reports/operational?${query(range)}&professionalId=${colleague?.id ?? ''}`,
  );
  expect(refusedColleague.status).toBe(403);
  expect(refusedColleague.body.code).toBe('forbidden');

  await openAs(page, 'reception', '/');
  const front = await apiGet<ReportOptionsResponse>(page, '/reports/options');
  expect(front.body.scope).toBe('locations');
  // Reception never gets revenue by professional (the financial reports build on this answer).
  expect(front.body.canSeeRevenueByProfessional).toBe(false);
  const outside = everything.body.locations.find(
    (location) => !front.body.locations.some((mine) => mine.id === location.id),
  );
  if (outside) {
    const refusedLocation = await apiGet<{ code: string }>(
      page,
      `/reports/operational?${query(range)}&locationId=${outside.id}`,
    );
    expect(refusedLocation.status).toBe(403);
  }
});

test('an inverted range is explained on the field and the figures stay', async ({ page }) => {
  await openAs(page, 'owner', '/reports');
  await figuresShown(page);

  await page.getByLabel('Desde').fill('2031-05-31');
  await page.getByLabel('Hasta').fill('2031-05-01');
  await page.getByRole('button', { name: 'Aplicar filtros' }).click();

  await expect(page.getByRole('alert')).toContainText(
    'La fecha «Hasta» no puede ser anterior a «Desde».',
  );
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

// The money and the cash register (Stage 4, track B, S4.14), the same three people ---------------------

/** Waits for the money figures to show: the tiles when there is money, the pointer when not. */
async function moneyShown(page: Page): Promise<void> {
  await expect(
    page
      .locator('dt', { hasText: /^Cargos$/ })
      .or(page.getByRole('link', { name: 'Ir a cobros' }).first()),
  ).toBeVisible();
}

const MONEY_SCOPES: Record<string, string> = {
  owner: 'Toda la organización',
  professional: 'Solo el dinero de sus propios turnos',
  reception: 'Solo las sedes en las que trabaja',
};

for (const { account, label } of ACCOUNTS) {
  test(`${label}: the money report shows what the API answers for their scope, fits 360 px and has no violations`, async ({
    page,
  }) => {
    const range = wideRange();
    await openAs(page, account, '/reports/financial');
    await expect(page.getByRole('heading', { level: 1, name: 'Informe de dinero' })).toBeVisible();
    await applyRange(page, range);
    await moneyShown(page);

    const report = await apiGet<FinancialReportResponse>(
      page,
      `/reports/financial?${query(range)}`,
    );
    expect(report.status).toBe(200);
    await expect(page.getByText(/Filtros aplicados/).locator('..')).toContainText(
      MONEY_SCOPES[label] ?? '',
    );
    // Revenue by professional: the organization and the professional (about themselves) have it;
    // reception never does, in the answer and on the screen.
    if (label === 'reception') {
      expect(report.body.byProfessional).toBeNull();
      await expect(page.getByLabel('Profesional', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'Por profesional' })).toHaveCount(0);
    } else {
      expect(report.body.byProfessional).not.toBeNull();
    }

    const charged = page.locator('dt', { hasText: /^Cargos$/ }).locator('..');
    if (report.body.totals.charged.count > 0) {
      await expect(charged).toContainText('$');
      // The table of the chart is one tab away.
      const series = page
        .getByRole('heading', { name: /^Dinero por (día|mes)$/ })
        .locator('xpath=ancestor::section[1]');
      await series.getByRole('tab', { name: 'Tabla' }).click();
      await expect(series.getByRole('table')).toBeVisible();
      await series.getByRole('tab', { name: 'Gráfico' }).click();
      await expect(
        series.getByRole('img', { name: 'Gráfico de barras: cargos y cobrado por período' }),
      ).toBeVisible();
    }

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('the records behind each money figure add up to it, for the same filters', async ({
  page,
}) => {
  const range = wideRange();
  await openAs(page, 'owner', '/reports/financial');
  await applyRange(page, range);
  await moneyShown(page);

  const report = await apiGet<FinancialReportResponse>(page, `/reports/financial?${query(range)}`);
  const figures: Record<string, number> = {
    charged: report.body.totals.charged.totalCents,
    voided: report.body.totals.voided.totalCents,
    collected: report.body.totals.collected.netCents,
    outstanding: report.body.totals.outstanding.cents,
    receivable: report.body.totals.receivable.cents,
    invoiced: report.body.totals.invoiced.netCents,
  };
  for (const [kind, figure] of Object.entries(figures)) {
    const records = await apiGet<FinancialRecordsResponse>(
      page,
      `/reports/financial/records?${query(range)}&kind=${kind}&limit=200`,
    );
    expect(records.status).toBe(200);
    // The sum of the whole kind is always in the answer; a page of 200 usually holds all the rows.
    expect(records.body.sumCents, kind).toBe(figure);
    if (records.body.total <= 200) {
      expect(
        records.body.records.reduce((total, record) => total + record.amountCents, 0),
        kind,
      ).toBe(figure);
    }
  }

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('reception is denied revenue by professional and a location it does not work at; a professional is denied a colleague', async ({
  page,
}) => {
  const range = wideRange();
  await openAs(page, 'owner', '/');
  const everything = await apiGet<ReportOptionsResponse>(page, '/reports/options');

  await openAs(page, 'reception', '/');
  const front = await apiGet<ReportOptionsResponse>(page, '/reports/options');
  const someone = everything.body.professionals[0]?.id ?? '';
  const byProfessional = await apiGet<{ code: string }>(
    page,
    `/reports/financial?${query(range)}&professionalId=${someone}`,
  );
  expect(byProfessional.status).toBe(403);
  const outside = everything.body.locations.find(
    (location) => !front.body.locations.some((mine) => mine.id === location.id),
  );
  if (outside) {
    const refusedLocation = await apiGet<{ code: string }>(
      page,
      `/reports/cash?${query(range)}&locationId=${outside.id}`,
    );
    expect(refusedLocation.status).toBe(403);
  }

  await openAs(page, 'cardiology', '/');
  const own = await apiGet<ReportOptionsResponse>(page, '/reports/options');
  const colleague = everything.body.professionals.find(
    (professional) => professional.id !== own.body.professionals[0]?.id,
  );
  const refusedColleague = await apiGet<{ code: string }>(
    page,
    `/reports/financial?${query(range)}&professionalId=${colleague?.id ?? ''}`,
  );
  expect(refusedColleague.status).toBe(403);
});

for (const { account, label } of ACCOUNTS.filter((entry) => entry.label !== 'professional')) {
  test(`${label}: the cash report fits 360 px, has no violations and matches the API`, async ({
    page,
  }) => {
    const range = wideRange();
    await openAs(page, account, '/reports/cash');
    await expect(page.getByRole('heading', { level: 1, name: 'Informe de caja' })).toBeVisible();
    await applyRange(page, range);
    const days = page
      .getByRole('heading', { name: 'Cajas por sede y día' })
      .locator('xpath=ancestor::section[1]');
    await expect(days).toBeVisible();

    const report = await apiGet<CashReportResponse>(page, `/reports/cash?${query(range)}`);
    expect(report.status).toBe(200);
    if (report.body.days.length > 0) {
      await expect(days.getByRole('row')).toHaveCount(1 + report.body.days.length);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('a professional has no cash report: the screen says so and the API refuses it', async ({
  page,
}) => {
  await openAs(page, 'cardiology', '/reports/cash');

  await expect(page.getByText('Su rol no incluye el informe de caja')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Tipo de informe' }).getByRole('link', { name: 'Caja' }),
  ).toHaveCount(0);
  const refused = await apiGet<{ code: string }>(page, `/reports/cash?${query(wideRange())}`);
  expect(refused.status).toBe(403);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('the owner exports the charges of the period: the request goes out with the filters and is followed', async ({
  page,
}) => {
  const range = wideRange();
  await openAs(page, 'owner', '/reports/financial');
  await applyRange(page, range);
  await moneyShown(page);

  const asked = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/billing/exports'),
  );
  await page.getByRole('button', { name: 'Exportar a CSV' }).click();

  const body = (await asked).postDataJSON() as Record<string, unknown>;
  expect(body).toEqual({ kind: 'charges', format: 'csv', ...range });
  // The stack of the suite runs the worker with the bucket of its MinIO, so the job builds the file.
  // The demonstration data has no charges of its own (the cash and invoicing specs create them in
  // the same stack): with charges in the period the panel must reach "ready", without them it says
  // there is nothing to export. The empty state is as valid as the full one.
  const report = await apiGet<FinancialReportResponse>(page, `/reports/financial?${query(range)}`);
  expect(report.status).toBe(200);
  if (report.body.totals.charged.count > 0) {
    await expect(page.getByText(/^Archivo listo: \d+ filas\.$/)).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(page.getByText('No hay nada para exportar')).toBeVisible();
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});
