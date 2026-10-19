import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';

import { CHILD_LINK, meOf, SELF_LINK, signedInRoutes } from './portal-fixtures.js';

/**
 * The frame of the portal (S5.10, task 5.39): who is signed in, whose record is shown, and the way
 * to switch or to leave. The header always names the person whose data is on the screen.
 */
const EMPTY_APPOINTMENTS = jsonResponse({ upcoming: [], past: [] });

function open(routes: ReturnType<typeof signedInRoutes>, path = '/portal') {
  return renderApp({ me: null, path, boot: bootFor('Centro Médico Aillu'), routes });
}

describe('the header of the portal', () => {
  it('names whose information is shown, and offers the sections of the account', async () => {
    const app = open(
      signedInRoutes(undefined, { 'GET /api/portal/appointments': EMPTY_APPOINTMENTS }),
    );

    expect(await screen.findByText('Está viendo la información de')).toBeInTheDocument();
    expect(screen.getByText('Ana Pérez')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Secciones del portal' });
    for (const name of [
      'Turnos',
      'Documentos',
      'Consentimientos',
      'Recetas',
      'Facturas',
      'Mis datos',
      'Sesiones',
    ]) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('link', { name: 'Turnos' })).toHaveAttribute(
      'data-status',
      'active',
    );
    // One person, one record: nothing to switch.
    expect(screen.queryByRole('button', { name: 'Cambiar de persona' })).not.toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
    expect(await a11yViolations(app.container)).toEqual([]);
  });

  it('says that a representative sees the record as such', async () => {
    open(
      signedInRoutes(meOf([CHILD_LINK], CHILD_LINK.id), {
        'GET /api/portal/appointments': EMPTY_APPOINTMENTS,
      }),
    );

    expect(await screen.findByText('Beto Pérez')).toBeInTheDocument();
    expect(screen.getByText('Usted ve esta ficha como representante (Madre).')).toBeInTheDocument();
  });

  it('signs out and goes back to the sign-in', async () => {
    const user = userEvent.setup();
    let out = false;
    const app = open(
      signedInRoutes(undefined, {
        'GET /api/portal/me': () =>
          out
            ? problemResponse(401, 'unauthenticated')
            : jsonResponse(meOf([SELF_LINK], SELF_LINK.id)),
        'POST /api/portal/logout': () => {
          out = true;
          return new Response(null, { status: 204 });
        },
        'GET /api/portal/appointments': EMPTY_APPOINTMENTS,
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ingresar al portal de pacientes' }),
    ).toBeInTheDocument();
    expect(app.requests).toContain('POST /api/portal/logout');
  });

  it('sends a session that ended while the page was open back to the sign-in', async () => {
    let ended = false;
    const app = open(
      signedInRoutes(undefined, {
        'GET /api/portal/me': () =>
          ended
            ? problemResponse(401, 'unauthenticated')
            : jsonResponse(meOf([SELF_LINK], SELF_LINK.id)),
        'GET /api/portal/appointments': () => {
          ended = true;
          return problemResponse(401, 'unauthenticated');
        },
      }),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ingresar al portal de pacientes' }),
    ).toBeInTheDocument();
    expect(
      app.requests.filter((request) => request === 'GET /api/portal/me').length,
    ).toBeGreaterThan(1);
  });

  it('shows a calm error with a way to try again when the server fails', async () => {
    const user = userEvent.setup();
    let fails = true;
    open(
      signedInRoutes(undefined, {
        'GET /api/portal/me': () =>
          fails
            ? problemResponse(500, 'internal_error')
            : jsonResponse(meOf([SELF_LINK], SELF_LINK.id)),
        'GET /api/portal/appointments': EMPTY_APPOINTMENTS,
      }),
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fails = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('Ana Pérez')).toBeInTheDocument();
  });
});

describe('a person with several records', () => {
  const TWO = meOf([SELF_LINK, CHILD_LINK], null);

  it('picks one before anything is shown, and the header keeps naming it', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const app = open(
      signedInRoutes(TWO, {
        'POST /api/portal/subject': (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse(meOf([SELF_LINK, CHILD_LINK], CHILD_LINK.id));
        },
        'GET /api/portal/appointments': EMPTY_APPOINTMENTS,
      }),
    );

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: '¿De quién quiere ver la información?',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('navigation', { name: 'Secciones del portal' }),
    ).not.toBeInTheDocument();
    expect(app.requests).not.toContain('GET /api/portal/appointments');
    expect(await a11yViolations(app.container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: /Beto Pérez/ }));

    expect(await screen.findByText('Está viendo la información de')).toBeInTheDocument();
    expect(screen.getByText('Beto Pérez')).toBeInTheDocument();
    expect(bodies).toEqual([{ linkId: CHILD_LINK.id }]);
  });

  it('switches between the records from the header', async () => {
    const user = userEvent.setup();
    open(
      signedInRoutes(meOf([SELF_LINK, CHILD_LINK], SELF_LINK.id), {
        'POST /api/portal/subject': jsonResponse(meOf([SELF_LINK, CHILD_LINK], CHILD_LINK.id)),
        'GET /api/portal/appointments': EMPTY_APPOINTMENTS,
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Cambiar de persona' }));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: '¿De quién quiere ver la información?',
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Beto Pérez/ }));

    await waitFor(() => {
      expect(screen.getByText('Beto Pérez')).toBeInTheDocument();
    });
  });

  it('can leave the picker without choosing again', async () => {
    const user = userEvent.setup();
    open(
      signedInRoutes(meOf([SELF_LINK, CHILD_LINK], SELF_LINK.id), {
        'GET /api/portal/appointments': EMPTY_APPOINTMENTS,
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Cambiar de persona' }));

    await user.click(await screen.findByRole('button', { name: 'Volver' }));

    expect(await screen.findByText('Está viendo la información de')).toBeInTheDocument();
  });
});

describe('a record whose access is paused', () => {
  it('tells the representative why, and shows nothing of that person', async () => {
    const paused = { ...CHILD_LINK, status: 'suspended' as const };
    open(
      signedInRoutes(meOf([SELF_LINK, paused], SELF_LINK.id), {
        'GET /api/portal/appointments': EMPTY_APPOINTMENTS,
      }),
    );

    expect(
      await screen.findByText(/está en pausa porque esa persona llegó a la mayoría de edad/),
    ).toBeInTheDocument();
    expect(screen.getByText('Ana Pérez')).toBeInTheDocument();
  });

  it('explains that the account has nothing to show when every access is paused or ended', async () => {
    const paused = { ...CHILD_LINK, status: 'suspended' as const };
    open(signedInRoutes(meOf([paused], null)));

    expect(
      await screen.findByRole('heading', { name: 'Su cuenta no tiene fichas para mostrar' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
  });
});
