import {
  InviteStaffRequest,
  InviteStaffResponse,
  StaffListResponse,
  StaffMemberDto,
  StaffStatusResponse,
  UpdateStaffProfileRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { renderInvitationEmail } from '../../../platform/mail/templates.js';
import { AccessRefused } from '../../access/index.js';
import type { DirectoryService } from '../application/directory.js';
import type { LifecycleService } from '../application/lifecycle.js';

export interface LifecycleRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  lifecycle: LifecycleService;
  directory: DirectoryService;
  email: EmailSender;
  /** Where the emailed links point. From configuration, never from the request. */
  origins: PublicOrigins;
}

/** The screen of the web app where the invitee chooses a password. */
export const INVITATION_PATH = '/accept-invitation';

const MemberParams = z.strictObject({ membershipId: z.uuid() });
const ListQuery = z.strictObject({
  includeDeactivated: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export function lifecycleRoutes(deps: LifecycleRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/staff/invitations',
      {
        config: { readOnly: 'write', permission: 'staff.manage', audits: ['staff.invited'] },
        schema: { body: InviteStaffRequest, response: { 201: InviteStaffResponse } },
      },
      async (request, reply) => {
        const actor = request.actor;
        const host = request.hostContext;
        if (!actor || host?.kind !== 'tenant') throw new AppError('unauthenticated');
        let prepared;
        try {
          prepared = await deps.withTenant(
            { tenantId: actor.tenantId, userId: actor.userId },
            (tx) =>
              deps.lifecycle.prepareInvitation(tx, {
                actor: { ...request.auditActor, userId: actor.userId },
                actorRoles: actor.roles,
                email: request.body.email,
                roles: request.body.roles,
                displayName: request.body.displayName,
              }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'invitation',
              metadata: { roles: [...request.body.roles] },
            });
          }
          throw error;
        }

        // The link goes by email only, after the invitation is safely stored. The response never
        // carries it.
        const link = `${deps.origins(host.tenant.slug)}${INVITATION_PATH}?token=${prepared.token}`;
        await deps.email.send({
          to: prepared.email,
          tenant: { id: host.tenant.id, isDemo: host.tenant.isDemo },
          ...renderInvitationEmail({
            organizationName: prepared.organizationName,
            ...(prepared.inviterName === null ? {} : { inviterName: prepared.inviterName }),
            link,
            expiresInDays: prepared.expiresInDays,
          }),
        });
        return reply.code(201).send({ expiresAt: prepared.expiresAt.toISOString() });
      },
    );

    typed.get(
      '/staff',
      {
        config: { readOnly: 'read', permission: 'staff.directory.read' },
        schema: { querystring: ListQuery, response: { 200: StaffListResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const staff = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.directory.list(
              tx,
              { membershipId: actor.membershipId, roles: actor.roles },
              { includeDeactivated: request.query.includeDeactivated ?? false },
            ),
        );
        return { staff };
      },
    );

    typed.get(
      '/staff/:membershipId',
      {
        config: { readOnly: 'read', permission: 'staff.directory.read' },
        schema: { params: MemberParams, response: { 200: StaffMemberDto } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.directory.find(
            tx,
            { membershipId: actor.membershipId, roles: actor.roles },
            request.params.membershipId,
          ),
        );
      },
    );

    typed.patch(
      '/staff/:membershipId/profile',
      {
        config: {
          readOnly: 'write',
          permission: 'staff.directory.read',
          audits: ['staff.profile_updated'],
        },
        schema: { params: MemberParams, body: UpdateStaffProfileRequest },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.directory.rename(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              viewer: { membershipId: actor.membershipId, roles: actor.roles },
              targetMembershipId: request.params.membershipId,
              displayName: request.body.displayName,
            }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'membership',
              resourceId: request.params.membershipId,
            });
          }
          throw error;
        }
        return reply.code(204).send();
      },
    );

    for (const [verb, action] of [
      ['deactivate', 'staff.deactivated'],
      ['reactivate', 'staff.reactivated'],
    ] as const) {
      typed.post(
        `/staff/:membershipId/${verb}`,
        {
          config: { readOnly: 'write', permission: 'staff.manage', audits: [action] },
          schema: { params: MemberParams, response: { 200: StaffStatusResponse } },
        },
        async (request) => {
          const actor = request.actor;
          if (!actor) throw new AppError('unauthenticated');
          try {
            const status = await deps.withTenant(
              { tenantId: actor.tenantId, userId: actor.userId },
              (tx) =>
                deps.lifecycle[verb](tx, {
                  actor: { ...request.auditActor, userId: actor.userId },
                  actorMembershipId: actor.membershipId,
                  targetMembershipId: request.params.membershipId,
                }),
            );
            return { membershipId: request.params.membershipId, status };
          } catch (error) {
            if (error instanceof AccessRefused) {
              return refuseRequest(deps.auditDeny, request, {
                reason: error.reason,
                resourceType: 'membership',
                resourceId: request.params.membershipId,
              });
            }
            throw error;
          }
        },
      );
    }
  };
}
