import {
  money,
  type CashReportResponse,
  type ExportRequestDto,
  type FinancialRecordsResponse,
  type FinancialReportResponse,
  type FinancialRow,
  type ReportOptionsResponse,
} from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../../shared/test/a11y.js';
import { bootFor, meFor } from '../../../shared/test/fixtures.js';
import { renderApp } from '../../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../../shared/test/render.js';

const ids = {
  centro: '0190a000-0000-7000-8000-0000000000e1',
  norte: '0190a000-0000-7000-8000-0000000000e2',
  paz: '0190a000-0000-7000-8000-0000000000d1',
  rios: '0190a000-0000-7000-8000-0000000000d2',
  osde: '0190a000-0000-7000-8000-0000000000f1',
  charge: '0190a000-0000-7000-8000-0000000000c1',
  session: '0190a000-0000-7000-8000-0000000000a1',
  export: '0190a000-0000-7000-8000-0000000000ee',
};

const filters = {
  from: '2031-05-01',
  to: '2031-05-31',
  locationId: null,
  professionalId: null,
  tenantPayerId: null,
  scope: 'organization' as const,
};

function moneyRow(key: string, label: string | null, extra: Partial<FinancialRow> = {}) {
  return {
    key,
    label,
    chargedCents: money(10_000_000),
    voidedCents: money(0),
    paymentsCents: money(6_000_000),
    refundsCents: money(500_000),
    collectedCents: money(5_500_000),
    outstandingCents: money(4_500_000),
    receivableCents: money(0),
    invoicedNetCents: money(8_000_000) as FinancialRow['invoicedNetCents'],
    ...extra,
  } satisfies FinancialRow;
}

function report(overrides: Partial<FinancialReportResponse> = {}): FinancialReportResponse {
  return {
    filters,
    generatedAt: '2031-06-01T12:00:00.000Z',
    totals: {
      charged: {
        count: 4,
        totalCents: money(15_800_000),
        patientCents: money(14_300_000),
        payerCents: money(1_500_000),
      },
      voided: { count: 1, totalCents: money(2_000_000) },
      collected: {
        paymentCount: 3,
        paymentsCents: money(10_000_000),
        refundCount: 1,
        refundsCents: money(500_000),
        netCents: money(9_500_000),
      },
      outstanding: { chargeCount: 3, cents: money(4_800_000) },
      receivable: { cents: money(1_500_000) },
      invoiced: {
        invoicedCents: money(10_000_000),
        creditedCents: money(2_000_000),
        netCents: money(8_000_000),
        documents: 2,
      },
    },
    byMethod: [],
    byPeriod: [moneyRow('2031-05-13', null), moneyRow('2031-05-19', null)],
    byLocation: [moneyRow(ids.centro, 'Centro'), moneyRow(ids.norte, 'Norte')],
    byProfessional: [moneyRow(ids.paz, 'Dra. Paz'), moneyRow(ids.rios, 'Dr. Ríos')],
    byPayer: [moneyRow('private', null), moneyRow(ids.osde, 'OSDE')],
    byType: [moneyRow('Consulta', null, { invoicedNetCents: null })],
    ...overrides,
  };
}

const chargeRecord = {
  id: ids.charge,
  date: '2031-05-19',
  patientName: 'Fernández, Lucía',
  locationId: ids.centro,
  locationName: 'Centro',
  professionalId: ids.paz,
  professionalName: 'Dra. Paz',
  payerName: null,
  typeName: 'Consulta',
  status: 'partially_paid',
  method: null,
  amountCents: money(10_000_000),
  chargeTotalCents: money(10_000_000),
} satisfies FinancialRecordsResponse['records'][number];

const paidRecord = {
  ...chargeRecord,
  id: '0190a000-0000-7000-8000-0000000000c2',
  patientName: 'Gómez, Mario',
  payerName: 'OSDE',
  status: 'paid',
  amountCents: money(2_000_000),
  chargeTotalCents: money(2_000_000),
} satisfies FinancialRecordsResponse['records'][number];

