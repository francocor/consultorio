import { effectivePermissions } from '@consultorio/contracts';
import type { FastifyRequest } from 'fastify';

import type { Actor } from '../../../platform/authz/actor.js';
import { AppError } from '../../../platform/http/problem.js';
import type { DemographicsEditor } from '../application/write-access.js';

/** The tenant of the request, from its host. Anything else is not a tenant request. */
export function tenantOf(request: FastifyRequest) {
  const context = request.hostContext;
  if (context?.kind !== 'tenant') throw new AppError('unauthenticated');
  return context.tenant;
}

/** What the write rule needs to know about whoever is acting. */
export function demographicsEditor(actor: Actor): DemographicsEditor {
  return {
    canAdminister: effectivePermissions(actor.roles, actor.grants).includes('patients.administer'),
    professionalId: actor.professionalId,
  };
}
