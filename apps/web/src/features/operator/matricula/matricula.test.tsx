import { screen, waitFor, within } from '@testing-library/react';
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

const SOUTH = { id: '0190a000-0000-7000-8000-0000000000a1', name: 'Consultorio Sur' };
const NORTH = { id: '0190a000-0000-7000-8000-0000000000a2', name: 'Centro Norte' };

const LUCIA = {
  tenant: SOUTH,
  professionalId: '0190a000-0000-7000-8000-0000000000b1',
  fullName: 'Lucía Paz',
  jurisdiction: 'AR-B',
  number: '12345',
  status: 'unverified',
  verifiedAt: null,
  note: null,
};
const BETO = {
  tenant: NORTH,
  professionalId: '0190a000-0000-7000-8000-0000000000b2',
  fullName: null,
  jurisdiction: 'AR-C',
  number: '90210',
  status: 'unverified',
  verifiedAt: null,
  note: 'Esperando respuesta del colegio.',
};
const DORA = {
  tenant: SOUTH,
  professionalId: '0190a000-0000-7000-8000-0000000000b3',
  fullName: 'Dora Vega',
  jurisdiction: 'AR-B',
  number: '55555',
  status: 'verified',
  verifiedAt: '2026-10-02T15:30:00.000Z',
  note: null,
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
      'GET /api/operator/matricula-queue': (url) => {
        urls.push(url);
        return jsonResponse({
          items: url.includes('status=verified') ? [DORA] : [LUCIA, BETO],
        });
      },
      ...routes,
    },
  });
  return { ...current, urls };
}

async function openQueue(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Matrículas' }));
  return screen.findByRole('tabpanel', { name: 'Matrículas' });
}

const rowOf = (panel: HTMLElement, text: string) =>
  within(within(panel).getByText(text).closest('tr') ?? panel);

