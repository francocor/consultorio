import { DEFAULT_SETTINGS_SECTIONS } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

type Handler = (url: string, init: RequestInit) => Response;

const settings = (overrides: Record<string, unknown> = {}) => ({
  receptionSeesClinicalMetadata: false,
  clinicalSharing: false,
  sharedTemplates: [],
  require2fa: false,
  quietHours: { start: '21:00', end: '08:00' },
  ...DEFAULT_SETTINGS_SECTIONS,
  ...overrides,
});

let current: RenderedApp | undefined;

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(routes: Record<string, Handler> = {}, loaded = settings(), me = meFor(['owner'])) {
  current = renderApp({
    me,
    path: '/settings/security',
    boot: bootFor('Centro Médico Aillu'),
    routes: { 'GET /api/settings': () => jsonResponse(loaded), ...routes },
  });
  return current;
}

describe('Settings > Seguridad y privacidad', () => {
  it('shows each policy with what it does', async () => {
    open(undefined, settings({ require2fa: true }));

    expect(
      await screen.findByRole('switch', { name: /Exigir la verificación en dos pasos/ }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /Recepción ve que existen datos clínicos/ }),
    ).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /Compartir plantillas clínicas/ })).not.toBeChecked();
  });

  it('turning on the second factor for everyone asks first, and says what happens', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'PATCH /api/settings': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(settings({ require2fa: true }));
      },
    });
    await user.click(
      await screen.findByRole('switch', { name: /Exigir la verificación en dos pasos/ }),
    );

    const confirmation = await screen.findByRole('alertdialog', {
      name: '¿Exigir la verificación en dos pasos?',
    });
    expect(confirmation).toHaveTextContent('plazo');
    await user.click(within(confirmation).getByRole('button', { name: 'Exigir a todo el equipo' }));

    await waitFor(() => {
      expect(body).toEqual({ require2fa: true });
    });
    expect(await screen.findByText('Configuración guardada.')).toBeInTheDocument();
  });

  it('cancelling the confirmation changes nothing', async () => {
    const user = userEvent.setup();
    const app = open();
    await user.click(
      await screen.findByRole('switch', { name: /Exigir la verificación en dos pasos/ }),
    );
    const confirmation = await screen.findByRole('alertdialog');

    await user.click(within(confirmation).getByRole('button', { name: 'Cancelar' }));

    expect(
      screen.getByRole('switch', { name: /Exigir la verificación en dos pasos/ }),
    ).not.toBeChecked();
    expect(app.requests.filter((request) => request.startsWith('PATCH'))).toEqual([]);
  });

  it('the reception metadata switch saves at once and sends only that setting', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'PATCH /api/settings': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(settings({ receptionSeesClinicalMetadata: true }));
      },
    });

    await user.click(
      await screen.findByRole('switch', { name: /Recepción ve que existen datos clínicos/ }),
    );

    await waitFor(() => {
      expect(body).toEqual({ receptionSeesClinicalMetadata: true });
    });
    expect(
      await screen.findByRole('switch', { name: /Recepción ve que existen datos clínicos/ }),
    ).toBeChecked();
  });

  it('turning sharing on shows the templates, psychology excluded by default', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'PATCH /api/settings': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(
          settings({
            clinicalSharing: true,
            sharedTemplates: ['general', 'odontology', 'physiotherapy', 'nutrition'],
          }),
        );
      },
    });
    await user.click(await screen.findByRole('switch', { name: /Compartir plantillas clínicas/ }));

    await waitFor(() => {
      expect(body).toEqual({ clinicalSharing: true });
    });
    const psychology = await screen.findByRole('checkbox', { name: /Psicología/ });
    expect(psychology).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Odontología/ })).toBeChecked();
  });

  it('adding psychology needs an explicit confirmation that is sent with the change', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(
      {
        'PATCH /api/settings': (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(
            settings({
              clinicalSharing: true,
              sharedTemplates: ['general', 'psychology'],
            }),
          );
        },
      },
      settings({ clinicalSharing: true, sharedTemplates: ['general'] }),
    );
    await user.click(await screen.findByRole('checkbox', { name: /Psicología/ }));

    const confirmation = await screen.findByRole('alertdialog', {
      name: '¿Compartir las plantillas de psicología?',
    });
    await user.click(within(confirmation).getByRole('button', { name: 'Compartir psicología' }));

    await waitFor(() => {
      expect(body).toEqual({
        sharedTemplates: ['general', 'psychology'],
        confirmPsychologySharing: true,
      });
    });
  });

  it('removing a template needs no confirmation', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open(
      {
        'PATCH /api/settings': (_url, init) => {
          body = jsonBody(init);
          return jsonResponse(settings({ clinicalSharing: true, sharedTemplates: ['general'] }));
        },
      },
      settings({ clinicalSharing: true, sharedTemplates: ['general', 'nutrition'] }),
    );

    await user.click(await screen.findByRole('checkbox', { name: /Nutrición/ }));

    await waitFor(() => {
      expect(body).toEqual({ sharedTemplates: ['general'] });
    });
  });

  it('saves the quiet hours', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'PATCH /api/settings': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(settings({ quietHours: { start: '22:00', end: '07:30' } }));
      },
    });
    const start = await screen.findByLabelText('Desde');
    expect(start).toHaveValue('21:00');
    await user.clear(start);
    await user.type(start, '22:00');
    const end = screen.getByLabelText('Hasta');
    await user.clear(end);
    await user.type(end, '07:30');

    await user.click(screen.getByRole('button', { name: 'Guardar horario' }));

    await waitFor(() => {
      expect(body).toEqual({ quietHours: { start: '22:00', end: '07:30' } });
    });
  });

  it('shows what the server refused and keeps the switch where it was', async () => {
    const user = userEvent.setup();
    open({ 'PATCH /api/settings': () => problemResponse(500, 'internal') });

    await user.click(
      await screen.findByRole('switch', { name: /Recepción ve que existen datos clínicos/ }),
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: /Recepción ve que existen datos clínicos/ }),
    ).not.toBeChecked();
  });

  it('is closed to whoever cannot manage the settings', async () => {
    const app = open(undefined, settings(), meFor(['reception']));

    expect(
      await screen.findByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
    expect(app.requests).not.toContain('GET /api/settings');
  });

  it('has no accessibility violations', async () => {
    const app = open(undefined, settings({ clinicalSharing: true, sharedTemplates: ['general'] }));
    await screen.findByRole('checkbox', { name: /Psicología/ });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
