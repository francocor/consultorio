import { ArchiveReleaseLinkResponse } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { archiveReleaseRequest } from '../../../../db/schema/archive-release.js';
import {
  SYSTEM_USER_ID,
  type RequestContext,
  type WithTenant,
} from '../../../../platform/db/tenant-context.js';
import { denied } from '../../../../platform/http/problem.js';
import type { ObjectStorage } from '../../../../platform/storage/object-storage.js';
import type { ActionTokens } from '../../../../platform/tokens/index.js';
import { writeArchiveAudit } from '../archive-state.js';

const Params = z.strictObject({
  slug: z.string().min(1).max(63),
  // Any text: a malformed token is refused like an expired one, never told apart.
  token: z.string().min(1).max(512),
});

export interface LinkRoutesDeps {
  withTenant: WithTenant;
  tokens: ActionTokens;
  /** The bucket where the package waits. Absent: the link answers like one that does not work. */
  storage: ObjectStorage | undefined;
  clock: () => Date;
}

/**
 * The single-use link that a verified requester receives by email (task 6.42, token kind
 * `archive_release`, 72 hours). It is on the organization's own host, like every emailed link, and the
 * requester has no session: the link is the whole credential.
 *
 * - `GET` only looks: it says when the link ends, and spends nothing, so a mail scanner that opens the
 *   link before the person does not use it up.
 * - `POST` spends the link and hands over the package once. The package is taken out of the bucket
 *   when the download ends.
 *
 * An unknown link, an expired one, one already used and one whose package is gone all get the same
 * answer. The routes are allowed in a cancelled organization (category `export`): that is the only
 * state the organization is ever in when a release happens.
 */
export function releaseLinkRoutes(deps: LinkRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    /**
     * The organization of the host. The slug of the path is not read: the page of the link cannot
     * know it (it is on the organization's own host), and the host decides the organization.
     */
    function contextOf(
      request: FastifyRequest,
    ): { tenantId: string; context: RequestContext } | null {
      const host = request.hostContext;
      if (host?.kind !== 'tenant') return null;
      return {
        tenantId: host.tenant.id,
        context: { tenantId: host.tenant.id, userId: SYSTEM_USER_ID },
      };
    }

    typed.get(
      '/public/:slug/archive-release/:token',
      {
        config: {
          readOnly: 'export',
          auth: 'public',
          rateLimit: { max: 30, timeWindow: 60_000 },
        },
        schema: { params: Params, response: { 200: ArchiveReleaseLinkResponse } },
      },
      async (request, reply) => {
        void reply.header('cache-control', 'no-store');
        const where = contextOf(request);
        if (!where) return denied(request, reply);
        const found = await deps.withTenant(where.context, async (tx) => {
          const inspected = await deps.tokens.inspect(tx, 'archive_release', request.params.token);
          if (!inspected) return null;
          const [row] = await tx
            .select({
              status: archiveReleaseRequest.status,
              linkExpiresAt: archiveReleaseRequest.linkExpiresAt,
              downloadedAt: archiveReleaseRequest.downloadedAt,
            })
            .from(archiveReleaseRequest)
            .where(eq(archiveReleaseRequest.id, inspected.subjectId));
          if (row?.status !== 'released' || row.downloadedAt !== null || !row.linkExpiresAt) {
            return null;
          }
          return row.linkExpiresAt;
        });
        if (!found) return denied(request, reply);
        return { expiresAt: found.toISOString() };
      },
    );

    typed.post(
      '/public/:slug/archive-release/:token',
      {
        // The platform trail records the download (`archive.released`, phase `downloaded`); the tenant
        // trail has no entry for it because the organization is gone and the link is not its own.
        config: {
          readOnly: 'export',
          auth: 'public',
          audits: 'none',
          rateLimit: { max: 10, timeWindow: 60_000 },
        },
        schema: { params: Params },
      },
      async (request, reply) => {
        void reply.header('cache-control', 'no-store');
        const where = contextOf(request);
        if (!where || !deps.storage) return denied(request, reply);

        const delivery = await deps.withTenant(where.context, async (tx) => {
          const redeemed = await deps.tokens.redeem(tx, 'archive_release', request.params.token);
          if (!redeemed) return null;
          const [row] = await tx
            .select()
            .from(archiveReleaseRequest)
            .where(
              and(
                eq(archiveReleaseRequest.id, redeemed.subjectId),
                eq(archiveReleaseRequest.status, 'released'),
              ),
            );
          if (
            !row ||
            row.packageKey === null ||
            row.downloadedAt !== null ||
            !row.linkExpiresAt ||
            row.linkExpiresAt.getTime() < deps.clock().getTime()
          ) {
            return null;
          }
          await tx
            .update(archiveReleaseRequest)
            .set({ downloadedAt: deps.clock() })
            .where(eq(archiveReleaseRequest.id, row.id));
          await writeArchiveAudit(tx, {
            action: 'archive.released',
            resourceType: 'archive_release_request',
            resourceId: row.id,
            metadata: { phase: 'downloaded', requesterKind: row.requesterKind },
          });
          return { id: row.id, key: row.packageKey };
        });
        if (!delivery) return denied(request, reply);

        const stored = await deps.storage.get(where.tenantId, delivery.key);
        if (!stored) return denied(request, reply);
        const { storage } = deps;
        // When the download ends (or breaks) the package leaves the bucket: it was for this link only.
        stored.stream.once('close', () => {
          void (async () => {
            try {
              await storage.remove(where.tenantId, delivery.key);
              await deps.withTenant(where.context, (tx) =>
                tx
                  .update(archiveReleaseRequest)
                  .set({ packageRemovedAt: deps.clock() })
                  .where(eq(archiveReleaseRequest.id, delivery.id)),
              );
            } catch {
              // The sweep of expired packages takes it out when the link ends.
            }
          })();
        });
        return reply
          .header('content-type', 'application/zip')
          .header('content-disposition', 'attachment; filename="registros-archivados.zip"')
          .header('content-length', String(stored.size))
          .header('content-security-policy', "default-src 'none'; sandbox; frame-ancestors 'none'")
          .send(stored.stream);
      },
    );
  };
}
