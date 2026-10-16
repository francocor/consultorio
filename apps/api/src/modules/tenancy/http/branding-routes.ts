import {
  BrandingPreviewRequest,
  BrandingResponse,
  ContrastResultDto,
  UpdateBrandingRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { BrandingService } from '../branding/branding.js';

export interface BrandingRoutesDeps {
  withTenant: WithTenant;
  branding: BrandingService;
}

/** The branding screen of the organization: owners and admins (`tenant.branding.manage`). */
export function brandingRoutes(deps: BrandingRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/branding',
      {
        config: { readOnly: 'read', permission: 'tenant.branding.manage' },
        schema: { response: { 200: BrandingResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.branding.get(tx),
        );
      },
    );

    typed.put(
      '/branding',
      {
        config: {
          readOnly: 'write',
          permission: 'tenant.branding.manage',
          audits: ['branding.updated'],
        },
        schema: { body: UpdateBrandingRequest, response: { 200: BrandingResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.branding.update(tx, {
            actor: { ...request.auditActor, userId: actor.userId },
            request: request.body,
          }),
        );
      },
    );

    // A pure computation (nothing is stored), so it is a read for the read-only policy.
    typed.post(
      '/branding/preview',
      {
        config: { readOnly: 'read', permission: 'tenant.branding.manage', audits: 'none' },
        schema: { body: BrandingPreviewRequest, response: { 200: ContrastResultDto } },
      },
      (request) => deps.branding.preview(request.body.primaryColor),
    );
  };
}
