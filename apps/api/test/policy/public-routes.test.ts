import { randomBytes } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createApplication } from '../../src/main/application.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb } from '../../src/platform/db/pool.js';
import { findUnlistedPublicRoutes } from '../../src/platform/http/auth-guard.js';

/**
 * Boot-time enumeration of the real application (design 4.5, identity-access "Authentication
 * required by default"): every route declares whether it needs a session, and the routes that do
 * not can only live under the allowed public prefixes. The pool is never connected: registering
 * routes does not query anything.
 */
const database = createRuntimeDb('postgres://app_rw:unused@127.0.0.1:1/unused');
const app = createApplication({
  database,
  logLevel: 'silent',
  health: { checkDatabase: () => Promise.resolve({ ok: true }) },
  deployment: {
    mode: 'multi',
    baseDomain: 'consultorio.test',
    platformHost: 'platform.consultorio.test',
  },
  cookieSecure: true,
  trustProxy: false,
  keys: createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) }),
});
await app.ready();

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('authentication of the real application', () => {
  it('registers routes with their requirement (the enumeration is not silently empty)', () => {
    expect([...app.routeAuth.keys()]).toEqual(
      expect.arrayContaining([
        'GET /health',
        'GET /ready',
        'POST /auth/login',
        'POST /auth/logout',
        'GET /auth/me',
      ]),
    );
  });

  it('gives every route a requirement: the same routes are categorized and authenticated', () => {
    expect([...app.routeAuth.keys()].sort()).toEqual([...app.routeCategories.keys()].sort());
  });

  it('requires a session on everything except the login, the probes and the allowed prefixes', () => {
    const publicRoutes = [...app.routeAuth].filter(([, auth]) => auth === 'public').map(([r]) => r);

    expect(publicRoutes).toEqual(expect.arrayContaining(['POST /auth/login', 'GET /health']));
    expect(app.routeAuth.get('GET /auth/me')).toBe('session');
    expect(app.routeAuth.get('POST /auth/logout')).toBe('session');
    expect(app.routeAuth.get('GET /auth/sessions')).toBe('session');
  });

  it('has no public route outside the allowed prefixes', () => {
    expect(findUnlistedPublicRoutes(app.routeAuth)).toEqual([]);
  });

  it('would notice a public route outside the allowlist (the check proves itself)', () => {
    const routes = new Map<string, 'public' | 'session'>([
      ['GET /auth/login-page', 'public'],
      ['GET /patients', 'public'],
      ['POST /users/invite', 'public'],
      ['GET /patients/:id', 'session'],
    ]);

    expect(findUnlistedPublicRoutes(routes)).toEqual(['GET /patients', 'POST /users/invite']);
  });
});
