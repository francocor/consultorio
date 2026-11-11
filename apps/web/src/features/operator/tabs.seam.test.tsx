import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse, problemResponse } from '../../shared/test/render.js';

const OPERATOR = {
  id: '0190a000-0000-7000-8000-000000000001',
  email: 'ops@platform.example',
  displayName: 'Ops',
};

function open() {
  return renderApp({
    platform: true,
    path: '/',
    routes: {
      'GET /api/operator/me': () => jsonResponse(OPERATOR),
      'GET /api/operator/tenants': () => jsonResponse({ tenants: [] }),
      'GET /api/operator/archives': () => jsonResponse({ archives: [] }),
      'GET /api/operator/archive-releases': () => jsonResponse({ requests: [] }),
      'GET /api/operator/dev/providers': () => problemResponse(404, 'not_found'),
    },
  });
}

describe('the operator console tabs of Stage 6', () => {
  it('offers the subscriptions and the archive next to the other sections', async () => {
    open();

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Organizaciones',
      'Feriados',
      'Matrículas',
      'Suscripciones',
      'Archivo',
    ]);
  });

  it('opens the subscriptions tab with its own heading, and the archive tab with its own', async () => {
    const user = userEvent.setup();
    open();

    await user.click(await screen.findByRole('tab', { name: 'Suscripciones' }));
    expect(
      await screen.findByRole('heading', { name: 'Suscripciones de las organizaciones' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Archivo' }));
    expect(
      await screen.findByRole('heading', { name: 'Archivo de organizaciones canceladas' }),
    ).toBeInTheDocument();
  });
});
