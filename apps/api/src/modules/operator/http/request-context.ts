import type { FastifyRequest } from 'fastify';

import type { PlatformAuditActor } from '../../../platform/audit/platform-audit.js';
import { AppError } from '../../../platform/http/problem.js';
import type { OperatorIdentity } from '../application/context.js';

/**
 * What a route of the operator console reads from its request: who is signed in, and the origin of
 * the request for the platform trail. The console's own routes and the routes other modules add to
 * it (`ModuleWiring.operatorRoutes`) use the same two functions.
 */

/** The operator of the request; a route without a session fails closed instead of acting as nobody. */
export function operatorOf(request: FastifyRequest): OperatorIdentity {
  if (!request.operator) throw new AppError('unauthenticated');
  return request.operator.operator;
}

/** The origin of the request, in the shape the platform audit writer takes beside the operator id. */
export function platformAuditMetaOf(
  request: FastifyRequest,
): Omit<PlatformAuditActor, 'operatorId'> {
  const { ip, userAgent, requestId } = request.auditActor;
  return { ip, userAgent, requestId };
}
