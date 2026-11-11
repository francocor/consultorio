import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import { testTenancy } from '../../testing/tenancy.js';

import { registerSecurityHeaders } from './security-headers.js';

describe('security headers', () => {
  async function respond(
    options: { secure: boolean },
    route?: (app: ReturnType<typeof Fastify>) => void,
  ) {
    const app = Fastify();
    registerSecurityHeaders(app, options);
    app.get('/json', () => ({ ok: true }));
    route?.(app);
    return app.inject({ method: 'GET', url: '/json' });
  }

  it('every answer says it is not to be sniffed, framed, cached or leaked through the referrer', async () => {
    const response = await respond({ secure: false });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it('asks browsers to keep to https only where the deployment is https', async () => {
    const plain = await respond({ secure: false });
    const secure = await respond({ secure: true });

    expect(plain.headers['strict-transport-security']).toBeUndefined();
    expect(secure.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('a route that sets its own policy keeps it (the public logo, the manifest)', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, { secure: false });
    app.get('/logo', (_request, reply) =>
      reply
        .header('cache-control', 'public, max-age=300')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send('x'),
    );

    const response = await app.inject({ method: 'GET', url: '/logo' });

    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('a page whose form posts back to itself may allow the referrer to its own origin (the token pages)', async () => {
    // With `no-referrer`, Chrome sends `Origin: null` on a form POST, which the origin check refuses.
    const app = Fastify();
    registerSecurityHeaders(app, { secure: false });
    app.get('/page', (_request, reply) => reply.header('referrer-policy', 'same-origin').send('x'));

    const response = await app.inject({ method: 'GET', url: '/page' });

    expect(response.headers['referrer-policy']).toBe('same-origin');
  });

  it('also covers errors and unknown paths', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, { secure: false });
    app.get('/boom', () => {
      throw new Error('boom');
    });

    const failing = await app.inject({ method: 'GET', url: '/boom' });
    const missing = await app.inject({ method: 'GET', url: '/nothing' });

    for (const response of [failing, missing]) {
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('is part of the real server', async () => {
    const app = buildServer({
      logLevel: 'silent',
      health: { checkDatabase: () => Promise.resolve({ ok: true }) },
      ...testTenancy(),
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    await app.close();
  });
});
