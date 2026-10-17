import {
  OwnerProfessionalRequest,
  ProfessionalDto,
  ProfessionalProfileRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import type { OwnerProfessionalService } from '../application/owner-professional.js';
import type { ProfileService } from '../application/profile.js';

export interface ProfileRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  profiles: ProfileService;
  ownerProfessional: OwnerProfessionalService;
}

const MemberParams = z.strictObject({ membershipId: z.uuid() });

/**
 * The professional profile of a member. The person edits their own; an owner or admin edits
 * anyone's. Whether the registration is verified is not here: only the platform operator sets it.
 */
export function profileRoutes(deps: ProfileRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/staff/:membershipId/professional-profile',
      {
        // Everyone on the staff has this permission; the service limits it to the person and to
        // those who manage staff.
        config: { readOnly: 'read', permission: 'staff.directory.read' },
        schema: { params: MemberParams, response: { 200: ProfessionalDto } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          return await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.profiles.find(tx, {
              actorMembershipId: actor.membershipId,
              actorRoles: actor.roles,
              targetMembershipId: request.params.membershipId,
            }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'membership',
              resourceId: request.params.membershipId,
            });
          }
          throw error;
        }
      },
    );

    // An owner acts as a health professional (decision D21, revised): completing the profile grants
    // the professional role in the same transaction. The service reads the roles from the
    // database, so only an active owner gets in; `staff.manage` is the permission of owners and
    // admins, and an admin is refused by the service with an audited denial.
    typed.post(
      '/staff/me/professional',
      {
        config: {
          readOnly: 'write',
          permission: 'staff.manage',
          audits: ['role.changed', 'staff.profile_updated'],
        },
        schema: { body: OwnerProfessionalRequest, response: { 200: ProfessionalDto } },
      },
      async (request) => {
        const actor = request.actor;
        const context = request.hostContext;
        if (!actor || context?.kind !== 'tenant') throw new AppError('unauthenticated');
        try {
          return await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.ownerProfessional.activate(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              membershipId: actor.membershipId,
              roles: actor.roles,
              country: context.tenant.country,
              request: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'membership',
              resourceId: actor.membershipId,
            });
          }
          throw error;
        }
      },
    );

    typed.put(
      '/staff/:membershipId/professional-profile',
      {
        config: {
          readOnly: 'write',
          permission: 'staff.directory.read',
          audits: ['staff.profile_updated'],
        },
        schema: {
          params: MemberParams,
          body: ProfessionalProfileRequest,
          response: { 200: ProfessionalDto },
        },
      },
      async (request) => {
        const actor = request.actor;
        const context = request.hostContext;
        if (!actor || context?.kind !== 'tenant') throw new AppError('unauthenticated');
        try {
          return await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.profiles.save(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              actorMembershipId: actor.membershipId,
              actorRoles: actor.roles,
              targetMembershipId: request.params.membershipId,
              country: context.tenant.country,
              request: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'membership',
              resourceId: request.params.membershipId,
            });
          }
          throw error;
        }
      },
    );
  };
}
