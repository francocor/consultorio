import { SetWeeklyHoursRequest, WeeklyHoursResponse } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import type { HoursService } from '../application/hours.js';

export interface HoursRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  hours: HoursService;
}

const ProfessionalParams = z.strictObject({ professionalId: z.uuid() });

/**
 * Weekly working hours of a professional. Everyone on the staff reads them (reception books with
 * them); the professional and those who manage staff edit them.
 */
export function hoursRoutes(deps: HoursRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/professionals/:professionalId/hours',
      {
        config: { readOnly: 'read', permission: 'staff.directory.read' },
        schema: { params: ProfessionalParams, response: { 200: WeeklyHoursResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const hours = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => deps.hours.get(tx, request.params.professionalId),
        );
        return { professionalId: request.params.professionalId, hours };
      },
    );

    typed.put(
      '/professionals/:professionalId/hours',
      {
        config: {
          readOnly: 'write',
          permission: 'staff.directory.read',
          audits: ['professional.hours_updated'],
        },
        schema: {
          params: ProfessionalParams,
          body: SetWeeklyHoursRequest,
          response: { 200: WeeklyHoursResponse },
        },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          const hours = await deps.withTenant(
            { tenantId: actor.tenantId, userId: actor.userId },
            (tx) =>
              deps.hours.set(tx, {
                actor: { ...request.auditActor, userId: actor.userId },
                viewer: { membershipId: actor.membershipId, roles: actor.roles },
                professionalId: request.params.professionalId,
                request: request.body,
              }),
          );
          return { professionalId: request.params.professionalId, hours };
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'professional',
              resourceId: request.params.professionalId,
            });
          }
          throw error;
        }
      },
    );
  };
}
