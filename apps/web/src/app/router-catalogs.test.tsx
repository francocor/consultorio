import { createRoute } from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { bootFor, meFor } from '../shared/test/fixtures.js';
import { renderApp } from '../shared/test/render-app.js';

import { createRegistry, type AppRegistry, type FeatureRoute } from './registry.js';

/**
 * The sign-in page is the page the performance budget measures, so it must not wait for anything a
 * visitor who is not signed in will never see: the catalogs of the features, and the navigation and
 * slots they contribute. Every other frame waits for them before it draws, so no screen ever shows a
 * message key instead of its text.
 */

const page = (mount: FeatureRoute['mount'], path: string, text: string): FeatureRoute => ({
  mount,
  create: (parent) =>
    createRoute({ getParentRoute: () => parent, path, component: () => <p>{text}</p> }),
});

function fixtureRegistry(): { registry: AppRegistry; ready: ReturnType<typeof vi.fn> } {
  const eager = createRegistry({
    routes: {
      '../features/fixture/routes.tsx': {
        default: [
          page('authed', '/fixture-authed', 'Fixture signed-in screen'),
          page('minimal', '/fixture-public', 'Fixture public page'),
          page('portal', '/fixture-portal', 'Fixture portal page'),
          page('platform', '/fixture-platform', 'Fixture platform page'),
        ],
      },
    },
    nav: {},
    slots: {},
  });
  const ready = vi.fn(() => Promise.resolve());
  return { registry: { ...eager, ready }, ready };
}

/** A load that stays pending until the test lets it through. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const catalogs = vi.fn(() => opened);
  return { catalogs, open };
}

describe('the catalogs and the contributions of the features', () => {
  it('are not waited for by the sign-in page', async () => {
    const { registry, ready } = fixtureRegistry();
    const { catalogs } = gate();

    renderApp({ me: null, boot: bootFor(), path: '/login', registry, catalogs });

    expect(await screen.findByRole('button', { name: 'Ingresar' })).toBeInTheDocument();
    expect(catalogs).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it('are not downloaded for a visitor without a session who is sent to sign-in', async () => {
    const { registry, ready } = fixtureRegistry();
    const { catalogs } = gate();

    renderApp({ me: null, boot: bootFor(), path: '/fixture-authed', registry, catalogs });

    expect(await screen.findByRole('button', { name: 'Ingresar' })).toBeInTheDocument();
    expect(catalogs).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it('are waited for by the signed-in screens before they draw', async () => {
    const { registry, ready } = fixtureRegistry();
    const { catalogs, open } = gate();

    renderApp({
      me: meFor(['owner']),
      boot: bootFor(),
      path: '/fixture-authed',
      registry,
      catalogs,
    });

    await waitFor(() => {
      expect(catalogs).toHaveBeenCalled();
    });
    expect(ready).toHaveBeenCalled();
    expect(screen.queryByText('Fixture signed-in screen')).not.toBeInTheDocument();

    open();

    expect(await screen.findByText('Fixture signed-in screen')).toBeInTheDocument();
  });

  it.each([
    ['the public pages', '/fixture-public', 'Fixture public page'],
    ['the patient portal', '/fixture-portal', 'Fixture portal page'],
  ])('are waited for by %s before they draw', async (_name, path, text) => {
    const { registry } = fixtureRegistry();
    const { catalogs, open } = gate();

    renderApp({ me: null, boot: bootFor(), path, registry, catalogs });

    await waitFor(() => {
      expect(catalogs).toHaveBeenCalled();
    });
    expect(screen.queryByText(text)).not.toBeInTheDocument();

    open();

    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('are waited for by the pages of the platform host before they draw', async () => {
    const { registry } = fixtureRegistry();
    const { catalogs, open } = gate();

    renderApp({
      me: null,
      boot: bootFor(),
      path: '/fixture-platform',
      platform: true,
      registry,
      catalogs,
    });

    await waitFor(() => {
      expect(catalogs).toHaveBeenCalled();
    });
    expect(screen.queryByText('Fixture platform page')).not.toBeInTheDocument();

    open();

    expect(await screen.findByText('Fixture platform page')).toBeInTheDocument();
  });
});
