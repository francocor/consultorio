import {
  ChangePortalEmailRequest,
  CreatePortalLinkRequest,
  PatientPortalResponse,
  PortalIdentityResponse,
  PortalInvitationRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { readOrganizationName } from '../../tenancy/index.js';
import {
  changeIdentityEmail,
  deactivateIdentity,
  linkDependent,
  listPortalOfPatient,
  prepareInvitation,
  revokeIdentitySessions,
  revokeLink,
  type IdentityDeps,
  type StaffAuditActor,
} from '../application/identities.js';
import { renderPortalInvitationEmail } from '../application/mail.js';

export interface StaffRoutesDeps {
  withTenant: WithTenant;
  identities: IdentityDeps;
  email: EmailSender;
  origins: PublicOrigins;
}

const PatientParams = z.strictObject({ id: z.uuid() });
const IdParams = z.strictObject({ id: z.uuid() });

/** The days an activation link lives; the kind of token decides, this only says it. */
const INVITATION_DAYS = 7;

/**
 * What the staff do about the portal accounts (S5.06): invite a patient, link another dependent to
 * an account, end an account or one link, and change an address after verifying the person out of
 * band. All of it needs `portal.manage` (owner, admin, reception); a portal session never has it.
 * These are staff routes under a staff session: the portal's own routes live in `portal-routes`.
 */
export function staffRoutes(deps: StaffRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function staffOf(request: FastifyRequest): {
      actor: NonNullable<FastifyRequest['actor']>;
      audit: StaffAuditActor;
    } {
      const actor = request.actor;
      if (!actor) throw new AppError('unauthenticated');
      return { actor, audit: { ...request.auditActor, userId: actor.userId } };
    }

    function tenantOfRequest(request: FastifyRequest) {
      const host = request.hostContext;
      if (host?.kind !== 'tenant') throw new AppError('unauthenticated');
      return host.tenant;
    }

    typed.get(
      '/patients/:id/portal',
      {
        config: { readOnly: 'read', permission: 'portal.manage' },
        schema: { params: PatientParams, response: { 200: PatientPortalResponse } },
      },
      async (request) => {
        const { actor } = staffOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          listPortalOfPatient(tx, request.params.id),
        );
      },
    );

    typed.post(
      '/patients/:id/portal-invitation',
      {
        config: {
          readOnly: 'write',
          permission: 'portal.manage',
          audits: ['portal.identity.created'],
        },
        schema: {
          params: PatientParams,
          body: PortalInvitationRequest,
          response: { 201: PortalIdentityResponse },
        },
      },
      async (request, reply) => {
        const { actor, audit } = staffOf(request);
        const tenant = tenantOfRequest(request);
        const representative =
          request.body.email === undefined ||
          request.body.relation === undefined ||
          request.body.verificationNote === undefined
            ? undefined
            : {
                email: request.body.email,
                relation: request.body.relation,
                verificationNote: request.body.verificationNote,
              };
        const prepared = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          async (tx) => ({
            ...(await prepareInvitation(tx, deps.identities, {
              actor: audit,
              patientId: request.params.id,
              ...(representative ? { representative } : {}),
            })),
            organizationName: await readOrganizationName(tx),
          }),
        );
        // The link goes by email only, after the invitation is safely stored. The answer never
        // carries it.
        await deps.email.send({
          to: prepared.email,
          tenant: { id: tenant.id, isDemo: tenant.isDemo },
          ...renderPortalInvitationEmail({
            organizationName: prepared.organizationName,
            link: `${deps.origins(tenant.slug)}/public/t/${prepared.token}`,
            expiresInDays: INVITATION_DAYS,
          }),
        });
        return reply.code(201).send({ identity: prepared.identity });
      },
    );

    typed.post(
      '/portal-identities/:id/links',
      {
        config: {
          readOnly: 'write',
          permission: 'portal.manage',
          audits: ['portal.identity.linked'],
        },
        schema: {
          params: IdParams,
          body: CreatePortalLinkRequest,
          response: { 201: PortalIdentityResponse },
        },
      },
      async (request, reply) => {
        const { actor, audit } = staffOf(request);
        const tenant = tenantOfRequest(request);
        const identity = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            linkDependent(tx, deps.identities, {
              actor: audit,
              country: tenant.country,
              identityId: request.params.id,
              patientId: request.body.patientId,
              relation: request.body.relation,
              verificationNote: request.body.verificationNote,
            }),
        );
        return reply.code(201).send({ identity });
      },
    );

    typed.post(
      '/portal-identities/:id/deactivate',
      {
        config: {
          readOnly: 'write',
          permission: 'portal.manage',
          audits: ['portal.identity.deactivated'],
        },
        schema: {
          params: IdParams,
          body: z.strictObject({}),
          response: { 200: PortalIdentityResponse },
        },
      },
      async (request) => {
        const { actor, audit } = staffOf(request);
        const identity = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deactivateIdentity(tx, deps.identities, {
              actor: audit,
              identityId: request.params.id,
            }),
        );
        return { identity };
      },
    );

    typed.post(
      '/portal-links/:id/revoke',
      {
        config: {
          readOnly: 'write',
          permission: 'portal.manage',
          audits: ['portal.identity.deactivated'],
        },
        schema: {
          params: IdParams,
          body: z.strictObject({}),
          response: { 200: PortalIdentityResponse },
        },
      },
      async (request) => {
        const { actor, audit } = staffOf(request);
        const identity = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => revokeLink(tx, deps.identities, { actor: audit, linkId: request.params.id }),
        );
        return { identity };
      },
    );

    typed.post(
      '/portal-identities/:id/email',
      {
        config: {
          readOnly: 'write',
          permission: 'portal.manage',
          audits: ['portal.profile.changed'],
        },
        schema: {
          params: IdParams,
          body: ChangePortalEmailRequest,
          response: { 200: PortalIdentityResponse },
        },
      },
      async (request) => {
        const { actor, audit } = staffOf(request);
        const identity = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            changeIdentityEmail(tx, deps.identities, {
              actor: audit,
              identityId: request.params.id,
              email: request.body.email,
            }),
        );
        return { identity };
      },
    );

    typed.post(
      '/portal-identities/:id/sessions/revoke',
      {
        config: {
          readOnly: 'write',
          permission: 'portal.manage',
          audits: ['auth.session.revoked'],
        },
        schema: {
          params: IdParams,
          body: z.strictObject({}),
          response: { 200: PortalIdentityResponse },
        },
      },
      async (request) => {
        const { actor, audit } = staffOf(request);
        const identity = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            revokeIdentitySessions(tx, deps.identities, {
              actor: audit,
              identityId: request.params.id,
            }),
        );
        return { identity };
      },
    );
  };
}
