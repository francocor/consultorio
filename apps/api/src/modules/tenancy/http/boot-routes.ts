import { createHash } from 'node:crypto';

import { BootPayload, WebManifest } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ResolvedTenant } from '../../../platform/http/tenant-host.js';
import type { BootService } from '../branding/boot.js';

export interface BootRoutesDeps {
  withTenant: WithTenant;
  boot: BootService;
}

/**
 * The two public documents a browser asks for before anyone signs in. Both belong to the tenant
 * host: the platform host and unknown hosts have no organization to describe.
 */
export function bootRoutes(deps: BootRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function tenantOf(request: { hostContext: unknown }): ResolvedTenant {
      const context = request.hostContext as { kind?: string; tenant?: ResolvedTenant } | null;
      if (context?.kind !== 'tenant' || !context.tenant) throw new AppError('not_found');
      return context.tenant;
    }

    typed.get(
      '/public/boot',
      {
        config: { readOnly: 'read', auth: 'public' },
        schema: { response: { 200: BootPayload, 304: z.undefined() } },
      },
      async (request, reply) => {
        const resolved = tenantOf(request);
        const payload = await deps.withTenant(
          { tenantId: resolved.id, userId: SYSTEM_USER_ID },
          (tx) => deps.boot.boot(tx, resolved),
        );
        // Revalidated on every load, never served from the browser's cache: a branding change must
        // show on the very next reload, and a stale answer would repaint the old look over the new
        // one remembered by the page. The tag makes the unchanged case a tiny 304.
        const etag = `"${createHash('sha256').update(JSON.stringify(payload)).digest('base64url').slice(0, 22)}"`;
        void reply.header('cache-control', 'public, no-cache').header('etag', etag);
        if (request.headers['if-none-match'] === etag) return reply.code(304).send(undefined);
        return reply.send(payload);
      },
    );

    typed.get(
      '/manifest.webmanifest',
      {
        config: { readOnly: 'read', auth: 'public' },
        schema: { response: { 200: WebManifest } },
      },
      async (request, reply) => {
        const resolved = tenantOf(request);
        const manifest = await deps.withTenant(
          { tenantId: resolved.id, userId: SYSTEM_USER_ID },
          (tx) => deps.boot.manifest(tx, resolved),
        );
        return reply
          .header('content-type', 'application/manifest+json; charset=utf-8')
          .header('cache-control', 'public, max-age=300')
          .send(manifest);
      },
    );
  };
}