describe('the matricula queue in the console', () => {
  it('lives next to the organizations, which stay the first thing the operator sees', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Organizaciones' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Organizaciones', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Matrículas' })).toBeInTheDocument();
  });

  it('lists what waits for a decision: who, where, which registration and any note', async () => {
    const user = userEvent.setup();
    const app = open();

    const panel = await openQueue(user);

    expect(
      within(panel).getByRole('heading', { level: 1, name: 'Verificación de matrículas' }),
    ).toBeInTheDocument();
    const lucia = rowOf(panel, 'Lucía Paz');
    expect(await within(panel).findByText('Lucía Paz')).toBeInTheDocument();
    expect(lucia.getByText('Consultorio Sur')).toBeInTheDocument();
    expect(lucia.getByText('AR-B')).toBeInTheDocument();
    expect(lucia.getByText('12345')).toBeInTheDocument();
    expect(lucia.getByText('Sin verificar')).toBeInTheDocument();
    expect(lucia.getByText('Sin nota')).toBeInTheDocument();
    // A profile with no name loaded says so, and the note travels with the row.
    const beto = rowOf(panel, 'Sin nombre cargado');
    expect(beto.getByText('Centro Norte')).toBeInTheDocument();
    expect(beto.getByText('Esperando respuesta del colegio.')).toBeInTheDocument();
    expect(new URL(app.urls[0] ?? '', 'http://x').searchParams.get('status')).toBe('unverified');
  });

  it('says in the page what verifying means and that it opens no clinical data', async () => {
    const user = userEvent.setup();
    open();

    const panel = await openQueue(user);

    expect(within(panel).getByText(/no da acceso a datos clínicos/)).toBeInTheDocument();
  });

  it('verifies the registration it showed, with the note, after confirming', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      [`POST /api/operator/tenants/${SOUTH.id}/professionals/${LUCIA.professionalId}/matricula/verify`]:
        (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ ...LUCIA, status: 'verified', verifiedAt: DORA.verifiedAt });
        },
    });

    const panel = await openQueue(user);
    await user.click(
      await within(panel).findByRole('button', { name: 'Verificar matrícula de Lucía Paz' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Verificar matrícula' });
    expect(within(dialog).getByText('Lucía Paz')).toBeInTheDocument();
    expect(within(dialog).getByText('Consultorio Sur')).toBeInTheDocument();
    expect(within(dialog).getByText('AR-B')).toBeInTheDocument();
    expect(within(dialog).getByText('12345')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Nota (opcional)'), 'Vigente en el colegio.');
    await user.click(within(dialog).getByRole('button', { name: 'Verificar matrícula' }));

    await waitFor(() => {
      expect(bodies).toEqual([
        { jurisdiction: 'AR-B', number: '12345', note: 'Vigente en el colegio.' },
      ]);
    });
  });

  it('sends no note when the field is left empty', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      [`POST /api/operator/tenants/${NORTH.id}/professionals/${BETO.professionalId}/matricula/verify`]:
        (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ ...BETO, status: 'verified', verifiedAt: DORA.verifiedAt });
        },
    });

    const panel = await openQueue(user);
    await user.click(
      await within(panel).findByRole('button', {
        name: 'Verificar matrícula de Sin nombre cargado',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Verificar matrícula' });
    await user.click(within(dialog).getByRole('button', { name: 'Verificar matrícula' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ jurisdiction: 'AR-C', number: '90210' }]);
    });
  });

  it('explains that the registration changed when the server refuses to verify it', async () => {
    const user = userEvent.setup();
    open({
      [`POST /api/operator/tenants/${SOUTH.id}/professionals/${LUCIA.professionalId}/matricula/verify`]:
        () => problemResponse(409, 'conflict'),
    });

    const panel = await openQueue(user);
    await user.click(
      await within(panel).findByRole('button', { name: 'Verificar matrícula de Lucía Paz' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Verificar matrícula' });
    await user.click(within(dialog).getByRole('button', { name: 'Verificar matrícula' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'La matrícula cambió desde que se cargó la lista',
    );
  });

  it('lists the verified ones on request, with the day, and withdraws a verification', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const app = open({
      [`POST /api/operator/tenants/${SOUTH.id}/professionals/${DORA.professionalId}/matricula/unverify`]:
        (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ ...DORA, status: 'unverified', verifiedAt: null });
        },
    });

    const panel = await openQueue(user);
    await within(panel).findByText('Lucía Paz');
    await user.click(within(panel).getByRole('button', { name: 'Verificadas' }));

    const dora = rowOf(panel, 'Dora Vega');
    expect(await within(panel).findByText('Dora Vega')).toBeInTheDocument();
    expect(dora.getByText('Verificada')).toBeInTheDocument();
    expect(dora.getByText(/02\/10\/2026/)).toBeInTheDocument();
    expect(app.urls.some((url) => url.includes('status=verified'))).toBe(true);

    await user.click(
      within(panel).getByRole('button', { name: 'Retirar la verificación de Dora Vega' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('no podrá emitir recetas');
    await user.type(within(dialog).getByLabelText('Nota (opcional)'), 'Suspendida por el colegio.');
    await user.click(within(dialog).getByRole('button', { name: 'Retirar verificación' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ note: 'Suspendida por el colegio.' }]);
    });
  });

  it('saves the note on its own, starting from the one already there', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    open({
      [`PUT /api/operator/tenants/${NORTH.id}/professionals/${BETO.professionalId}/matricula/note`]:
        (_url, init) => {
          bodies.push(jsonBody(init));
          return jsonResponse({ ...BETO, note: 'El colegio confirmó por teléfono.' });
        },
    });

    const panel = await openQueue(user);
    await user.click(
      await within(panel).findByRole('button', { name: 'Editar la nota de Sin nombre cargado' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Nota de la matrícula' });
    const field = within(dialog).getByLabelText('Nota');
    expect(field).toHaveValue('Esperando respuesta del colegio.');
    await user.clear(field);
    await user.type(field, 'El colegio confirmó por teléfono.');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar nota' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ note: 'El colegio confirmó por teléfono.' }]);
    });
  });

  it('shows an empty state when nothing waits, and for the verified list when none is verified', async () => {
    const user = userEvent.setup();
    open({
      'GET /api/operator/matricula-queue': () => jsonResponse({ items: [] }),
    });

    const panel = await openQueue(user);
    expect(await within(panel).findByText('No hay matrículas pendientes')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Verificadas' }));

    expect(
      await within(panel).findByText('Todavía no hay matrículas verificadas'),
    ).toBeInTheDocument();
  });

  it('is accessible', async () => {
    const user = userEvent.setup();
    const { container } = open();

    const panel = await openQueue(user);
    await within(panel).findByText('Lucía Paz');

    expect(await a11yViolations(container)).toEqual([]);
  });
});
