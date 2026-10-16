import {
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  BrandingPreviewRequest,
  BrandingResponse,
  ContrastResultDto,
  UpdateBrandingRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { BrandingService } from '../branding/branding.js';
import type { LogoService } from '../branding/logo-service.js';

export interface BrandingRoutesDeps {
  withTenant: WithTenant;
  branding: BrandingService;
  logo: LogoService;
}

/** The branding screen of the organization: owners and admins (`tenant.branding.manage`). */
export function brandingRoutes(deps: BrandingRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // The logo travels as the image itself, not inside a form: only the three safe types are read,
    // up to the cap. SVG (which can carry script) and everything else get a 415 before any parsing.
    app.addContentTypeParser(
      [...LOGO_TYPES],
      { parseAs: 'buffer', bodyLimit: LOGO_MAX_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );

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

    typed.put(
      '/branding/logo',
      {
        config: {
          readOnly: 'write',
          permission: 'tenant.branding.manage',
          audits: ['branding.logo_updated'],
        },
        schema: { response: { 200: BrandingResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        if (!deps.logo.available) throw new AppError('service_unavailable');
        const bytes: unknown = request.body;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          throw new AppError('validation_failed', [{ path: 'logo', i18nKey: 'logo.empty' }]);
        }
        const change = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.logo.upload(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              tenantId: actor.tenantId,
              bytes,
              contentType: (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '',
            }),
        );
        // The previous object goes only once the new logo is committed.
        if (change.staleKey) await deps.logo.discard(actor.tenantId, change.staleKey);
        return change.response;
      },
    );

    typed.delete(
      '/branding/logo',
      {
        config: {
          readOnly: 'write',
          permission: 'tenant.branding.manage',
          audits: ['branding.logo_updated'],
        },
        schema: { response: { 200: BrandingResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const change = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.logo.remove(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              tenantId: actor.tenantId,
            }),
        );
        if (change.staleKey) await deps.logo.discard(actor.tenantId, change.staleKey);
        return change.response;
      },
    );

    // The logo is public by design: the sign-in screen shows it before anyone signs in. It is
    // served from the tenant's own host, with headers that stop it from ever being run as script.
    typed.get(
      '/public/branding/logo',
      {
        config: { readOnly: 'read', auth: 'public' },
        schema: {
          querystring: z.object({
            v: z.string().max(20).optional(),
            size: z.enum(['192', '512']).optional(),
          }),
        },
      },
      async (request, reply) => {
        const context = request.hostContext;
        if (context?.kind !== 'tenant') throw new AppError('not_found');
        const tenantId = context.tenant.id;
        const logo = await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
          deps.logo.read(tx, {
            tenantId,
            ...(request.query.size === undefined
              ? {}
              : { iconSize: request.query.size === '192' ? (192 as const) : (512 as const) }),
          }),
        );
        if (!logo) throw new AppError('not_found');
        return (
          reply
            .header('content-type', logo.contentType)
            .header('x-content-type-options', 'nosniff')
            .header('content-security-policy', "default-src 'none'; sandbox")
            .header('content-disposition', 'inline')
            // The address carries the version, so a new logo is a new address.
            .header('cache-control', 'public, max-age=31536000, immutable')
            .send(logo.stream)
        );
      },
    );
  };
}
