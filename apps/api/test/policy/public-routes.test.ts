import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createApplication } from '../../src/main/application.js';
import {
  createPasswordPolicy,
  createPasswordValidator,
} from '../../src/modules/identity/domain/password-policy.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb } from '../../src/platform/db/pool.js';
import {
  findMisplacedPortalRoutes,
  findUnlistedPublicRoutes,
} from '../../src/platform/http/auth-guard.js';
import { buildTestApplication } from '../support/app.js';
import { createRecordingJobClient } from '../support/jobs.js';

import type { Declaration } from './public-route-declaration.js';
import { STAGE6_PUBLIC_ROUTES } from './stage6-public-routes.js';

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
  email: createFakeEmailSender(),
  passwordValidator: createPasswordValidator(createPasswordPolicy(new Set<string>())),
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

/**
 * The public surface of the whole product (tasks 3.74): the application as `main` builds it, with
 * every module wired. Each route under `/public/` and `/webhooks/` has to declare how it protects
 * itself, and which test probes that protection. A route that nobody declared fails the first
 * test; a declaration of a route that is gone fails the second. The answers of the routes are
 * probed in `test/security/`.
 */
const surfaceDatabase = createRuntimeDb('postgres://app_rw:unused@127.0.0.1:1/unused');
const surface = buildTestApplication(surfaceDatabase, { jobs: createRecordingJobClient() });
await surface.ready();

afterAll(async () => {
  await surface.close();
  await surfaceDatabase.close();
});

const SURFACE_PROBES = 'test/security/public-surface.test.ts';
const NONDISCLOSURE = 'test/security/public-nondisclosure.test.ts';
const ABUSE = 'test/security/public-abuse.test.ts';
const TOKENS = 'test/security/public-tokens.test.ts';
const SELF_SERVICE = 'test/integration/booking-self-service.test.ts';
const WAITLIST_JOIN = 'test/integration/waitlist-join.test.ts';
const PORTAL_SIGNIN = 'test/integration/portal-signin.test.ts';

const DECLARED: Record<string, Declaration> = {
  // The routes of Stage 6 (signup and the payments provider), declared in their own file.
  ...STAGE6_PUBLIC_ROUTES,
  'GET /public/boot': { guards: ['open-metadata'], probes: [SURFACE_PROBES] },
  'GET /public/branding/logo': { guards: ['open-metadata'], probes: [SURFACE_PROBES] },
  'GET /public/challenge': { guards: ['open-metadata', 'rate-limit'], probes: [ABUSE] },
  'GET /public/:slug/booking': { guards: ['link-slug'], probes: [NONDISCLOSURE, SURFACE_PROBES] },
  'GET /public/:slug/booking/availability': {
    guards: ['link-slug'],
    probes: [NONDISCLOSURE, SURFACE_PROBES],
  },
  'GET /public/:slug/p/:professionalSlug': {
    guards: ['link-slug'],
    probes: [NONDISCLOSURE, SURFACE_PROBES],
  },
  'POST /public/:slug/booking/holds': {
    guards: ['link-slug', 'bot-challenge', 'rate-limit'],
    probes: [ABUSE, NONDISCLOSURE],
  },
  'POST /public/:slug/booking/holds/:id/submission': {
    guards: ['bot-challenge', 'hold-session', 'rate-limit'],
    probes: [ABUSE, NONDISCLOSURE],
  },
  'POST /public/:slug/booking/holds/:id/code': {
    guards: ['bot-challenge', 'hold-session', 'rate-limit'],
    probes: [ABUSE],
  },
  'POST /public/:slug/booking/holds/:id/confirm': {
    guards: ['otp', 'hold-session', 'rate-limit'],
    probes: [ABUSE, NONDISCLOSURE],
  },
  'POST /public/:slug/waitlist': {
    guards: ['link-slug', 'bot-challenge', 'rate-limit'],
    probes: [NONDISCLOSURE, WAITLIST_JOIN],
  },
  'POST /public/:slug/waitlist/:id/code': {
    guards: ['bot-challenge', 'rate-limit'],
    probes: [WAITLIST_JOIN],
  },
  'POST /public/:slug/waitlist/:id/confirm': {
    guards: ['otp', 'rate-limit'],
    probes: [NONDISCLOSURE, WAITLIST_JOIN],
  },
  'GET /public/t/:token': { guards: ['token', 'rate-limit'], probes: [TOKENS, SURFACE_PROBES] },
  'POST /public/t/:token': { guards: ['token', 'rate-limit'], probes: [TOKENS] },
  'GET /public/t/:token/appointment': {
    guards: ['token', 'rate-limit'],
    probes: [SURFACE_PROBES, SELF_SERVICE],
  },
  'GET /public/t/:token/slots': {
    guards: ['token', 'rate-limit'],
    probes: [SURFACE_PROBES, SELF_SERVICE],
  },
  'POST /public/t/:token/cancel': { guards: ['token', 'rate-limit'], probes: [SELF_SERVICE] },
  'POST /public/t/:token/reschedule': { guards: ['token', 'rate-limit'], probes: [SELF_SERVICE] },
  'GET /public/v/:token': {
    guards: ['token', 'rate-limit'],
    probes: [SURFACE_PROBES, 'test/integration/video-join-public.test.ts'],
  },
  'POST /public/v/:token': {
    guards: ['token', 'rate-limit'],
    probes: ['test/integration/video-join-public.test.ts'],
  },
  // The patient portal (Stage 5): register and sign in with a code. The answers never say whether an
  // account, a document or a patient exists; the probes prove it.
  'POST /public/:slug/portal/register': {
    guards: ['bot-challenge', 'rate-limit'],
    probes: [PORTAL_SIGNIN],
  },
  'POST /public/:slug/portal/register/verify': {
    guards: ['otp', 'rate-limit'],
    probes: [PORTAL_SIGNIN],
  },
  'POST /public/:slug/portal/otp': {
    guards: ['bot-challenge', 'rate-limit'],
    probes: [PORTAL_SIGNIN],
  },
  'POST /public/:slug/portal/otp/verify': {
    guards: ['otp', 'rate-limit'],
    probes: [PORTAL_SIGNIN],
  },
  'POST /webhooks/whatsapp': {
    guards: ['signature'],
    probes: ['test/integration/whatsapp-webhook.test.ts'],
  },
  // The e-prescription provider tells us a prescription changed state; the signature is checked over
  // the raw bytes, the state is whatever the provider says when asked.
  'POST /webhooks/erx': {
    guards: ['signature'],
    probes: ['test/integration/prescription-lifecycle.test.ts'],
  },
};

