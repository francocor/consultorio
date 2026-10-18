import type { InvoiceDto, InvoiceListResponse } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonResponse, type FetchHandler } from '../../shared/test/render.js';

import { invoice, pending, readyToIssue } from './test-fixtures.js';

/**
 * The invoices screen (S4.13, tasks 4.55 and 4.56; spec "AFIP outage handling", "Retry progress is
 * not a separate state"): the state of each invoice as one of four, the age of a pending one and the
 * flag of a prolonged outage, the environment on every row, the simulated notice, the nav entry.
 */

let current: RenderedApp | undefined;

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

const list = (invoices: InvoiceDto[], thresholdHours = 24): InvoiceListResponse => ({
  invoices,
  outageThresholdHours: thresholdHours,
});

interface Setup {
  roles?: Parameters<typeof meFor>[0];
  invoices?: InvoiceDto[];
  readiness?: typeof readyToIssue | { available: false; reasons: string[]; simulated: boolean };
  simulated?: boolean;
  routes?: Record<string, FetchHandler | Response>;
}

function open({
  roles = ['reception'],
  invoices = [],
  readiness = readyToIssue,
  simulated = true,
  routes = {},
}: Setup = {}) {
  current = renderApp({
    me: meFor(roles),
    boot: bootFor('Centro Médico Aillu', { localProviders: { afip: simulated } }),
    path: '/invoices',
    routes: {
      'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
      'GET /api/invoices': (url) => {
        const status = new URL(url, 'http://test').searchParams.get('status');
        return jsonResponse(
          list(status === null ? invoices : invoices.filter((entry) => entry.status === status)),
        );
      },
      'GET /api/invoicing/readiness': () => jsonResponse(readiness),
      ...routes,
    },
  });
  return current;
}

const cardOf = async (name: RegExp) => {
  const listed = await screen.findByRole('list', { name: 'Facturas' });
  const items = within(listed).getAllByRole('listitem');
  const card = items.find((item) => name.test(item.textContent));
  if (!card) throw new Error(`no invoice card matches ${String(name)}`);
  return card;
};

describe('the navigation entry', () => {
  it.each([['reception'], ['admin'], ['owner']] as const)('is there for %s', async (role) => {
    open({ roles: [role] });

    const links = await screen.findAllByRole('link', { name: 'Facturas' });
    expect(links.length).toBeGreaterThan(0);
  });

  it('is not there for a professional, who does not issue invoices', async () => {
    open({ roles: ['professional'] });

    await screen.findAllByRole('link', { name: /Hoy|Agenda/ });
    expect(screen.queryByRole('link', { name: 'Facturas' })).not.toBeInTheDocument();
  });
});

