import {
  PortalConsentDetailDto,
  PortalConsentResponse,
  PortalConsentRevokeRequest,
  PortalConsentSignRequest,
  PortalConsentsResponse,
  PortalCopyRequest,
  PortalInvoicesResponse,
  PortalPrescriptionsQuery,
  PortalPrescriptionsResponse,
  PortalProfileResponse,
  PortalProfileUpdateRequest,
  PortalRectificationRequest,
  PortalRequestResponse,
  type PortalRightsRequestDto,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { readPatientBasics, type PortalRightsRequest } from '../../patients/index.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { readInvoices } from '../application/invoices.js';
import { renderPortalRequestNoticeEmail } from '../application/mail.js';
import type {
  PortalCall,
  PortalConsentPort,
  PortalPrescriptionPort,
} from '../application/ports.js';
import {
  organizationRecipients,
  readProfile,
  requestCopy,
  requestRectification,
  updateProfile,
} from '../application/profile.js';
import type { PortalSubject, WithPortalSubject } from '../application/subject.js';

import { portalCaller, refuseUnknown } from './portal-routes.js';

export interface SectionRoutesDeps {
  withPortalSubject: WithPortalSubject;
  auditDeny: AuthzOptions['auditDeny'];
  clock: () => Date;
  email: EmailSender;
  origins: PublicOrigins;
  /** Absent: the section answers `available: false` and the screen shows its empty state. */
  consent: PortalConsentPort | undefined;
  prescriptions: PortalPrescriptionPort | undefined;
}

const IdParams = z.strictObject({ id: z.uuid() });
const NoQuery = z.strictObject({});

function requestDto(request: PortalRightsRequest): PortalRightsRequestDto {
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
  };
}

/** One entry of the trail for the read of a section: which one, and how many items it held. */
async function auditRead(
  tx: Tx,
  actor: AuditActor,
  subject: PortalSubject,
  section: string,
  count: number,
): Promise<void> {
  await audit(tx, {
    action: 'portal.read',
    outcome: 'allow',
    actor,
    resourceType: section,
    patientId: subject.patientId,
    metadata: { section, count },
  });
}

/**
 * The sections of the portal that read other modules (S5.08, task 5.33) and the patient's own data
 * (task 5.34): invoices, consents, prescriptions, the profile and the requests about it. Consents and
 * prescriptions go through the ports of `ports.ts`; with no port wired they are empty states.
 */
