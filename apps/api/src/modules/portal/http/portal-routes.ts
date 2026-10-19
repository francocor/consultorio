import {
  PortalAppointmentResponse,
  PortalAppointmentsResponse,
  PortalDocumentsResponse,
  PortalMeResponse,
  PortalSubjectRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { audit } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import type { PortalSessionInfo } from '../../../platform/http/portal-guard.js';
import { AppError } from '../../../platform/http/problem.js';
import {
  cancelAppointment,
  confirmAppointment,
  readAppointments,
  type AppointmentDeps,
} from '../application/appointments.js';
import { listSharedDocuments } from '../application/document-shares.js';
import type { PortalSessions } from '../application/sessions.js';
import {
  readMe,
  selectSubject,
  type PortalSubject,
  type WithPortalSubject,
} from '../application/subject.js';

export interface PortalRoutesDeps {
  withTenant: WithTenant;
  withPortalSubject: WithPortalSubject;
  sessions: PortalSessions;
  auditDeny: AuthzOptions['auditDeny'];
  appointments: AppointmentDeps;
  /** What the portal can show today (a part with no module behind it shows its empty state). */
  capabilities: () => PortalMeResponse['capabilities'];
}

const IdParams = z.strictObject({ id: z.uuid() });
const NoQuery = z.strictObject({});

/** Who is acting in a portal route: always present once the portal guard has run. */
export function portalCaller(request: FastifyRequest): {
  actor: PortalActor;
  session: PortalSessionInfo;
} {
  const actor = request.portalActor;
  const session = request.portalSession;
  if (!actor || !session) throw new AppError('unauthenticated');
  return { actor, session };
}

/**
 * Answers "not found" for something the subject asked for that is not theirs (or does not exist),
 * and records the attempt on its own connection, so the rollback of the request cannot erase it
 * (patient-portal "Own-data-only access"). The answer is the same for a resource of another
 * patient and for one that never existed.
 */
export async function refuseUnknown(
  auditDeny: AuthzOptions['auditDeny'],
  request: FastifyRequest,
  input: { subject: PortalSubject | null; resourceType: string; resourceId?: string },
): Promise<never> {
  const { actor } = portalCaller(request);
  await auditDeny(actor.tenantId, {
    action: 'portal.denied',
    actor: request.auditActor,
    resourceType: input.resourceType,
    ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
    ...(input.subject === null ? {} : { patientId: input.subject.patientId }),
    reason: 'not_found_for_subject',
    metadata: { identityId: actor.identityId },
  });
  throw new AppError('not_found');
}

/**
 * The portal as the patient uses it once signed in (S5.08). Every route needs the portal cookie
 * (`auth: 'portal'`, under /portal/), names no tenant and no patient, and reads or changes only
 * the subject the session picked.
 */
export function portalRoutes(deps: PortalRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/portal/me',
      {
        config: { readOnly: 'read', auth: 'portal', portalPermission: 'portal.self.read' },
        schema: { querystring: NoQuery, response: { 200: PortalMeResponse } },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: SYSTEM_USER_ID }, (tx) =>
          readMe(tx, { actor, capabilities: deps.capabilities() }),
        );
      },
    );

    typed.post(
      '/portal/subject',
      {
        config: {
          readOnly: 'auth',
          auth: 'portal',
          portalPermission: 'portal.self.read',
          audits: ['portal.denied'],
        },
        schema: { body: PortalSubjectRequest, response: { 200: PortalMeResponse } },
      },
      async (request) => {
        const { actor, session } = portalCaller(request);
        const outcome = await deps.withTenant(
          { tenantId: actor.tenantId, userId: SYSTEM_USER_ID },
          (tx) =>
            selectSubject(tx, deps, {
              actor,
              sessionId: session.sessionId,
              linkId: request.body.linkId,
            }),
        );
        if (outcome === 'unknown') {
          return refuseUnknown(deps.auditDeny, request, {
            subject: null,
            resourceType: 'portal_link',
            resourceId: request.body.linkId,
          });
        }
        return deps.withTenant({ tenantId: actor.tenantId, userId: SYSTEM_USER_ID }, (tx) =>
          readMe(tx, {
            actor: { ...actor, linkId: request.body.linkId },
            capabilities: deps.capabilities(),
          }),
        );
      },
    );

    typed.get(
      '/portal/appointments',
      {
        config: { readOnly: 'read', auth: 'portal', portalPermission: 'portal.self.read' },
        schema: { querystring: NoQuery, response: { 200: PortalAppointmentsResponse } },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        return deps.withPortalSubject(actor, (tx, subject) =>
          readAppointments(tx, deps.appointments, subject),
        );
      },
    );

    typed.get(
      '/portal/documents',
      {
        config: {
          readOnly: 'read',
          auth: 'portal',
          portalPermission: 'portal.document.read',
          audits: ['portal.read'],
        },
        schema: { querystring: NoQuery, response: { 200: PortalDocumentsResponse } },
      },
      async (request) => {
        const { actor } = portalCaller(request);
        return deps.withPortalSubject(actor, async (tx, subject) => {
          const documents = await listSharedDocuments(tx);
          await audit(tx, {
            action: 'portal.read',
            outcome: 'allow',
            actor: request.auditActor,
            resourceType: 'document',
            patientId: subject.patientId,
            metadata: { section: 'documents', count: documents.length },
          });
          return { documents };
        });
      },
    );

    const change = (action: 'confirm' | 'cancel') => async (request: FastifyRequest) => {
      const { actor } = portalCaller(request);
      const { id } = request.params as { id: string };
      const outcome = await deps.withPortalSubject(actor, async (tx, subject) => ({
        subject,
        result: await (action === 'confirm' ? confirmAppointment : cancelAppointment)(
          tx,
          deps.appointments,
          subject,
          { appointmentId: id, actor: request.auditActor },
        ),
      }));
      if (!outcome.result.ok) {
        return refuseUnknown(deps.auditDeny, request, {
          subject: outcome.subject,
          resourceType: 'appointment',
          resourceId: id,
        });
      }
      return { appointment: outcome.result.appointment };
    };

    typed.post(
      '/portal/appointments/:id/confirm',
      {
        config: {
          // Confirming adds nothing the patient needs protected: a read-only organization refuses it.
          readOnly: 'write',
          auth: 'portal',
          portalPermission: 'portal.appointment.cancel',
          audits: ['appointment.status_changed', 'portal.denied'],
        },
        schema: {
          params: IdParams,
          body: z.strictObject({}).optional(),
          response: { 200: PortalAppointmentResponse },
        },
      },
      change('confirm'),
    );

    typed.post(
      '/portal/appointments/:id/cancel',
      {
        config: {
          // Cancelling is the patient's protection and works in a read-only organization.
          readOnly: 'patient_protective',
          auth: 'portal',
          portalPermission: 'portal.appointment.cancel',
          audits: ['appointment.cancelled', 'portal.denied'],
        },
        schema: {
          params: IdParams,
          body: z.strictObject({}).optional(),
          response: { 200: PortalAppointmentResponse },
        },
      },
      change('cancel'),
    );
  };
}
