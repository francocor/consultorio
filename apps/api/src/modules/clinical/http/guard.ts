import type { FastifyRequest } from 'fastify';

import type { Actor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { NoteConflict, NoteDenied } from '../application/errors.js';
import type { Caller } from '../application/notes.js';

export interface ClinicalRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
}

/** The professional the permission guard let through. Without one the request would not be here. */
function clinicalActor(request: FastifyRequest): Actor & { professionalId: string } {
  const actor = request.actor;
  if (!actor?.professionalId) throw new AppError('forbidden');
  return { ...actor, professionalId: actor.professionalId };
}

/** False while the organization is read-only (the read-only policy let this route through). */
function tenantIsActive(request: FastifyRequest): boolean {
  const context = request.hostContext;
  return context?.kind !== 'tenant' || context.tenant.status === 'active';
}

export interface Subject {
  resourceType: string;
  resourceId?: string;
  patientId?: string;
}

/**
 * Runs a clinical request as the professional: a transaction whose settings carry the
 * professional, so the database policies see who is reading. A refusal decided by a service
 * becomes the uniform 403, a state conflict becomes 409; both write their deny entry on a
 * separate connection, so the rollback of the request cannot erase it.
 */
export async function runAsProfessional<T>(
  deps: ClinicalRoutesDeps,
  request: FastifyRequest,
  subject: Subject,
  fn: (tx: Tx, caller: Caller) => Promise<T>,
): Promise<T> {
  const actor = clinicalActor(request);
  const caller: Caller = {
    actor: { ...request.auditActor, userId: actor.userId },
    professionalId: actor.professionalId,
    tenantActive: tenantIsActive(request),
  };
  try {
    return await deps.withTenant(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actingProfessionalId: actor.professionalId,
      },
      (tx) => fn(tx, caller),
    );
  } catch (error) {
    if (error instanceof NoteDenied) {
      return refuseRequest(deps.auditDeny, request, {
        ...subject,
        reason: error.reason,
        resourceId: error.entry.noteId,
        patientId: error.entry.patientId,
      });
    }
    if (error instanceof AccessRefused) {
      return refuseRequest(deps.auditDeny, request, { reason: error.reason, ...subject });
    }
    if (error instanceof NoteConflict) {
      await refuseRequest(deps.auditDeny, request, {
        ...subject,
        reason: error.reason,
        resourceId: error.entry.noteId,
        patientId: error.entry.patientId,
      }).catch(() => undefined);
      throw new AppError('conflict');
    }
    throw error;
  }
}
