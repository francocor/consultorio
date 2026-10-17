import { createRoute } from '@tanstack/react-router';
import { screen, within } from '@testing-library/react';
import { Users } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { bootFor, meFor } from '../shared/test/fixtures.js';
import { renderApp } from '../shared/test/render-app.js';
import { jsonResponse } from '../shared/test/render.js';

import { guardedScreen } from './guards.js';
import { createRegistry, type FeatureRoute } from './registry.js';

/**
 * Two fixture features, written the way a real one is, mounted through the registry only: the
 * router, the navigation and the Settings frame know nothing about them.
 */
const bookingRoutes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/fixture-links',
        component: guardedScreen(['booking.manage'], () => <p>Fixture links screen</p>),
      }),
  },
];

const messagingRoutes: readonly FeatureRoute[] = [
  {
    mount: 'settings',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/fixture-messaging',
        component: () => <p>Fixture messaging settings</p>,
      }),
  },
];

const publicRoutes: readonly FeatureRoute[] = [
  {
    mount: 'minimal',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/fixture-public',
        component: () => <p>Fixture public page</p>,
      }),
  },
];

const registry = createRegistry({
  routes: {
    '../features/links/routes.tsx': { default: bookingRoutes },
    '../features/messaging/routes.tsx': { default: messagingRoutes },
    '../features/public/routes.tsx': { default: publicRoutes },
  },
  nav: {
    '../features/links/nav.ts': {
      default: {
        items: [
          {
            id: 'fixture-links',
            to: '/fixture-links',
            labelKey: 'staff:title',
            icon: Users,
            anyOf: ['booking.manage'],
            placements: [{ layout: 'admin', after: 'worklist' }],
          },
        ],
      },
    },
    '../features/messaging/nav.ts': {
      default: {
        settingsTabs: [
          {
            id: 'fixture-messaging',
            to: '/settings/fixture-messaging',
            labelKey: 'settings:tab.branding',
            permission: 'tenant.settings.manage',
          },
        ],
      },
    },
  },
  slots: {},
});

const boot = bootFor('Centro Médico Aillu');
const routes = { 'GET /api/worklist/count': () => jsonResponse({ open: 0 }) };

describe('features that register through routes.tsx and nav.ts', () => {
  it('mounts a route inside the signed-in shell, for the permission the feature asks for', async () => {
    renderApp({ me: meFor(['owner']), boot, path: '/fixture-links', registry, routes });

    expect(await screen.findByText('Fixture links screen')).toBeInTheDocument();
    // The shell around it is the real one.
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
  });

  it('shows the no-access screen, not the contributed one, to a user without the permission', async () => {
    renderApp({ me: meFor(['reception']), boot, path: '/fixture-links', registry, routes });

    expect(await screen.findByText('No tiene acceso a esta sección')).toBeInTheDocument();
    expect(screen.queryByText('Fixture links screen')).not.toBeInTheDocument();
  });

  it('offers the navigation entry only to the roles whose layout places it and who hold the permission', async () => {
    const owner = renderApp({
      me: meFor(['owner']),
      boot,
      path: '/fixture-links',
      registry,
      routes,
    });
    const ownerLinks = await screen.findAllByRole('link', { name: 'Equipo' });
    expect(ownerLinks.map((link) => link.getAttribute('href'))).toContain('/fixture-links');
    owner.unmount();

    renderApp({ me: meFor(['reception']), boot, path: '/', registry, routes });
    await screen.findAllByRole('navigation');
    expect(
      screen
        .queryAllByRole('link')
        .filter((link) => link.getAttribute('href') === '/fixture-links'),
    ).toEqual([]);
  });

  it('mounts a settings section under /settings and lists it as a tab', async () => {
    renderApp({
      me: meFor(['owner']),
      boot,
      path: '/settings/fixture-messaging',
      registry,
      routes,
    });

    expect(await screen.findByText('Fixture messaging settings')).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Secciones de configuración' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toContain('/settings/fixture-messaging');
  });

  it('mounts a public route in the minimal frame, without the staff shell', async () => {
    renderApp({ me: null, boot, path: '/fixture-public', registry, routes });

    expect(await screen.findByText('Fixture public page')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('keeps an address nobody registered as not found', async () => {
    renderApp({ me: meFor(['owner']), boot, path: '/nothing-here', registry, routes });

    expect(await screen.findByText('No encontramos esta página')).toBeInTheDocument();
    expect(screen.queryByText('Fixture links screen')).not.toBeInTheDocument();
  });
});
