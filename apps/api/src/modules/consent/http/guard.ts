import type { FastifyRequest } from 'fastify';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { RequestContext, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { ConsentRefused } from '../application/refusal.js';

export interface ConsentRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
}

/** The caller the permission guard let through. A request without one never reaches a handler. */
export function actorOf(request: FastifyRequest): Actor {
  const actor = request.actor;
  if (!actor) throw new AppError('unauthenticated');
  return actor;
}

/**
 * The transaction of a request. A professional's transaction acts as the professional, so the
 * clinical row policies of the database see who is asking; everyone else's has no professional.
 */
export function transactionOf(actor: Actor): RequestContext {
  return {
    tenantId: actor.tenantId,
    userId: actor.userId,
    actingProfessionalId: actor.professionalId,
  };
}

/** Who acted and from where, for the audit entry the service writes. */
export function auditActorOf(
  request: FastifyRequest,
  actor: Actor,
): AuditActor & { userId: string } {
  return { ...request.auditActor, userId: actor.userId };
}

/** Turns a refusal decided by a service into the uniform 403 with its audit entry. */
export async function refuse(
  deps: Pick<ConsentRoutesDeps, 'auditDeny'>,
  request: FastifyRequest,
  error: AccessRefused,
  extra: { resourceType?: string; resourceId?: string; patientId?: string } = {},
): Promise<never> {
  const known = error instanceof ConsentRefused ? error.context : {};
  return refuseRequest(deps.auditDeny, request, {
    reason: error.reason,
    ...extra,
    resourceType: 'consent_request',
    ...known,
  });
}

/** Runs a handler and answers a refusal of the service as the uniform 403. */
export async function withRefusals<T>(
  deps: Pick<ConsentRoutesDeps, 'auditDeny'>,
  request: FastifyRequest,
  extra: { resourceType?: string; resourceId?: string; patientId?: string },
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AccessRefused) return refuse(deps, request, error, extra);
    throw error;
  }
}
