import type { AfipSimulatorStateResponse, AfipSimulatorVoucherDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../../shared/test/a11y.js';
import { renderInRouter } from '../../../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../../../shared/test/render.js';
import { REGISTERED_TABS } from '../tabs.js';

import { AfipSimulator } from './AfipSimulator.js';

type Handler = (url: string, init: RequestInit) => Response;

const BASE = '/api/operator/dev/afip';

const voucher = (overrides: Partial<AfipSimulatorVoucherDto> = {}): AfipSimulatorVoucherDto => ({
  id: '0190a000-0000-7000-8000-0000000000c1',
  issuerCuit: '20123456786',
  pointOfSale: 1,
  type: 'FC',
  number: 7,
  cae: '71234567890123',
  caeExpiresOn: '2026-10-27',
  issueDate: '2026-10-17',
  totalCents: 123_450,
  createdAt: '2026-10-17T15:00:00.000Z',
  ...overrides,
});

const state = (
  overrides: Partial<AfipSimulatorStateResponse> = {},
): AfipSimulatorStateResponse => ({
  mode: 'ok',
  vouchers: [],
  ...overrides,
});

let missing: string[] | undefined;

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(loaded: AfipSimulatorStateResponse, routes: Record<string, Handler | Response> = {}) {
  const app = renderInRouter(<AfipSimulator />, {
    routes: { [`GET ${BASE}/state`]: () => jsonResponse(loaded), ...routes },
  });
  missing = app.missingKeys;
  return app;
}

describe('the AFIP simulator tab', () => {
  it('is registered in the provider console', () => {
    const tab = REGISTERED_TABS.find((entry) => entry.id === 'afip');

    expect(tab?.labelKey).toBe('invoicing:dev.tab');
  });

  it('lists the vouchers the simulator authorized, with number, CAE and amount in pesos', async () => {
    open(
      state({
        vouchers: [voucher(), voucher({ number: 6, id: '0190a000-0000-7000-8000-0000000000c2' })],
      }),
    );

    const table = await screen.findByRole('table', {
      name: 'Comprobantes que autorizó el simulador, los más nuevos primero',
    });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('20123456786');
    expect(rows[1]).toHaveTextContent('FC');
    expect(rows[1]).toHaveTextContent('7');
    expect(rows[1]).toHaveTextContent('71234567890123');
    expect(rows[1]).toHaveTextContent('27/10/2026');
    expect(rows[1]).toHaveTextContent('$ 1.234,50');
  });

  it('says so when nothing was authorized yet', async () => {
    open(state());

    expect(
      await screen.findByText('El simulador todavía no autorizó ningún comprobante.'),
    ).toBeInTheDocument();
  });

  it('shows the current mode and switches it', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(state({ mode: 'slow' }), {
      [`PUT ${BASE}/mode`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ mode: 'down' });
      },
    });

    const select = await screen.findByLabelText('Modo del simulador');
    expect(select).toHaveValue('slow');
    await user.selectOptions(select, 'down');

    await waitFor(() => {
      expect(body).toEqual({ mode: 'down' });
    });
  });

  it('offers every mode of the simulator, one-shot ones marked as such', async () => {
    open(state());

    const select = await screen.findByLabelText('Modo del simulador');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Funciona',
      'Caído (las facturas quedan pendientes)',
      'Lento (responde con demora)',
      'Autoriza y no responde (una vez)',
      'Rechaza el próximo pedido (una vez)',
    ]);
  });

  it('resets the simulator and says it did', async () => {
    const user = userEvent.setup();
    let called = false;
    open(state({ vouchers: [voucher()] }), {
      [`POST ${BASE}/reset`]: () => {
        called = true;
        return jsonResponse(state());
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Reiniciar el simulador' }));

    await waitFor(() => {
      expect(called).toBe(true);
    });
    expect(await screen.findByText('Se reinició el simulador.')).toBeInTheDocument();
  });

  it('shows a failure to switch the mode', async () => {
    const user = userEvent.setup();
    open(state(), { [`PUT ${BASE}/mode`]: () => problemResponse(500, 'internal_error') });

    await user.selectOptions(await screen.findByLabelText('Modo del simulador'), 'down');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = open(state({ vouchers: [voucher()] }));
    await screen.findByRole('table');

    expect(await a11yViolations(container)).toEqual([]);
  });
});
