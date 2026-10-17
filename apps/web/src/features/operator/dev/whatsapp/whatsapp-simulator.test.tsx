import type { SimulatorMessageDto, SimulatorStateResponse } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../../shared/test/a11y.js';
import { renderInRouter } from '../../../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../../../shared/test/render.js';
import { REGISTERED_TABS } from '../tabs.js';

import { WhatsAppSimulator } from './WhatsAppSimulator.js';

/** The item at a position, or a failure that names it. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}

type Handler = (url: string, init: RequestInit) => Response;

const BASE = '/api/operator/dev/whatsapp';

const phoneMessage = (overrides: Partial<SimulatorMessageDto> = {}): SimulatorMessageDto => ({
  id: '0190a000-0000-7000-8000-0000000000b1',
  providerMessageId: 'wamid.1',
  direction: 'outbound',
  number: '+5491155550001',
  templateKey: 'appointment_reminder',
  body: 'Recordatorio: tiene un turno mañana.',
  status: 'accepted',
  errorCode: null,
  createdAt: '2031-05-11T13:00:00.000Z',
  ...overrides,
});

const state = (overrides: Partial<SimulatorStateResponse> = {}): SimulatorStateResponse => ({
  messages: [],
  mode: 'ok',
  unreachableNumbers: [],
  ...overrides,
});

let missing: string[] | undefined;

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(loaded: SimulatorStateResponse, routes: Record<string, Handler | Response> = {}) {
  const app = renderInRouter(<WhatsAppSimulator />, {
    routes: { [`GET ${BASE}/messages`]: () => jsonResponse(loaded), ...routes },
  });
  missing = app.missingKeys;
  return app;
}

describe('the WhatsApp simulator tab', () => {
  it('is registered in the provider console', () => {
    const tab = REGISTERED_TABS.find((entry) => entry.id === 'whatsapp');

    expect(tab?.labelKey).toBe('messaging:dev.tab');
  });

  it('shows the messages the platform handed to the phone, as the patient reads them', async () => {
    open(
      state({
        messages: [
          phoneMessage(),
          phoneMessage({
            id: '0190a000-0000-7000-8000-0000000000b2',
            providerMessageId: 'in.1',
            direction: 'inbound',
            body: 'BAJA',
            status: 'received',
          }),
        ],
      }),
    );

    const list = await screen.findByRole('list', {
      name: 'Mensajes del teléfono del simulador, el más nuevo primero',
    });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Para +5491155550001');
    expect(items[0]).toHaveTextContent('Recordatorio: tiene un turno mañana.');
    expect(items[0]).toHaveTextContent('Estado: aceptado');
    expect(items[1]).toHaveTextContent('De +5491155550001');
    expect(items[1]).toHaveTextContent('BAJA');
  });

  it('says the phone is empty before anything arrives', async () => {
    open(state());

    expect(
      await screen.findByText('El teléfono todavía no recibió ningún mensaje.'),
    ).toBeInTheDocument();
  });

  it('reports a message as delivered through the signed webhook and refreshes', async () => {
    const user = userEvent.setup();
    let body: unknown;
    let url = '';
    open(state({ messages: [phoneMessage()] }), {
      [`POST ${BASE}/messages/wamid.1/status`]: (requested, init) => {
        url = requested;
        body = jsonBody(init);
        return jsonResponse({ delivered: true });
      },
    });

    await user.click(await screen.findByRole('button', { name: /Marcar entregado/ }));

    await waitFor(() => {
      expect(body).toEqual({ status: 'delivered' });
    });
    expect(url).toContain('/messages/wamid.1/status');
  });

  it('reports a failure with the "not on WhatsApp" code', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(state({ messages: [phoneMessage()] }), {
      [`POST ${BASE}/messages/wamid.1/status`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ delivered: true });
      },
    });

    await user.click(await screen.findByRole('button', { name: /Marcar fallido/ }));

    await waitFor(() => {
      expect(body).toEqual({ status: 'failed', errorCode: 'not_on_whatsapp' });
    });
  });

  it("offers no receipts for a message that already failed, nor for the patient's own replies", async () => {
    open(
      state({
        messages: [
          phoneMessage({ status: 'failed' }),
          phoneMessage({
            id: '0190a000-0000-7000-8000-0000000000b2',
            providerMessageId: 'in.1',
            direction: 'inbound',
            status: 'received',
          }),
        ],
      }),
    );

    const list = await screen.findByRole('list', {
      name: 'Mensajes del teléfono del simulador, el más nuevo primero',
    });
    const items = within(list).getAllByRole('listitem');
    const failed = at(items, 0);
    expect(within(failed).getByRole('button', { name: /Marcar entregado/ })).toBeDisabled();
    expect(within(failed).getByRole('button', { name: /Marcar leído/ })).toBeDisabled();
    expect(within(at(items, 1)).queryByRole('button')).not.toBeInTheDocument();
  });

  it('replies as the patient and tells whether the real webhook accepted it', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(state(), {
      [`POST ${BASE}/inbound`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ delivered: true });
      },
    });

    await user.type(
      await screen.findByLabelText('Número del paciente (formato +549…)'),
      '+5491155550001',
    );
    await user.type(screen.getByLabelText('Mensaje'), 'BAJA');
    await user.click(screen.getByRole('button', { name: 'Enviar respuesta' }));

    await waitFor(() => {
      expect(body).toEqual({ from: '+5491155550001', text: 'BAJA' });
    });
    expect(await screen.findByText('La respuesta llegó al webhook.')).toBeInTheDocument();
  });

  it('does not send a reply without a number', async () => {
    open(state());

    expect(await screen.findByRole('button', { name: 'Enviar respuesta' })).toBeDisabled();
  });

  it('switches the simulated provider to an outage', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(state(), {
      [`PUT ${BASE}/mode`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ mode: 'down' });
      },
    });

    await user.selectOptions(await screen.findByLabelText('Modo del simulador'), 'down');

    await waitFor(() => {
      expect(body).toEqual({ mode: 'down' });
    });
  });

  it('marks a number as not on WhatsApp and lists the marked ones to unmark', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(state({ unreachableNumbers: ['+5491155559999'] }), {
      [`PUT ${BASE}/unreachable`]: (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse({ number: '+5491155550002', unreachable: true });
      },
    });

    await user.type(await screen.findByLabelText('Número (formato +549…)'), '+5491155550002');
    await user.click(screen.getByRole('button', { name: 'Marcar sin WhatsApp' }));
    await user.click(screen.getByRole('button', { name: 'Quitar la marca de +5491155559999' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        { number: '+5491155550002', unreachable: true },
        { number: '+5491155559999', unreachable: false },
      ]);
    });
  });

  it('shows the problem when the console refuses a control', async () => {
    const user = userEvent.setup();
    open(state(), { [`PUT ${BASE}/mode`]: problemResponse(403, 'forbidden') });

    await user.selectOptions(await screen.findByLabelText('Modo del simulador'), 'reject_template');

    expect(
      await screen.findByText('No tiene permiso para realizar esta acción.'),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const app = open(state({ messages: [phoneMessage()], unreachableNumbers: ['+5491155559999'] }));
    await screen.findByRole('list', {
      name: 'Mensajes del teléfono del simulador, el más nuevo primero',
    });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
