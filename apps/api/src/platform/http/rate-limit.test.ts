import { Problem } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import type { DeploymentSettings } from '../../modules/tenancy/domain/host.js';
import { stubAuthz } from '../../testing/authz.js';
import { TEST_TENANT } from '../../testing/tenancy.js';

import { clientKeyOf, createMemoryRateLimitStore } from './rate-limit.js';
import type { ResolvedTenant } from './tenant-host.js';

describe('in-memory rate limit store', () => {
  it('counts hits inside a window and tells when the window resets', async () => {
    let now = 1_000;
    const store = createMemoryRateLimitStore({ now: () => now });

    const first = await store.hit('k', 60_000);
    now += 10_000;
    const second = await store.hit('k', 60_000);

    expect(first).toEqual({ count: 1, resetsInMs: 60_000 });
    expect(second).toEqual({ count: 2, resetsInMs: 50_000 });
  });

  it('starts a new window once the old one is over, and keeps keys apart', async () => {
    let now = 0;
    const store = createMemoryRateLimitStore({ now: () => now });
    await store.hit('a', 1_000);
    await store.hit('a', 1_000);
    await store.hit('b', 1_000);

    now = 1_000;
    const again = await store.hit('a', 1_000);
    const other = await store.hit('b', 1_000);

    expect(again.count).toBe(1);
    expect(other.count).toBe(1);
  });

  it('forgets the oldest keys beyond its capacity instead of growing without bound', async () => {
    const store = createMemoryRateLimitStore({ maxKeys: 2 });
    await store.hit('one', 60_000);
    await store.hit('two', 60_000);
    await store.hit('three', 60_000);

    // "one" was evicted: it starts from 1 again.
    expect((await store.hit('one', 60_000)).count).toBe(1);
    expect((await store.hit('three', 60_000)).count).toBe(2);
  });
});

describe('client key', () => {
  it('keeps IPv4 addresses as they are and unwraps IPv4-mapped IPv6', () => {
    expect(clientKeyOf('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKeyOf('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('treats the addresses of one IPv6 /64 as one client, and different /64 as different clients', () => {
    const a = clientKeyOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = clientKeyOf('2001:0db8:0001:0002::1');
    const other = clientKeyOf('2001:db8:1:3::1');

    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(other).toBe('2001:db8:1:3::/64');
  });
});

const NORTE: ResolvedTenant = {
  ...TEST_TENANT,
  id: '0190a000-0000-7000-8000-0000000000a1',
  slug: 'norte',
};
const SUR: ResolvedTenant = {
  ...TEST_TENANT,
  id: '0190a000-0000-7000-8000-0000000000a2',
  slug: 'sur',
};
const multi: DeploymentSettings = {
  mode: 'multi',
  baseDomain: 'consultorio.test',
  platformHost: 'platform.consultorio.test',
};

function server(limits: { client: number; tenant: number }) {
  return buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    deployment: multi,
    lookupTenant: (slug) =>
      Promise.resolve([NORTE, SUR].find((tenant) => tenant.slug === slug) ?? null),
    auth: {
      authz: stubAuthz,
      cookieSecure: true,
      authenticate: () => Promise.resolve(null),
    },
    rateLimit: {
      store: createMemoryRateLimitStore(),
      perClient: { max: limits.client, windowMs: 60_000 },
      perTenant: { max: limits.tenant, windowMs: 60_000 },
    },
    routes: [
      (scope) => {
        scope.get('/auth/ping', { config: { readOnly: 'read', auth: 'public' } }, () => ({
          pong: true,
        }));
        scope.get('/auth/staff-ping', { config: { readOnly: 'read', auth: 'session' } }, () => ({
          pong: true,
        }));
        scope.get(
          '/auth/strict',
          {
            config: {
              readOnly: 'read',
              auth: 'public',
              rateLimit: { max: 2, timeWindow: 60_000 },
            },
          },
          () => ({ pong: true }),
        );
      },
    ],
  });
}

const ping = (
  app: ReturnType<typeof server>,
  slug: string,
  ip = '203.0.113.1',
  url = '/auth/ping',
) =>
  app.inject({
    url,
    headers: { host: `${slug}.consultorio.test` },
    remoteAddress: ip,
  });

describe('rate limiting per client and per tenant', () => {
  it('answers 429 problem+json with Retry-After once a client exceeds the limit', async () => {
    const app = server({ client: 3, tenant: 100 });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await ping(app, 'norte')).statusCode);
    const blocked = await ping(app, 'norte');

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(Problem.parse(blocked.json())).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('keeps separate buckets per tenant: the same client is not blocked on another tenant', async () => {
    const app = server({ client: 2, tenant: 100 });

    await ping(app, 'norte');
    await ping(app, 'norte');
    const norteBlocked = await ping(app, 'norte');
    const sur = await ping(app, 'sur');

    expect(norteBlocked.statusCode).toBe(429);
    expect(sur.statusCode).toBe(200);
    await app.close();
  });

  it('keeps separate buckets per client address', async () => {
    const app = server({ client: 1, tenant: 100 });

    await ping(app, 'norte', '203.0.113.1');
    const sameClient = await ping(app, 'norte', '203.0.113.1');
    const otherClient = await ping(app, 'norte', '203.0.113.2');

    expect(sameClient.statusCode).toBe(429);
    expect(otherClient.statusCode).toBe(200);
    await app.close();
  });

  it('caps the whole tenant even when every request comes from a different address', async () => {
    const app = server({ client: 100, tenant: 3 });

    const statuses: number[] = [];
    for (let i = 1; i <= 5; i += 1)
      statuses.push((await ping(app, 'norte', `203.0.113.${String(i)}`)).statusCode);
    const other = await ping(app, 'sur', '203.0.113.9');

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(other.statusCode).toBe(200);
    await app.close();
  });

  it('counts the public routes of a tenant apart from the staff ones, so a flood of visitors cannot lock staff out (JD-S3 B23)', async () => {
    const app = server({ client: 100, tenant: 3 });

    const flood: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      flood.push((await ping(app, 'norte', `203.0.113.${String(10 + index)}`)).statusCode);
    }
    const staff = await ping(app, 'norte', '198.51.100.7', '/auth/staff-ping');
    const moreVisitors = await ping(app, 'norte', '203.0.113.99');

    expect(flood.filter((status) => status === 429).length).toBeGreaterThan(0);
    // The staff route is not answered 429: the request got as far as the authentication.
    expect(staff.statusCode).not.toBe(429);
    expect(moreVisitors.statusCode).toBe(429);
  });

  it('lets one route be stricter than the default', async () => {
    const app = server({ client: 100, tenant: 100 });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1)
      statuses.push((await ping(app, 'norte', '203.0.113.1', '/auth/strict')).statusCode);

    expect(statuses).toEqual([200, 200, 429, 429]);
    expect((await ping(app, 'norte')).statusCode).toBe(200);
    await app.close();
  });

  it('never rate limits the liveness and readiness probes', async () => {
    const app = server({ client: 1, tenant: 1 });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push(
        (await app.inject({ url: '/health', remoteAddress: '203.0.113.1' })).statusCode,
      );
    }

    expect(statuses).toEqual([200, 200, 200, 200]);
    await app.close();
  });
});