function records(overrides: Partial<FinancialRecordsResponse> = {}): FinancialRecordsResponse {
  return {
    filters,
    kind: 'charged',
    total: 2,
    sumCents: money(12_000_000),
    limit: 20,
    offset: 0,
    records: [
      {
        id: ids.charge,
        date: '2031-05-19',
        patientName: 'Fernández, Lucía',
        locationId: ids.centro,
        locationName: 'Centro',
        professionalId: ids.paz,
        professionalName: 'Dra. Paz',
        payerName: null,
        typeName: 'Consulta',
        status: 'partially_paid',
        method: null,
        amountCents: money(10_000_000),
        chargeTotalCents: money(10_000_000),
      },
      {
        id: '0190a000-0000-7000-8000-0000000000c2',
        date: '2031-05-19',
        patientName: 'Gómez, Mario',
        locationId: ids.centro,
        locationName: 'Centro',
        professionalId: ids.paz,
        professionalName: 'Dra. Paz',
        payerName: 'OSDE',
        typeName: 'Consulta',
        status: 'paid',
        method: null,
        amountCents: money(2_000_000),
        chargeTotalCents: money(2_000_000),
      },
    ],
    ...overrides,
  };
}

function options(overrides: Partial<ReportOptionsResponse> = {}): ReportOptionsResponse {
  return {
    scope: 'organization',
    locations: [
      { id: ids.centro, name: 'Centro' },
      { id: ids.norte, name: 'Norte' },
    ],
    professionals: [
      { id: ids.paz, name: 'Dra. Paz' },
      { id: ids.rios, name: 'Dr. Ríos' },
    ],
    specialties: [],
    payers: [{ id: ids.osde, name: 'OSDE' }],
    canSeeRevenueByProfessional: true,
    canSeeCashReport: true,
    maxSpanDays: 366,
    ...overrides,
  };
}

const exportOf = (overrides: Partial<ExportRequestDto> = {}): ExportRequestDto => ({
  id: ids.export,
  kind: 'charges',
  format: 'csv',
  status: 'queued',
  from: '2031-05-01',
  to: '2031-05-31',
  createdAt: '2031-06-01T12:00:00.000Z',
  completedAt: null,
  fileName: null,
  sizeBytes: null,
  rowCount: null,
  failureCode: null,
  ...overrides,
});

