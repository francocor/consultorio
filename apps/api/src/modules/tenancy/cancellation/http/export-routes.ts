import { DownloadLinkResponse, ExportPackageResponse } from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { Actor } from '../../../../platform/authz/actor.js';
import type { WithTenant } from '../../../../platform/db/tenant-context.js';
import { AppError } from '../../../../platform/http/problem.js';
import type { CancellationDelivery } from '../delivery.js';

export interface ExportRoutesDeps {
  withTenant: WithTenant;
  delivery: CancellationDelivery;
}

function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) throw new AppError('unauthenticated');
  return request.actor;
}

/**
 * The packages of the cancellation export for the people they belong to. The two audiences have two
 * routes and two permissions on purpose: `billing.manage` (the owner) reaches only the
 * administrative package, `clinical.note.read` (a professional) reaches only their own clinical one,
 * and neither route takes an id, so there is nothing to point at another person's package. The file
 * itself is served by `GET /files/:token`; these routes say where the package stands and issue the
 * link. All of them work in a cancelling, read-only or cancelled organization (category `export`).
 */
export function exportRoutes(deps: ExportRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    const sessionIdOf = (request: FastifyRequest): string => {
      if (!request.session) throw new AppError('unauthenticated');
      return request.session.sessionId;
    };

    typed.get(
      '/cancellation/export/administrative',
      {
        config: { readOnly: 'read', permission: 'billing.manage' },
        schema: { response: { 200: ExportPackageResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.delivery.administrative(tx),
        );
      },
    );

    typed.post(
      '/cancellation/export/administrative/download',
      {
        config: {
          readOnly: 'export',
          permission: 'billing.manage',
          audits: ['export.cancellation.requested'],
        },
        schema: { response: { 200: DownloadLinkResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.delivery.issueLink(tx, {
            kind: 'administrative',
            actor,
            auditActor: { ...request.auditActor, userId: actor.userId },
            sessionId: sessionIdOf(request),
          }),
        );
      },
    );

    typed.get(
      '/cancellation/export/clinical',
      {
        config: { readOnly: 'read', permission: 'clinical.note.read' },
        schema: { response: { 200: ExportPackageResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            actingProfessionalId: actor.professionalId,
          },
          (tx) => deps.delivery.clinical(tx, actor),
        );
      },
    );

    typed.post(
      '/cancellation/export/clinical/download',
      {
        config: {
          readOnly: 'export',
          permission: 'clinical.note.read',
          audits: ['export.cancellation.requested'],
        },
        schema: { response: { 200: DownloadLinkResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            actingProfessionalId: actor.professionalId,
          },
          (tx) =>
            deps.delivery.issueLink(tx, {
              kind: 'clinical',
              actor,
              auditActor: { ...request.auditActor, userId: actor.userId },
              sessionId: sessionIdOf(request),
            }),
        );
      },
    );
  };
}