describe('a flood of unknown hosts is limited before it costs a database lookup (review finding 8)', () => {
  function probeServer(limits: { client: number }) {
    const lookups: string[] = [];
    const app = buildServer({
      logLevel: 'silent',
      health: { checkDatabase: () => Promise.resolve({ ok: true }) },
      deployment: multi,
      lookupTenant: (slug) => {
        lookups.push(slug);
        return Promise.resolve([NORTE, SUR].find((tenant) => tenant.slug === slug) ?? null);
      },
      auth: { authz: stubAuthz, cookieSecure: true, authenticate: () => Promise.resolve(null) },
      rateLimit: {
        store: createMemoryRateLimitStore(),
        perClient: { max: limits.client, windowMs: 60_000 },
        perTenant: { max: 100_000, windowMs: 60_000 },
      },
      routes: [
        (scope) => {
          scope.get('/auth/ping', { config: { readOnly: 'read', auth: 'public' } }, () => ({
            pong: true,
          }));
        },
      ],
    });
    return { app, lookups };
  }

  const probe = (app: ReturnType<typeof probeServer>['app'], slug: string, ip: string) =>
    app.inject({
      url: '/auth/ping',
      headers: { host: `${slug}.consultorio.test` },
      remoteAddress: ip,
    });

  it('stops querying for the tenants a client invents once the client is over its allowance', async () => {
    const { app, lookups } = probeServer({ client: 2 });

    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      statuses.push((await probe(app, `invented-${String(i)}`, '198.51.100.9')).statusCode);
    }

    expect(statuses.slice(0, 4)).toEqual([404, 404, 404, 404]);
    expect(statuses.slice(-4)).toEqual([429, 429, 429, 429]);
    // Every request that reached the database was counted before it did; the rest were refused.
    expect(lookups.length).toBeLessThan(14);
    expect(lookups.length).toBe(statuses.filter((status) => status === 404).length);
    await app.close();
  });

  it('answers 429 problem+json with Retry-After, like the other limits', async () => {
    const { app } = probeServer({ client: 1 });

    let last = await probe(app, 'invented-0', '198.51.100.10');
    for (let i = 1; i < 10; i += 1)
      last = await probe(app, `invented-${String(i)}`, '198.51.100.10');

    expect(last.statusCode).toBe(429);
    expect(Problem.parse(last.json())).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('leaves another client alone, and a real tenant of the same client within its own limit', async () => {
    const { app, lookups } = probeServer({ client: 5 });
    for (let i = 0; i < 40; i += 1) await probe(app, `invented-${String(i)}`, '198.51.100.11');

    const stranger = await probe(app, 'norte', '198.51.100.12');

    expect(stranger.statusCode).toBe(200);
    expect(lookups).toContain('norte');
    await app.close();
  });

  it('does not slow the probes down: liveness and readiness are never limited', async () => {
    const { app } = probeServer({ client: 1 });
    for (let i = 0; i < 20; i += 1) await probe(app, `invented-${String(i)}`, '198.51.100.13');

    const health = await app.inject({ url: '/health', remoteAddress: '198.51.100.13' });

    expect(health.statusCode).toBe(200);
    await app.close();
  });
});
