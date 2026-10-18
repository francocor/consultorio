import {
  CreateExportRequest,
  DownloadLinkResponse,
  ExportRequestDto,
  ExportRequestListResponse,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { getExport, issueDownload, listExports, requestExport } from '../application/exports.js';

import { actorOf, billingActorOf } from './context.js';

export interface ExportRoutesDeps {
  withTenant: WithTenant;
  jobs: JobClient | undefined;
  tokens: ActionTokens;
}

const Params = z.strictObject({ id: z.uuid() });

/**
 * Exports of charges, payments and the payer settlement. Asking for one is allowed to everyone who
 * may read payments, and what the file lists is limited to what that person may see. Exports are
 * allowed in a read-only organization (category `export`): the data stays reachable. The file
 * itself is served by `GET /files/:token`; this is where the link is issued.
 */
export function exportRoutes(deps: ExportRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/billing/exports',
      {
        config: { readOnly: 'export', permission: 'payments.read', audits: ['export.requested'] },
        schema: { body: CreateExportRequest, response: { 202: ExportRequestDto } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const created = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            requestExport(tx, {
              request: request.body,
              actor: billingActorOf(request),
              viewer: actor,
              tenantId: actor.tenantId,
              jobs: deps.jobs,
            }),
        );
        return reply.code(202).send(created);
      },
    );

    typed.get(
      '/billing/exports',
      {
        config: { readOnly: 'read', permission: 'payments.read' },
        schema: { response: { 200: ExportRequestListResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => ({
          exports: await listExports(tx, actor.userId),
        }));
      },
    );

    typed.get(
      '/billing/exports/:id',
      {
        config: { readOnly: 'read', permission: 'payments.read' },
        schema: { params: Params, response: { 200: ExportRequestDto } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          getExport(tx, request.params.id, actor.userId),
        );
      },
    );

    typed.post(
      '/billing/exports/:id/download',
      {
        config: { readOnly: 'export', permission: 'payments.read', audits: 'none' },
        schema: { params: Params, response: { 200: DownloadLinkResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        const session = request.session;
        if (!session) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          issueDownload(tx, {
            id: request.params.id,
            userId: actor.userId,
            sessionId: session.sessionId,
            tokens: deps.tokens,
          }),
        );
      },
    );
  };
}
