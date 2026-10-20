import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { buildTestApplication } from '../../../test/support/app.js';
import { createRuntimeDb } from '../../platform/db/pool.js';

import { mergeFeatureRoutes, operatorExtensionsOf } from './feature-routes.js';
import type { ModuleWiring, OperatorWiringContext } from './types.js';

const fakeApp = () =>
  ({ calls: [] as string[] }) as unknown as FastifyInstance & { calls: string[] };

describe('merging the routes that modules put behind a feature', () => {
  it('runs every handler of a feature, in the order the modules came, and keeps the features apart', async () => {
    const order: string[] = [];
    const merged = mergeFeatureRoutes([
      {
        signup: () => {
          order.push('signup:a');
        },
        subscriptions: () => {
          order.push('subscriptions:a');
        },
      },
      undefined,
      {
        signup: async () => {
          await Promise.resolve();
          order.push('signup:b');
        },
      },
    ]);

    expect(Object.keys(merged).sort()).toEqual(['signup', 'subscriptions']);
    await merged.signup?.(fakeApp());
    expect(order).toEqual(['signup:a', 'signup:b']);
    await merged.subscriptions?.(fakeApp());
    expect(order).toEqual(['signup:a', 'signup:b', 'subscriptions:a']);
  });

  it('is empty when no module has routes behind a feature', () => {
    expect(mergeFeatureRoutes([undefined, {}])).toEqual({});
  });
});

describe('the routes modules add to the operator console', () => {
  const context = {
    run: vi.fn(),
    tenantCancelled: { publishCancelled: vi.fn() },
    email: { send: vi.fn() },
    origins: {},
  } as unknown as OperatorWiringContext;

  it('hands each module the same context and keeps the ones that add routes, in order', () => {
    const seen: OperatorWiringContext[] = [];
    const subscriptionsRoutes = vi.fn();
    const tenancyRoutes = vi.fn();
    const registering = (routes: () => void) => (received: OperatorWiringContext) => {
      seen.push(received);
      return routes;
    };
    const wirings = [
      { name: 'none' },
      { name: 'subscriptions', operatorRoutes: registering(subscriptionsRoutes) },
      { name: 'tenancy', operatorRoutes: registering(tenancyRoutes) },
    ] as unknown as readonly ModuleWiring[];

    const extensions = operatorExtensionsOf(wirings, context);

    expect(extensions).toEqual([subscriptionsRoutes, tenancyRoutes]);
    expect(seen).toEqual([context, context]);
  });
});

describe('a module whose routes sit behind a feature of the deployment', () => {
  const probe = (): ModuleWiring => ({
    name: 'probe',
    create: () => ({
      routes: (app) => {
        app.get('/probe/always', { config: { readOnly: 'read', auth: 'public' } }, () => ({}));
      },
      featureRoutes: {
        signup: (app) => {
          app.post(
            '/public/probe-signup',
            { config: { readOnly: 'write', auth: 'public' } },
            () => ({}),
          );
        },
        subscriptions: (app) => {
          app.get(
            '/probe/subscription',
            { config: { readOnly: 'read', auth: 'public' } },
            () => ({}),
          );
        },
      },
    }),
  });

  async function routesOf(mode: 'multi' | 'single') {
    const db = createRuntimeDb('postgres://nobody:nothing@127.0.0.1:1/none');
    const app = buildTestApplication(db, {
      wiring: [probe()],
      ...(mode === 'single'
        ? {
            deployment: { mode: 'single' as const, slug: 'test-tenant' },
            publicUrl: 'https://agenda.clinica.example',
          }
        : {}),
    });
    await app.ready();
    const routes = [...app.routeCategories.keys()];
    await app.close();
    await db.close();
    return routes;
  }

  it('serves them in multi mode', async () => {
    const routes = await routesOf('multi');

    expect(routes).toContain('GET /probe/always');
    expect(routes).toContain('POST /public/probe-signup');
    expect(routes).toContain('GET /probe/subscription');
  });

  it('serves only the ones that are not behind a feature in single mode', async () => {
    const routes = await routesOf('single');

    expect(routes).toContain('GET /probe/always');
    expect(routes).not.toContain('POST /public/probe-signup');
    expect(routes).not.toContain('GET /probe/subscription');
  });
});
