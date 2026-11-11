import { DEFAULT_SETTINGS_SECTIONS, type ErxConnectionDto } from '@consultorio/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, type FetchHandler } from '../../shared/test/render.js';

/**
 * Settings > Recetas electronicas (S5.05, task 5.22): the connection of the organization to the
 * provider. The owner and the administration switch it on; the credentials a real provider needs are
 * written once and never shown again.
 */

const connection = (overrides: Partial<ErxConnectionDto> = {}): ErxConnectionDto => ({
  providerAvailable: true,
  provider: 'local',
  enabled: false,
  simulated: true,
  credentialsSaved: false,
  ...overrides,
});

const settings = {
  receptionSeesClinicalMetadata: false,
  clinicalSharing: false,
  sharedTemplates: [],
  require2fa: false,
  quietHours: { start: '21:00', end: '08:00' },
  ...DEFAULT_SETTINGS_SECTIONS,
  integrations: { whatsapp: false, video: true, einvoicing: false },
};

let current: RenderedApp | undefined;

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(
  loaded: ErxConnectionDto,
  routes: Record<string, FetchHandler | Response> = {},
  roles: Parameters<typeof meFor>[0] = ['owner'],
) {
  current = renderApp({
    me: meFor(roles),
    path: '/settings/prescriptions',
    boot: bootFor('Centro Médico Aillu', {
      localProviders: { afip: false, erx: loaded.simulated },
    }),
    routes: {
      'GET /api/prescriptions/connection': () => jsonResponse(loaded),
      'GET /api/settings': () => jsonResponse(settings),
      ...routes,
    },
  });
  return current;
}

describe('Settings > Recetas electrónicas', () => {
  it('is a section of Settings for the owner and the admin, and not for reception', async () => {
    open(connection());

    const nav = await screen.findByRole('navigation', { name: /Secciones/i });
    expect(within(nav).getByRole('link', { name: 'Recetas electrónicas' })).toBeInTheDocument();
  });

  it('shows the no-access screen to a professional who cannot manage the settings', async () => {
    open(connection(), {}, ['reception']);

    expect(await screen.findByText('No tiene acceso a esta sección')).toBeInTheDocument();
  });

  it('says the provider is a simulator and that its prescriptions are tests', async () => {
    open(connection());

    expect(
      await screen.findByText(/El proveedor es un simulador: las recetas son de prueba/),
    ).toBeInTheDocument();
    expect(screen.getByText('Recetas de prueba')).toBeInTheDocument();
  });

  it('switches e-prescription on and says it was saved', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(connection(), {
      'PUT /api/prescriptions/connection': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(connection({ enabled: true }));
      },
    });

    await user.click(await screen.findByRole('switch', { name: 'Receta electrónica activada' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ enabled: true }]);
    });
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('cannot be switched on when the deployment serves no provider, and says why', async () => {
    open(connection({ providerAvailable: false, provider: null, simulated: false }));

    expect(
      await screen.findByText(
        /no tiene un proveedor de recetas configurado, así que no se puede activar/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Receta electrónica activada' })).toBeDisabled();
    expect(screen.queryByLabelText('Credenciales nuevas')).not.toBeInTheDocument();
  });

  it('asks for the credentials of a real provider, writes them once and never shows them again', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open(
      connection({
        simulated: false,
        provider: 'authorized',
        enabled: true,
        credentialsSaved: true,
      }),
      {
        'PUT /api/prescriptions/connection': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(
            connection({
              simulated: false,
              provider: 'authorized',
              enabled: true,
              credentialsSaved: true,
            }),
          );
        },
      },
    );

    expect(
      await screen.findByText('Hay credenciales guardadas. Por seguridad no se vuelven a mostrar.'),
    ).toBeInTheDocument();
    const field = screen.getByLabelText('Credenciales nuevas');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveValue('');
    await user.type(field, 'clave-secreta');
    await user.click(screen.getByRole('button', { name: 'Guardar credenciales' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ enabled: true, credentials: 'clave-secreta' }]);
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Credenciales nuevas')).toHaveValue('');
    });
    expect(document.body).not.toHaveTextContent('clave-secreta');
  });

  it('passes the accessibility checks', async () => {
    const app = open(connection());
    await screen.findByRole('switch', { name: 'Receta electrónica activada' });

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
