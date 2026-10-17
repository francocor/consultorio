import {
  Problem,
  READ_ONLY_ALLOWLIST,
  ROUTE_CATEGORIES,
  type RouteCategory,
} from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import type { ResolvedTenant } from '../http/tenant-host.js';

import { refuseWhenReadOnly } from './index.js';

const BASE: ResolvedTenant = {
  id: '0190a000-0000-7000-8000-0000000000a1',
  slug: 'active',
  status: 'active',
  readOnlySince: null,
  isDemo: false,
  country: 'AR',
};
const TENANTS: ResolvedTenant[] = [
  BASE,
  {
    ...BASE,
    id: '0190a000-0000-7000-8000-0000000000a2',
    slug: 'frozen',
    status: 'read_only',
    readOnlySince: new Date('2026-10-01T00:00:00Z'),
  },
  { ...BASE, id: '0190a000-0000-7000-8000-0000000000a3', slug: 'closed', status: 'cancelled' },
];
const ACTIVE = { host: 'active.consultorio.test' };
const FROZEN = { host: 'frozen.consultorio.test' };
const CLOSED = { host: 'closed.consultorio.test' };

function server() {
  const app = buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    deployment: {
      mode: 'multi',
      baseDomain: 'consultorio.test',
      platformHost: 'platform.consultorio.test',
    },
    lookupTenant: (slug) => Promise.resolve(TENANTS.find((tenant) => tenant.slug === slug) ?? null),
  });
  for (const category of ROUTE_CATEGORIES) {
    app.post(`/cat/${category}`, { config: { readOnly: category } }, () => ({ done: category }));
  }
  // Public booking and waitlist routes are `write` or `read` like any other route.
  // A patient-protective route that keeps only part of what it does open: the handler decides.
  app.post<{ Querystring: { by?: string } }>(
    '/cat/partly-protective',
    { config: { readOnly: 'patient_protective' } },
    (request) => {
      if (request.query.by !== 'patient') refuseWhenReadOnly(request);
      return { done: request.query.by ?? 'nobody' };
    },
  );
  app.get('/public/frozen/booking/availability', { config: { readOnly: 'read' } }, () => ({
    slots: [1],
  }));
  app.post('/public/frozen/booking/holds', { config: { readOnly: 'write' } }, () => ({
    held: true,
  }));
  app.get('/public/frozen/p/dr-lopez', { config: { readOnly: 'read' } }, () => ({ page: true }));
  app.post('/public/frozen/waitlist', { config: { readOnly: 'write' } }, () => ({ joined: true }));
  app.get('/public/frozen/portal/otp', { config: { readOnly: 'auth' } }, () => ({ portal: true }));
  return app;
}

