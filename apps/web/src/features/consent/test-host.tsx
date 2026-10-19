import { createRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { createRegistry, type FeatureRoute } from '../../app/registry.js';
import { renderApp, type RenderAppOptions } from '../../shared/test/render-app.js';

/**
 * Renders a piece of the consent feature inside the signed-in application, the way a screen of
 * another feature mounts it (the pieces read the profile of the user, which only the signed-in
 * layout loads). The piece is the whole content of `/fixture-host`.
 */
export function renderHosted(
  ui: ReactElement,
  options: Omit<RenderAppOptions, 'path' | 'registry'>,
) {
  const host: FeatureRoute = {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/fixture-host',
        component: () => ui,
      }),
  };
  return renderApp({
    ...options,
    path: '/fixture-host',
    registry: createRegistry({
      routes: { '../features/host/routes.tsx': { default: [host] } },
      nav: {},
      slots: {},
    }),
  });
}
