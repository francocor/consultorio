import { randomBytes } from 'node:crypto';

import { ROUTE_CATEGORIES } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createOperatorSecrets } from '../../src/modules/operator/index.js';
import { createRuntimeDb } from '../../src/platform/db/pool.js';
import type { DevProvider } from '../../src/platform/local-providers/dev-routes.js';
import { buildTestApplication } from '../support/app.js';

/**
 * The simulator console exists only when LOCAL_PROVIDERS_CONSOLE is on. This is the route
 * enumeration of the real application in both modes: with the console off there is not one
 * `/operator/dev/*` route (not even one that answers 403), with it on every one of them is
 * categorized, and the listing of the providers is among them.
 */
const whatsapp: DevProvider = {
  id: 'whatsapp',
  label: 'WhatsApp',
  status: () => Promise.resolve({ adapter: 'local', mode: 'ok' }),
  routes: (app) => {
    app.get(
      '/operator/dev/whatsapp/messages',
      { config: { readOnly: 'read', auth: 'public', operatorAuth: 'session' } },
      () => ({ messages: [] }),
    );
  },
};

async function routesOf(console: boolean) {
  // Never connects: building the application only declares routes.
  const db = createRuntimeDb('postgres://nobody:nothing@127.0.0.1:1/none');
  const app = buildTestApplication(db, {
    operator: {
      database: db,
      secrets: createOperatorSecrets(createLocalKeyManagement(randomBytes(32).toString('base64'))),
    },
    localProviders: { console, providers: [whatsapp] },
  });
  await app.ready();
  const routes = [...app.routeCategories.entries()];
  await app.close();
  return routes;
}

describe('the route enumeration of the provider console', () => {
  it('registers the operator console itself in both modes (the enumeration is not silently empty)', async () => {
    for (const mode of [false, true]) {
      const routes = (await routesOf(mode)).map(([route]) => route);

      expect(routes, `console=${String(mode)}`).toEqual(
        expect.arrayContaining(['GET /operator/tenants', 'POST /operator/auth/login']),
      );
    }
  });

  it('has no /operator/dev route at all while the console is off', async () => {
    const routes = (await routesOf(false)).map(([route]) => route);

    expect(routes.filter((route) => route.includes('/operator/dev'))).toEqual([]);
  });

  it('lists the providers and the routes each provider adds when the console is on', async () => {
    const routes = await routesOf(true);

    // Fastify answers HEAD for every GET; the GET routes are the ones the console declares.
    const dev = routes.filter(
      ([route]) => route.includes('/operator/dev') && !route.startsWith('HEAD '),
    );
    expect(dev.map(([route]) => route).sort()).toEqual([
      'GET /operator/dev/providers',
      'GET /operator/dev/whatsapp/messages',
    ]);
    for (const [route, category] of dev) expect(ROUTE_CATEGORIES, route).toContain(category);
  });
});