/** The routes under the prefixes of the surface; HEAD is the same handler as GET. */
const surfaceRoutes = () =>
  [...surface.routeAuth]
    .filter(([route, auth]) => auth === 'public' && !route.startsWith('HEAD '))
    .map(([route]) => route)
    .filter((route) => /^[A-Z,]+ \/(public|webhooks)\//.test(route))
    .sort();

describe('the public surface of the whole product', () => {
  it('keeps the portal on its side of the line: portal routes live under /portal/ and only they do', () => {
    const portal = [...surface.routeAuth].filter(([, auth]) => auth === 'portal');

    expect(portal.length).toBeGreaterThanOrEqual(3);
    expect(findMisplacedPortalRoutes(surface.routeAuth)).toEqual([]);
  });

  it('enumerates the routes under /public/ and /webhooks/ (the list is not silently empty)', () => {
    expect(surfaceRoutes().length).toBeGreaterThanOrEqual(20);
  });

  it('has a declared protection for every route, and no declaration without a route', () => {
    const routes = surfaceRoutes();
    const declared = Object.keys(DECLARED).sort();

    expect(routes.filter((route) => DECLARED[route] === undefined)).toEqual([]);
    expect(declared.filter((route) => !routes.includes(route))).toEqual([]);
  });

  it('protects every route with a guard, and every form with the challenge or the code', () => {
    for (const [route, declaration] of Object.entries(DECLARED)) {
      expect(declaration.guards.length, route).toBeGreaterThan(0);
      if (
        route.startsWith('POST /public/') &&
        !route.startsWith('POST /public/t/') &&
        !route.startsWith('POST /public/v/')
      ) {
        // A form is guarded by the challenge or by a code; the verification link of a signup
        // (Stage 6) is guarded by the single-use token it carries.
        expect(
          declaration.guards.some(
            (guard) => guard === 'bot-challenge' || guard === 'otp' || guard === 'token',
          ),
          route,
        ).toBe(true);
      }
    }
  });

  it('points each declaration at test files that exist', () => {
    for (const [route, declaration] of Object.entries(DECLARED)) {
      expect(declaration.probes.length, route).toBeGreaterThan(0);
      for (const file of declaration.probes) {
        expect(existsSync(new URL(`../../${file}`, import.meta.url)), `${route}: ${file}`).toBe(
          true,
        );
      }
    }
  });

  it('limits what it says it limits: the route carries a rate limit of its own', () => {
    for (const route of [
      'GET /public/t/:token',
      'POST /public/t/:token',
      'POST /public/:slug/booking/holds',
      'POST /public/:slug/booking/holds/:id/submission',
      'GET /public/challenge',
      'POST /public/:slug/portal/register',
      'POST /public/:slug/portal/register/verify',
      'POST /public/:slug/portal/otp',
      'POST /public/:slug/portal/otp/verify',
    ]) {
      expect(surface.routeDeclarations.get(route)?.rateLimited, route).toBe(true);
    }
  });

  it('gives no answer a shape that holds personal data: the schemas of the public responses', () => {
    // Fields that identify a patient or hold clinical content. `maskedEmail` is the visitor's own
    // address with all but its first letter hidden.
    const banned = new Set([
      'patientId',
      'patient',
      'givenNames',
      'familyName',
      'birthDate',
      'document',
      'nationalId',
      'phone',
      'email',
      'address',
      'diagnosis',
      'note',
      'notes',
      'reason',
      'coverage',
      'memberNumber',
    ]);
    const collect = (node: unknown, out: Set<string>): void => {
      if (Array.isArray(node)) {
        for (const item of node) collect(item, out);
      } else if (typeof node === 'object' && node !== null) {
        for (const [key, value] of Object.entries(node)) {
          if (key === 'properties' && typeof value === 'object' && value !== null) {
            for (const name of Object.keys(value as object)) out.add(name);
          }
          collect(value, out);
        }
      }
    };

    let checked = 0;
    for (const route of surfaceRoutes()) {
      const response = surface.routeDeclarations.get(route)?.responseSchemas ?? {};
      for (const [status, schema] of Object.entries(response)) {
        const names = new Set<string>();
        collect(
          z.toJSONSchema(schema as z.ZodType, { io: 'output', unrepresentable: 'any' }),
          names,
        );
        expect(
          [...names].filter((name) => banned.has(name)),
          `${route} ${status}`,
        ).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('would notice an undeclared route (the check proves itself)', () => {
    const routes = [...surfaceRoutes(), 'POST /public/:slug/invented'];

    expect(routes.filter((route) => DECLARED[route] === undefined)).toEqual([
      'POST /public/:slug/invented',
    ]);
  });
});
