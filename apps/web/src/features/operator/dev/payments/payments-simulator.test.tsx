import type { PaymentsSimulatorStateResponse } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../../shared/test/a11y.js';
import { renderInRouter } from '../../../../shared/test/render-app.js';
import { jsonBody, jsonResponse } from '../../../../shared/test/render.js';
import { REGISTERED_TABS } from '../tabs.js';

import { PaymentsSimulator } from './PaymentsSimulator.js';

type Handler = (url: string, init: RequestInit) => Response;

const BASE = '/api/operator/dev/payments';

const state = (
  overrides: Partial<PaymentsSimulatorStateResponse> = {},
): PaymentsSimulatorStateResponse => ({
  mode: 'ok',
  preapprovals: [],
  payments: [],
  ...overrides,
});

let missing: string[] | undefined;
afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(
  loaded: PaymentsSimulatorStateResponse,
  routes: Record<string, Handler | Response> = {},
) {
  const app = renderInRouter(<PaymentsSimulator />, {
    routes: { [`GET ${BASE}/state`]: () => jsonResponse(loaded), ...routes },
  });
  missing = app.missingKeys;
  return app;
}

describe('the Mercado Pago simulator tab', () => {
  it('is registered in the provider console', () => {
    const tab = REGISTERED_TABS.find((entry) => entry.id === 'payments');

    expect(tab?.labelKey).toBe('subscription:dev.tab');
  });

  it('lists the authorizations and payments the simulator holds, with the amount in pesos', async () => {
    open(
      state({
        preapprovals: [
          {
            preapprovalId: 'LOC-PRE-1',
            reference: 'sub:abc:1',
            status: 'authorized',
            amountCents: 3_600_000,
            createdAt: '2026-10-17T15:00:00.000Z',
          },
        ],
        payments: [
          {
            paymentId: 'LOC-PAY-1',
            reference: 'sub:abc:1',
            status: 'approved',
            amountCents: 3_600_000,
            refundedCents: 100_000,
            createdAt: '2026-10-18T15:00:00.000Z',
          },
        ],
      }),
    );

    const preapprovals = await screen.findByRole('table', { name: 'Autorizaciones del simulador' });
    expect(within(preapprovals).getAllByRole('row')[1]).toHaveTextContent('LOC-PRE-1');
    expect(within(preapprovals).getAllByRole('row')[1]).toHaveTextContent('$ 36.000,00');
    const payments = screen.getByRole('table', { name: 'Pagos del simulador' });
    expect(within(payments).getAllByRole('row')[1]).toHaveTextContent('LOC-PAY-1');
    expect(within(payments).getAllByRole('row')[1]).toHaveTextContent('$ 1.000,00');
  });

  it('puts the simulator in a mode', async () => {
    const user = userEvent.setup();
    let sent: unknown;
    open(state(), {
      [`PUT ${BASE}/mode`]: (_url, init) => {
        sent = jsonBody(init);
        return jsonResponse({ mode: 'refuse_amount_change' });
      },
    });

    await user.selectOptions(
      await screen.findByLabelText('Comportamiento del simulador'),
      'refuse_amount_change',
    );

    await waitFor(() => {
      expect(sent).toEqual({ mode: 'refuse_amount_change' });
    });
  });

  it('runs the billing cycle and says what it did', async () => {
    const user = userEvent.setup();
    let sent: unknown;
    open(state(), {
      [`POST ${BASE}/cycle`]: (_url, init) => {
        sent = jsonBody(init);
        return jsonResponse({ charged: 2, delivered: 3 });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Cobrar y rechazar' }));

    expect(
      await screen.findByText('Se hicieron 2 cobros y se entregaron 3 avisos.'),
    ).toBeInTheDocument();
    expect(sent).toEqual({ outcome: 'rejected' });
  });

  it('forgets everything it holds when it is reset', async () => {
    const user = userEvent.setup();
    open(
      state({
        payments: [
          {
            paymentId: 'LOC-PAY-1',
            reference: 'sub:abc:1',
            status: 'approved',
            amountCents: 100,
            refundedCents: 0,
            createdAt: '2026-10-18T15:00:00.000Z',
          },
        ],
      }),
      { [`POST ${BASE}/reset`]: () => jsonResponse(state()) },
    );

    await user.click(await screen.findByRole('button', { name: 'Reiniciar el simulador' }));

    expect(await screen.findByText('Todavía no hay pagos.')).toBeInTheDocument();
  });

  it('is accessible', async () => {
    const { container } = open(state());
    await screen.findByLabelText('Comportamiento del simulador');

    expect(await a11yViolations(container)).toEqual([]);
  });
});
