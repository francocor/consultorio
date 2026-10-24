import type { BootPayload, MeResponse } from '@consultorio/contracts';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

import { createI18n } from '../../app/i18n.js';
import { AppProviders } from '../../app/providers.js';
import type { AppRegistry } from '../../app/registry.js';
import {
  createAppRouter,
  createOperatorRouter,
  type AppRouter,
  type LoadCatalogs,
  type OperatorRouter,
} from '../../app/router.js';
import { createAppServices, type AppServices } from '../../app/services.js';
import { LOCALE_RESOURCES } from '../lib/locale-all.js';

import { bootFor } from './fixtures.js';
import { jsonResponse, problemResponse, urlOf, type FetchHandler } from './render.js';

export interface RenderAppOptions {
  /** The signed-in user; `null` answers 401 to `/auth/me`. */
  me?: MeResponse | null;
  boot?: BootPayload;
  path?: string;
  /** Render the platform operator console instead of an organization's app. */
  platform?: boolean;
  /** Replaces what the features contribute (fixture features). */
  registry?: AppRegistry;
  /** What loads the catalogs of the screens, like the application does; missing means they are all in hand. */
  catalogs?: LoadCatalogs;
  /** Extra API routes, keyed "METHOD /api/path". */
  routes?: Record<string, FetchHandler | Response>;
}

export interface RenderedApp extends ReturnType<typeof render> {
  services: AppServices;
  router: AppRouter | OperatorRouter;
  /** Every request the app made, as "METHOD /api/path" without the query string. */
  requests: string[];
  missingKeys: string[];
}

function createRecordingFetch(
  routes: Record<string, FetchHandler | Response>,
  requests: string[],
): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0] ?? url;
    requests.push(`${method} ${path}`);
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${url}`];
    if (!handler) return Promise.reject(new Error(`Unhandled request in test: ${method} ${url}`));
    return Promise.resolve(
      handler instanceof Response ? handler.clone() : handler(url, init ?? {}),
    );
  };
}

function defaultRoutes(options: RenderAppOptions): Record<string, FetchHandler | Response> {
  return {
    'GET /api/public/boot': jsonResponse(options.boot ?? bootFor()),
    'GET /api/auth/me': options.me
      ? jsonResponse(options.me)
      : problemResponse(401, 'unauthenticated'),
    'POST /api/auth/logout': new Response(null, { status: 204 }),
    ...options.routes,
  };
}

function setup(options: RenderAppOptions) {
  const requests: string[] = [];
  const missingKeys: string[] = [];
  const services = createAppServices({
    ...(options.registry ? { registry: options.registry } : {}),
    fetch: createRecordingFetch(defaultRoutes(options), requests),
    isOnline: () => true,
    retry: () => false,
  });
  const i18n = createI18n({
    resources: LOCALE_RESOURCES,
    onMissing: (key) => {
      missingKeys.push(key);
    },
  });
  return { services, i18n, requests, missingKeys };
}

/** Renders the whole application (providers, router, shell) with a fake network. */
export function renderApp(options: RenderAppOptions = {}): RenderedApp {
  const { services, i18n, requests, missingKeys } = setup(options);
  const history = createMemoryHistory({ initialEntries: [options.path ?? '/'] });
  const catalogs = options.catalogs ? { catalogs: options.catalogs } : {};
  const router = options.platform
    ? createOperatorRouter({ services, history, ...catalogs })
    : createAppRouter({ services, history, ...catalogs });
  const result = render(
    <AppProviders services={services} i18n={i18n}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return Object.assign(result, { services, router, requests, missingKeys });
}

/** Renders one component as the only page of a router, so its links and navigation work. */
export function renderInRouter(ui: ReactElement, options: RenderAppOptions = {}) {
  const { services, i18n, requests, missingKeys } = setup(options);
  const root = createRootRoute();
  const index = createRoute({ getParentRoute: () => root, path: '/', component: () => ui });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const result = render(
    <AppProviders services={services} i18n={i18n}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return Object.assign(result, { services, requests, missingKeys });
}
