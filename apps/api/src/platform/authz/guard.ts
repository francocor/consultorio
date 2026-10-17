import { type Permission } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';

import type { AuditDenyEvent, AuditDenyOutcome } from '../audit/deny.js';
import type { AuthenticatedSession } from '../http/auth-guard.js';
import { AppError } from '../http/problem.js';

import type { Actor } from './actor.js';
import { can } from './can.js';
import {
  deriveProfessionalId,
  type MatriculaValidator,
  type ProfessionalRepo,
} from './professional-gate.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The permission a caller needs. Authorization is decided before the handler runs, from the
     * catalog in `@consultorio/contracts`. A route declares this, or `auth: 'public'`, or (for
     * self-service under `/auth/`) `auth: 'session'`; one with none of them fails at boot.
     */
    permission?: Permission;
  }
  interface FastifyRequest {
    /** Who is acting, once the permission guard has run. Null on public and self-service routes. */
    actor: Actor | null;
  }
  interface FastifyInstance {
    /** "METHOD /url" -> permission, for every route that declares one. Read by policy tests. */
    routePermissions: Map<string, Permission>;
  }
}

/** The grants (`permission_grant`) of a member. The access module implements it (S1.18). */
export interface GrantsRepo {
  grantsFor(tenantId: string, membershipId: string): Promise<string[]>;
  /** The professionals whose calendars the member was delegated (from the grant's scope). */
  delegatedCalendarsFor?(tenantId: string, membershipId: string): Promise<string[]>;
}

/** Before the access module there are no grants: roles alone decide. */
export const noGrants: GrantsRepo = { grantsFor: () => Promise.resolve([]) };

/** Builds the actor of a request from the session, the grants and the professional gate. */
export type ActorLoader = (session: AuthenticatedSession) => Promise<Actor>;

export function createActorLoader(deps: {
  professionals: ProfessionalRepo;
  grants: GrantsRepo;
  validateMatricula: MatriculaValidator;
}): ActorLoader {
  return async (session) => {
    const [grants, delegated, professionalId] = await Promise.all([
      deps.grants.grantsFor(session.tenantId, session.membershipId).catch(() => []),
      (
        deps.grants.delegatedCalendarsFor?.(session.tenantId, session.membershipId) ??
        Promise.resolve([])
      ).catch(() => []),
      deriveProfessionalId(
        { tenantId: session.tenantId, membershipId: session.membershipId, roles: session.roles },
        deps.professionals,
        deps.validateMatricula,
      ),
    ]);
    return {
      kind: session.roles.includes('patient') ? 'patient' : 'staff',
      userId: session.userId,
      tenantId: session.tenantId,
      membershipId: session.membershipId,
      roles: session.roles,
      grants,
      professionalId,
      delegatedProfessionalIds: delegated,
    };
  };
}

export interface AuthzOptions {
  loadActor: ActorLoader;
  /** Records a denial on its own connection, so the rollback of the request cannot erase it. */
  auditDeny(tenantId: string, event: AuditDenyEvent): Promise<AuditDenyOutcome>;
}

/**
 * The permission check that runs for every route that declares `config.permission`, after the
 * session is known and before the handler. A denial is written to the audit log by the
 * independent writer and answered with the uniform 403: it names no permission, no role and no
 * resource (authorization, "Denials are uniform and non-leaking").
 */
export function registerPermissionGuard(app: FastifyInstance, options: AuthzOptions): void {
  app.decorateRequest('actor', null);

  app.addHook('onRequest', async (request) => {
    if (request.is404) return;
    const permission = request.routeOptions.config.permission;
    const session = request.session;
    if (permission === undefined || session === null) return;

    const actor = await options.loadActor(session);
    const decision = can(actor, permission, { tenantId: session.tenantId });
    if (!decision.allowed) {
      await options.auditDeny(session.tenantId, {
        action: 'access.denied',
        actor: request.auditActor,
        resourceType: 'route',
        reason: decision.reason,
        metadata: { permission, method: request.method },
      });
      throw new AppError('forbidden');
    }
    request.actor = actor;
  });
}
