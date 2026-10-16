import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

import { createI18n } from '../../app/i18n.js';
import { AppProviders } from '../../app/providers.js';
import { createAppServices, type AppServices } from '../../app/services.js';

/** The URL of whatever `fetch` was called with. */
export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A `fetch` for tests: routes by "METHOD /api/path"; anything unhandled is a loud failure. */
export function fakeFetch(routes: Record<string, FetchHandler | Response>): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0] ?? url;
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${url}`];
    if (!handler) {
      return Promise.reject(new Error(`Unhandled request in test: ${method} ${url}`));
    }
    return Promise.resolve(
      handler instanceof Response ? handler.clone() : handler(url, init ?? {}),
    );
  };
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const problemResponse = (status: number, code: string, requestId = 'req-test') =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: code,
      status,
      code,
      i18nKey: `errors.${code}`,
      requestId,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

export interface RenderOptions {
  fetch?: typeof fetch;
  services?: AppServices;
}

export interface AppRenderResult extends RenderResult {
  services: AppServices;
  missingKeys: string[];
}

/**
 * Renders inside the real providers with a fake network. A message key without a translation is
 * collected so a test can assert there is none, instead of silently showing a raw key.
 */
export function renderWithApp(ui: ReactElement, options: RenderOptions = {}): AppRenderResult {
  const missingKeys: string[] = [];
  const i18n = createI18n({
    onMissing: (key) => {
      missingKeys.push(key);
    },
  });
  const services =
    options.services ??
    createAppServices({
      fetch: options.fetch ?? fakeFetch({}),
      isOnline: () => true,
    });
  const result = render(
    <AppProviders services={services} i18n={i18n}>
      {ui}
    </AppProviders>,
  );
  return Object.assign(result, { services, missingKeys });
}
