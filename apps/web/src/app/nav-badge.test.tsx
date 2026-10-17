import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bootFor, meFor } from '../shared/test/fixtures.js';
import { renderApp } from '../shared/test/render-app.js';
import { jsonResponse } from '../shared/test/render.js';

function open(openCount: number, roles: Parameters<typeof meFor>[0] = ['reception']) {
  return renderApp({
    me: meFor(roles),
    path: '/',
    boot: bootFor('Centro Médico Aillu'),
    routes: {
      'GET /api/worklist': () => jsonResponse({ items: [], openCount }),
      'GET /api/patients': () => jsonResponse({ patients: [], nextCursor: null }),
    },
  });
}

async function worklistLink() {
  const nav = await screen.findByRole('navigation', { name: 'Navegación principal' });
  return within(nav).findByRole('link', { name: /Pendientes/ });
}

describe('the badge of the worklist in the navigation', () => {
  it('says how many items are open, in words for a screen reader', async () => {
    open(3);

    const link = await worklistLink();

    await waitFor(() => {
      expect(link).toHaveAccessibleName('Pendientes, 3 abiertos');
    });
    expect(within(link).getByText('3')).toBeInTheDocument();
  });

  it('speaks in the singular for one item', async () => {
    open(1);

    await waitFor(async () => {
      expect(await worklistLink()).toHaveAccessibleName('Pendientes, 1 abierto');
    });
  });

  it('shows nothing when there is nothing to do', async () => {
    const app = open(0);

    const link = await worklistLink();
    await waitFor(() => {
      expect(app.requests).toContain('GET /api/worklist');
    });

    expect(link).toHaveAccessibleName('Pendientes');
  });

  it('caps a long queue so the badge keeps its size', async () => {
    open(120);

    const link = await worklistLink();

    await waitFor(() => {
      expect(within(link).getByText('99+')).toBeInTheDocument();
    });
    expect(link).toHaveAccessibleName('Pendientes, 120 abiertos');
  });

  it('is not requested by somebody who does not work the worklist', async () => {
    const app = open(5, ['professional']);
    await screen.findByRole('navigation', { name: 'Navegación principal' });

    expect(app.requests.filter((request) => request.includes('/worklist'))).toEqual([]);
  });
});
