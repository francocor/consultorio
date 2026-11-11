import { CreateUploadsRequest, CreateUploadsResponse, DocumentDto } from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Actor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { DocumentRefused } from '../application/refusal.js';
import type { UploadService } from '../application/uploads.js';

export interface DocumentRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  uploads: UploadService;
}

const DocumentParams = z.strictObject({ id: z.uuid() });

/** The caller the permission guard let through. A request without one never reaches a handler. */
export function actorOf(request: FastifyRequest): Actor {
  const actor = request.actor;
  if (!actor) throw new AppError('unauthenticated');
  return actor;
}

/**
 * The transaction of a request. A professional's transaction acts as the professional, so the
 * clinical row policies of the database see who is asking; everyone else's has no professional,
 * and the database shows them administrative documents only.
 */
export function transactionOf(actor: Actor) {
  return {
    tenantId: actor.tenantId,
    userId: actor.userId,
    actingProfessionalId: actor.professionalId,
  };
}

/** Turns a refusal decided by a service into the uniform 403 with its audit entry. */
export async function refuse(
  deps: Pick<DocumentRoutesDeps, 'auditDeny'>,
  request: FastifyRequest,
  error: AccessRefused,
  extra: { resourceId?: string; patientId?: string } = {},
): Promise<never> {
  // What the service knew about the document wins over what the route knew from the address.
  const known = error instanceof DocumentRefused ? error.context : {};
  return refuseRequest(deps.auditDeny, request, {
    reason: error.reason,
    resourceType: 'document',
    ...extra,
    ...known,
  });
}

/**
 * Upload routes. The browser sends the file straight to storage with a presigned POST, so the API
 * never carries file bytes: it registers the upload, and confirms it afterwards. Reception and the
 * administration may upload administrative documents; a clinical one needs a treating professional
 * (the service checks it; the database repeats it).
 */
export function uploadRoutes(deps: DocumentRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/documents/uploads',
      {
        // The request registers rows nobody can see yet; the audit entry comes with the confirmation.
        config: { readOnly: 'write', permission: 'patients.write', audits: 'none' },
        schema: { body: CreateUploadsRequest, response: { 200: CreateUploadsResponse } },
      },
      async (request) => {
        const actor = actorOf(request);
        try {
          return await deps.withTenant(transactionOf(actor), (tx) =>
            deps.uploads.create(tx, { actor, request: request.body }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuse(deps, request, error, { patientId: request.body.patientId });
          }
          throw error;
        }
      },
    );

    typed.post(
      '/documents/:id/uploaded',
      {
        config: { readOnly: 'write', permission: 'patients.write', audits: ['document.uploaded'] },
        schema: { params: DocumentParams, response: { 200: DocumentDto } },
      },
      async (request) => {
        const actor = actorOf(request);
        return deps.withTenant(transactionOf(actor), (tx) =>
          deps.uploads.complete(tx, {
            actor,
            auditActor: { ...request.auditActor, userId: actor.userId },
            documentId: request.params.id,
          }),
        );
      },
    );
  };
}
