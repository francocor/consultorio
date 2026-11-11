import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { renderApp, type RenderedApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

type Handler = (url: string, init: RequestInit) => Response;

const OPERATOR = {
  id: '0190a000-0000-7000-8000-0000000000c1',
  email: 'operador@demo.invalid',
  displayName: 'Operador de la plataforma',
};

const tenant = (overrides: Record<string, unknown> = {}) => ({
  id: '0190a000-0000-7000-8000-0000000000d1',
  slug: 'aillu',
  name: 'Centro Médico Aillu',
  status: 'active',
  isDemo: true,
  country: 'AR',
  createdAt: '2026-10-01T12:00:00.000Z',
  ...overrides,
});

const TENANTS = [
  tenant(),
  tenant({
    id: '0190a000-0000-7000-8000-0000000000d2',
    slug: 'clinica-sur',
    name: 'Clínica del Sur',
    status: 'read_only',
    isDemo: false,
  }),
];

let current: RenderedApp | undefined;

afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(routes: Record<string, Handler> = {}, signedIn = true) {
  current = renderApp({
    platform: true,
    me: null,
    path: '/',
    routes: {
      'GET /api/operator/me': () =>
        signedIn ? jsonResponse(OPERATOR) : problemResponse(401, 'unauthenticated'),
      'GET /api/operator/tenants': () => jsonResponse({ tenants: TENANTS }),
      ...routes,
    },
  });
  return current;
}

describe('operator console: signing in', () => {
  it('asks for email, password and the code of the second factor', async () => {
    open({}, false);

    expect(
      await screen.findByRole('heading', { name: 'Consola de la plataforma' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Correo electrónico')).toBeInTheDocument();
    expect(screen.getByLabelText('Contraseña')).toBeInTheDocument();
    expect(screen.getByLabelText('Código de verificación')).toBeInTheDocument();
  });

  it('signs in in one step and shows the organizations', async () => {
    const user = userEvent.setup();
    let body: unknown;
    let signedIn = false;
    open(
      {
        'GET /api/operator/me': () =>
          signedIn ? jsonResponse(OPERATOR) : problemResponse(401, 'unauthenticated'),
        'POST /api/operator/auth/login': (_url, init) => {
          body = jsonBody(init);
          signedIn = true;
          return jsonResponse(OPERATOR);
        },
      },
      false,
    );
    await user.type(await screen.findByLabelText('Correo electrónico'), 'operador@demo.invalid');
    await user.type(screen.getByLabelText('Contraseña'), 'Operador-Demo-2026-clave');
    await user.type(screen.getByLabelText('Código de verificación'), '123456');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(await screen.findByRole('heading', { name: 'Organizaciones' })).toBeInTheDocument();
    expect(body).toEqual({
      email: 'operador@demo.invalid',
      password: 'Operador-Demo-2026-clave',
      code: '123456',
    });
  });

  it('shows one calm message for a wrong password or code, without saying which', async () => {
    const user = userEvent.setup();
    open(
      { 'POST /api/operator/auth/login': () => problemResponse(401, 'invalid_credentials') },
      false,
    );
    await user.type(await screen.findByLabelText('Correo electrónico'), 'operador@demo.invalid');
    await user.type(screen.getByLabelText('Contraseña'), 'mala');
    await user.type(screen.getByLabelText('Código de verificación'), '000000');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no son correctos/);
  });

  it('asks for all three fields before sending anything', async () => {
    const user = userEvent.setup();
    const app = open({}, false);
    await user.click(await screen.findByRole('button', { name: 'Ingresar' }));

    expect(await screen.findAllByText('Este dato es obligatorio.')).toHaveLength(3);
    expect(app.requests.filter((request) => request.startsWith('POST'))).toEqual([]);
  });

  it('has no accessibility violations', async () => {
    const app = open({}, false);
    await screen.findByLabelText('Código de verificación');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});

describe('operator console: organizations', () => {
  it('lists them with their address, state and whether they are demonstrations', async () => {
    open();

    const list = await screen.findByRole('table', { name: 'Organizaciones' });
    const rows = within(list).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Centro Médico Aillu');
    expect(rows[1]).toHaveTextContent('aillu');
    expect(rows[1]).toHaveTextContent('Activa');
    expect(rows[1]).toHaveTextContent('Demostración');
    expect(rows[2]).toHaveTextContent('Clínica del Sur');
    expect(rows[2]).toHaveTextContent('Solo lectura');
    expect(rows[2]).not.toHaveTextContent('Demostración');
  });

  it('has an empty state that points to the first action', async () => {
    open({ 'GET /api/operator/tenants': () => jsonResponse({ tenants: [] }) });

    expect(await screen.findByText('Todavía no hay organizaciones')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: 'Crear una organización' }).length,
    ).toBeGreaterThan(0);
  });

  it('creates an organization and invites its owner', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'POST /api/operator/tenants': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(
          {
            tenant: tenant({
              id: '0190a000-0000-7000-8000-0000000000d3',
              slug: 'nueva',
              name: 'Nueva Clínica',
              isDemo: false,
            }),
            invitationSent: true,
            invitationExpiresAt: '2026-10-23T12:00:00.000Z',
          },
          201,
        );
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Crear una organización' }));
    const dialog = await screen.findByRole('dialog', { name: 'Crear una organización' });
    await user.type(within(dialog).getByLabelText('Nombre de la organización'), 'Nueva Clínica');
    await user.type(
      within(dialog).getByLabelText('Correo de la persona propietaria'),
      'duena@nueva.example',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Crear organización' }));

    await waitFor(() => {
      expect(body).toEqual({
        name: 'Nueva Clínica',
        ownerEmail: 'duena@nueva.example',
        isDemo: false,
      });
    });
    expect(
      await screen.findByText(/Organización creada\. La invitación salió a duena@nueva\.example/),
    ).toBeInTheDocument();
  });

  it('marks a demonstration organization only at creation, and says it cannot change later', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'POST /api/operator/tenants': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(
          {
            tenant: tenant(),
            invitationSent: true,
            invitationExpiresAt: '2026-10-23T12:00:00.000Z',
          },
          201,
        );
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Crear una organización' }));
    const dialog = await screen.findByRole('dialog', { name: 'Crear una organización' });
    await user.type(within(dialog).getByLabelText('Nombre de la organización'), 'Demo Hospital');
    await user.type(
      within(dialog).getByLabelText('Correo de la persona propietaria'),
      'demo@demo.invalid',
    );
    const demo = within(dialog).getByRole('checkbox', {
      name: /Es una organización de demostración/,
    });
    expect(within(dialog).getByText(/no se puede cambiar/)).toBeInTheDocument();
    await user.click(demo);
    await user.click(within(dialog).getByRole('button', { name: 'Crear organización' }));

    await waitFor(() => {
      expect(body).toMatchObject({ isDemo: true });
    });
  });

  it('warns when the invitation email could not be sent', async () => {
    const user = userEvent.setup();
    open({
      'POST /api/operator/tenants': () =>
        jsonResponse(
          {
            tenant: tenant(),
            invitationSent: false,
            invitationExpiresAt: '2026-10-23T12:00:00.000Z',
          },
          201,
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Crear una organización' }));
    const dialog = await screen.findByRole('dialog', { name: 'Crear una organización' });
    await user.type(within(dialog).getByLabelText('Nombre de la organización'), 'Otra Clínica');
    await user.type(
      within(dialog).getByLabelText('Correo de la persona propietaria'),
      'a@b.example',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Crear organización' }));

    expect(await screen.findByText(/no se pudo enviar el correo/i)).toBeInTheDocument();
  });

  it('shows what the server refused next to the field', async () => {
    const user = userEvent.setup();
    open({
      'POST /api/operator/tenants': () =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'validation_failed',
            status: 422,
            code: 'validation_failed',
            i18nKey: 'errors.validation_failed',
            requestId: 'req-1',
            errors: [{ path: 'ownerEmail', i18nKey: 'validation.email' }],
          }),
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Crear una organización' }));
    const dialog = await screen.findByRole('dialog', { name: 'Crear una organización' });
    await user.type(within(dialog).getByLabelText('Nombre de la organización'), 'Otra Clínica');
    await user.type(
      within(dialog).getByLabelText('Correo de la persona propietaria'),
      'a@b.example',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Crear organización' }));

    expect(await within(dialog).findByText(/correo electrónico válido/)).toBeInTheDocument();
  });

  it('resends the invitation to an owner', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'POST /api/operator/tenants/0190a000-0000-7000-8000-0000000000d2/owner-invitation': (
        _url,
        init,
      ) => {
        body = jsonBody(init);
        return jsonResponse({
          invitationSent: true,
          invitationExpiresAt: '2026-10-23T12:00:00.000Z',
        });
      },
    });
    await user.click(
      await screen.findByRole('button', { name: 'Reenviar la invitación de Clínica del Sur' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Reenviar la invitación' });
    await user.type(
      within(dialog).getByLabelText('Correo de la persona propietaria'),
      'dueno@sur.example',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reenviar invitación' }));

    await waitFor(() => {
      expect(body).toEqual({ ownerEmail: 'dueno@sur.example' });
    });
    expect(await screen.findByText(/La invitación salió a dueno@sur\.example/)).toBeInTheDocument();
  });

  it('resets a demonstration after confirming, and offers it only for demonstrations', async () => {
    const user = userEvent.setup();
    let calls = 0;
    open({
      'POST /api/operator/tenants/0190a000-0000-7000-8000-0000000000d1/demo-reset': () => {
        calls += 1;
        return jsonResponse({ status: 'done' });
      },
    });
    await screen.findByRole('table');
    expect(
      screen.queryByRole('button', { name: 'Reiniciar la demostración de Clínica del Sur' }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Reiniciar la demostración de Centro Médico Aillu' }),
    );
    const confirmation = await screen.findByRole('alertdialog', {
      name: '¿Reiniciar la demostración?',
    });
    expect(confirmation).toHaveTextContent('contraseñas');
    await user.click(within(confirmation).getByRole('button', { name: 'Reiniciar demostración' }));

    await waitFor(() => {
      expect(calls).toBe(1);
    });
    expect(await screen.findByText('Demostración reiniciada.')).toBeInTheDocument();
  });

  it('signs out', async () => {
    const user = userEvent.setup();
    let signedIn = true;
    open({
      'GET /api/operator/me': () =>
        signedIn ? jsonResponse(OPERATOR) : problemResponse(401, 'unauthenticated'),
      'POST /api/operator/auth/logout': () => {
        signedIn = false;
        return new Response(null, { status: 204 });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));

    expect(await screen.findByLabelText('Código de verificación')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const app = open();
    await screen.findByRole('table');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
