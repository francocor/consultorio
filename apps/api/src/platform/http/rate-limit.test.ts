import { Problem } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import type { DeploymentSettings } from '../../modules/tenancy/domain/host.js';
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
    auth: { cookieSecure: true, authenticate: () => Promise.resolve(null) },
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