describe('read-only policy: one case per category', () => {
  it.each(ROUTE_CATEGORIES)(
    'category %s in an ACTIVE tenant is always served',
    async (category) => {
      const app = server();

      const response = await app.inject({
        method: 'POST',
        url: `/cat/${category}`,
        headers: ACTIVE,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ done: category });
      await app.close();
    },
  );

  it.each(READ_ONLY_ALLOWLIST)(
    'allowlisted category %s is served in a READ-ONLY tenant',
    async (category) => {
      const app = server();

      const response = await app.inject({
        method: 'POST',
        url: `/cat/${category}`,
        headers: FROZEN,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ done: category });
      await app.close();
    },
  );

  it('refuses a plain write in a READ-ONLY tenant with 402 tenant_read_only', async () => {
    const app = server();

    const response = await app.inject({ method: 'POST', url: '/cat/write', headers: FROZEN });

    expect(response.statusCode).toBe(402);
    expect(Problem.parse(response.json())).toMatchObject({
      code: 'tenant_read_only',
      i18nKey: 'errors.tenant_read_only',
      status: 402,
    });
    await app.close();
  });

  it('treats a cancelled tenant like a read-only one for writes (and serves its reads)', async () => {
    const app = server();

    const write = await app.inject({ method: 'POST', url: '/cat/write', headers: CLOSED });
    const read = await app.inject({ method: 'POST', url: '/cat/read', headers: CLOSED });

    expect(write.statusCode).toBe(402);
    expect(read.statusCode).toBe(200);
    await app.close();
  });

  it('does not turn an unknown route into a 402: it stays a plain 404', async () => {
    const app = server();

    const response = await app.inject({ method: 'POST', url: '/nope', headers: FROZEN });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('leaves the operator (platform) context alone: read-only is a tenant state', async () => {
    const app = server();

    const response = await app.inject({
      method: 'POST',
      url: '/cat/write',
      headers: { host: 'platform.consultorio.test' },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe('public booking and waitlist in a read-only tenant', () => {
  it.each([
    ['GET', '/public/frozen/booking/availability'],
    ['POST', '/public/frozen/booking/holds'],
    ['GET', '/public/frozen/p/dr-lopez'],
    ['POST', '/public/frozen/waitlist'],
  ] as const)(
    '%s %s shows the generic "not available" response, not a 402',
    async (method, url) => {
      const app = server();

      const response = await app.inject({ method, url, headers: FROZEN });
      const unknown = await app.inject({ method: 'GET', url: '/no-such-page', headers: FROZEN });

      expect(response.statusCode).toBe(404);
      const shape = (body: unknown) => ({ ...Problem.parse(body), requestId: undefined });
      expect(shape(response.json())).toEqual(shape(unknown.json()));
      await app.close();
    },
  );

  it('serves the same public routes normally while the tenant is active', async () => {
    const app = server();
    app.get('/public/active/booking/availability', { config: { readOnly: 'read' } }, () => ({
      slots: [1],
    }));

    const response = await app.inject({
      url: '/public/active/booking/availability',
      headers: ACTIVE,
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('keeps portal sign-in (authentication) available in a read-only tenant', async () => {
    const app = server();

    const response = await app.inject({ url: '/public/frozen/portal/otp', headers: FROZEN });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe('every route must declare a category', () => {
  it('fails at boot when a route has none', () => {
    const app = server();

    expect(() => app.get('/forgot-the-category', () => ({ oops: true }))).toThrow(
      /forgot-the-category/,
    );
  });

  it('fails at boot when the category is not a known one', () => {
    const app = server();

    expect(() =>
      app.get('/typo', { config: { readOnly: 'reed' as RouteCategory } }, () => ({})),
    ).toThrow(/typo/);
  });

  it('lists the category of each registered route', async () => {
    const app = server();
    await app.ready();

    expect(app.routeCategories.get('GET /health')).toBe('read');
    expect(app.routeCategories.get('POST /cat/write')).toBe('write');
    expect(app.routeCategories.get('POST /cat/webhook')).toBe('webhook');
  });
});

describe('a route that is open to the patient and closed to the organization', () => {
  const call = async (host: { host: string }, by: string) => {
    const app = server();
    const response = await app.inject({
      method: 'POST',
      url: `/cat/partly-protective?by=${by}`,
      headers: host,
    });
    await app.close();
    return response;
  };

  it('serves the patient in a READ-ONLY tenant and refuses the organization with 402', async () => {
    const patient = await call(FROZEN, 'patient');
    const organization = await call(FROZEN, 'organization');
    const professional = await call(FROZEN, 'professional');

    expect(patient.statusCode).toBe(200);
    expect(patient.json()).toEqual({ done: 'patient' });
    for (const refused of [organization, professional]) {
      expect(refused.statusCode).toBe(402);
      expect(Problem.parse(refused.json())).toMatchObject({ code: 'tenant_read_only' });
    }
  });

  it('serves everybody in an ACTIVE tenant, and refuses the organization in a cancelled one', async () => {
    expect((await call(ACTIVE, 'organization')).statusCode).toBe(200);
    expect((await call(ACTIVE, 'patient')).statusCode).toBe(200);
    expect((await call(CLOSED, 'organization')).statusCode).toBe(402);
    expect((await call(CLOSED, 'patient')).statusCode).toBe(200);
  });
});
