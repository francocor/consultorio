import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../authz/guard.js';
import { refuseRequest } from '../authz/refuse.js';
import type { WithTenant } from '../db/tenant-context.js';
import { AppError } from '../http/problem.js';
import type { ObjectStorage } from '../storage/object-storage.js';

import { FileRefused, type FileResourceRegistry } from './file-resources.js';

export interface FileRoutesDeps {
  registry: FileResourceRegistry;
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Absent when no bucket is configured: the route then answers "unavailable". */
  storage: ObjectStorage | undefined;
}

// Any text: a malformed token is refused like an expired one, never told apart.
const FileParams = z.strictObject({ token: z.string().min(1).max(512) });

/**
 * `GET /files/:token`, the one door to every file the product hands out (a patient's document, a
 * billing export, an invoice PDF). The token proves a person asked for the file in this session
 * minutes ago; the resource that owns the kind decides again whether they may have it, writes the
 * audit entry, and says which object to stream. The API carries the bytes, so the link stays bound
 * to the session and the storage address is never shown to the browser.
 *
 * The route declares the audit actions of every registered resource, so it must be registered
 * after the modules were built (the application does it last).
 */
export function fileRoutes(deps: FileRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const audits = deps.registry.audits();

    typed.get(
      '/files/:token',
      {
        // A link is spent by its first request. HEAD would spend it without delivering anything.
        exposeHeadRoute: false,
        // Session cookie AND token (design 5.6): the guard asks for the session, the token is bound to it.
        config: {
          readOnly: 'read',
          permission: 'patients.read',
          audits: audits.length === 0 ? 'none' : audits,
        },
        schema: { params: FileParams },
      },
      async (request, reply) => {
        const actor = request.actor;
        const session = request.session;
        if (!actor || !session) throw new AppError('unauthenticated');
        let delivery;
        try {
          delivery = await deps.withTenant(
            {
              tenantId: actor.tenantId,
              userId: actor.userId,
              actingProfessionalId: actor.professionalId,
            },
            (tx) =>
              deps.registry.redeem(tx, {
                actor,
                auditActor: { ...request.auditActor, userId: actor.userId },
                sessionId: session.sessionId,
                token: request.params.token,
              }),
          );
        } catch (error) {
          if (error instanceof FileRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: error.resourceType,
              ...error.context,
            });
          }
          throw error;
        }
        // Audited and spent; now stream.
        if (!deps.storage) throw new AppError('service_unavailable');
        const stored = await deps.storage.get(actor.tenantId, delivery.objectKey);
        if (!stored) throw new AppError('not_found');
        return reply
          .header('content-type', delivery.contentType)
          .header('content-disposition', delivery.contentDisposition)
          .header('content-length', String(stored.size))
          .header('cache-control', 'no-store')
          .header('content-security-policy', "default-src 'none'; sandbox; frame-ancestors 'none'")
          .send(stored.stream);
      },
    );
  };
}
