import type { ErxSimulatorStateResponse } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../../shared/test/a11y.js';
import { renderInRouter } from '../../../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../../../shared/test/render.js';
import { REGISTERED_TABS } from '../tabs.js';

import { ErxSimulator } from './ErxSimulator.js';

type Handler = (url: string, init: RequestInit) => Response;

const BASE = '/api/operator/dev/erx';

const state = (overrides: Partial<ErxSimulatorStateResponse> = {}): ErxSimulatorStateResponse => ({
  mode: 'ok',
  prescriptions: [],
  ...overrides,
});

const issued = {
  externalId: 'ERX-0123456789AB',
  state: 'issued' as const,
  createdAt: '2026-10-19T15:00:00.000Z',
};

let missing: string[] | undefined;

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(loaded: ErxSimulatorStateResponse, routes: Record<string, Handler | Response> = {}) {
  const app = renderInRouter(<ErxSimulator />, {
    routes: { [`GET ${BASE}/state`]: () => jsonResponse(loaded), ...routes },
  });
  missing = app.missingKeys;
  return app;
}

describe('the e-Rx simulator tab', () => {
  it('is registered in the provider console', () => {
    const tab = REGISTERED_TABS.find((entry) => entry.id === 'erx');

    expect(tab?.labelKey).toBe('prescriptions:dev.tab');
  });

  it('lists the prescriptions the simulator issued, with their state, and nothing about the patient or the medication', async () => {
    open(
      state({
        prescriptions: [issued, { ...issued, externalId: 'ERX-FFFFFFFFFFFF', state: 'dispensed' }],
      }),
    );

    const table = await screen.findByRole('table', {
      name: 'Recetas que emitió el simulador, las más nuevas primero',
    });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('ERX-0123456789AB');
    expect(rows[1]).toHaveTextContent('Emitida');
    expect(rows[2]).toHaveTextContent('Dispensada');
    expect(within(table).queryByText(/Amoxicilina|DNI/)).not.toBeInTheDocument();
  });

  it('offers to dispense or expire an issued prescription only', async () => {
    open(
      state({
        prescriptions: [issued, { ...issued, externalId: 'ERX-AAAAAAAAAAAA', state: 'cancelled' }],
      }),
    );

    expect(
      await screen.findByRole('button', {
        name: 'Marcar como dispensada la receta ERX-0123456789AB',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Marcar como vencida la receta ERX-0123456789AB' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /receta ERX-AAAAAAAAAAAA/ }),
    ).not.toBeInTheDocument();
  });

  it('sends the move and says the application was notified', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(state({ prescriptions: [issued] }), {
      [`POST ${BASE}/advance`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({ delivered: true });
      },
    });

    await user.click(
      await screen.findByRole('button', {
        name: 'Marcar como dispensada la receta ERX-0123456789AB',
      }),
    );

    await waitFor(() => {
      expect(bodies).toEqual([{ externalId: 'ERX-0123456789AB', to: 'dispensed' }]);
    });
    expect(
      await screen.findByText('Estado cambiado. La aplicación recibió el aviso.'),
    ).toBeInTheDocument();
  });

  it('switches the mode of the simulator', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(state(), {
      [`PUT ${BASE}/mode`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({ mode: 'down' });
      },
    });

    await user.selectOptions(await screen.findByLabelText('Modo del simulador'), 'down');

    await waitFor(() => {
      expect(bodies).toEqual([{ mode: 'down' }]);
    });
  });

  it('resets the simulator and shows it empty', async () => {
    const user = userEvent.setup();
    open(state({ mode: 'down', prescriptions: [issued] }), {
      [`POST ${BASE}/reset`]: () => jsonResponse(state()),
    });

    await user.click(await screen.findByRole('button', { name: 'Reiniciar simulador' }));

    expect(
      await screen.findByText('El simulador todavía no emitió ninguna receta.'),
    ).toBeInTheDocument();
  });

  it('shows the error when the console is not available', async () => {
    renderInRouter(<ErxSimulator />, {
      routes: { [`GET ${BASE}/state`]: () => problemResponse(404, 'not_found') },
    });

    expect(await screen.findByText(/No encontramos lo que busca/)).toBeInTheDocument();
  });

  it('passes the accessibility checks', async () => {
    const app = open(state({ prescriptions: [issued] }));
    await screen.findByRole('table');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
