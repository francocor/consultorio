import {
  ChangeRolesRequest,
  GRANTABLE,
  GrantListResponse,
  GrantPermissionRequest,
  MemberRolesResponse,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import type { Grants } from '../application/grants.js';
import { sendProfessionalAddedNotice } from '../application/professional-notice.js';
import { AccessRefused } from '../application/refusal.js';
import type { RoleService } from '../application/roles.js';

export interface MemberRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  grants: Grants;
  roles: RoleService;
  /** Tells the owners when an admin adds a professional (decision D19). */
  email: EmailSender;
  /** Where the emailed links point. From configuration, never from the request. */
  origins: PublicOrigins;
}

const MemberParams = z.strictObject({ membershipId: z.uuid() });
const GrantParams = z.strictObject({
  membershipId: z.uuid(),
  permission: z.string().min(1).max(64),
});

export function memberRoutes(deps: MemberRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    /** Records the refusal on its own connection, then answers the uniform 403. */
    const refuse = (
      request: FastifyRequest,
      refusal: AccessRefused,
      targetMembershipId: string,
      metadata: Record<string, string> = {},
    ) =>
      refuseRequest(deps.auditDeny, request, {
        reason: refusal.reason,
        resourceType: 'membership',
        resourceId: targetMembershipId,
        metadata,
      });

    typed.get(
      '/members/:membershipId/grants',
      {
        config: { readOnly: 'read', permission: 'permissions.grant' },
        schema: { params: MemberParams, response: { 200: GrantListResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const grants = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => deps.grants.list(tx, request.params.membershipId),
        );
        return {
          grantable: [...GRANTABLE],
          grants: grants.map((grant) => ({
            id: grant.id,
            permission: grant.permission,
            scope: grant.scope,
            grantedBy: grant.grantedBy,
            grantedAt: grant.grantedAt.toISOString(),
          })),
        };
      },
    );

    typed.post(
      '/members/:membershipId/grants',
      {
        config: {
          readOnly: 'write',
          permission: 'permissions.grant',
          audits: ['permission.granted'],
        },
        schema: { params: MemberParams, body: GrantPermissionRequest },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          const grant = await deps.withTenant(
            { tenantId: actor.tenantId, userId: actor.userId },
            (tx) =>
              deps.grants.grant(tx, {
                actor: { ...request.auditActor, userId: actor.userId },
                actorMembershipId: actor.membershipId,
                targetMembershipId: request.params.membershipId,
                permission: request.body.permission,
                scope: request.body.scope,
              }),
          );
          return await reply.code(201).send({
            id: grant.id,
            permission: grant.permission,
            scope: grant.scope,
            grantedBy: grant.grantedBy,
            grantedAt: grant.grantedAt.toISOString(),
          });
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuse(request, error, request.params.membershipId, {
              permission: request.body.permission.slice(0, 64),
            });
          }
          throw error;
        }
      },
    );

    typed.delete(
      '/members/:membershipId/grants/:permission',
      {
        config: {
          readOnly: 'write',
          permission: 'permissions.grant',
          audits: ['permission.revoked'],
        },
        schema: { params: GrantParams },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.grants.revoke(tx, {
            actor: request.auditActor,
            actorUserId: actor.userId,
            targetMembershipId: request.params.membershipId,
            permission: request.params.permission,
          }),
        );
        return reply.code(204).send();
      },
    );

    typed.put(
      '/members/:membershipId/roles',
      {
        config: {
          readOnly: 'write',
          permission: 'staff.manage',
          audits: ['role.changed', 'professional.added_by_admin'],
        },
        schema: {
          params: MemberParams,
          body: ChangeRolesRequest,
          response: { 200: MemberRolesResponse },
        },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          const result = await deps.withTenant(
            { tenantId: actor.tenantId, userId: actor.userId },
            (tx) =>
              deps.roles.changeRoles(tx, {
                actor: { ...request.auditActor, userId: actor.userId },
                actorMembershipId: actor.membershipId,
                targetMembershipId: request.params.membershipId,
                newRoles: request.body.roles,
              }),
          );
          const host = request.hostContext;
          if (result.notice && host?.kind === 'tenant') {
            await sendProfessionalAddedNotice({
              email: deps.email,
              notice: result.notice,
              tenant: { id: host.tenant.id, isDemo: host.tenant.isDemo },
              link: deps.origins(host.tenant.slug) + '/staff',
              onFailure: (error) => {
                request.log.error(
                  { err: error },
                  'the owners could not be told about a professional',
                );
              },
            });
          }
          return { membershipId: request.params.membershipId, roles: result.roles };
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuse(request, error, request.params.membershipId);
          }
          throw error;
        }
      },
    );
  };
}
