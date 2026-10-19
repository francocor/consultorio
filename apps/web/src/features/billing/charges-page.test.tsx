import { money, type ChargeDto, type ExportRequestDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, type FetchHandler } from '../../shared/test/render.js';

import { charge, IDS } from './test-fixtures.js';

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
  vi.restoreAllMocks();
});

const SECOND = '0190a000-0000-7000-8000-0000000000c9';

const exportOf = (overrides: Partial<ExportRequestDto> = {}): ExportRequestDto => ({
  id: '0190a000-0000-7000-8000-0000000000ee',
  kind: 'charges',
  format: 'csv',
  status: 'queued',
  from: '2031-05-01',
  to: '2031-05-31',
  createdAt: '2031-05-31T12:00:00.000Z',
  completedAt: null,
  fileName: null,
  sizeBytes: null,
  rowCount: null,
  failureCode: null,
  ...overrides,
});

function open(
  charges: ChargeDto[],
  roles: Parameters<typeof meFor>[0] = ['reception'],
  routes: Record<string, FetchHandler | Response> = {},
) {
  const listUrls: string[] = [];
  const app = renderApp({
    me: meFor(roles),
    boot: bootFor('Centro Médico Aillu'),
    path: '/charges',
    routes: {
      'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
      'GET /api/billing/charges': (url) => {
        listUrls.push(url);
        return jsonResponse({ charges });
      },
      ...routes,
    },
  });
  missing = app.missingKeys;
  return { ...app, listUrls };
}

