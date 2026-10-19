import {
  AuthorizePortalLinkRequest,
  ChangePortalEmailRequest,
  CreatePortalLinkRequest,
  PatientPortalResponse,
  PortalIdentityResponse,
  PortalInvitationRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { audit as writeAudit } from '../../../platform/audit/writer.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { reverifyLink } from '../application/dependents.js';
import {
  changeIdentityEmail,
  deactivateIdentity,
  identityDto,
  linkDependent,
  listPortalOfPatient,
  prepareInvitation,
  revokeIdentitySessions,
  revokeLink,
  type IdentityDeps,
  type StaffAuditActor,
} from '../application/identities.js';
import {
  renderPortalInvitationEmail,
  renderPortalSecurityNoticeEmail,
  type PortalSecurityNoticeKind,
} from '../application/mail.js';

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
 * band. All of it needs `portal.manage` (owner, admin, reception) except changing an address, which
 * needs `portal.identity.email` (owner and admin): whoever holds the mailbox holds the account. A
 * portal session never has either. These are staff routes under a staff session: the portal's own
 * routes live in `portal-routes`.
 *
 * A change that gives somebody access (a representative for a minor) or moves an account to another
 * mailbox sends a notice with no link to the address that would otherwise never find out, and the
 * trail records that it did (JD-S5 R1-A-C1). A notice that cannot be sent is logged and does not
 * undo the change; the missing entry of the trail is what shows it.
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

    /** Tells an address about a change to the access, and writes in the trail that it did. */
    async function notify(
      request: FastifyRequest,
      input: {
        kind: PortalSecurityNoticeKind;
        to: string;
        resourceId: string;
        patientId?: string;
      },
    ): Promise<void> {
      const { actor, audit } = staffOf(request);
      const tenant = tenantOfRequest(request);
      try {
        const organizationName = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => readOrganizationName(tx),
        );
        await deps.email.send({
          to: input.to,
          tenant: { id: tenant.id, isDemo: tenant.isDemo },
          ...renderPortalSecurityNoticeEmail({ organizationName, kind: input.kind }),
        });
        await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          writeAudit(tx, {
            action: 'portal.notice.sent',
            outcome: 'allow',
            actor: audit,
            resourceType: 'portal_identity',
            resourceId: input.resourceId,
            ...(input.patientId === undefined ? {} : { patientId: input.patientId }),
            metadata: { kind: input.kind },
          }),
        );
      } catch (error) {
        request.log.error(
          { kind: input.kind, code: error instanceof Error ? error.name : 'unknown' },
          'a notice about a change to the portal access could not be sent',
        );
      }
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
          audits: ['portal.identity.created', 'portal.notice.sent'],
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
        // A representative is given access to a minor's record: the address on that record is told.
        if (representative && prepared.recordEmail !== null) {
          await notify(request, {
            kind: 'representative_added',
            to: prepared.recordEmail,
            resourceId: prepared.identity.id,
            patientId: request.params.id,
          });
        }
        return reply.code(201).send({ identity: prepared.identity });
      },
    );

    typed.post(
      '/portal-identities/:id/links',
      {
        config: {
          readOnly: 'write',
          permission: 'portal.manage',
          audits: ['portal.identity.linked', 'portal.notice.sent'],
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
        const linked = await deps.withTenant(
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
        if (linked.recordEmail !== null) {
          await notify(request, {
            kind: 'representative_added',
            to: linked.recordEmail,
            resourceId: request.params.id,
            patientId: request.body.patientId,
          });
        }
        return reply.code(201).send({ identity: linked.identity });
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
      '/portal-links/:id/authorize',
      {
        config: {
          readOnly: 'write',
          permission: 'portal.manage',
          audits: ['portal.identity.linked'],
        },
        schema: {
          params: IdParams,
          body: AuthorizePortalLinkRequest,
          response: { 200: PortalIdentityResponse },
        },
      },
      async (request) => {
        const { actor, audit } = staffOf(request);
        const identity = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          async (tx) => {
            const identityId = await reverifyLink(tx, deps.identities, {
              actor: audit,
              linkId: request.params.id,
              verificationNote: request.body.verificationNote,
            });
            return identityDto(tx, identityId);
          },
        );
        return { identity };
      },
    );

    typed.post(
      '/portal-identities/:id/email',
      {
        config: {
          readOnly: 'write',
          // Not reception's: the new mailbox receives every code of the account (JD-S5 R1-A-C1).
          permission: 'portal.identity.email',
          audits: ['portal.profile.changed', 'portal.notice.sent'],
        },
        schema: {
          params: IdParams,
          body: ChangePortalEmailRequest,
          response: { 200: PortalIdentityResponse },
        },
      },
      async (request) => {
        const { actor, audit } = staffOf(request);
        const changed = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            changeIdentityEmail(tx, deps.identities, {
              actor: audit,
              identityId: request.params.id,
              email: request.body.email,
            }),
        );
        // The mailbox that held the account is told, without a link: it cannot be used to answer.
        if (changed.previousEmail !== null) {
          await notify(request, {
            kind: 'email_changed',
            to: changed.previousEmail,
            resourceId: request.params.id,
          });
        }
        return { identity: changed.identity };
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