describe('the list of invoices', () => {
  it('shows each invoice with its state as an icon and a word, its number, recipient and amount', async () => {
    open({
      invoices: [
        invoice(),
        pending(5, { id: '0190a000-0000-7000-8000-0000000000b2' }),
        invoice({
          id: '0190a000-0000-7000-8000-0000000000b3',
          status: 'rejected',
          number: null,
          cae: null,
          rejectionMessage: 'El CUIT del receptor no es válido',
          recipient: { ...invoice().recipient, name: 'Marta Gómez' },
        }),
        invoice({
          id: '0190a000-0000-7000-8000-0000000000b4',
          status: 'manual',
          number: 4321,
          pointOfSale: 9,
          environment: 'production',
          simulated: false,
          testDocument: false,
          recipient: { ...invoice().recipient, name: 'Juan Sosa' },
        }),
      ],
    });

    const issued = await cardOf(/Lucía Fernández/);
    expect(within(issued).getByText('Factura C 0001-00000077')).toBeInTheDocument();
    expect(within(issued).getByText('Emitida')).toBeInTheDocument();
    expect(within(issued).getByText('$ 20.000,00')).toBeInTheDocument();
    expect(within(issued).getByText('Homologación (prueba)')).toBeInTheDocument();
    expect(within(issued).getByText('Documento de prueba sin validez fiscal')).toBeInTheDocument();

    const rejected = await cardOf(/Marta Gómez/);
    expect(within(rejected).getByText('Rechazada')).toBeInTheDocument();
    expect(
      within(rejected).getByText('ARCA rechazó la factura: El CUIT del receptor no es válido'),
    ).toBeInTheDocument();

    const manual = await cardOf(/Juan Sosa/);
    expect(within(manual).getByText('Registrada a mano')).toBeInTheDocument();
    expect(within(manual).getByText('Factura C 0009-00004321')).toBeInTheDocument();
    // A real environment is not a test document.
    expect(within(manual).getByText('Producción')).toBeInTheDocument();
    expect(
      within(manual).queryByText('Documento de prueba sin validez fiscal'),
    ).not.toBeInTheDocument();
  });

  it('shows a pending invoice as pending with its age and that it will be issued when the service recovers, never a retry state', async () => {
    open({ invoices: [pending(25 * 60)] });

    const card = await cardOf(/Pendiente/);

    expect(within(card).getByText('Pendiente')).toBeInTheDocument();
    expect(card).toHaveTextContent('Se emitirá cuando el servicio de ARCA (ex AFIP) se recupere');
    expect(card).toHaveTextContent('Se pidió hace 25 horas.');
    expect(card.textContent).not.toMatch(/reintent|retry|reconcil|en cola|queued/i);
  });

  it('flags a pending invoice that waited past the threshold and tells the owner what to do', async () => {
    open({ roles: ['owner'], invoices: [pending(25 * 60)] });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Hay 1 factura pendiente hace más de 24 horas.');
    expect(alert).toHaveTextContent('registre la que emitió por fuera del sistema');
    const card = await cardOf(/Pendiente/);
    expect(within(card).getByText('Demora prolongada')).toBeInTheDocument();
    // It is still pending: the flag is a warning, not a state.
    expect(within(card).getByText('Pendiente')).toBeInTheDocument();
  });

  it('does not flag a pending invoice that has waited less than the threshold', async () => {
    open({ invoices: [pending(23 * 60)] });

    const card = await cardOf(/Pendiente/);

    expect(within(card).queryByText('Demora prolongada')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('asks the server for the state that was chosen', async () => {
    open({ invoices: [invoice(), pending(5, { id: '0190a000-0000-7000-8000-0000000000b2' })] });
    await cardOf(/Lucía Fernández/);

    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'Pendiente');

    const listed = () => within(screen.getByRole('list', { name: 'Facturas' }));
    await waitFor(() => {
      expect(listed().queryByText('Emitida')).not.toBeInTheDocument();
    });
    expect(listed().getAllByText('Pendiente').length).toBeGreaterThan(0);
  });

  it('says there are no invoices yet, in words', async () => {
    open({ invoices: [] });

    expect(await screen.findByText('Todavía no hay facturas')).toBeInTheDocument();
  });

  it('says why a new invoice cannot be issued, and where the owner fixes it', async () => {
    open({
      roles: ['owner'],
      readiness: { available: false, reasons: ['disabled', 'profile_missing'], simulated: false },
    });

    const notice = await screen.findByText('Todavía no se pueden emitir facturas nuevas:');
    const region = notice.closest('[role="status"]');
    expect(region).toHaveTextContent('La facturación electrónica está desactivada.');
    expect(region).toHaveTextContent('Faltan los datos fiscales.');
    expect(region).toHaveTextContent('Configuración, pestaña Facturación');
  });
});

describe('the simulated billing notice', () => {
  it('is on the screen while the invoices come from a simulator', async () => {
    open({ simulated: true, invoices: [invoice()] });

    await cardOf(/Lucía Fernández/);
    expect(screen.getByText('Facturación de prueba')).toBeInTheDocument();
    expect(
      screen.getByText(/Las facturas de esta organización las emite un simulador/),
    ).toBeInTheDocument();
  });

  it('is not shown when the invoices are real', async () => {
    open({
      simulated: false,
      invoices: [invoice({ environment: 'production', simulated: false, testDocument: false })],
    });

    await cardOf(/Lucía Fernández/);
    expect(screen.queryByText('Facturación de prueba')).not.toBeInTheDocument();
    expect(screen.queryByText('Documento de prueba sin validez fiscal')).not.toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no violations with every state on the screen', async () => {
    const app = open({
      roles: ['owner'],
      invoices: [
        invoice(),
        pending(25 * 60, { id: '0190a000-0000-7000-8000-0000000000b2' }),
        invoice({
          id: '0190a000-0000-7000-8000-0000000000b3',
          status: 'rejected',
          number: null,
          cae: null,
          rejectionMessage: 'Rechazada',
        }),
        invoice({ id: '0190a000-0000-7000-8000-0000000000b4', status: 'manual', number: 12 }),
      ],
    });
    await cardOf(/Lucía Fernández/);

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
