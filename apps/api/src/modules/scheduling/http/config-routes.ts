import {
  AppointmentTypeDto,
  AppointmentTypeListResponse,
  BlockDto,
  BlockListQuery,
  BlockListResponse,
  CreateAppointmentTypeRequest,
  CreateBlockRequest,
  CreateDayOffRequest,
  DayOffDto,
  HolidayListResponse,
  HoursPeriodDto,
  HoursPeriodListResponse,
  SetHoursPeriodRequest,
  UpdateAppointmentTypeRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import type { AppointmentTypeService } from '../application/appointment-types.js';
import type { BlockService } from '../application/blocks.js';
import type { HolidayService } from '../application/holidays.js';
import type { HoursPeriodService } from '../application/hours-periods.js';
import { listVisibleBlocks } from '../application/visible-blocks.js';

export interface ConfigRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  types: AppointmentTypeService;
  blocks: BlockService;
  holidays: HolidayService;
  hoursPeriods: HoursPeriodService;
}

const IdParams = z.strictObject({ id: z.uuid() });
const ProfessionalParams = z.strictObject({ professionalId: z.uuid() });
const PeriodParams = z.strictObject({ professionalId: z.uuid(), periodId: z.uuid() });
const TypeListQuery = z.strictObject({
  includeInactive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
const RemoveBlockQuery = z.strictObject({ scope: z.enum(['occurrence', 'series']).optional() });
const YearQuery = z.strictObject({ year: z.coerce.number().int().min(2000).max(2100) });

function actorOf(request: FastifyRequest) {
  const actor = request.actor;
  if (!actor) throw new AppError('unauthenticated');
  const audit: AuditActor & { userId: string } = { ...request.auditActor, userId: actor.userId };
  return { actor, audit, context: { tenantId: actor.tenantId, userId: actor.userId } };
}

/**
 * Scheduling setup: what can be booked (types), when the calendar is closed (blocks, days off,
 * the holiday calendar) and the working hours of a professional for a range of dates. Everyone who
 * works with the calendar reads; owner and admin configure.
 */
export function configRoutes(deps: ConfigRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Appointment types ----------------------------------------------------------------------
    typed.get(
      '/appointment-types',
      {
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { querystring: TypeListQuery, response: { 200: AppointmentTypeListResponse } },
      },
      async (request) => {
        const { context } = actorOf(request);
        const types = await deps.withTenant(context, (tx) =>
          deps.types.list(tx, { includeInactive: request.query.includeInactive ?? false }),
        );
        return { types };
      },
    );

    typed.post(
      '/appointment-types',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.configure',
          audits: ['appointment_type.created'],
        },
        schema: { body: CreateAppointmentTypeRequest, response: { 201: AppointmentTypeDto } },
      },
      async (request, reply) => {
        const { audit, context } = actorOf(request);
        const created = await deps.withTenant(context, (tx) =>
          deps.types.create(tx, { actor: audit, request: request.body }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.patch(
      '/appointment-types/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.configure',
          audits: ['appointment_type.updated'],
        },
        schema: {
          params: IdParams,
          body: UpdateAppointmentTypeRequest,
          response: { 200: AppointmentTypeDto },
        },
      },
      async (request) => {
        const { audit, context } = actorOf(request);
        return deps.withTenant(context, (tx) =>
          deps.types.update(tx, { actor: audit, id: request.params.id, request: request.body }),
        );
      },
    );

    for (const [verb, active, action] of [
      ['deactivate', false, 'appointment_type.deactivated'],
      ['reactivate', true, 'appointment_type.reactivated'],
    ] as const) {
      typed.post(
        `/appointment-types/:id/${verb}`,
        {
          config: { readOnly: 'write', permission: 'scheduling.configure', audits: [action] },
          schema: { params: IdParams, response: { 200: AppointmentTypeDto } },
        },
        async (request) => {
          const { audit, context } = actorOf(request);
          return deps.withTenant(context, (tx) =>
            deps.types.setActive(tx, { actor: audit, id: request.params.id, active }),
          );
        },
      );
    }

    // Blocks ---------------------------------------------------------------------------------
    typed.get(
      '/schedule-blocks',
      {
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { querystring: BlockListQuery, response: { 200: BlockListResponse } },
      },
      async (request) => {
        const { actor, audit, context } = actorOf(request);
        try {
          const blocks = await deps.withTenant(context, (tx) =>
            listVisibleBlocks(tx, {
              blocks: deps.blocks,
              query: request.query,
              actor,
              auditActor: audit,
            }),
          );
          return { blocks };
        } catch (error) {
          // The same refusals as the calendar feed: a calendar that is not theirs, a location that
          // is not assigned.
          if (error instanceof AccessRefused) {
            return await refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'calendar',
              ...(request.query.professionalId === undefined
                ? {}
                : { resourceId: request.query.professionalId }),
            });
          }
          throw error;
        }
      },
    );

    typed.post(
      '/schedule-blocks',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.configure',
          audits: ['schedule_block.created'],
        },
        schema: {
          body: CreateBlockRequest,
          response: { 201: z.strictObject({ blocks: z.array(BlockDto) }) },
        },
      },
      async (request, reply) => {
        const { audit, context } = actorOf(request);
        const blocks = await deps.withTenant(context, (tx) =>
          deps.blocks.create(tx, { actor: audit, request: request.body }),
        );
        return reply.code(201).send({ blocks });
      },
    );

    typed.delete(
      '/schedule-blocks/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.configure',
          audits: ['schedule_block.removed'],
        },
        schema: { params: IdParams, querystring: RemoveBlockQuery },
      },
      async (request, reply) => {
        const { audit, context } = actorOf(request);
        await deps.withTenant(context, (tx) =>
          deps.blocks.remove(tx, {
            actor: audit,
            id: request.params.id,
            scope: request.query.scope ?? 'occurrence',
          }),
        );
        return reply.code(204).send();
      },
    );

    // Holiday calendar and days off ----------------------------------------------------------
    typed.get(
      '/holidays',
      {
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { querystring: YearQuery, response: { 200: HolidayListResponse } },
      },
      async (request) => {
        const { context } = actorOf(request);
        const holidays = await deps.withTenant(context, (tx) =>
          deps.holidays.holidaysOfYear(tx, request.query.year),
        );
        return { year: request.query.year, holidays };
      },
    );

    typed.post(
      '/days-off',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.configure',
          audits: ['day_off.created'],
        },
        schema: { body: CreateDayOffRequest, response: { 201: DayOffDto } },
      },
      async (request, reply) => {
        const { audit, context } = actorOf(request);
        const created = await deps.withTenant(context, (tx) =>
          deps.holidays.createDayOff(tx, { actor: audit, request: request.body }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.delete(
      '/days-off/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.configure',
          audits: ['day_off.removed'],
        },
        schema: { params: IdParams },
      },
      async (request, reply) => {
        const { audit, context } = actorOf(request);
        await deps.withTenant(context, (tx) =>
          deps.holidays.removeDayOff(tx, { actor: audit, id: request.params.id }),
        );
        return reply.code(204).send();
      },
    );

    // Working hours for a range of dates -----------------------------------------------------
    typed.get(
      '/professionals/:professionalId/hours-periods',
      {
        config: { readOnly: 'read', permission: 'staff.directory.read' },
        schema: { params: ProfessionalParams, response: { 200: HoursPeriodListResponse } },
      },
      async (request) => {
        const { context } = actorOf(request);
        const periods = await deps.withTenant(context, (tx) =>
          deps.hoursPeriods.list(tx, request.params.professionalId),
        );
        return { periods };
      },
    );

    typed.post(
      '/professionals/:professionalId/hours-periods',
      {
        config: {
          readOnly: 'write',
          permission: 'staff.directory.read',
          audits: ['professional.hours_period_set'],
        },
        schema: {
          params: ProfessionalParams,
          body: SetHoursPeriodRequest,
          response: { 201: HoursPeriodDto },
        },
      },
      async (request, reply) => {
        const { actor, audit, context } = actorOf(request);
        try {
          const created = await deps.withTenant(context, (tx) =>
            deps.hoursPeriods.set(tx, {
              actor: audit,
              viewer: { membershipId: actor.membershipId, roles: actor.roles },
              professionalId: request.params.professionalId,
              request: request.body,
            }),
          );
          return await reply.code(201).send(created);
        } catch (error) {
          if (error instanceof AccessRefused) {
            return await refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'professional',
              resourceId: request.params.professionalId,
            });
          }
          throw error;
        }
      },
    );

    typed.delete(
      '/professionals/:professionalId/hours-periods/:periodId',
      {
        config: {
          readOnly: 'write',
          permission: 'staff.directory.read',
          audits: ['professional.hours_period_removed'],
        },
        schema: { params: PeriodParams },
      },
      async (request, reply) => {
        const { actor, audit, context } = actorOf(request);
        try {
          await deps.withTenant(context, (tx) =>
            deps.hoursPeriods.remove(tx, {
              actor: audit,
              viewer: { membershipId: actor.membershipId, roles: actor.roles },
              professionalId: request.params.professionalId,
              periodId: request.params.periodId,
            }),
          );
          return await reply.code(204).send();
        } catch (error) {
          if (error instanceof AccessRefused) {
            return await refuseRequest(deps.auditDeny, request, {
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
