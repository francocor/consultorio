import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../shared/test/a11y.js';
import { renderApp, type RenderedApp } from '../../../shared/test/render-app.js';
import {
  jsonBody,
  jsonResponse,
  problemResponse,
  type FetchHandler,
} from '../../../shared/test/render.js';

const OPERATOR = {
  id: '0190a000-0000-7000-8000-0000000000c1',
  email: 'operador@demo.invalid',
  displayName: 'Operador de la plataforma',
};

const YEAR = new Date().getFullYear();
const CHRISTMAS = {
  id: '0190a000-0000-7000-8000-0000000000e1',
  country: 'AR',
  date: `${String(YEAR)}-12-25`,
  name: 'Navidad',
  kind: 'national',
};
const BRIDGE = {
  id: '0190a000-0000-7000-8000-0000000000e2',
  country: 'AR',
  date: `${String(YEAR)}-12-07`,
  name: 'Día no laborable con fines turísticos',
  kind: 'bridge',
};

let current: RenderedApp | undefined;
afterEach(() => {
  expect(current?.missingKeys ?? []).toEqual([]);
  current = undefined;
});

function open(routes: Record<string, FetchHandler | Response> = {}) {
  const urls: string[] = [];
  current = renderApp({
    platform: true,
    me: null,
    path: '/',
    routes: {
      'GET /api/operator/me': () => jsonResponse(OPERATOR),
      'GET /api/operator/tenants': () => jsonResponse({ tenants: [] }),
      'GET /api/operator/holidays': (url) => {
        urls.push(url);
        return jsonResponse({ holidays: [CHRISTMAS, BRIDGE] });
      },
      ...routes,
    },
  });
  return { ...current, urls };
}

async function openCatalog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Feriados' }));
  return screen.findByRole('tabpanel', { name: 'Feriados' });
}

describe('the holiday catalog in the console', () => {
  it('lives next to the organizations, which stay the first thing the operator sees', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Organizaciones' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Organizaciones', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Feriados' })).toBeInTheDocument();
  });

  it('lists the holidays of the country and year, each with its kind in words', async () => {
    const user = userEvent.setup();
    const app = open();

    const panel = await openCatalog(user);

    const christmas = within(
      (await within(panel).findByText('Navidad')).closest('tr') as HTMLElement,
    );
    expect(christmas.getByText('Feriado nacional')).toBeInTheDocument();
    expect(christmas.getByText(`25/12/${String(YEAR)}`)).toBeInTheDocument();
    expect(
      within(
        within(panel)
          .getByText('Día no laborable con fines turísticos')
          .closest('tr') as HTMLElement,
      ).getByText('Día puente'),
    ).toBeInTheDocument();
    const query = new URL(app.urls[0] ?? '', 'http://x').searchParams;
    expect(query.get('country')).toBe('AR');
    expect(query.get('year')).toBe(String(YEAR));
  });

  it('says that a change reaches every organization without a release', async () => {
    const user = userEvent.setup();
    open();

    const panel = await openCatalog(user);

    expect(within(panel).getByText(/sin esperar una versión nueva/)).toBeInTheDocument();
  });

  it('adds a holiday', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      'POST /api/operator/holidays': (_url, init) => {
        bodies.push(jsonBody(init));
        return jsonResponse(
          { ...CHRISTMAS, id: '0190a000-0000-7000-8000-0000000000e9', name: 'Traslado' },
          201,
        );
      },
    });

    const panel = await openCatalog(user);
    await user.click(await within(panel).findByRole('button', { name: 'Agregar feriado' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar feriado' });
    fireEvent.change(within(dialog).getByLabelText('Fecha'), {
      target: { value: `${String(YEAR)}-08-17` },
    });
    await user.type(within(dialog).getByLabelText('Nombre'), 'Traslado');
    await user.selectOptions(within(dialog).getByLabelText('Tipo'), 'bridge');
    await user.click(within(dialog).getByRole('button', { name: 'Agregar' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        { country: 'AR', date: `${String(YEAR)}-08-17`, name: 'Traslado', kind: 'bridge' },
      ]);
    });
  });

  it('removes a holiday after confirming', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    open({
      [`DELETE /api/operator/holidays/${BRIDGE.id}`]: () => {
        calls.push('removed');
        return new Response(null, { status: 204 });
      },
    });

    const panel = await openCatalog(user);
    await user.click(
      await within(panel).findByRole('button', {
        name: 'Quitar Día no laborable con fines turísticos',
      }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Quitar feriado',
      }),
    );

    await waitFor(() => {
      expect(calls).toEqual(['removed']);
    });
  });

  it('looks at another year', async () => {
    const user = userEvent.setup();
    const app = open();

    const panel = await openCatalog(user);
    await within(panel).findByText('Navidad');
    await user.click(within(panel).getByRole('button', { name: 'Año siguiente' }));

    await waitFor(() => {
      expect(app.urls.some((url) => url.includes(`year=${String(YEAR + 1)}`))).toBe(true);
    });
  });

  it('shows what the server refused', async () => {
    const user = userEvent.setup();
    open({ 'POST /api/operator/holidays': () => problemResponse(409, 'conflict') });

    const panel = await openCatalog(user);
    await user.click(await within(panel).findByRole('button', { name: 'Agregar feriado' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agregar feriado' });
    fireEvent.change(within(dialog).getByLabelText('Fecha'), {
      target: { value: `${String(YEAR)}-12-25` },
    });
    await user.type(within(dialog).getByLabelText('Nombre'), 'Navidad');
    await user.click(within(dialog).getByRole('button', { name: 'Agregar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('entra en conflicto');
  });

  it('is accessible', async () => {
    const user = userEvent.setup();
    const { container } = open();

    const panel = await openCatalog(user);
    await within(panel).findByText('Navidad');

    expect(await a11yViolations(container)).toEqual([]);
  });
});
