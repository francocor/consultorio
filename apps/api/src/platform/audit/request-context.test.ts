import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import { testTenancy } from '../../testing/tenancy.js';

import { setAuditActor } from './request-context.js';

function server(options: { trustProxy?: boolean } = {}) {
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

  it('reads the client address from X-Forwarded-For when the proxy is trusted', async () => {
    const app = server({ trustProxy: true });

    const response = await app.inject({
      url: '/actor',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '198.51.100.23' },
    });

    expect(response.json<{ ip: string }>().ip).toBe('198.51.100.23');
    await app.close();
  });

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
