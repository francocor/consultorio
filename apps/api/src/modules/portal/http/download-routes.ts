import { PortalDownloadLinkResponse } from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { PortalActor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { FileRefused, type FileResourceRegistry } from '../../../platform/files/file-resources.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ObjectStorage } from '../../../platform/storage/object-storage.js';
import {
  isRenderedKey,
  issueDownloadLink,
  type DownloadDeps,
  type DownloadKind,
} from '../application/downloads.js';
import type { WithPortalSubject } from '../application/subject.js';

import { portalCaller, refuseUnknown } from './portal-routes.js';

export interface DownloadRoutesDeps {
  withTenant: WithTenant;
  withPortalSubject: WithPortalSubject;
  auditDeny: AuthzOptions['auditDeny'];
  downloads: DownloadDeps;
  registry: FileResourceRegistry<PortalActor>;
  /** Absent when no bucket is configured: the door then answers "unavailable". */
  storage: ObjectStorage | undefined;
}

const IdParams = z.strictObject({ id: z.uuid() });
// Any text: a malformed token is refused like an expired one, never told apart.
const FileParams = z.strictObject({ token: z.string().min(1).max(512) });

const KINDS: readonly {
  kind: DownloadKind;
  segment: string;
  permission:
    | 'portal.document.read'
    | 'portal.prescription.read'
    | 'portal.invoice.read'
    | 'portal.self.read';
}[] = [
  { kind: 'document', segment: 'documents', permission: 'portal.document.read' },
  { kind: 'prescription', segment: 'prescriptions', permission: 'portal.prescription.read' },
  { kind: 'invoice', segment: 'invoices', permission: 'portal.invoice.read' },
  { kind: 'consent', segment: 'consents', permission: 'portal.self.read' },
];

/**
 * The downloads of the patient (task 5.35). Asking for a link is a read: it authorizes the file for
 * the subject of the session and answers an address of the portal, valid for five minutes and for
 * this session only. The file itself comes through `GET /portal/files/:token`, the portal's door:
 * it spends the link, authorizes the file AGAIN for whoever is signed in then, writes the entry of
 * the download and streams the bytes from the API, so the address of the storage is never shown to
 * the browser and a link copied to another session or device is no use.
 */
export function downloadRoutes(deps: DownloadRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    for (const { kind, segment, permission } of KINDS) {
      typed.post(
        `/portal/${segment}/:id/download-link`,
        {
          config: {
            readOnly: 'read',
            auth: 'portal',
            portalPermission: permission,
            audits: ['portal.denied'],
          },
          schema: {
            params: IdParams,
            body: z.strictObject({}).optional(),
            response: { 200: PortalDownloadLinkResponse },
          },
        },
        async (request) => {
          const { actor, session } = portalCaller(request);
          const outcome = await deps.withPortalSubject(actor, async (tx, subject) => ({
            subject,
            link: await issueDownloadLink(
              tx,
              deps.downloads,
              { actor, subject, auditActor: request.auditActor },
              { kind, id: request.params.id, sessionId: session.sessionId },
            ),
          }));
          if (!outcome.link) {
            return refuseUnknown(deps.auditDeny, request, {
              subject: outcome.subject,
              resourceType: kind,
              resourceId: request.params.id,
            });
          }
          return outcome.link;
        },
      );
    }

    const audits = deps.registry.audits();
    typed.get(
      '/portal/files/:token',
      {
        // A link is spent by its first request. HEAD would spend it without delivering anything.
        exposeHeadRoute: false,
        config: {
          readOnly: 'read',
          auth: 'portal',
          portalPermission: 'portal.self.read',
          audits: audits.length === 0 ? 'none' : [...audits, 'portal.denied'],
        },
        schema: { params: FileParams },
      },
      async (request, reply) => {
        const { actor, session } = portalCaller(request);
        let delivery;
        try {
          delivery = await deps.withTenant(
            { tenantId: actor.tenantId, userId: SYSTEM_USER_ID },
            (tx) =>
              deps.registry.redeem(tx, {
                actor,
                auditActor: request.auditActor,
                sessionId: session.sessionId,
                token: request.params.token,
              }),
          );
        } catch (error) {
          if (error instanceof FileRefused) return refuse(request, actor, error);
          throw error;
        }
        // Audited and spent; now stream.
        if (!deps.storage) throw new AppError('service_unavailable');
        const stored = await deps.storage.get(actor.tenantId, delivery.objectKey);
        if (!stored) throw new AppError('not_found');
        // A file rendered for this download is not kept: it goes when the response is over.
        if (isRenderedKey(actor.tenantId, delivery.objectKey)) {
          const storage = deps.storage;
          reply.raw.once('close', () => {
            void storage.remove(actor.tenantId, delivery.objectKey).catch(() => undefined);
          });
        }
        return reply
          .header('content-type', delivery.contentType)
          .header('content-disposition', delivery.contentDisposition)
          .header('content-length', String(stored.size))
          .header('cache-control', 'no-store')
          .header('content-security-policy', "default-src 'none'; sandbox; frame-ancestors 'none'")
          .send(stored.stream);
      },
    );

    /** The uniform 403 for a link that was live and whose owner lost access, audited as a denial. */
    async function refuse(
      request: FastifyRequest,
      actor: PortalActor,
      error: FileRefused,
    ): Promise<never> {
      await deps.auditDeny(actor.tenantId, {
        action: 'portal.denied',
        actor: request.auditActor,
        resourceType: error.resourceType,
        ...(error.context.resourceId === undefined ? {} : { resourceId: error.context.resourceId }),
        ...(error.context.patientId === undefined ? {} : { patientId: error.context.patientId }),
        reason: error.reason,
        metadata: { identityId: actor.identityId },
      });
      throw new AppError('forbidden');
    }
  };
}
