import {
  DocumentDto,
  DocumentListResponse,
  DocumentVersionsResponse,
  DownloadLinkResponse,
  HideDocumentRequest,
  ReclassifyDocumentRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import type { DownloadService } from '../application/downloads.js';
import type { LifecycleService } from '../application/lifecycle.js';
import type { ListingService } from '../application/listing.js';

import { actorOf, refuse, transactionOf } from './document-routes.js';

export interface AccessRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  listing: ListingService;
  downloads: DownloadService;
  lifecycle: LifecycleService;
}

const DocumentParams = z.strictObject({ id: z.uuid() });
const PatientParams = z.strictObject({ id: z.uuid() });
const ListQuery = z.strictObject({
  includeHidden: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
/**
 * Reading, requesting the download of, and managing documents that exist. The download itself is
 * `GET /files/:token`, the shared door of the platform (`platform/files/file-routes.ts`). Every route here carries the broad
 * permission of its action (`patients.read` or `patients.write`); which documents the caller may
 * touch is decided per document by the service and, underneath, by row level security. A refusal
 * the service decides becomes the uniform 403 with an audit entry.
 */
export function accessRoutes(deps: AccessRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/patients/:id/documents',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: {
          params: PatientParams,
          querystring: ListQuery,
          response: { 200: DocumentListResponse },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.listing.list(tx, {
            actor,
            patientId: request.params.id,
            includeHidden: request.query.includeHidden ?? false,
          }),
        );
      },
    );

    typed.get(
      '/documents/:id/versions',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: DocumentParams, response: { 200: DocumentVersionsResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        try {
          return await deps.withTenant(transactionOf(actor), (tx) =>
            deps.listing.versions(tx, { actor, documentId: request.params.id }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuse(deps, request, error, { resourceId: request.params.id });
          }
          throw error;
        }
      },
    );

    typed.post(
      '/documents/:id/download-link',
      {
        // Issuing a link is a read (design 7, "Read-only policy"): it works in a read-only organization.
        config: { readOnly: 'read', permission: 'patients.read', audits: 'none' },
        schema: { params: DocumentParams, response: { 200: DownloadLinkResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        const session = request.session;
        if (!session) throw new AppError('unauthenticated');
        try {
          return await deps.withTenant(transactionOf(actor), (tx) =>
            deps.downloads.issue(tx, {
              actor,
              sessionId: session.sessionId,
              documentId: request.params.id,
            }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuse(deps, request, error, { resourceId: request.params.id });
          }
          throw error;
        }
      },
    );

    typed.post(
      '/documents/:id/hide',
      {
        config: { readOnly: 'write', permission: 'patients.write', audits: ['document.hidden'] },
        schema: {
          params: DocumentParams,
          body: HideDocumentRequest,
          response: { 200: DocumentDto },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        try {
          return await deps.withTenant(transactionOf(actor), (tx) =>
            deps.lifecycle.hide(tx, {
              actor,
              auditActor: { ...request.auditActor, userId: actor.userId },
              documentId: request.params.id,
              request: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuse(deps, request, error, { resourceId: request.params.id });
          }
          throw error;
        }
      },
    );

    typed.post(
      '/documents/:id/reclassify',
      {
        // A clinical act: only a professional with a profile reaches the handler at all.
        config: {
          readOnly: 'write',
          permission: 'clinical.document.write',
          audits: ['document.reclassified'],
        },
        schema: {
          params: DocumentParams,
          body: ReclassifyDocumentRequest,
          response: { 200: DocumentDto },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        try {
          return await deps.withTenant(transactionOf(actor), (tx) =>
            deps.lifecycle.reclassify(tx, {
              actor,
              auditActor: { ...request.auditActor, userId: actor.userId },
              documentId: request.params.id,
              request: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuse(deps, request, error, { resourceId: request.params.id });
          }
          throw error;
        }
      },
    );
  };
}
