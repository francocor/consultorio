import { DocumentPortalShareResponse } from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import {
  DocumentRefused,
  loadDocumentForSharing,
  type DocumentForSharing,
} from '../../documents/index.js';
import { readOrganizationName } from '../../tenancy/index.js';
import {
  noticeRecipients,
  shareDocument,
  shareStatus,
  unshareDocument,
  type ShareOutcome,
} from '../application/document-shares.js';
import { renderPortalNoticeEmail } from '../application/mail.js';

export interface DocumentRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  email: EmailSender;
  origins: PublicOrigins;
  clock: () => Date;
}

const IdParams = z.strictObject({ id: z.uuid() });

/**
 * What the staff do to share a document with its patient (task 5.32): see whether it is shared,
 * share it, stop sharing it. Whoever may open a clinical document (a professional with the gate)
 * shares it; an administrative one is shared by whoever administers patients. A denial is audited
 * like any other and answers the uniform 403.
 */
export function documentRoutes(deps: DocumentRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    /** Runs `work` as the staff member, who is a professional's transaction when they are one. */
    async function asStaff<T>(
      request: FastifyRequest,
      work: (tx: Tx, document: DocumentForSharing) => Promise<T>,
    ): Promise<T> {
      const actor = request.actor;
      if (!actor) throw new AppError('unauthenticated');
      const documentId = (request.params as { id: string }).id;
      try {
        return await deps.withTenant(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            actingProfessionalId: actor.professionalId,
          },
          async (tx) => work(tx, await loadDocumentForSharing(tx, actor, documentId)),
        );
      } catch (error) {
        if (error instanceof DocumentRefused) {
          return refuseRequest(deps.auditDeny, request, {
            reason: error.reason,
            resourceType: 'document',
            ...error.context,
          });
        }
        throw error;
      }
    }

    function staffActor(request: FastifyRequest) {
      const actor = request.actor;
      if (!actor) throw new AppError('unauthenticated');
      return { ...request.auditActor, userId: actor.userId };
    }

    typed.get(
      '/documents/:id/portal-share',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: IdParams, response: { 200: DocumentPortalShareResponse } },
      },
      (request) => asStaff(request, (tx, document) => shareStatus(tx, document)),
    );

    typed.post(
      '/documents/:id/portal-share',
      {
        config: { readOnly: 'write', permission: 'patients.write', audits: ['sharing.changed'] },
        schema: {
          params: IdParams,
          body: z.strictObject({}).optional(),
          response: { 200: DocumentPortalShareResponse },
        },
      },
      async (request) => {
        const host = request.hostContext;
        if (host?.kind !== 'tenant') throw new AppError('unauthenticated');
        const result: { outcome: ShareOutcome; recipients: string[]; organization: string } =
          await asStaff(request, async (tx, document) => {
            const outcome = await shareDocument(tx, {
              actor: staffActor(request),
              document,
            });
            return {
              outcome,
              recipients: outcome.changed ? await noticeRecipients(tx, document.patientId) : [],
              organization: await readOrganizationName(tx),
            };
          });
        // The notice goes after the share is stored, by email, without saying what the document is.
        // A mailbox that fails does not undo the share: the patient finds it in the portal anyway.
        await Promise.allSettled(
          result.recipients.map((to) =>
            deps.email.send({
              to,
              tenant: { id: host.tenant.id, isDemo: host.tenant.isDemo },
              ...renderPortalNoticeEmail({
                organizationName: result.organization,
                kind: 'document_available',
                link: `${deps.origins(host.tenant.slug)}/portal`,
              }),
            }),
          ),
        );
        return result.outcome.status;
      },
    );

    typed.delete(
      '/documents/:id/portal-share',
      {
        config: { readOnly: 'write', permission: 'patients.write', audits: ['sharing.changed'] },
        schema: { params: IdParams, response: { 200: DocumentPortalShareResponse } },
      },
      async (request) => {
        const outcome = await asStaff(request, (tx, document) =>
          unshareDocument(tx, { actor: staffActor(request), document, now: deps.clock() }),
        );
        return outcome.status;
      },
    );
  };
}
