import { ArchiveReleaseLinkResponse } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
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
import { abandonDownload, claimDownload, completeDownload } from '../download.js';

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
 * - `POST` hands over the package. The link is spent when the transfer ENDS, not when it starts: a
 *   download that breaks can be tried again while the link lives (a few times, one at a time, see
 *   `download.ts`). The package is taken out of the bucket when a download completes.
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
        const { storage } = deps;
        const { token } = request.params;

        // The lease first; the link is spent only when the transfer ends (see `download.ts`).
        const claim = await deps.withTenant(where.context, (tx) =>
          claimDownload(tx, deps.tokens, token, deps.clock()),
        );
        if (!claim) return denied(request, reply);

        const release = () =>
          deps
            .withTenant(where.context, (tx) => abandonDownload(tx, claim.id, claim.startedAt))
            .catch(() => {
              // The lease runs out by itself in minutes.
            });
        const stored = await storage.get(where.tenantId, claim.key).catch(() => null);
        if (!stored) {
          await release();
          return denied(request, reply);
        }

        let finished = false;
        reply.raw.once('finish', () => {
          finished = true;
          void (async () => {
            try {
              const completed = await deps.withTenant(where.context, (tx) =>
                completeDownload(tx, deps.tokens, token, claim.id, deps.clock()),
              );
              // The completion was not recorded (the link was spent, or the lease was lost): the package
              // stays where it is and the sweep of the releaser takes it out when the link ends.
              if (!completed) return;
              // The package was for this link only: it leaves the bucket once the transfer is done.
              await storage.remove(where.tenantId, claim.key);
              await deps.withTenant(where.context, (tx) =>
                tx
                  .update(archiveReleaseRequest)
                  .set({ packageRemovedAt: deps.clock() })
                  .where(eq(archiveReleaseRequest.id, claim.id)),
              );
            } catch {
              // The sweep of the releaser takes the package out when the link ends.
            }
          })();
        });
        reply.raw.once('close', () => {
          // A transfer that did not finish gives the link back: it can be tried again while it lives.
          if (!finished) void release();
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
