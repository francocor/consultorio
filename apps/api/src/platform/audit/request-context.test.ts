import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import type { TrustProxySetting } from '../../main/trust-proxy.js';
import { testTenancy } from '../../testing/tenancy.js';

import { setAuditActor } from './request-context.js';

function server(options: { trustProxy?: TrustProxySetting } = {}) {
  const app = buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    ...testTenancy(),
    ...options,
  });
  app.get('/actor', { config: { readOnly: 'read' } }, (request) => request.auditActor);
  app.get('/login-as', { config: { readOnly: 'read' } }, (request) => {
    setAuditActor(request, {
      userId: '0190a000-0000-7000-8000-0000000000f1',
      actingRole: 'reception',
    });
    return request.auditActor;
  });
  return app;
}

describe('request context for audit', () => {
  it('captures ip, user agent and the request id; the actor is unknown until authentication', async () => {
    const app = server();

    const response = await app.inject({
      url: '/actor',
      remoteAddress: '203.0.113.50',
      headers: { 'user-agent': 'TestBrowser/1.0' },
    });

    expect(response.json()).toEqual({
      userId: null,
      actingRole: null,
      ip: '203.0.113.50',
      userAgent: 'TestBrowser/1.0',
      requestId: response.headers['x-request-id'],
    });
    await app.close();
  });

  it('records the acting user and role once authentication has set them', async () => {
    const app = server();

    const response = await app.inject({ url: '/login-as', remoteAddress: '203.0.113.51' });

    expect(response.json()).toMatchObject({
      userId: '0190a000-0000-7000-8000-0000000000f1',
      actingRole: 'reception',
      ip: '203.0.113.51',
    });
    await app.close();
  });

  it('ignores X-Forwarded-For unless the proxy is trusted (the ip cannot be spoofed)', async () => {
    const app = server();

    const response = await app.inject({
      url: '/actor',
      remoteAddress: '203.0.113.60',
      headers: { 'x-forwarded-for': '10.9.9.9' },
    });

    expect(response.json<{ ip: string }>().ip).toBe('203.0.113.60');
    await app.close();
  });

  it('reads the client address from the hop our proxy appended to X-Forwarded-For', async () => {
    const app = server({ trustProxy: 1 });

    const response = await app.inject({
      url: '/actor',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '198.51.100.23' },
    });

    expect(response.json<{ ip: string }>().ip).toBe('198.51.100.23');
    await app.close();
  });

  it('ignores addresses a client prepends to X-Forwarded-For: rotating them changes nothing (finding 2)', async () => {
    const app = server({ trustProxy: 1 });

    const seen = new Set<string>();
    for (const fake of ['6.6.6.6', '7.7.7.7', '8.8.8.8', '9.9.9.9']) {
      const response = await app.inject({
        url: '/actor',
        remoteAddress: '10.0.0.2',
        headers: { 'x-forwarded-for': `${fake}, 198.51.100.23` },
      });
      seen.add(response.json<{ ip: string }>().ip);
    }

    expect([...seen]).toEqual(['198.51.100.23']);
    await app.close();
  });

  it('with two proxies in front, believes the second hop and still ignores what the client wrote', async () => {
    const app = server({ trustProxy: 2 });

    const response = await app.inject({
      url: '/actor',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.23, 10.0.0.9' },
    });

    expect(response.json<{ ip: string }>().ip).toBe('198.51.100.23');
    await app.close();
  });

  it('with a list of proxies, skips the proxies and stops at the first address that is not one', async () => {
    const app = server({ trustProxy: ['10.0.0.0/8'] });

    const response = await app.inject({
      url: '/actor',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.23, 10.0.0.9' },
    });

    expect(response.json<{ ip: string }>().ip).toBe('198.51.100.23');
    await app.close();
  });

  it('with a list of proxies, does not believe the header from a peer that is not in the list', async () => {
    const app = server({ trustProxy: ['10.0.0.0/8'] });

    const response = await app.inject({
      url: '/actor',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '198.51.100.23' },
    });

    expect(response.json<{ ip: string }>().ip).toBe('203.0.113.9');
    await app.close();
  });

  it.each(['not-an-ip', '999.1.1.1', 'fe80::1%eth0', "1.2.3.4'; drop table audit_event"])(
    'records no address, and does not fail, when the forwarded value is %j',
    async (forwarded) => {
      const app = server({ trustProxy: 1 });

      const response = await app.inject({
        url: '/actor',
        remoteAddress: '10.0.0.2',
        headers: { 'x-forwarded-for': forwarded },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ ip: unknown }>().ip).toBeNull();
      await app.close();
    },
  );

  it.each(['203.0.113.7', '2001:db8::1', '::ffff:198.51.100.4'])(
    'keeps a valid address as it is: %s',
    async (address) => {
      const app = server({ trustProxy: 1 });

      const response = await app.inject({
        url: '/actor',
        remoteAddress: '10.0.0.2',
        headers: { 'x-forwarded-for': address },
      });

      expect(response.json<{ ip: string }>().ip).toBe(address);
      await app.close();
    },
  );

  it('truncates a very long user agent and strips control characters', async () => {
    const app = server();

    const response = await app.inject({
      url: '/actor',
      headers: { 'user-agent': `Agent\u0007${'x'.repeat(2000)}` },
    });

    const userAgent = response.json<{ userAgent: string }>().userAgent;
    expect(userAgent).toHaveLength(512);
    expect(userAgent.startsWith('Agentxxx')).toBe(true);
    await app.close();
  });

  it('records a missing user agent as null', async () => {
    const app = server();

    const response = await app.inject({ url: '/actor', headers: { 'user-agent': '' } });

    expect(response.json<{ userAgent: unknown }>().userAgent).toBeNull();
    await app.close();
  });
});
