import {
  CreateLocationRequest,
  LocationDto,
  LocationListResponse,
  MemberLocationsResponse,
  SetMemberLocationsRequest,
  UpdateLocationRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { LocationService } from '../application/locations.js';

export interface LocationRoutesDeps {
  withTenant: WithTenant;
  locations: LocationService;
  /** The time zone a new location gets when none is sent, from the country of the organization. */
  defaultTimeZone: (country: string) => string;
}

const LocationParams = z.strictObject({ id: z.uuid() });
const MemberParams = z.strictObject({ membershipId: z.uuid() });
const ListQuery = z.strictObject({
  includeInactive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export function locationRoutes(deps: LocationRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/locations',
      {
        // Everyone on the staff may list; what they get depends on where they work.
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { querystring: ListQuery, response: { 200: LocationListResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const locations = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.locations.list(
              tx,
              { roles: actor.roles, membershipId: actor.membershipId },
              { includeInactive: request.query.includeInactive ?? false },
            ),
        );
        return { locations };
      },
    );

    typed.post(
      '/locations',
      {
        config: { readOnly: 'write', permission: 'locations.manage', audits: ['location.created'] },
        schema: { body: CreateLocationRequest, response: { 201: LocationDto } },
      },
      async (request, reply) => {
        const actor = request.actor;
        const context = request.hostContext;
        if (!actor || context?.kind !== 'tenant') throw new AppError('unauthenticated');
        const created = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.locations.create(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              name: request.body.name,
              timeZone: request.body.timeZone ?? deps.defaultTimeZone(context.tenant.country),
            }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.patch(
      '/locations/:id',
      {
        config: { readOnly: 'write', permission: 'locations.manage', audits: ['location.updated'] },
        schema: {
          params: LocationParams,
          body: UpdateLocationRequest,
          response: { 200: LocationDto },
        },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.locations.update(tx, {
            actor: { ...request.auditActor, userId: actor.userId },
            locationId: request.params.id,
            name: request.body.name,
            timeZone: request.body.timeZone,
          }),
        );
      },
    );

    for (const [verb, active, action] of [
      ['deactivate', false, 'location.deactivated'],
      ['reactivate', true, 'location.reactivated'],
    ] as const) {
      typed.post(
        `/locations/:id/${verb}`,
        {
          config: { readOnly: 'write', permission: 'locations.manage', audits: [action] },
          schema: { params: LocationParams, response: { 200: LocationDto } },
        },
        async (request) => {
          const actor = request.actor;
          if (!actor) throw new AppError('unauthenticated');
          return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.locations.setActive(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              locationId: request.params.id,
              active,
            }),
          );
        },
      );
    }

    typed.get(
      '/members/:membershipId/locations',
      {
        config: { readOnly: 'read', permission: 'staff.manage' },
        schema: { params: MemberParams, response: { 200: MemberLocationsResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const locationIds = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => deps.locations.memberLocations(tx, request.params.membershipId),
        );
        return { membershipId: request.params.membershipId, locationIds };
      },
    );

    typed.put(
      '/members/:membershipId/locations',
      {
        config: {
          readOnly: 'write',
          permission: 'staff.manage',
          audits: ['location_membership.changed'],
        },
        schema: {
          params: MemberParams,
          body: SetMemberLocationsRequest,
          response: { 200: MemberLocationsResponse },
        },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const locationIds = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.locations.setMemberLocations(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              membershipId: request.params.membershipId,
              locationIds: request.body.locationIds,
            }),
        );
        return { membershipId: request.params.membershipId, locationIds };
      },
    );
  };
}
