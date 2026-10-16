import type { FastifyRequest } from 'fastify';

import { AppError } from '../http/problem.js';

import type { AuthzOptions } from './guard.js';

export interface Refusal {
  /** Short machine-readable reason for the audit trail. Never sent to the caller. */
  reason: string;
  resourceType: string;
  resourceId?: string;
  patientId?: string;
  /** Field names and short scalars only (validated by the audit writer). */
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Turns a refusal decided by a service into the uniform 403, after writing a deny entry to the
 * audit log on its own connection (so the rollback of the request cannot erase it). If the entry
 * cannot be written the answer is still a refusal: access is never granted because auditing failed.
 */
export async function refuseRequest(
  auditDeny: AuthzOptions['auditDeny'],
  request: FastifyRequest,
  refusal: Refusal,
): Promise<never> {
  const actor = request.actor;
  if (actor) {
    await auditDeny(actor.tenantId, {
      action: 'access.denied',
      actor: request.auditActor,
      resourceType: refusal.resourceType,
      ...(refusal.resourceId === undefined ? {} : { resourceId: refusal.resourceId }),
      ...(refusal.patientId === undefined ? {} : { patientId: refusal.patientId }),
      reason: refusal.reason,
      metadata: refusal.metadata ?? {},
    });
  }
  throw new AppError('forbidden');
}
