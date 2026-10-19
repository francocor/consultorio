import type { FastifyRequest } from 'fastify';

import type { Actor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import type { RunAs } from '../application/corrections.js';
import { PrescriptionConflict, PrescriptionDenied } from '../application/errors.js';
import type { Caller } from '../application/issue.js';

export interface PrescriptionRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
}

/** The professional the permission guard let through. Without one the request would not be here. */
function clinicalActor(request: FastifyRequest): Actor & { professionalId: string } {
  const actor = request.actor;
  if (!actor?.professionalId) throw new AppError('forbidden');
  return { ...actor, professionalId: actor.professionalId };
}

export interface Subject {
  resourceType: string;
  resourceId?: string;
  patientId?: string;
}

/**
 * Runs a request as the professional, in as many short transactions as it needs. Each step is a
 * transaction whose settings carry the professional, so the database policies see who is reading and
 * writing; nothing is held between two steps, so a request that waits for the provider in the middle
 * holds no connection (JD-S5 R2-12). A refusal decided by a service, in any step or between them,
 * becomes the uniform 403, and a state that does not allow the request becomes its own code (409);
 * both write their deny entry on a separate connection, so the rollback of the request cannot erase
 * it.
 */
export async function runPhasedAsProfessional<T>(
  deps: PrescriptionRoutesDeps,
  request: FastifyRequest,
  subject: Subject,
  fn: (run: RunAs, caller: Caller) => Promise<T>,
): Promise<T> {
  const actor = clinicalActor(request);
  const caller: Caller = {
    actor: { ...request.auditActor, userId: actor.userId },
    professionalId: actor.professionalId,
  };
  const run: RunAs = (work) =>
    deps.withTenant(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actingProfessionalId: actor.professionalId,
      },
      work,
    );
  try {
    return await fn(run, caller);
  } catch (error) {
    if (error instanceof PrescriptionDenied) {
      return refuseRequest(deps.auditDeny, request, {
        ...subject,
        reason: error.reason,
        ...(error.entry.prescriptionId === undefined
          ? {}
          : { resourceId: error.entry.prescriptionId }),
        ...(error.entry.patientId === undefined ? {} : { patientId: error.entry.patientId }),
      });
    }
    if (error instanceof AccessRefused) {
      return refuseRequest(deps.auditDeny, request, { reason: error.reason, ...subject });
    }
    if (error instanceof PrescriptionConflict) {
      await refuseRequest(deps.auditDeny, request, {
        ...subject,
        reason: error.reason,
        ...(error.entry.prescriptionId === undefined
          ? {}
          : { resourceId: error.entry.prescriptionId }),
        ...(error.entry.patientId === undefined ? {} : { patientId: error.entry.patientId }),
      }).catch(() => undefined);
      throw new AppError(error.code);
    }
    throw error;
  }
}

/** Runs a request as the professional, in one transaction. */
export function runAsProfessional<T>(
  deps: PrescriptionRoutesDeps,
  request: FastifyRequest,
  subject: Subject,
  fn: (tx: Tx, caller: Caller) => Promise<T>,
): Promise<T> {
  return runPhasedAsProfessional(deps, request, subject, (run, caller) =>
    run((tx) => fn(tx, caller)),
  );
}
