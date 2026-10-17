import {
  BookingLinkDto,
  BookingLinksResponse,
  CreateBookingLinkRequest,
  UpdateBookingLinkRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { LinkService } from '../application/links.js';

export interface LinkRoutesDeps {
  withTenant: WithTenant;
  links: LinkService;
  clock: () => Date;
}

const IdParams = z.strictObject({ id: z.uuid() });

/** The links screen of the organization: owners and admins (`booking.manage`). */
export function linkRoutes(deps: LinkRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function scope(request: FastifyRequest) {
      const actor = request.actor;
      if (!actor) throw new AppError('unauthenticated');
      return {
        context: { tenantId: actor.tenantId, userId: actor.userId },
        audit: { ...request.auditActor, userId: actor.userId },
      };
    }

    typed.get(
      '/booking-links',
      {
        config: { readOnly: 'read', permission: 'booking.manage' },
        schema: { response: { 200: BookingLinksResponse } },
      },
      (request) => {
        const { context } = scope(request);
        return deps.withTenant(context, (tx) => deps.links.list(tx));
      },
    );

    typed.post(
      '/booking-links',
      {
        config: {
          readOnly: 'write',
          permission: 'booking.manage',
          audits: ['booking.link.enabled'],
        },
        schema: { body: CreateBookingLinkRequest, response: { 201: BookingLinkDto } },
      },
      async (request, reply) => {
        const { context, audit } = scope(request);
        const created = await deps.withTenant(context, (tx) =>
          deps.links.create(tx, { actor: audit, request: request.body }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.patch(
      '/booking-links/:id',
      {
        config: {
          readOnly: 'write',
          permission: 'booking.manage',
          audits: ['booking.link.enabled', 'booking.link.disabled'],
        },
        schema: {
          params: IdParams,
          body: UpdateBookingLinkRequest,
          response: { 200: BookingLinkDto },
        },
      },
      (request) => {
        const { context, audit } = scope(request);
        return deps.withTenant(context, (tx) =>
          deps.links.update(tx, { actor: audit, id: request.params.id, request: request.body }),
        );
      },
    );

    typed.post(
      '/booking-links/:id/regenerate',
      {
        config: {
          readOnly: 'write',
          permission: 'booking.manage',
          audits: ['booking.link.regenerated'],
        },
        schema: {
          params: IdParams,
          body: z.strictObject({}).optional(),
          response: { 200: BookingLinkDto },
        },
      },
      (request) => {
        const { context, audit } = scope(request);
        return deps.withTenant(context, (tx) =>
          deps.links.regenerate(tx, { actor: audit, id: request.params.id, now: deps.clock() }),
        );
      },
    );
  };
}
