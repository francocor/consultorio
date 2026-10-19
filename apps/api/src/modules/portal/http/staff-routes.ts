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

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
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
import { renderPortalInvitationEmail } from '../application/mail.js';
import { PORTAL_NOTICE_JOB } from '../application/notice-job.js';
import { PortalStaffRefused } from '../application/staff-gate.js';

export interface StaffRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  identities: IdentityDeps;
  email: EmailSender;
  origins: PublicOrigins;
  /** Queues the notices in the transaction of the change. Absent: the deployment has no queue. */
  jobs?: JobClient | undefined;
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
 * trail records that it did (JD-S5 R1-A-C1). The notice is queued in the transaction of the change
 * (an outbox: both exist or neither does) and a worker sends it (JD-S5 R2-2); the entry of the trail
 * is written when it is sent, so its absence is what shows a notice that did not go out.
 *
 * What gives somebody access to a patient is for an owner or an administrator for seven days after
 * the e-mail or the birth date of the record changed, and always for a representative of a patient
 * whose record has no e-mail to tell (JD-S5 R2-2): the answer is `portal_recent_identity_change` or
 * `portal_owner_or_admin_required`, and the refusal is in the trail.
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

    /** An owner or an administrator may do what reception may not (JD-S5 R2-2). */
    function ownerOrAdminOf(actor: NonNullable<FastifyRequest['actor']>): boolean {
      return actor.roles.includes('owner') || actor.roles.includes('admin');
    }

    /**
     * Runs the change; when the gate of the staff refuses it, writes the refusal in the trail on a
     * connection of its own (the transaction of the change rolled back) and answers with its code.
     */
    async function gated<T>(request: FastifyRequest, work: () => Promise<T>): Promise<T> {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof PortalStaffRefused)) throw error;
        const actor = request.actor;
        if (actor) {
          await deps
            .auditDeny(actor.tenantId, {
              action: 'access.denied',
              actor: request.auditActor,
              resourceType: 'patient',
              resourceId: error.patientId,
              patientId: error.patientId,
              reason: error.code,
              metadata: {},
            })
            .catch(() => undefined);
        }
        throw new AppError(error.code);
      }
    }

    /**
     * Queues the notice of a change to the access in the transaction that made it. Without a queue
     * nothing can be promised: the change stands and the log says no notice was queued.
     */
    async function queueNotice(
      tx: Tx,
      request: FastifyRequest,
      input: {
        kind: 'email_changed' | 'representative_added';
        to: string;
        resourceId: string;
        patientId?: string;
      },
    ): Promise<void> {
      const { actor, audit } = staffOf(request);
      if (!deps.jobs) {
        request.log.error(
          { kind: input.kind },
          'a notice about a change to the portal access could not be queued: no queue',
        );
        return;
      }
      await deps.jobs.enqueue(tx, PORTAL_NOTICE_JOB, {
        tenantId: actor.tenantId,
        kind: input.kind,
        to: input.to,
        resourceId: input.resourceId,
        ...(input.patientId === undefined ? {} : { patientId: input.patientId }),
        actorUserId: actor.userId,
        actingRole: audit.actingRole,
      });
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
        const prepared = await gated(request, () =>
          deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
            const made = await prepareInvitation(tx, deps.identities, {
              actor: audit,
              ownerOrAdmin: ownerOrAdminOf(actor),
              patientId: request.params.id,
              ...(representative ? { representative } : {}),
            });
            // A representative is given access to a minor's record: the address on that record is
            // told, in the same transaction.
            if (representative && made.recordEmail !== null) {
              await queueNotice(tx, request, {
                kind: 'representative_added',
                to: made.recordEmail,
                resourceId: made.identity.id,
                patientId: request.params.id,
              });
            }
            return { ...made, organizationName: await readOrganizationName(tx) };
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
        const linked = await gated(request, () =>
          deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
            const made = await linkDependent(tx, deps.identities, {
              actor: audit,
              ownerOrAdmin: ownerOrAdminOf(actor),
              country: tenant.country,
              identityId: request.params.id,
              patientId: request.body.patientId,
              relation: request.body.relation,
              verificationNote: request.body.verificationNote,
            });
            if (made.recordEmail !== null) {
              await queueNotice(tx, request, {
                kind: 'representative_added',
                to: made.recordEmail,
                resourceId: request.params.id,
                patientId: request.body.patientId,
              });
            }
            return made;
          }),
        );
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
        const identity = await gated(request, () =>
          deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
            const identityId = await reverifyLink(tx, deps.identities, {
              actor: audit,
              ownerOrAdmin: ownerOrAdminOf(actor),
              linkId: request.params.id,
              verificationNote: request.body.verificationNote,
            });
            return identityDto(tx, identityId);
          }),
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
          async (tx) => {
            const made = await changeIdentityEmail(tx, deps.identities, {
              actor: audit,
              identityId: request.params.id,
              email: request.body.email,
            });
            // The mailbox that held the account is told, without a link (it cannot be used to
            // answer), and the notice is queued with the change, not after it.
            if (made.previousEmail !== null) {
              await queueNotice(tx, request, {
                kind: 'email_changed',
                to: made.previousEmail,
                resourceId: request.params.id,
              });
            }
            return made;
          },
        );
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
