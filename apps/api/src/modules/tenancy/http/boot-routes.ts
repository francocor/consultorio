import { BootPayload, WebManifest } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

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
        schema: { response: { 200: BootPayload } },
      },
      async (request, reply) => {
        const resolved = tenantOf(request);
        const payload = await deps.withTenant(
          { tenantId: resolved.id, userId: SYSTEM_USER_ID },
          (tx) => deps.boot.boot(tx, resolved),
        );
        // Short, so a branding change reaches every browser within the minute.
        return reply.header('cache-control', 'public, max-age=60').send(payload);
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
