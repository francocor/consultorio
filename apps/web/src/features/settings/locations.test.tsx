import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';
import { IDS, LOCATIONS } from '../staff/fixtures.js';

const INACTIVE = {
  id: '0190a000-0000-7000-8000-0000000000c9',
  name: 'Sucursal Rosario',
  timeZone: 'America/Argentina/Cordoba',
  active: false,
};

type Handler = (url: string, init: RequestInit) => Response;

function open(
  routes: Record<string, Handler> = {},
  me = meFor(['owner']),
  path = '/settings/locations',
) {
  return renderApp({
    me,
    path,
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/locations': (url) =>
        jsonResponse({
          locations: url.includes('includeInactive=true') ? [...LOCATIONS, INACTIVE] : LOCATIONS,
        }),
      ...routes,
    },
  });
}

describe('settings area', () => {
  it('opens on the first section the role may use', async () => {
    const app = open({}, meFor(['owner']), '/settings');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Configuración' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe('/settings/locations');
    });
  });

  it('shows only the sections of the permissions the person has', async () => {
    open({}, meFor(['admin']));

    const nav = await screen.findByRole('navigation', { name: 'Secciones de configuración' });
    expect(within(nav).getByRole('link', { name: 'Sedes' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Identidad visual' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Seguridad' })).toBeInTheDocument();
  });

  it('a person who can only manage locations does not see the other sections', async () => {
    open(
      {},
      meFor(['reception'], {
        grants: [],
        permissions: ['locations.manage', 'staff.directory.read'],
      }),
    );

    const nav = await screen.findByRole('navigation', { name: 'Secciones de configuración' });
    expect(within(nav).getByRole('link', { name: 'Sedes' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Seguridad' })).not.toBeInTheDocument();
  });

  it('a role with no setting at all sees "no access"', async () => {
    open({}, meFor(['reception']), '/settings/locations');

    expect(
      await screen.findByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
  });
});

describe('locations', () => {
  it('lists the locations with their time zone', async () => {
    const app = open();

    expect(await screen.findByRole('heading', { name: 'Sedes' })).toBeInTheDocument();
    expect(await screen.findByText('2 sedes')).toBeInTheDocument();
    const central = screen.getByText('Sede Central').closest('li');
    expect(within(central as HTMLElement).getByText(/Buenos Aires/)).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('creates a location with a name and a time zone', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      'POST /api/locations': (_url, init) => {
        body = jsonBody(init);
        return jsonResponse(
          {
            id: IDS.norte,
            name: 'Sede Mendoza',
            timeZone: 'America/Argentina/Mendoza',
            active: true,
          },
          201,
        );
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Agregar sede' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar una sede' });

    await user.type(within(dialog).getByLabelText('Nombre de la sede'), 'Sede Mendoza');
    await user.selectOptions(
      within(dialog).getByLabelText('Zona horaria'),
      'America/Argentina/Mendoza',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Crear sede' }));

    await waitFor(() => {
      expect(body).toEqual({ name: 'Sede Mendoza', timeZone: 'America/Argentina/Mendoza' });
    });
    expect(await screen.findByText('Sede creada.')).toBeInTheDocument();
  });

  it('asks for a name', async () => {
    const user = userEvent.setup();
    const app = open();
    await user.click(await screen.findByRole('button', { name: 'Agregar sede' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Crear sede' }));

    expect(await within(dialog).findByText('Este dato es obligatorio.')).toBeInTheDocument();
    expect(app.requests).not.toContain('POST /api/locations');
  });

  it('edits the name of a location', async () => {
    const user = userEvent.setup();
    let body: unknown;
    open({
      [`PATCH /api/locations/${IDS.central}`]: (_url, init) => {
        body = jsonBody(init);
        return jsonResponse({ ...LOCATIONS[0], name: 'Casa Central' });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Editar Sede Central' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar la sede' });

    const name = within(dialog).getByLabelText('Nombre de la sede');
    await user.clear(name);
    await user.type(name, 'Casa Central');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar sede' }));

    await waitFor(() => {
      expect(body).toEqual({ name: 'Casa Central', timeZone: 'America/Argentina/Buenos_Aires' });
    });
    expect(await screen.findByText('Sede actualizada.')).toBeInTheDocument();
  });

  it('deactivates after confirming, and can show and reactivate inactive ones', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      [`POST /api/locations/${IDS.norte}/deactivate`]: () => {
        calls.push('deactivate');
        return jsonResponse({ ...LOCATIONS[1], active: false });
      },
      [`POST /api/locations/${INACTIVE.id}/reactivate`]: () => {
        calls.push('reactivate');
        return jsonResponse({ ...INACTIVE, active: true });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Desactivar Consultorios Norte' }));
    const confirmation = await screen.findByRole('alertdialog', {
      name: '¿Desactivar Consultorios Norte?',
    });
    await user.click(within(confirmation).getByRole('button', { name: 'Desactivar sede' }));
    await waitFor(() => {
      expect(calls).toEqual(['deactivate']);
    });

    await user.click(await screen.findByRole('switch', { name: 'Mostrar sedes desactivadas' }));
    const former = (await screen.findByText('Sucursal Rosario')).closest('li');
    expect(within(former as HTMLElement).getByText('Desactivada')).toBeInTheDocument();
    await user.click(
      within(former as HTMLElement).getByRole('button', { name: 'Reactivar Sucursal Rosario' }),
    );

    await waitFor(() => {
      expect(calls).toEqual(['deactivate', 'reactivate']);
    });
  });

  it('has an empty state and a retryable error', async () => {
    const user = userEvent.setup();
    let fail = true;
    open({
      'GET /api/locations': () =>
        fail ? problemResponse(500, 'internal_error') : jsonResponse({ locations: [] }),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Código de referencia');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(
      await screen.findByRole('heading', { name: 'Todavía no hay sedes' }),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const app = open();
    await screen.findByText('2 sedes');

    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
