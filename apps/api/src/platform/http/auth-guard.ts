import type { Role, SessionScope } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';

import { setAuditActor } from '../audit/request-context.js';

import { AppError } from './problem.js';
import { clearSessionCookie, readSessionCookie } from './session-cookie.js';

/** Who is making the request, once the session cookie has been verified. */
export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  membershipId: string;
  tenantId: string;
  roles: readonly Role[];
  scope: SessionScope;
}

/** Looks up the live session of a token on a tenant. Null for anything that is not one. */
export type Authenticate = (
  token: string,
  tenantId: string,
) => Promise<AuthenticatedSession | null>;

/** `public` needs no session; `session` needs any valid one. */
export type RouteAuth = 'public' | 'session';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Mandatory on every route once authentication is configured: a route without it fails at boot. */
    auth?: RouteAuth;
    /**
     * A session that may only enroll a second factor (`two_factor_enrollment`) can reach this route.
     * Every other route answers it 403 `two_factor_enrollment_required`.
     */
    allowEnrollmentScope?: boolean;
  }
  interface FastifyRequest {
    /** The verified session, or null on public routes and before authentication. */
    session: AuthenticatedSession | null;
  }
  interface FastifyInstance {
    /** "METHOD /url" -> auth requirement, for every registered route. Read by the policy test. */
    routeAuth: Map<string, RouteAuth>;
  }
}

/**
 * Where an unauthenticated route may live (design 4.5, identity-access "Authentication required
 * by default"). Anything else must require a session. The policy test enumerates the real
 * application and fails if a public route sits outside these prefixes.
 */
export const PUBLIC_ROUTE_PREFIXES = [
  '/auth/',
  '/public/',
  '/files/',
  '/webhooks/',
  '/health',
  '/ready',
] as const;

export function isAllowedPublicPath(path: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) && path.length > prefix.length : path === prefix,
  );
}

/**
 * Public routes that sit outside the allowed prefixes, as `"METHOD /url"` strings. The policy test
 * runs it over the real application, so a public endpoint cannot be added anywhere else.
 */
export function findUnlistedPublicRoutes(routes: ReadonlyMap<string, RouteAuth>): string[] {
  return [...routes]
    .filter(
      ([route, auth]) =>
        auth === 'public' && !isAllowedPublicPath(route.slice(route.indexOf(' ') + 1)),
    )
    .map(([route]) => route);
}

function isRouteAuth(value: unknown): value is RouteAuth {
  return value === 'public' || value === 'session';
}

/** Highest-privilege role first: used to label audit entries. */
const ROLE_PRECEDENCE: readonly Role[] = ['owner', 'admin', 'professional', 'reception', 'patient'];

export function primaryRole(roles: readonly Role[]): Role {
  return ROLE_PRECEDENCE.find((role) => roles.includes(role)) ?? 'patient';
}

export interface AuthGuardOptions {
  authenticate: Authenticate;
  /** Adds `Secure` to the cookie it clears. */
  cookieSecure: boolean;
}

/**
 * Registers the authentication guard: every route either declares `config.auth: 'public'` or
 * requires a verified session. A route that declares neither fails at boot, so a new endpoint
 * cannot ship unprotected by accident. The session comes from the opaque cookie and is looked up
 * on the tenant of the HOST, so a cookie replayed on another tenant's host finds nothing (401).
 *
 * Register it after the tenant host guard (it needs `request.hostContext`) and before any route.
 */
export function registerAuthGuard(app: FastifyInstance, options: AuthGuardOptions): void {
  const routeAuth = new Map<string, RouteAuth>();
  app.decorate('routeAuth', routeAuth);
  app.decorateRequest('session', null);

  app.addHook('onRoute', (route) => {
    const auth: unknown = route.config?.auth;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!isRouteAuth(auth)) {
      throw new Error(
        `Route ${methods.join(',')} ${route.url} must declare config.auth ('public' or 'session')`,
      );
    }
    for (const method of methods) routeAuth.set(`${method} ${route.url}`, auth);
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.is404) return;
    if (request.routeOptions.config.auth === 'public') return;

    const context = request.hostContext;
    const token = readSessionCookie(request.headers.cookie);
    if (context?.kind !== 'tenant' || token === null) throw new AppError('unauthenticated');

    const session = await options.authenticate(token, context.tenant.id);
    if (session === null) {
      void reply.header('set-cookie', clearSessionCookie({ secure: options.cookieSecure }));
      throw new AppError('unauthenticated');
    }

    if (
      session.scope === 'two_factor_enrollment' &&
      !request.routeOptions.config.allowEnrollmentScope
    ) {
      throw new AppError('two_factor_enrollment_required');
    }

    request.session = session;
    setAuditActor(request, { userId: session.userId, actingRole: primaryRole(session.roles) });
  });
}
