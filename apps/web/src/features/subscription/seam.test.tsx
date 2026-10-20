import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { defaultRegistry } from '../../app/registry.js';
import { bootFor, meFor } from '../../shared/test/fixtures.js';
import { renderApp } from '../../shared/test/render-app.js';
import { jsonResponse } from '../../shared/test/render.js';

const routes = {
  'GET /api/worklist/count': () => jsonResponse({ open: 0 }),
};
const multi = bootFor('Centro Médico Aillu');
const single = bootFor('Centro Médico Aillu', { deploymentMode: 'single' });

describe('the subscription registrations (route and navigation entry)', () => {
  it('opens /subscription for the owner, who holds billing.manage', async () => {
    renderApp({ me: meFor(['owner']), boot: multi, path: '/subscription', routes });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Suscripción' }),
    ).toBeInTheDocument();
  });

  it.each([['admin'], ['professional'], ['reception']] as const)(
    'shows the no-access screen to %s, which never sees billing',
    async (role) => {
      renderApp({ me: meFor([role]), boot: multi, path: '/subscription', routes });

      expect(await screen.findByText('No tiene acceso a esta sección')).toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Suscripción' }),
      ).not.toBeInTheDocument();
    },
  );

  it('lists the entry in the navigation of the owner, pointing at the route', async () => {
    renderApp({ me: meFor(['owner']), boot: multi, path: '/', routes });

    const links = await screen.findAllByRole('link', { name: 'Suscripción' });
    expect(links.map((link) => link.getAttribute('href'))).toContain('/subscription');
  });

  it.each([['admin'], ['professional'], ['reception']] as const)(
    'does not list the entry for %s',
    async (role) => {
      renderApp({ me: meFor([role]), boot: multi, path: '/calendar', routes });

      await screen.findAllByRole('navigation');
      expect(screen.queryByRole('link', { name: 'Suscripción' })).not.toBeInTheDocument();
    },
  );

  it('does not exist in a single-tenant deployment: no entry for the owner, and the address is not found', async () => {
    renderApp({ me: meFor(['owner']), boot: single, path: '/', routes });

    await screen.findAllByRole('navigation');
    expect(screen.queryByRole('link', { name: 'Suscripción' })).not.toBeInTheDocument();
  });

  it('answers a single-tenant deployment with the screen of an address that does not exist', async () => {
    renderApp({ me: meFor(['owner']), boot: single, path: '/subscription', routes });

    expect(await screen.findByText('No encontramos esta página')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Suscripción' }),
    ).not.toBeInTheDocument();
  });

  it('registers the route in the authed mount and the entry for the owner layout only', () => {
    const registry = defaultRegistry();

    expect(registry.routes.some((route) => route.mount === 'authed')).toBe(true);
    const entry = registry.navItems.find((item) => item.id === 'subscription');
    expect(entry).toMatchObject({
      to: '/subscription',
      anyOf: ['billing.manage'],
      multiModeOnly: true,
    });
    expect(entry?.placements.map((placement) => placement.layout)).toEqual(['admin']);
  });
});
