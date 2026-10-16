import {
  CreateSupportGrantRequest,
  SupportGrantDto,
  SupportGrantListResponse,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { SupportGrants } from '../application/support-grants.js';

export interface SupportRoutesDeps {
  withTenant: WithTenant;
  grants: SupportGrants;
}

const GrantParams = z.strictObject({ grantId: z.uuid() });

/** The owner opens and closes the window in which the platform may help with configuration. */
export function supportRoutes(deps: SupportRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/support-grants',
      {
        config: { readOnly: 'read', permission: 'tenant.support.manage' },
        schema: { response: { 200: SupportGrantListResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const grants = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => deps.grants.list(tx),
        );
        return { grants };
      },
    );

    typed.post(
      '/support-grants',
      {
        config: {
          readOnly: 'write',
          permission: 'tenant.support.manage',
          audits: ['support.grant.created'],
        },
        schema: { body: CreateSupportGrantRequest, response: { 201: SupportGrantDto } },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const grant = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.grants.create(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              userId: actor.userId,
              request: request.body,
            }),
        );
        return reply.code(201).send(grant);
      },
    );

    typed.delete(
      '/support-grants/:grantId',
      {
        config: {
          readOnly: 'write',
          permission: 'tenant.support.manage',
          audits: ['support.grant.revoked'],
        },
        schema: { params: GrantParams },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.grants.revoke(tx, {
            actor: { ...request.auditActor, userId: actor.userId },
            userId: actor.userId,
            grantId: request.params.grantId,
          }),
        );
        return reply.code(204).send();
      },
    );
  };
}
