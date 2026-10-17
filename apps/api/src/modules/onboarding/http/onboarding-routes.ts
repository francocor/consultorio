import {
  FastPathRequest,
  FastPathResponse,
  InvitationImpactDto,
  OnboardingStateDto,
  ProfessionalStepRequest,
  STAFF_ROLES,
  UpdateOnboardingStateRequest,
  type StaffRole,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import type { OnboardingActor, OnboardingService } from '../application/onboarding.js';

export interface OnboardingRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  onboarding: OnboardingService;
}

const ImpactQuery = z.strictObject({
  roles: z
    .string()
    .transform((value) => value.split(',').map((role) => role.trim()))
    .pipe(z.array(z.enum(STAFF_ROLES)).min(1).max(STAFF_ROLES.length)),
});

/** Who is asking and the facts the services need, from the request the guard already checked. */
function actorOf(request: FastifyRequest): OnboardingActor {
  const actor = request.actor;
  const host = request.hostContext;
  if (!actor || host?.kind !== 'tenant') throw new AppError('unauthenticated');
  return {
    audit: { ...request.auditActor, userId: actor.userId },
    membershipId: actor.membershipId,
    roles: actor.roles,
    country: host.tenant.country,
  };
}

/**
 * The guided first run (tenant-onboarding, Part A). Everything needs `onboarding.manage`: the
 * owner, and an admin only by an explicit grant. The tenant always comes from the session.
 */
export function onboardingRoutes(deps: OnboardingRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    /** Runs a service call as the organization; a refusal becomes the uniform audited 403. */
    async function run<T>(
      request: FastifyRequest,
      call: (tx: Tx, actor: OnboardingActor) => Promise<T>,
    ): Promise<T> {
      const actor = actorOf(request);
      const session = request.actor;
      if (!session) throw new AppError('unauthenticated');
      try {
        return await deps.withTenant({ tenantId: session.tenantId, userId: session.userId }, (tx) =>
          call(tx, actor),
        );
      } catch (error) {
        if (error instanceof AccessRefused) {
          return refuseRequest(deps.auditDeny, request, {
            reason: error.reason,
            resourceType: 'onboarding',
          });
        }
        throw error;
      }
    }

    typed.get(
      '/onboarding/state',
      {
        config: { readOnly: 'read', permission: 'onboarding.manage' },
        schema: { response: { 200: OnboardingStateDto } },
      },
      (request) => run(request, (tx) => deps.onboarding.get(tx)),
    );

    typed.put(
      '/onboarding/state',
      {
        config: {
          readOnly: 'write',
          permission: 'onboarding.manage',
          audits: [
            'onboarding.step_updated',
            'onboarding.checklist_dismissed',
            'onboarding.checklist_restored',
          ],
        },
        schema: { body: UpdateOnboardingStateRequest, response: { 200: OnboardingStateDto } },
      },
      (request) =>
        run(request, (tx, actor) => deps.onboarding.update(tx, { actor, request: request.body })),
    );

    typed.post(
      '/onboarding/professional',
      {
        config: {
          readOnly: 'write',
          permission: 'onboarding.manage',
          audits: ['onboarding.step_updated', 'role.changed', 'staff.profile_updated'],
        },
        schema: { body: ProfessionalStepRequest, response: { 200: OnboardingStateDto } },
      },
      (request) =>
        run(request, (tx, actor) =>
          deps.onboarding.professionalStep(tx, { actor, request: request.body }),
        ),
    );

    typed.post(
      '/onboarding/fast-path',
      {
        config: {
          readOnly: 'write',
          permission: 'onboarding.manage',
          audits: [
            'onboarding.fast_path',
            'onboarding.completed',
            'role.changed',
            'staff.profile_updated',
            'location.created',
            'professional.hours_updated',
            'appointment_type.created',
          ],
        },
        schema: { body: FastPathRequest, response: { 200: FastPathResponse } },
      },
      (request) =>
        run(request, (tx, actor) => deps.onboarding.fastPath(tx, { actor, request: request.body })),
    );

    typed.post(
      '/onboarding/complete',
      {
        config: {
          readOnly: 'write',
          permission: 'onboarding.manage',
          audits: ['onboarding.completed'],
        },
        schema: { response: { 200: OnboardingStateDto } },
      },
      (request) => run(request, (tx, actor) => deps.onboarding.complete(tx, { actor })),
    );

    typed.get(
      '/onboarding/invitation-impact',
      {
        config: { readOnly: 'read', permission: 'onboarding.manage' },
        schema: { querystring: ImpactQuery, response: { 200: InvitationImpactDto } },
      },
      (request) =>
        run(request, (tx) => {
          const roles: StaffRole[] = request.query.roles;
          return deps.onboarding.invitationImpact(tx, roles);
        }),
    );
  };
}
