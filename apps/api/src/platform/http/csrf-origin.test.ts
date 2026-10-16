import { Problem } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import { stubAuthz } from '../../testing/authz.js';
import { testTenancy } from '../../testing/tenancy.js';

import { SESSION_COOKIE } from './session-cookie.js';

const HOST = 'clinica.consultorio.test';
const COOKIE = `${SESSION_COOKIE}=${'C'.repeat(43)}`;

function server() {
  const app = buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    ...testTenancy(),
    auth: {
      authz: stubAuthz,
      cookieSecure: true,
      authenticate: () => Promise.resolve(null),
    },
    routes: [
      (scope) => {
        scope.post('/auth/echo', { config: { readOnly: 'auth', auth: 'public' } }, () => ({
          done: true,
        }));
        scope.get('/auth/read', { config: { readOnly: 'read', auth: 'public' } }, () => ({
          done: true,
        }));
        scope.delete('/auth/remove', { config: { readOnly: 'auth', auth: 'public' } }, () => ({
          done: true,
        }));
        scope.post(
          '/webhooks/provider',
          { config: { readOnly: 'webhook', auth: 'public' } },
          () => ({
            received: true,
          }),
        );
      },
    ],
  });
  return app;
}

describe('Origin check on requests that change state', () => {
  it('lets a same-origin POST through', async () => {
    const app = server();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/echo',
      headers: { host: HOST, origin: `https://${HOST}` },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['a sibling tenant', 'https://otra.consultorio.test'],
    ['the literal null origin', 'null'],
    ['a look-alike host', `https://${HOST}.evil.example`],
    ['garbage', 'not a url'],
  ])('refuses a cross-origin POST from %s with 403', async (_label, origin) => {
    const app = server();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/echo',
      headers: { host: HOST, origin, cookie: COOKIE },
    });

    expect(response.statusCode).toBe(403);
    expect(Problem.parse(response.json())).toMatchObject({ code: 'forbidden' });
    await app.close();
  });

  it('applies to DELETE as well, and not to reads', async () => {
    const app = server();
    const headers = { host: HOST, origin: 'https://evil.example' };

    const remove = await app.inject({ method: 'DELETE', url: '/auth/remove', headers });
    const read = await app.inject({ method: 'GET', url: '/auth/read', headers });

    expect(remove.statusCode).toBe(403);
    expect(read.statusCode).toBe(200);
    await app.close();
  });

  it('refuses a POST that carries a session cookie but no Origin', async () => {
    const app = server();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/echo',
      headers: { host: HOST, cookie: COOKIE },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('lets a POST with neither Origin nor cookie through (nothing ambient to abuse)', async () => {
    const app = server();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/echo',
      headers: { host: HOST },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('does not apply to provider webhooks, which are signed instead', async () => {
    const app = server();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/provider',
      headers: { host: HOST, origin: 'https://provider.example' },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
