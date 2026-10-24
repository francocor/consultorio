import type { FastifyInstance } from 'fastify';

import type { PortalActor } from '../authz/actor.js';
import { can } from '../authz/can.js';
import type { AuthzOptions } from '../authz/guard.js';

import { clearPortalCookie, readPortalCookie } from './portal-session.js';
import { AppError } from './problem.js';

/** Who is making the request, once the portal cookie has been verified. */
export interface PortalSessionInfo {
  sessionId: string;
  identityId: string;
  tenantId: string;
  /** The subject the person picked, or null until they pick one. */
  linkId: string | null;
}

/** Looks up the live session of a token on a tenant. Null for anything that is not one. */
export type AuthenticatePortal = (
  token: string,
  tenantId: string,
) => Promise<PortalSessionInfo | null>;

declare module 'fastify' {
  interface FastifyRequest {
    /** The verified portal session, or null outside portal routes. */
    portalSession: PortalSessionInfo | null;
    /** Who is acting in the portal, once the guard has run. Null outside portal routes. */
    portalActor: PortalActor | null;
  }
}

export interface PortalGuardOptions {
  authenticate: AuthenticatePortal;
  /** Adds `Secure` to the cookie it clears, and picks the name of the cookie. */
  cookieSecure: boolean;
  /** Records a denial on its own connection, so the rollback of the request cannot erase it. */
  auditDeny: AuthzOptions['auditDeny'];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostOfOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * The guard of the authenticated portal routes (`config.auth: 'portal'`, task 5.29), the portal's
 * counterpart of the staff authentication guard:
 *
 * - It reads ONLY the portal cookie. A staff session on a portal route finds no cookie (401), and a
 *   portal session on a staff route finds none either: the two doors never share a credential.
 * - The tenant is the host's. The session is looked up on it and must belong to it; nothing in the
 *   path, the query or the body can name another organization.
 * - A write must come from the page of the same host (the `Origin` header is mandatory, not just
 *   consistent: the portal cookie is `SameSite=Strict`, this is a second layer).
 * - The route declares what it asks of the portal actor (`portalPermission`); the actor is built
 *   here from the session and holds only the permissions of `PORTAL_ACTOR_PERMISSIONS`.
 *
 * Register it inside the plugin scope that holds the portal routes, before them. Routes of that
 * scope that are not `portal` ones are left to the staff guard.
 */
export function registerPortalGuard(app: FastifyInstance, options: PortalGuardOptions): void {
  app.decorateRequest('portalSession', null);
  app.decorateRequest('portalActor', null);

  app.addHook('onRequest', async (request, reply) => {
    if (request.is404) return;
    const config = request.routeOptions.config;
    if (config.auth !== 'portal') return;

    const context = request.hostContext;
    const token = readPortalCookie(request.headers.cookie, { secure: options.cookieSecure });
    if (context?.kind !== 'tenant' || token === null) throw new AppError('unauthenticated');

    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (origin === undefined || hostOfOrigin(origin) !== request.headers.host) {
        throw new AppError('forbidden');
      }
    }

    const session = await options.authenticate(token, context.tenant.id);
    if (session?.tenantId !== context.tenant.id) {
      void reply.header('set-cookie', clearPortalCookie({ secure: options.cookieSecure }));
      throw new AppError('unauthenticated');
    }

    const actor: PortalActor = {
      kind: 'portal',
      tenantId: session.tenantId,
      identityId: session.identityId,
      linkId: session.linkId,
    };
    request.portalSession = session;
    request.portalActor = actor;
    request.auditActor = { ...request.auditActor, userId: null, actingRole: 'patient' };

    const permission = config.portalPermission;
    const decision =
      permission === undefined
        ? undefined
        : can(actor, permission, {
            tenantId: context.tenant.id,
          });
    if (decision === undefined || !decision.allowed) {
      await options.auditDeny(session.tenantId, {
        action: 'access.denied',
        actor: request.auditActor,
        resourceType: 'route',
        reason: decision?.allowed === false ? decision.reason : 'not_permitted',
        metadata: { identityId: session.identityId, method: request.method },
      });
      throw new AppError('forbidden');
    }
  });
}