export function sectionRoutes(deps: SectionRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function callOf(request: FastifyRequest, subject: PortalSubject): PortalCall {
      const { actor } = portalCaller(request);
      return { actor, subject, auditActor: request.auditActor };
    }

    // Invoices ------------------------------------------------------------------------------------

    typed.get(
      '/portal/invoices',
      {
        config: {
          readOnly: 'read',
          auth: 'portal',
          portalPermission: 'portal.invoice.read',
          audits: ['patient.read'],
        },
        schema: { querystring: NoQuery, response: { 200: PortalInvoicesResponse } },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        return deps.withPortalSubject(actor, async (tx, subject) => ({
          invoices: await readInvoices(tx, deps, subject, request.auditActor),
        }));
      },
    );

    // Consents ------------------------------------------------------------------------------------

    typed.get(
      '/portal/consents',
      {
        config: {
          readOnly: 'read',
          auth: 'portal',
          portalPermission: 'portal.self.read',
          audits: ['portal.read'],
        },
        schema: { querystring: NoQuery, response: { 200: PortalConsentsResponse } },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        const port = deps.consent;
        if (!port) return { available: false, consents: [] };
        return deps.withPortalSubject(actor, async (tx, subject) => {
          const consents = await port.list(tx, callOf(request, subject));
          await auditRead(tx, request.auditActor, subject, 'consent', consents.length);
          return { available: true, consents };
        });
      },
    );

    typed.get(
      '/portal/consents/:id',
      {
        config: {
          readOnly: 'read',
          auth: 'portal',
          portalPermission: 'portal.self.read',
          audits: ['portal.denied'],
        },
        schema: {
          params: IdParams,
          querystring: NoQuery,
          response: { 200: PortalConsentDetailDto },
        },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        const port = deps.consent;
        if (!port) throw new AppError('not_found');
        const outcome = await deps.withPortalSubject(actor, async (tx, subject) => ({
          subject,
          consent: await port.read(tx, {
            ...callOf(request, subject),
            consentId: request.params.id,
          }),
        }));
        if (!outcome.consent) {
          return refuseUnknown(deps.auditDeny, request, {
            subject: outcome.subject,
            resourceType: 'consent',
            resourceId: request.params.id,
          });
        }
        return outcome.consent;
      },
    );

    typed.post(
      '/portal/consents/:id/sign',
      {
        config: {
          // Signing is a new record, not a protection of the patient: a read-only organization
          // refuses it.
          readOnly: 'write',
          auth: 'portal',
          portalPermission: 'portal.consent.sign',
          audits: ['consent.signed', 'portal.denied'],
        },
        schema: {
          params: IdParams,
          body: PortalConsentSignRequest,
          response: { 200: PortalConsentResponse },
        },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        const port = deps.consent;
        if (!port) throw new AppError('not_found');
        const outcome = await deps.withPortalSubject(actor, async (tx, subject) => ({
          subject,
          consent: await port.sign(tx, {
            ...callOf(request, subject),
            consentId: request.params.id,
            request: request.body,
          }),
        }));
        if (!outcome.consent) {
          return refuseUnknown(deps.auditDeny, request, {
            subject: outcome.subject,
            resourceType: 'consent',
            resourceId: request.params.id,
          });
        }
        return { consent: outcome.consent };
      },
    );

    typed.post(
      '/portal/consents/:id/revoke',
      {
        config: {
          // Revoking a consent is the patient's protection and works in a read-only organization.
          readOnly: 'patient_protective',
          auth: 'portal',
          portalPermission: 'portal.consent.revoke',
          audits: ['consent.revoked', 'portal.denied'],
        },
        schema: {
          params: IdParams,
          body: PortalConsentRevokeRequest,
          response: { 200: PortalConsentResponse },
        },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        const port = deps.consent;
        if (!port) throw new AppError('not_found');
        const outcome = await deps.withPortalSubject(actor, async (tx, subject) => ({
          subject,
          consent: await port.revoke(tx, {
            ...callOf(request, subject),
            consentId: request.params.id,
            request: request.body,
          }),
        }));
        if (!outcome.consent) {
          return refuseUnknown(deps.auditDeny, request, {
            subject: outcome.subject,
            resourceType: 'consent',
            resourceId: request.params.id,
          });
        }
        return { consent: outcome.consent };
      },
    );

    // Prescriptions -------------------------------------------------------------------------------

    typed.get(
      '/portal/prescriptions',
      {
        config: {
          readOnly: 'read',
          auth: 'portal',
          portalPermission: 'portal.prescription.read',
          audits: ['portal.read'],
        },
        schema: {
          querystring: PortalPrescriptionsQuery,
          response: { 200: PortalPrescriptionsResponse },
        },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        const port = deps.prescriptions;
        if (!port) return { available: false, prescriptions: [], nextCursor: null };
        return deps.withPortalSubject(actor, async (tx, subject) => {
          const page = await port.list(tx, {
            ...callOf(request, subject),
            cursor: request.query.cursor,
          });
          await auditRead(
            tx,
            request.auditActor,
            subject,
            'prescription',
            page.prescriptions.length,
          );
          return { available: true, ...page };
        });
      },
    );

    // The patient's own data ----------------------------------------------------------------------

    typed.get(
      '/portal/profile',
      {
        config: {
          readOnly: 'read',
          auth: 'portal',
          portalPermission: 'portal.self.read',
          audits: ['portal.read'],
        },
        schema: { querystring: NoQuery, response: { 200: PortalProfileResponse } },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        return deps.withPortalSubject(actor, async (tx, subject) => {
          const profile = await readProfile(tx, subject);
          await auditRead(tx, request.auditActor, subject, 'profile', 1);
          return profile;
        });
      },
    );

    typed.patch(
      '/portal/profile',
      {
        config: {
          // A new version of the record: a read-only organization refuses it.
          readOnly: 'write',
          auth: 'portal',
          portalPermission: 'portal.profile.write',
          audits: ['portal.profile.changed'],
        },
        schema: { body: PortalProfileUpdateRequest, response: { 200: PortalProfileResponse } },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        return deps.withPortalSubject(actor, (tx, subject) =>
          updateProfile(tx, subject, { request: request.body, actor: request.auditActor }),
        );
      },
    );

    /** Tells the organization, by email and without the detail, that a patient made a request. */
    async function tellOrganization(
      request: FastifyRequest,
      input: {
        kind: 'copy' | 'rectification';
        patientId: string;
        recipients: string[];
        patientName: string;
        organization: string;
      },
    ): Promise<void> {
      const host = request.hostContext;
      if (host?.kind !== 'tenant') return;
      await Promise.allSettled(
        input.recipients.map((to) =>
          deps.email.send({
            to,
            tenant: { id: host.tenant.id, isDemo: host.tenant.isDemo },
            ...renderPortalRequestNoticeEmail({
              organizationName: input.organization,
              kind: input.kind,
              patientName: input.patientName,
              link: `${deps.origins(host.tenant.slug)}/patients/${input.patientId}`,
            }),
          }),
        ),
      );
    }

    async function makeRequest(
      request: FastifyRequest,
      kind: 'copy' | 'rectification',
      create: (tx: Tx, subject: PortalSubject) => Promise<PortalRightsRequest>,
    ): Promise<{ request: PortalRightsRequestDto }> {
      const { actor } = portalCaller(request);
      const done = await deps.withPortalSubject(actor, async (tx, subject) => {
        const created = await create(tx, subject);
        const basics = await readPatientBasics(tx, subject.patientId);
        return {
          created,
          patientId: subject.patientId,
          patientName: basics ? `${basics.givenNames} ${basics.familyName}`.trim() : '',
          recipients: await organizationRecipients(tx),
          organization: await readOrganizationName(tx),
        };
      });
      await tellOrganization(request, { kind, ...done });
      return { request: requestDto(done.created) };
    }

    typed.post(
      '/portal/rectification-requests',
      {
        config: {
          // A rectification request is the patient's right (Ley 25.326) and stays open.
          readOnly: 'patient_protective',
          auth: 'portal',
          portalPermission: 'portal.profile.write',
          audits: ['patient.rights_request.created'],
        },
        schema: { body: PortalRectificationRequest, response: { 200: PortalRequestResponse } },
      },
      (request) =>
        makeRequest(request, 'rectification', (tx, subject) =>
          requestRectification(tx, subject, { request: request.body, actor: request.auditActor }),
        ),
    );

    typed.post(
      '/portal/copy-requests',
      {
        config: {
          // The right of access does not lapse with a subscription (the registry's own rule).
          readOnly: 'patient_protective',
          auth: 'portal',
          portalPermission: 'portal.profile.write',
          audits: ['patient.rights_request.created'],
        },
        schema: { body: PortalCopyRequest, response: { 200: PortalRequestResponse } },
      },
      (request) =>
        makeRequest(request, 'copy', (tx, subject) =>
          requestCopy(tx, subject, { note: request.body.note, actor: request.auditActor }),
        ),
    );
  };
}
