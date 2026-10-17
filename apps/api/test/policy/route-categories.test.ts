import { ROUTE_CATEGORIES } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../src/main/server.js';
import { testTenancy } from '../../src/testing/tenancy.js';

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