function cashReport(overrides: Partial<CashReportResponse> = {}): CashReportResponse {
  const cash = {
    method: 'cash' as const,
    count: 4,
    paymentsCents: money(6_000_000),
    refundsCents: money(0),
    netCents: money(6_000_000),
  };
  return {
    filters: { from: '2031-05-01', to: '2031-05-31', locationId: null, scope: 'organization' },
    generatedAt: '2031-06-01T12:00:00.000Z',
    totals: {
      openingCents: money(1_500_000),
      paymentsCents: money(8_000_000),
      refundsCents: money(500_000),
      expectedCents: money(7_500_000),
      countedCents: money(6_900_000),
      differenceCents: money(-100_000),
      daysWithDifference: 1,
      byMethod: [
        cash,
        {
          method: 'debit',
          count: 2,
          paymentsCents: money(2_000_000),
          refundsCents: money(500_000),
          netCents: money(1_500_000),
        },
      ],
    },
    days: [
      {
        date: '2031-05-13',
        locationId: ids.centro,
        locationName: 'Centro',
        openingCents: money(1_000_000),
        paymentsCents: money(8_000_000),
        refundsCents: money(500_000),
        expectedCents: money(7_000_000),
        countedCents: money(6_900_000),
        differenceCents: money(-100_000),
        openSessions: 0,
        closedSessions: 1,
        byMethod: [cash],
        sessions: [
          {
            id: ids.session,
            status: 'closed',
            openedAt: '2031-05-13T12:00:00.000Z',
            closedAt: '2031-05-13T21:00:00.000Z',
            openingCents: money(1_000_000),
            expectedCents: money(7_000_000),
            countedCents: money(6_900_000),
            differenceCents: money(-100_000),
            differenceReason: 'Faltante de vuelto',
          },
        ],
      },
      {
        date: '2031-05-13',
        locationId: ids.norte,
        locationName: 'Norte',
        openingCents: money(500_000),
        paymentsCents: money(0),
        refundsCents: money(0),
        expectedCents: money(500_000),
        countedCents: null,
        differenceCents: null,
        openSessions: 1,
        closedSessions: 0,
        byMethod: [],
        sessions: [
          {
            id: '0190a000-0000-7000-8000-0000000000a2',
            status: 'open',
            openedAt: '2031-05-13T12:00:00.000Z',
            closedAt: null,
            openingCents: money(500_000),
            expectedCents: money(500_000),
            countedCents: null,
            differenceCents: null,
            differenceReason: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

let missing: string[] | undefined;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
  vi.restoreAllMocks();
});

interface Setup {
  path?: string;
  roles?: Parameters<typeof meFor>[0];
  readOnly?: boolean;
  options?: ReportOptionsResponse;
  report?: () => Response;
  records?: (url: string) => Response;
  cash?: () => Response;
  routes?: Record<string, FetchHandler | Response>;
}

function open(setup: Setup = {}) {
  const urls: string[] = [];
  const app = renderApp({
    path: setup.path ?? '/reports/financial',
    me: meFor(setup.roles ?? ['owner'], setup.readOnly ? { tenantStatus: 'read_only' } : {}),
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/reports/options': () => jsonResponse(setup.options ?? options()),
      'GET /api/reports/financial': (url) => {
        urls.push(url);
        return setup.report ? setup.report() : jsonResponse(report());
      },
      'GET /api/reports/financial/records': (url) => {
        urls.push(url);
        return setup.records ? setup.records(url) : jsonResponse(records());
      },
      'GET /api/reports/cash': (url) => {
        urls.push(url);
        return setup.cash ? setup.cash() : jsonResponse(cashReport());
      },
      ...setup.routes,
    },
  });
  missing = app.missingKeys;
  return { app, urls };
}

/** The row of a table that holds that text (a row is named by its first cells, not by all of them). */
async function rowOf(container: HTMLElement, text: string): Promise<HTMLElement> {
  return waitForElement(async () =>
    (await within(container).findAllByRole('row')).find((row) => row.textContent.includes(text)),
  );
}

async function waitForElement(find: () => Promise<HTMLElement | undefined>): Promise<HTMLElement> {
  let found: HTMLElement | undefined;
  await waitFor(async () => {
    found = await find();
    expect(found).toBeDefined();
  });
  return found as HTMLElement;
}

/** The tile of the dashboard with that label. */
async function tile(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name, { selector: 'dt' })).closest('div') as HTMLElement;
}

describe('the money report', () => {
  it('shows each figure of the period with the words that say how it was worked out', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Informe de dinero' }),
    ).toBeVisible();
    const charged = await tile('Cargos');
    expect(within(charged).getByText('$ 158.000,00')).toBeVisible();
    expect(
      within(charged).getByText('4 cargos: paciente $ 143.000,00, obra social $ 15.000,00'),
    ).toBeVisible();
    // The voided charge is shown apart and says it is not part of the charges.
    const voided = await tile('Cargos anulados');
    expect(within(voided).getByText('$ 20.000,00')).toBeVisible();
    expect(within(voided).getByText('1 cargos anulados; no cuentan como cargos')).toBeVisible();
    const collected = await tile('Cobrado');
    expect(within(collected).getByText('$ 95.000,00')).toBeVisible();
    expect(
      within(collected).getByText('Pagos $ 100.000,00 menos devoluciones $ 5.000,00'),
    ).toBeVisible();
    expect(within(await tile('Falta cobrar al paciente')).getByText('$ 48.000,00')).toBeVisible();
    expect(within(await tile('A cobrar a obras sociales')).getByText('$ 15.000,00')).toBeVisible();
    // 100000 of invoices and a credit note of 20000 net to 80000.
    const invoiced = await tile('Facturado neto');
    expect(within(invoiced).getByText('$ 80.000,00')).toBeVisible();
    expect(
      within(invoiced).getByText(
        'Facturas $ 100.000,00 menos notas de crédito $ 20.000,00 en 2 comprobantes',
      ),
    ).toBeVisible();
  });

  it('says which filters are applied and whose figures these are', async () => {
    open({
      roles: ['professional'],
      options: options({ scope: 'professional' }),
      report: () => jsonResponse(report({ filters: { ...filters, scope: 'professional' } })),
    });

    await tile('Cargos');
    expect((await screen.findByText(/Filtros aplicados/)).closest('p')).toHaveTextContent(
      /Filtros aplicados: Del \d{2}\/\d{2}\/\d{4} al \d{2}\/\d{2}\/\d{4} · Solo el dinero de sus propios turnos/,
    );
  });

  it('shows an empty state with a pointer to the first charge when there is no money in the period', async () => {
    open({
      report: () =>
        jsonResponse(
          report({
            totals: {
              charged: {
                count: 0,
                totalCents: money(0),
                patientCents: money(0),
                payerCents: money(0),
              },
              voided: { count: 0, totalCents: money(0) },
              collected: {
                paymentCount: 0,
                paymentsCents: money(0),
                refundCount: 0,
                refundsCents: money(0),
                netCents: money(0),
              },
              outstanding: { chargeCount: 0, cents: money(0) },
              receivable: { cents: money(0) },
              invoiced: {
                invoicedCents: money(0),
                creditedCents: money(0),
                netCents: money(0),
                documents: 0,
              },
            },
            byPeriod: [],
            byLocation: [],
            byProfessional: [],
            byPayer: [],
            byType: [],
          }),
        ),
    });

    const empties = await screen.findAllByText(
      'Todavía no hay movimientos de dinero en este período',
    );
    expect(empties.length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Ir a cobros' })[0]).toHaveAttribute(
      'href',
      '/charges',
    );
    // No zero-valued tiles that imply real data.
    expect(screen.queryByText('Cargos', { selector: 'dt' })).toBeNull();
  });

  it('keeps the other widgets working when the list of records fails, and offers a retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    open({
      records: () => {
        attempts += 1;
        return attempts === 1 ? problemResponse(500, 'internal_error') : jsonResponse(records());
      },
    });

    expect(within(await tile('Cargos')).getByText('$ 158.000,00')).toBeVisible();
    const list = (
      await screen.findByRole('heading', { name: 'Registros detrás de cada cifra' })
    ).closest('section') as HTMLElement;
    await user.click(await within(list).findByRole('button', { name: /Reintentar/ }));

    expect(await within(list).findByText('Fernández, Lucía')).toBeVisible();
    expect(within(await tile('Cargos')).getByText('$ 158.000,00')).toBeVisible();
  });

  it('offers a table with the same data as the chart, with the date as written in Argentina', async () => {
    const user = userEvent.setup();
    open();

    const series = (await screen.findByRole('heading', { name: 'Dinero por día' })).closest(
      'section',
    ) as HTMLElement;
    await user.click(await within(series).findByRole('tab', { name: 'Tabla' }));

    const table = within(series).getByRole('table');
    expect(within(table).getByRole('cell', { name: '13/05/2031' })).toBeVisible();
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 2);
  });

  it('cuts the money by place, professional, payer and type, and every cut adds up to a total', async () => {
    const user = userEvent.setup();
    open();

    const breakdown = (
      await screen.findByRole('heading', { name: /Detalle por sede, profesional/ })
    ).closest('section') as HTMLElement;
    const location = await within(breakdown).findByRole('table');
    expect(within(location).getByRole('cell', { name: 'Centro' })).toBeVisible();
    // The foot of the table is the sum of its rows.
    expect(
      within(within(location).getAllByRole('row').at(-1) as HTMLElement).getByText('$ 200.000,00'),
    ).toBeVisible();

    await user.click(within(breakdown).getByRole('tab', { name: 'Por obra social' }));
    const payer = await within(breakdown).findByRole('table');
    expect(within(payer).getByRole('cell', { name: 'Particulares' })).toBeVisible();
    expect(within(payer).getByRole('cell', { name: 'OSDE' })).toBeVisible();

    await user.click(within(breakdown).getByRole('tab', { name: 'Por tipo de turno' }));
    const type = await within(breakdown).findByRole('table');
    // A voucher does not say the type of appointment: a dash, never a zero.
    expect(
      within(within(type).getAllByRole('row')[1] as HTMLElement).getAllByText('–'),
    ).toHaveLength(1);
  });

  it('gives reception no breakdown by professional and says why', async () => {
    open({
      roles: ['reception'],
      options: options({ scope: 'locations', canSeeRevenueByProfessional: false }),
      report: () =>
        jsonResponse(report({ byProfessional: null, filters: { ...filters, scope: 'locations' } })),
    });

    const breakdown = (
      await screen.findByRole('heading', { name: /Detalle por sede, profesional/ })
    ).closest('section') as HTMLElement;

    expect(
      await within(breakdown).findByText(
        'Su rol no incluye el detalle de ingresos por profesional.',
      ),
    ).toBeVisible();
    expect(within(breakdown).queryByRole('tab', { name: 'Por profesional' })).toBeNull();
    expect(screen.queryByLabelText('Profesional')).toBeNull();
  });

  it('opens the records behind a figure and shows that they add up to it', async () => {
    const user = userEvent.setup();
    const { urls } = open({
      records: (url) =>
        jsonResponse(
          url.includes('kind=voided')
            ? records({
                kind: 'voided',
                total: 1,
                sumCents: money(2_000_000),
                records: [paidRecord],
              })
            : records(),
        ),
    });

    await user.click(
      await screen.findByRole('button', { name: 'Ver los registros de Cargos anulados' }),
    );

    await waitFor(() => {
      expect(urls.some((url) => url.includes('/records') && url.includes('kind=voided'))).toBe(
        true,
      );
    });
    expect(await screen.findByText('Suma de los 1 registros: $ 20.000,00')).toBeVisible();
    expect(screen.getByLabelText('Mostrar')).toHaveValue('voided');
  });

  it('pages the records and shows the sum of the whole list, not of the page', async () => {
    const user = userEvent.setup();
    const { urls } = open({
      records: (url) =>
        jsonResponse(
          records({
            total: 45,
            sumCents: money(90_000_000),
            offset: url.includes('offset=20') ? 20 : 0,
          }),
        ),
    });

    expect(await screen.findByText('Suma de los 45 registros: $ 900.000,00')).toBeVisible();
    expect(screen.getByText('Mostrando 1 a 2 de 45')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Siguiente' }));

    await waitFor(() => {
      expect(urls.some((url) => url.includes('offset=20'))).toBe(true);
    });
    expect(await screen.findByText('Mostrando 21 a 22 de 45')).toBeVisible();
  });

  it('shows the movements of the collected records with their method, a refund negative', async () => {
    const user = userEvent.setup();
    open({
      records: (url) =>
        jsonResponse(
          url.includes('kind=collected')
            ? records({
                kind: 'collected',
                total: 2,
                sumCents: money(1_500_000),
                records: [
                  {
                    ...chargeRecord,
                    status: 'payment',
                    method: 'debit',
                    amountCents: money(2_000_000),
                    chargeTotalCents: null,
                  },
                  {
                    ...paidRecord,
                    status: 'refund',
                    method: 'debit',
                    amountCents: money(-500_000),
                    chargeTotalCents: null,
                  },
                ],
              })
            : records(),
        ),
    });

    await user.selectOptions(await screen.findByLabelText('Mostrar'), 'collected');

    expect(await screen.findByText('Devolución · Débito')).toBeVisible();
    expect(screen.getByText('-$ 5.000,00')).toBeVisible();
    expect(screen.getByText('Suma de los 2 registros: $ 15.000,00')).toBeVisible();
  });

  it('narrows the report to a payer and to a place, and sends exactly those filters', async () => {
    const user = userEvent.setup();
    const { urls } = open();

    await user.selectOptions(await screen.findByLabelText('Obra social o prepaga'), ids.osde);
    await user.selectOptions(screen.getByLabelText('Sede'), ids.norte);
    await user.click(screen.getByRole('button', { name: 'Aplicar filtros' }));

    await waitFor(() => {
      expect(
        urls.some(
          (url) =>
            url.includes('/reports/financial?') &&
            url.includes(`tenantPayerId=${ids.osde}`) &&
            url.includes(`locationId=${ids.norte}`),
        ),
      ).toBe(true);
    });
    expect(urls.every((url) => !url.includes('specialty'))).toBe(true);
    expect((await screen.findByText(/Filtros aplicados/)).closest('p')).toHaveTextContent(
      /Obra social o prepaga: OSDE/,
    );
  });

  it('refuses an inverted range on the field without asking the server', async () => {
    const user = userEvent.setup();
    const { urls } = open();
    await tile('Cargos');
    const before = urls.length;

    await user.clear(screen.getByLabelText('Hasta'));
    await user.type(screen.getByLabelText('Hasta'), '2000-01-01');
    await user.click(screen.getByRole('button', { name: 'Aplicar filtros' }));

    expect(
      await screen.findByText('La fecha «Hasta» no puede ser anterior a «Desde».'),
    ).toBeVisible();
    expect(urls).toHaveLength(before);
  });

  it('has no accessibility violations', async () => {
    open();
    await tile('Cargos');
    await screen.findByText('Fernández, Lucía');

    expect(await a11yViolations(document.body)).toEqual([]);
  });
});

