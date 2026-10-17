import { WorklistItemDto, WorklistQuery, WorklistResponse } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import type { WorklistService } from '../application/worklist.js';

import { requestActor } from './appointment-routes.js';

export interface WorklistRoutesDeps {
  withTenant: WithTenant;
  worklist: WorklistService;
}

const IdParams = z.strictObject({ id: z.uuid() });
const NoBody = z.strictObject({});

/**
 * The reception worklist: one queue for everything that needs a person. Owner, admin and reception
 * work it (permission `worklist.manage`); reception sees the locations it is assigned to.
 */
export function worklistRoutes(deps: WorklistRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/worklist',
      {
        config: { readOnly: 'read', permission: 'worklist.manage' },
        schema: { querystring: WorklistQuery, response: { 200: WorklistResponse } },
      },
      (request) => {
        const { actor, context } = requestActor(request);
        return deps.withTenant(context, (tx) =>
          deps.worklist.list(
            tx,
            { roles: actor.roles, membershipId: actor.membershipId },
            request.query,
          ),
        );
      },
    );

    for (const [verb, status, action, resolution] of [
      ['resolve', 'resolved', 'worklist.resolved', 'handled'],
      ['dismiss', 'dismissed', 'worklist.dismissed', 'dismissed'],
    ] as const) {
      typed.post(
        `/worklist/:id/${verb}`,
        {
          config: { readOnly: 'write', permission: 'worklist.manage', audits: [action] },
          schema: { params: IdParams, body: NoBody, response: { 200: WorklistItemDto } },
        },
        (request) => {
          const { actor, audit, context } = requestActor(request);
          return deps.withTenant(context, (tx) =>
            deps.worklist.close(tx, {
              id: request.params.id,
              viewer: { roles: actor.roles, membershipId: actor.membershipId },
              actor: audit,
              status,
              resolution,
            }),
          );
        },
      );
    }
  };
}
