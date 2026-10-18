import type { FastifyRequest } from 'fastify';

import type { Actor } from '../../../platform/authz/actor.js';
import { AppError } from '../../../platform/http/problem.js';
import type { BillingActor } from '../application/common.js';

/** Who is acting. A route with a permission always has one; anything else is not signed in. */
export function actorOf(request: FastifyRequest): Actor {
  const actor = request.actor;
  if (!actor) throw new AppError('unauthenticated');
  return actor;
}

/** The actor in the shape the audit writer and the author columns want. */
export function billingActorOf(request: FastifyRequest): BillingActor {
  const actor = actorOf(request);
  return { ...request.auditActor, userId: actor.userId };
}

/** The tenant of the request, from its host. */
export function tenantOf(request: FastifyRequest) {
  const context = request.hostContext;
  if (context?.kind !== 'tenant') throw new AppError('unauthenticated');
  return context.tenant;
}
