import type { DemoOutboxResponse } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../../shared/test/a11y.js';
import { renderInRouter } from '../../../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../../../shared/test/render.js';
import { REGISTERED_TABS } from '../tabs.js';

import { DemoOutbox } from './DemoOutbox.js';

const URL_PATH = '/api/operator/dev/demo-outbox';

const message = (overrides: Partial<DemoOutboxResponse['messages'][number]> = {}) => ({
  id: '0190a000-0000-7000-8000-000000000001',
  to: 'valentina.gomez@demo.invalid',
  subject: 'Ingrese al portal de Aillu: su código',
  text: 'Su código para ingresar es:\n\n482913\n\nVence en 10 minutos.',
  createdAt: '2026-10-19T15:00:00.000Z',
  ...overrides,
});

let missing: string[] | undefined;

afterEach(() => {
  expect(missing ?? []).toEqual([]);
  missing = undefined;
});

function open(
  messages: DemoOutboxResponse['messages'],
  onRequest: (url: string) => void = () => undefined,
) {
  const app = renderInRouter(<DemoOutbox />, {
    routes: {
      [`GET ${URL_PATH}`]: (url) => {
        onRequest(url);
        const asked = new URL(url, 'http://localhost').searchParams.get('to');
        return jsonResponse({
          messages: asked === null ? messages : messages.filter((entry) => entry.to === asked),
        } satisfies DemoOutboxResponse);
      },
    },
  });
  missing = app.missingKeys;
  return app;
}

describe('the demo outbox tab', () => {
  it('is registered in the provider console', () => {
    const tab = REGISTERED_TABS.find((entry) => entry.id === 'demo-outbox');

    expect(tab?.labelKey).toBe('operator:demoOutbox.tab');
  });

  it('shows the address, the subject and the whole text of each message, so the code can be read', async () => {
    open([
      message(),
      message({
        id: '0190a000-0000-7000-8000-000000000002',
        to: 'lorena.acosta@demo.invalid',
        subject: 'Active su acceso',
        text: 'Abra https://aillu.localhost/portal/activar',
      }),
    ]);

    const first = await screen.findByRole('article', { name: /Ingrese al portal de Aillu/ });
    expect(within(first).getByText('valentina.gomez@demo.invalid')).toBeInTheDocument();
    expect(within(first).getByText(/482913/)).toBeInTheDocument();
    const second = screen.getByRole('article', { name: /Active su acceso/ });
    expect(within(second).getByText(/portal\/activar/)).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('says so when nothing was sent yet', async () => {
    open([]);

    expect(await screen.findByText('La demo todavía no envió ningún correo.')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('asks only for the messages to the address typed', async () => {
    const user = userEvent.setup();
    const asked: string[] = [];
    open(
      [
        message(),
        message({
          id: '0190a000-0000-7000-8000-000000000002',
          to: 'lorena.acosta@demo.invalid',
          subject: 'Otro correo',
          text: 'Otro texto',
        }),
      ],
      (url) => asked.push(url),
    );
    await screen.findAllByRole('article');

    await user.type(
      screen.getByRole('searchbox', { name: 'Filtrar por dirección' }),
      'lorena.acosta@demo.invalid',
    );
    await user.click(screen.getByRole('button', { name: 'Filtrar' }));

    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(1);
    });
    expect(screen.getByRole('article', { name: /Otro correo/ })).toBeInTheDocument();
    expect(asked.at(-1)).toContain('to=lorena.acosta%40demo.invalid');
  });

  it('explains a failure to load', async () => {
    renderInRouter(<DemoOutbox />, {
      routes: { [`GET ${URL_PATH}`]: () => problemResponse(500, 'internal_error') },
    });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = open([message()]);
    await screen.findByRole('article');

    expect(await a11yViolations(container)).toEqual([]);
  });
});
