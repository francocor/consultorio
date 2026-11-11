import { ErxConnectionDto, PutErxConnectionRequest } from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PrescriptionDeps } from '../application/common.js';
import { putConnection, readConnection } from '../application/connection.js';

export interface ConnectionRoutesDeps {
  withTenant: WithTenant;
  services: PrescriptionDeps;
}

/**
 * The connection of the organization to the e-prescription provider (`tenant.settings.manage`:
 * owner and admin). Whether it is switched on is theirs to decide; the credentials a real provider
 * needs are written once and never returned by any of these routes.
 */
export function connectionRoutes(deps: ConnectionRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function run<T>(request: FastifyRequest, work: (tx: Tx) => Promise<T>): Promise<T> {
      const { actor } = request;
      if (!actor) throw new AppError('unauthenticated');
      return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
    }

    typed.get(
      '/prescriptions/connection',
      {
        config: { readOnly: 'read', permission: 'tenant.settings.manage' },
        schema: { response: { 200: ErxConnectionDto } },
      },
      (request) => run(request, (tx) => readConnection(tx, deps.services)),
    );

    typed.put(
      '/prescriptions/connection',
      {
        config: {
          readOnly: 'write',
          permission: 'tenant.settings.manage',
          audits: ['setting.changed'],
        },
        schema: { body: PutErxConnectionRequest, response: { 200: ErxConnectionDto } },
      },
      (request) =>
        run(request, (tx) =>
          putConnection(tx, deps.services, {
            actor: { ...request.auditActor, userId: request.actor?.userId ?? null },
            request: request.body,
          }),
        ),
    );
  };
}