describe('the export buttons', () => {
  function exportRoutes(bodies: Record<string, unknown>[], status: Partial<ExportRequestDto> = {}) {
    return {
      'POST /api/billing/exports': (_url: string, init: RequestInit) => {
        bodies.push(jsonBody(init) as Record<string, unknown>);
        return jsonResponse(exportOf(), 202);
      },
      [`GET /api/billing/exports/${ids.export}`]: () =>
        jsonResponse(
          exportOf({ status: 'ready', fileName: 'cobros-20310601.csv', rowCount: 3, ...status }),
        ),
      [`POST /api/billing/exports/${ids.export}/download`]: () =>
        jsonResponse({ url: `/files/${'A'.repeat(43)}`, expiresAt: '2031-06-01T12:05:00.000Z' }),
      [`GET /api/files/${'A'.repeat(43)}`]: () =>
        new Response('id\n1\n', {
          headers: { 'content-disposition': 'attachment; filename="cobros-20310601.csv"' },
        }),
    };
  }

  it('asks for the file in the format chosen, with the period and the filters on screen, and hands it over', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    const downloaded: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded.push(this.download);
    });
    open({ routes: exportRoutes(bodies) });

    await user.selectOptions(await screen.findByLabelText('Sede'), ids.norte);
    await user.click(screen.getByRole('button', { name: 'Aplicar filtros' }));
    expect((await screen.findByText(/Filtros aplicados/)).closest('p')).toHaveTextContent(
      /Sede: Norte/,
    );
    await user.selectOptions(screen.getByLabelText('Qué exportar'), 'payments');
    await user.click(screen.getByRole('button', { name: 'Exportar a Excel' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    // The scope is never sent: the server decides it from the session.
    expect(bodies[0]).toEqual({
      kind: 'payments',
      format: 'xlsx',
      from: expect.stringMatching(/^\d{4}-\d{2}-01$/) as string,
      to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
      locationId: ids.norte,
    });
    expect(await screen.findByText('Archivo listo: 3 filas.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Descargar cobros-20310601.csv' }));
    await waitFor(() => {
      expect(downloaded).toEqual(['cobros-20310601.csv']);
    });
  });

  it('offers CSV, Excel and PDF, each asking for its own format', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open({ routes: exportRoutes(bodies) });

    for (const [label, format] of [
      ['Exportar a CSV', 'csv'],
      ['Exportar a PDF', 'pdf'],
    ] as const) {
      await user.click(await screen.findByRole('button', { name: label }));
      await waitFor(() => {
        expect(bodies.at(-1)).toMatchObject({ kind: 'charges', format });
      });
    }
    expect(screen.getByRole('button', { name: 'Exportar a Excel' })).toBeEnabled();
  });

  it('says there is nothing to export instead of handing over an empty file', async () => {
    const user = userEvent.setup();
    open({
      routes: {
        'POST /api/billing/exports': () => jsonResponse(exportOf(), 202),
        [`GET /api/billing/exports/${ids.export}`]: () =>
          jsonResponse(exportOf({ status: 'empty', rowCount: 0 })),
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Exportar a CSV' }));

    expect(await screen.findByText('No hay nada para exportar')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Descargar/ })).toBeNull();
  });

  it('keeps working when the organization is read-only: reading and exporting are allowed', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open({ readOnly: true, routes: exportRoutes(bodies) });

    expect(within(await tile('Cargos')).getByText('$ 158.000,00')).toBeVisible();
    for (const name of ['Exportar a CSV', 'Exportar a Excel', 'Exportar a PDF']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    await user.click(screen.getByRole('button', { name: 'Exportar a PDF' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
  });

  it('exports only what a professional sees: the request names no scope and no colleague', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open({
      roles: ['professional'],
      options: options({ scope: 'professional' }),
      routes: exportRoutes(bodies),
    });

    await user.click(await screen.findByRole('button', { name: 'Exportar a CSV' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(['format', 'from', 'kind', 'to']);
  });
});

describe('the cash register report', () => {
  it('shows a day with a difference together with the reason that was written', async () => {
    open({ path: '/reports/cash' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Informe de caja' })).toBeVisible();
    const days = (await screen.findByRole('heading', { name: 'Cajas por sede y día' })).closest(
      'section',
    ) as HTMLElement;
    const row = await rowOf(days, 'Centro');
    expect(within(row).getByText('-$ 1.000,00')).toBeVisible();
    expect(within(row).getByText('Faltante de vuelto')).toBeVisible();
    expect(within(row).getByText('$ 69.000,00')).toBeVisible();
    expect(within(row).getByText('Cerrada')).toBeVisible();
  });

  it('shows a register that is still open with no counted cash, never a zero', async () => {
    open({ path: '/reports/cash' });

    const days = (await screen.findByRole('heading', { name: 'Cajas por sede y día' })).closest(
      'section',
    ) as HTMLElement;
    const row = await rowOf(days, 'Norte');

    expect(within(row).getByText('Abierta')).toBeVisible();
    expect(within(row).getAllByText('–').length).toBeGreaterThanOrEqual(2);
  });

  it('adds up the period by method of payment and says that only cash is in the drawer', async () => {
    open({ path: '/reports/cash' });

    const methods = (
      await screen.findByRole('heading', { name: 'Cobros por medio de pago' })
    ).closest('section') as HTMLElement;
    const debit = await rowOf(methods, 'Débito');

    expect(within(debit).getByText('$ 15.000,00')).toBeVisible();
    expect(screen.getByText(/En el cajón solo hay efectivo/)).toBeVisible();
    expect(await tile('Diferencia')).toHaveTextContent('1 días con diferencia');
  });

  it('shows an empty state when there is no register in the period', async () => {
    open({
      path: '/reports/cash',
      cash: () =>
        jsonResponse(
          cashReport({
            days: [],
            totals: {
              openingCents: money(0),
              paymentsCents: money(0),
              refundsCents: money(0),
              expectedCents: money(0),
              countedCents: null,
              differenceCents: null,
              daysWithDifference: 0,
              byMethod: [],
            },
          }),
        ),
    });

    expect((await screen.findAllByText('No hay cajas en este período')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Ir a la caja' })[0]).toHaveAttribute(
      'href',
      '/cash',
    );
  });

  it('tells a professional there is no cash report and never asks the server for it', async () => {
    const { app } = open({
      path: '/reports/cash',
      roles: ['professional'],
      options: options({ scope: 'professional', canSeeCashReport: false }),
    });

    expect(await screen.findByText('Su rol no incluye el informe de caja')).toBeVisible();
    expect(app.requests).not.toContain('GET /api/reports/cash');
    const nav = screen.getByRole('navigation', { name: 'Tipo de informe' });
    expect(within(nav).queryByRole('link', { name: 'Caja' })).toBeNull();
  });

  it('offers the export of the movements of the drawer', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    open({
      path: '/reports/cash',
      routes: {
        'POST /api/billing/exports': (_url: string, init: RequestInit) => {
          bodies.push(jsonBody(init) as Record<string, unknown>);
          return jsonResponse(exportOf({ kind: 'payments' }), 202);
        },
        [`GET /api/billing/exports/${ids.export}`]: () =>
          jsonResponse(exportOf({ status: 'empty' })),
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Exportar a CSV' }));

    await waitFor(() => {
      expect(bodies[0]).toMatchObject({ kind: 'payments', format: 'csv' });
    });
  });

  it('has no accessibility violations', async () => {
    open({ path: '/reports/cash' });
    await screen.findByText('Faltante de vuelto');

    expect(await a11yViolations(document.body)).toEqual([]);
  });
});

describe('moving between the reports', () => {
  it('links the three reports, the cash one only to who may read it, and marks the one on screen', async () => {
    open();

    const nav = await screen.findByRole('navigation', { name: 'Tipo de informe' });
    expect(within(nav).getByRole('link', { name: 'Dinero' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Turnos' })).toHaveAttribute('href', '/reports');
    expect(await within(nav).findByRole('link', { name: 'Caja' })).toHaveAttribute(
      'href',
      '/reports/cash',
    );
  });
});
