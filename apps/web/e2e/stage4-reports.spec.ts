import type {
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
