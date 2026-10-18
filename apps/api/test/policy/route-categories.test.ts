import { ROUTE_CATEGORIES, type RouteCategory } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../src/main/server.js';
import { createRuntimeDb } from '../../src/platform/db/pool.js';
import { testTenancy } from '../../src/testing/tenancy.js';
import { buildTestApplication } from '../support/app.js';

import { findStage4RouteProblems, isStage4Route, STAGE4_ROUTES } from './stage4-routes.js';

/**
 * Every route of the real application (all feature routes enabled, multi mode) must declare a
 * read-only category. The boot hook already refuses a route without one; this test makes the
 * rule visible in CI and lists what is registered, so a route cannot be added silently.
 */
async function realApplication() {
  const app = buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    ...testTenancy(),
    deployment: {
      mode: 'multi',
      baseDomain: 'consultorio.test',
      platformHost: 'platform.consultorio.test',
    },
  });
  await app.ready();
  return app;
}

describe('route categories', () => {
  it('registers routes (the enumeration is not silently empty)', async () => {
    const app = await realApplication();

    expect(app.routeCategories.size).toBeGreaterThanOrEqual(2);
    expect([...app.routeCategories.keys()]).toEqual(
      expect.arrayContaining(['GET /health', 'GET /ready']),
    );
    await app.close();
  });

  it('gives every registered route a known category', async () => {
    const app = await realApplication();

    const uncategorized = [...app.routeCategories.entries()]
      .filter(([, category]) => !ROUTE_CATEGORIES.includes(category))
      .map(([route]) => route);

    expect(uncategorized).toEqual([]);
    await app.close();
  });

  it('cannot add a route without a category to the real application', () => {
    const app = buildServer({
      logLevel: 'silent',
      health: { checkDatabase: () => Promise.resolve({ ok: true }) },
      ...testTenancy(),
    });

    expect(() => app.get('/added-later', () => ({}))).toThrow(/added-later/);
  });
});

/**
 * Stage 4 (billing, reports, invoicing): the categories are listed route by route in
 * `stage4-routes.ts`. A new route of these modules fails here until somebody decides its category,
 * and a route that changes money can never be filed as a read (BIL-14, INV-13, RPT-12, TEN-11).
 */
describe('the routes of Stage 4', () => {
  async function stage4Routes() {
    const app = buildTestApplication(createRuntimeDb('postgres://nobody:nothing@127.0.0.1:1/none'));
    await app.ready();
    const routes = new Map(app.routeCategories);
    await app.close();
    return routes;
  }

  it('lists every route of billing, invoicing and reports with the category the table gives it', async () => {
    const routes = await stage4Routes();

    const registered = [...routes.keys()].filter((key) => isStage4Route(key));
    expect(registered.length).toBeGreaterThan(60);
    expect(findStage4RouteProblems(routes)).toEqual([]);
  });

  it('refuses a route that is not in the table, one that went missing and one in the wrong category', () => {
    const routes = new Map<string, RouteCategory>(
      Object.entries(STAGE4_ROUTES).map(([key, category]) => [key, category]),
    );
    routes.set('POST /billing/surprise', 'write');
    routes.delete('GET /reports/cash');
    routes.set('POST /billing/charges', 'read');

    expect(findStage4RouteProblems(routes)).toEqual([
      'POST /billing/surprise is registered but not in the table of Stage 4 routes',
      'GET /reports/cash is in the table but not registered',
      'POST /billing/charges is filed as "read" but the table says "write"',
      'POST /billing/charges changes data and is filed as "read", which a read-only organization may call',
    ]);
  });

  it('never files a route that changes data as a read, and never a read as a write', () => {
    const wrong = Object.entries(STAGE4_ROUTES).filter(([key, category]) => {
      const method = key.split(' ')[0] ?? '';
      const reads = method === 'GET' || method === 'HEAD';
      return reads ? category !== 'read' : category === 'read';
    });

    expect(wrong).toEqual([]);
    // The only changes that stay open in a read-only organization are the two exports.
    const open = Object.entries(STAGE4_ROUTES)
      .filter(([key, category]) => !key.startsWith('GET ') && category !== 'write')
      .map(([key]) => key)
      .sort();
    expect(open).toEqual(['POST /billing/exports', 'POST /billing/exports/:id/download']);
  });
});