describe('the charges screen', () => {
  it('lists the charges of the day with their state, total and what is missing, in pesos', async () => {
    open([
      charge(),
      charge({
        id: SECOND,
        patientName: 'Mario Gómez',
        status: 'paid',
        paidCents: money(2_500_000),
        totalCents: money(2_500_000),
        outstandingCents: money(0),
      }),
    ]);

    const list = await screen.findByRole('list', { name: 'Cobros del período' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('Lucía Fernández');
    expect(first).toHaveTextContent('Pendiente');
    expect(first).toHaveTextContent('Falta cobrar: $ 10.000,00');
    expect(second).toHaveTextContent('Pagado');
    expect(second).toHaveTextContent('Total: $ 25.000,00');
    expect(second).toHaveTextContent('Falta cobrar: $ 0,00');
  });

  it('asks the server for the period and the filters that were chosen', async () => {
    const user = userEvent.setup();
    const app = open([charge()]);
    await screen.findByRole('list', { name: 'Cobros del período' });

    await user.selectOptions(screen.getByLabelText('Estado'), 'partially_paid');
    await user.click(screen.getByRole('checkbox', { name: 'Solo los que hay que revisar' }));

    await waitFor(() => {
      const last = app.listUrls[app.listUrls.length - 1] ?? '';
      expect(last).toContain('status=partially_paid');
      expect(last).toContain('needsReview=true');
    });
  });

  it('says so when the period has no charges', async () => {
    open([]);

    expect(await screen.findByText('No hay cobros en este período')).toBeVisible();
  });

  it('flags the charges to review and opens one with its payments and actions', async () => {
    const user = userEvent.setup();
    open([charge({ needsReview: true, reviewReason: 'no_show' })], ['admin']);

    const list = await screen.findByRole('list', { name: 'Cobros del período' });
    expect(within(list).getByText('Para revisar')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Ver cobro de Lucía Fernández' }));

    const dialog = await screen.findByRole('dialog', { name: 'Lucía Fernández' });
    expect(
      within(dialog).getByText(/el paciente no vino y este cobro quedó marcado/i),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Registrar pago' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Anular cobro' })).toBeVisible();
  });

  it('refuses a period that ends before it starts, without asking the server', async () => {
    const user = userEvent.setup();
    const app = open([charge()]);
    await screen.findByRole('list', { name: 'Cobros del período' });

    const from = screen.getByLabelText('Desde');
    await user.clear(from);
    await user.type(from, '2999-01-01');

    expect(
      await screen.findByText('La fecha de inicio no puede ser posterior a la de fin.'),
    ).toBeVisible();
    expect(app.listUrls.filter((url) => url.includes('from=2999-01-01'))).toEqual([]);
  });

  it('shows what each payer owes, grouped, with the total', async () => {
    const user = userEvent.setup();
    open([charge()], ['reception'], {
      'GET /api/billing/receivables': () =>
        jsonResponse({
          groups: [
            {
              tenantPayerId: IDS.payer,
              payerName: 'OSDE',
              totalCents: money(1_600_000),
              items: [
                {
                  chargeId: IDS.charge,
                  patientName: 'Lucía Fernández',
                  startsAt: '2031-05-12T13:00:00.000Z',
                  appointmentTypeName: 'Consulta',
                  amountCents: money(800_000),
                },
                {
                  chargeId: SECOND,
                  patientName: 'Mario Gómez',
                  startsAt: '2031-05-12T14:00:00.000Z',
                  appointmentTypeName: 'Consulta',
                  amountCents: money(800_000),
                },
              ],
            },
          ],
          totalCents: money(1_600_000),
        }),
    });

    await user.click(await screen.findByRole('tab', { name: 'A cobrar a obras sociales' }));

    expect(await screen.findByRole('heading', { name: 'OSDE' })).toBeVisible();
    expect(screen.getByText('Total a cobrar a obras sociales').parentElement).toHaveTextContent(
      '$ 16.000,00',
    );
  });

  it('requests an export of the period and, once ready, hands the file over', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    let polls = 0;
    const downloaded: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded.push(this.download);
    });
    const token = 'A'.repeat(43);
    open([charge()], ['reception'], {
      'POST /api/billing/exports': (_url, init) => {
        bodies.push(jsonBody(init) as Record<string, unknown>);
        return jsonResponse(exportOf(), 202);
      },
      [`GET /api/billing/exports/${exportOf().id}`]: () => {
        polls += 1;
        return jsonResponse(
          exportOf({ status: 'ready', fileName: 'cobros.csv', rowCount: 3, sizeBytes: 120 }),
        );
      },
      [`POST /api/billing/exports/${exportOf().id}/download`]: () =>
        jsonResponse({ url: `/files/${token}`, expiresAt: '2031-05-31T12:05:00.000Z' }),
      [`GET /api/files/${token}`]: () =>
        new Response('id\n1\n', {
          headers: { 'content-disposition': 'attachment; filename="cobros.csv"' },
        }),
    });

    await user.click(await screen.findByRole('tab', { name: 'Exportar' }));
    await user.selectOptions(await screen.findByLabelText('Qué exportar'), 'payments');
    await user.selectOptions(screen.getByLabelText('Formato'), 'xlsx');
    await user.click(screen.getByRole('button', { name: 'Pedir la exportación' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({ kind: 'payments', format: 'xlsx' });
    expect(await screen.findByText('El archivo está listo: 3 filas.')).toBeVisible();
    expect(polls).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Descargar cobros.csv' }));

    await waitFor(() => {
      expect(downloaded).toEqual(['cobros.csv']);
    });
  });

  it('says there is nothing to export instead of handing over an empty file', async () => {
    const user = userEvent.setup();
    open([charge()], ['reception'], {
      'POST /api/billing/exports': () => jsonResponse(exportOf({ status: 'queued' }), 202),
      [`GET /api/billing/exports/${exportOf().id}`]: () =>
        jsonResponse(exportOf({ status: 'empty', rowCount: 0 })),
    });

    await user.click(await screen.findByRole('tab', { name: 'Exportar' }));
    await user.click(await screen.findByRole('button', { name: 'Pedir la exportación' }));

    expect(await screen.findByText('No hay nada para exportar')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Descargar/ })).toBeNull();
  });

  it('asks for a shorter period when the export has too many rows, instead of a vague failure (JD-S4 R1-A-T7)', async () => {
    const user = userEvent.setup();
    open([charge()], ['reception'], {
      'POST /api/billing/exports': () => jsonResponse(exportOf({ status: 'queued' }), 202),
      [`GET /api/billing/exports/${exportOf().id}`]: () =>
        jsonResponse(exportOf({ status: 'failed', failureCode: 'export_too_large' })),
    });

    await user.click(await screen.findByRole('tab', { name: 'Exportar' }));
    await user.click(await screen.findByRole('button', { name: 'Pedir la exportación' }));

    expect(await screen.findByText(/demasiados movimientos para un solo archivo/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Descargar/ })).toBeNull();
  });

  it('is not for a role that cannot read payments', async () => {
    const app = open([charge()], ['patient']);

    await waitFor(() => {
      expect(app.requests).toContain('GET /api/auth/me');
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByRole('list', { name: 'Cobros del período' })).toBeNull();
  });

  it('has no accessibility violations', async () => {
    open([charge({ needsReview: true, reviewReason: 'cancelled' })]);
    await screen.findByRole('list', { name: 'Cobros del período' });

    expect(await a11yViolations(document.body)).toEqual([]);
  });
});

beforeEach(() => {
  vi.useRealTimers();
});
