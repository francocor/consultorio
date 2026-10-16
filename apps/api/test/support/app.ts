import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createApplication, type ApplicationOptions } from '../../src/main/application.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import type { DbHandle } from '../../src/platform/db/pool.js';

export const BASE_DOMAIN = 'consultorio.test';

export const hostOf = (slug: string) => `${slug}.${BASE_DOMAIN}`;

/** Headers a browser on a tenant's host sends with a state-changing request. */
export const browserHeaders = (slug: string, cookie?: string) => ({
  host: hostOf(slug),
  origin: `https://${hostOf(slug)}`,
  'user-agent': 'vitest-browser',
  ...(cookie === undefined ? {} : { cookie }),
});

/**
 * The real application (multi mode, real database as `app_rw`) with the pieces a test controls
 * replaced. Everything else is what `main` builds.
 */
export function buildTestApplication(
  runtime: DbHandle,
  overrides: Partial<ApplicationOptions> = {},
): FastifyInstance {
  return createApplication({
    database: runtime,
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    deployment: {
      mode: 'multi',
      baseDomain: BASE_DOMAIN,
      platformHost: `platform.${BASE_DOMAIN}`,
    },
    cookieSecure: true,
    trustProxy: false,
    keys: createTenantKeys({
      kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
    }),
    // Tests sign in many times from one address; the limits have their own tests.
    limits: {
      perClient: { max: 100_000, windowMs: 60_000 },
      perTenant: { max: 100_000, windowMs: 60_000 },
      login: { max: 100_000, timeWindow: 60_000 },
    },
    ...overrides,
  });
}

/** The `sid=...` pair of a response's Set-Cookie header, ready to send back as a `Cookie` header. */
export function sessionCookieOf(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const pair = header?.split(';')[0];
  if (!pair?.startsWith('sid=') || pair === 'sid=') {
    throw new Error('response did not set a session cookie');
  }
  return pair;
}
