import {
  CashCloseRequest,
  CashCurrentQuery,
  CashCurrentResponse,
  CashOpenRequest,
  CashSessionDetailResponse,
  CashSessionDto,
  CashSessionListQuery,
  CashSessionListResponse,
  type CashRegisterOpenExtension,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { conflictWith } from '../../../platform/http/problem.js';
import {
  closeSession,
  currentSession,
  listSessions,
  openSession,
  sessionDetail,
} from '../application/cash-register.js';

import { actorOf, billingActorOf } from './context.js';

export interface CashRoutesDeps {
  withTenant: WithTenant;
  clock: () => Date;
}

const Params = z.strictObject({ id: z.uuid() });

/**
 * The cash register of each location: open it with the opening cash, close it with what was
 * counted. Reception works at its own locations; owners and administrators at all of them.
 */
export function cashRoutes(deps: CashRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/billing/cash/sessions',
      {
        config: { readOnly: 'write', permission: 'cash.operate', audits: ['cash.opened'] },
        schema: { body: CashOpenRequest, response: { 201: CashSessionDto } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const outcome = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            openSession(tx, {
              request: request.body,
              actor: billingActorOf(request),
              viewer: actor,
              now: deps.clock(),
            }),
        );
        if (!outcome.opened) {
          // The register that is already open, so the screen can go to it.
          const extra: CashRegisterOpenExtension = { existingSessionId: outcome.existingSessionId };
          return conflictWith(request, reply, extra);
        }
        return reply.code(201).send(outcome.session);
      },
    );

    typed.get(
      '/billing/cash/sessions',
      {
        config: { readOnly: 'read', permission: 'cash.operate' },
        schema: { querystring: CashSessionListQuery, response: { 200: CashSessionListResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => ({
          sessions: await listSessions(tx, { query: request.query, viewer: actor }),
        }));
      },
    );

    // Registered before `/billing/cash/sessions/:id`: "current" is not a register id.
    typed.get(
      '/billing/cash/current',
      {
        config: { readOnly: 'read', permission: 'cash.operate' },
        schema: { querystring: CashCurrentQuery, response: { 200: CashCurrentResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => ({
          session: await currentSession(tx, {
            locationId: request.query.locationId,
            viewer: actor,
          }),
        }));
      },
    );

    typed.get(
      '/billing/cash/sessions/:id',
      {
        config: { readOnly: 'read', permission: 'cash.operate' },
        schema: { params: Params, response: { 200: CashSessionDetailResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          sessionDetail(tx, { id: request.params.id, viewer: actor }),
        );
      },
    );

    typed.post(
      '/billing/cash/sessions/:id/close',
      {
        config: { readOnly: 'write', permission: 'cash.operate', audits: ['cash.closed'] },
        schema: { params: Params, body: CashCloseRequest, response: { 200: CashSessionDto } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          closeSession(tx, {
            id: request.params.id,
            request: request.body,
            actor: billingActorOf(request),
            viewer: actor,
            now: deps.clock(),
          }),
        );
      },
    );
  };
}
