import { SettingsDto, UpdateSettingsRequest } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { SettingsService } from '../application/settings.js';

export interface SettingsRoutesDeps {
  withTenant: WithTenant;
  settings: SettingsService;
}

/** Organization settings. Only the owner and admins (permission `tenant.settings.manage`). */
export function settingsRoutes(deps: SettingsRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/settings',
      {
        config: { readOnly: 'read', permission: 'tenant.settings.manage' },
        schema: { response: { 200: SettingsDto } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.settings.get(tx),
        );
      },
    );

    typed.patch(
      '/settings',
      {
        config: {
          readOnly: 'write',
          permission: 'tenant.settings.manage',
          audits: [
            'sharing.changed',
            'setting.reception_sees_clinical_metadata.changed',
            'setting.changed',
          ],
        },
        schema: { body: UpdateSettingsRequest, response: { 200: SettingsDto } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.settings.update(tx, {
            actor: { ...request.auditActor, userId: actor.userId },
            patch: request.body,
          }),
        );
      },
    );
  };
}
