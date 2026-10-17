import {
  AppointmentDto,
  AppointmentHistoryResponse,
  BookAppointmentRequest,
  CancelAppointmentRequest,
  CheckInRequest,
  CorrectStatusRequest,
  CreateHoldRequest,
  DetachPatientRequest,
  HoldDto,
  RescheduleRequest,
  TransitionRequest,
  effectivePermissions,
  type SlotConflictExtension,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError, conflictCode } from '../../../platform/http/problem.js';
import { AccessRefused, visibleLocationIds } from '../../access/index.js';
import { bookAppointment, SlotTakenError } from '../application/book-appointment.js';
import { createSchedulingPorts, isExclusionViolation } from '../application/drizzle-ports.js';
import { appointmentHistory } from '../application/history.js';
import { createHold, releaseHold } from '../application/holds.js';
import { detachPatient } from '../application/identity.js';
import {
  correctStatus,
  rescheduleAppointment,
  transitionAppointment,
  type TransitionAction,
} from '../application/lifecycle.js';
import { SlotNoLongerAvailableError, type BookActor } from '../application/placement.js';
import type { LocationRecord } from '../application/ports.js';
import type { TimeRange } from '../domain/working-hours.js';

export interface AppointmentRoutesDeps {
  withTenant: WithTenant;
  keys: TenantKeys;
  auditDeny: AuthzOptions['auditDeny'];
  clock: () => Date;
}

/** What a request knows about who acts, from the session and never from the body. */
export function requestActor(request: FastifyRequest): {
  actor: Actor;
  audit: AuditActor & { userId: string };
  book: BookActor;
  context: { tenantId: string; userId: string };
} {
  const actor = request.actor;
  if (!actor) throw new AppError('unauthenticated');
  return {
    actor,
    audit: { ...request.auditActor, userId: actor.userId },
    book: {
      userId: actor.userId,
      permissions: new Set(effectivePermissions(actor.roles, actor.grants)),
      professionalId: actor.professionalId,
    },
    context: { tenantId: actor.tenantId, userId: actor.userId },
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const slotRange = (range: TimeRange) => ({ startsAt: iso(range.start), endsAt: iso(range.end) });

/** The 409 for a time that is taken, with the taken range and the next free times. */
export function replySlotTaken(
  request: FastifyRequest,
  reply: FastifyReply,
  error?: SlotTakenError,
): FastifyReply {
  const extra: SlotConflictExtension | Record<string, never> = error
    ? { conflict: slotRange(error.conflict), nextSlots: error.nextSlots.map(slotRange) }
    : {};
  return conflictCode(request, reply, 'slot_taken', extra);
}

/** The 409 for a hold that ended before its holder finished (scheduling, "Slot holds"). */
export function replySlotNoLongerAvailable(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  return conflictCode(request, reply, 'slot_no_longer_available');
}

/**
 * Reception and other non-professional staff operate the locations they are assigned to; owners and
 * admins every location; a professional is held to their own calendar instead (not to locations).
 */
export function locationAuthorizer(
  tx: Tx,
  actor: Actor,
): (location: LocationRecord) => Promise<void> {
  return async (location) => {
    if (
      actor.roles.some((role) => role === 'owner' || role === 'admin' || role === 'professional')
    ) {
      return;
    }
    const visible = await visibleLocationIds(tx, {
      roles: actor.roles,
      membershipId: actor.membershipId,
    });
    if (visible !== 'all' && !visible.includes(location.id)) {
      throw new AccessRefused('location_not_assigned');
    }
  };
}

const IdParams = z.strictObject({ id: z.uuid() });

/** The lifecycle actions: the URL word, the action, and who may ask. */
const TRANSITION_ROUTES = [
  { path: 'confirm', action: 'confirm', permission: 'scheduling.checkin' },
  { path: 'start', action: 'start', permission: 'scheduling.checkin' },
  { path: 'attend', action: 'attend', permission: 'scheduling.checkin' },
  { path: 'no-show', action: 'no_show', permission: 'scheduling.checkin' },
  { path: 'approve', action: 'approve', permission: 'scheduling.book' },
] as const satisfies readonly {
  path: string;
  action: TransitionAction;
  permission: 'scheduling.checkin' | 'scheduling.book';
}[];

export function appointmentRoutes(deps: AppointmentRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    /** Runs a use case and turns its refusals into the answers the API gives. */
    async function respond(
      request: FastifyRequest,
      reply: FastifyReply,
      appointmentId: string,
      work: () => Promise<AppointmentDto>,
    ): Promise<AppointmentDto> {
      try {
        return await work();
      } catch (error) {
        // Fastify takes the reply itself as the result of an async handler once it is sent.
        if (error instanceof SlotTakenError) return replySlotTaken(request, reply, error) as never;
        if (error instanceof SlotNoLongerAvailableError) {
          return replySlotNoLongerAvailable(request, reply) as never;
        }
        if (isExclusionViolation(error)) return replySlotTaken(request, reply) as never;
        if (error instanceof AccessRefused) {
          return await refuseRequest(deps.auditDeny, request, {
            reason: error.reason,
            resourceType: 'appointment',
            resourceId: appointmentId,
          });
        }
        throw error;
      }
    }

    typed.post(
      '/appointments',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.book',
          audits: ['appointment.created', 'appointment.overridden'],
        },
        schema: { body: BookAppointmentRequest, response: { 201: AppointmentDto } },
      },
      async (request, reply) => {
        const { actor, audit, book, context } = requestActor(request);
        try {
          const created = await deps.withTenant(context, (tx) =>
            bookAppointment(createSchedulingPorts(tx, { keys: deps.keys }), {
              request: request.body,
              actor: book,
              auditActor: audit,
              now: deps.clock(),
              authorizeLocation: locationAuthorizer(tx, actor),
            }),
          );
          return await reply.code(201).send(created);
        } catch (error) {
          if (error instanceof SlotTakenError) return replySlotTaken(request, reply, error);
          if (error instanceof SlotNoLongerAvailableError) {
            return replySlotNoLongerAvailable(request, reply);
          }
          if (isExclusionViolation(error)) return replySlotTaken(request, reply);
          if (error instanceof AccessRefused) {
            return await refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'appointment',
              metadata: { professionalId: request.body.professionalId },
            });
          }
          throw error;
        }
      },
    );

    // A slot hold is not an appointment: no patient, no status, no history. It only keeps a range
    // for a short time while a booking is completed, and it ends by itself.
    typed.post(
      '/slot-holds',
      {
        config: { readOnly: 'write', permission: 'scheduling.book', audits: 'none' },
        schema: { body: CreateHoldRequest, response: { 201: HoldDto } },
      },
      async (request, reply) => {
        const { actor, book, context } = requestActor(request);
        try {
          const created = await deps.withTenant(context, (tx) =>
            createHold(createSchedulingPorts(tx, { keys: deps.keys }), {
              request: request.body,
              actor: book,
              now: deps.clock(),
              origin: 'staff',
              sourceKey: actor.userId,
              authorizeLocation: locationAuthorizer(tx, actor),
            }),
          );
          return await reply.code(201).send(created);
        } catch (error) {
          if (error instanceof SlotTakenError) return replySlotTaken(request, reply, error);
          if (isExclusionViolation(error)) return replySlotTaken(request, reply);
          if (error instanceof AccessRefused) {
            return await refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'slot_hold',
            });
          }
          throw error;
        }
      },
    );

    typed.delete(
      '/slot-holds/:id',
      {
        config: { readOnly: 'write', permission: 'scheduling.book', audits: 'none' },
        schema: { params: IdParams, response: { 200: HoldDto } },
      },
      (request) => {
        const { actor, context } = requestActor(request);
        return deps.withTenant(context, (tx) =>
          releaseHold(createSchedulingPorts(tx, { keys: deps.keys }), {
            holdId: request.params.id,
            sourceKey: actor.userId,
            now: deps.clock(),
          }),
        );
      },
    );

    typed.post(
      '/appointments/:id/check-in',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.checkin',
          audits: [
            'appointment.status_changed',
            'appointment.identity.confirmed',
            'appointment.identity.self_confirmed',
          ],
        },
        schema: {
          params: IdParams,
          body: CheckInRequest,
          response: { 200: AppointmentDto },
        },
      },
      (request, reply) => {
        const { audit, book, context } = requestActor(request);
        return respond(request, reply, request.params.id, () =>
          deps.withTenant(context, (tx) =>
            transitionAppointment(createSchedulingPorts(tx, { keys: deps.keys }), {
              appointmentId: request.params.id,
              action: 'check_in',
              actor: book,
              auditActor: audit,
              now: deps.clock(),
              expectedVersion: request.body.expectedVersion,
              confirmIdentity: request.body.confirmIdentity,
            }),
          ),
        );
      },
    );

    // The match was wrong: move the appointment to another patient record, or cancel it.
    typed.post(
      '/appointments/:id/detach-patient',
      {
        config: {
          readOnly: 'write',
          permission: 'worklist.manage',
          audits: ['appointment.identity.rejected', 'appointment.cancelled'],
        },
        schema: {
          params: IdParams,
          body: DetachPatientRequest,
          response: { 200: AppointmentDto },
        },
      },
      (request, reply) => {
        const { audit, book, context } = requestActor(request);
        const body = request.body;
        return respond(request, reply, request.params.id, () =>
          deps.withTenant(context, (tx) =>
            detachPatient(createSchedulingPorts(tx, { keys: deps.keys }), {
              appointmentId: request.params.id,
              actor: book,
              auditActor: audit,
              now: deps.clock(),
              expectedVersion: body.expectedVersion,
              resolution:
                body.resolution === 'move_to_patient'
                  ? { kind: 'move_to_patient', patientId: body.patientId }
                  : {
                      kind: 'cancel',
                      cancellation: {
                        cancelledBy: body.cancelledBy,
                        reasonCode: body.reasonCode,
                        ...(body.note === undefined ? {} : { note: body.note }),
                      },
                    },
            }),
          ),
        );
      },
    );

    for (const route of TRANSITION_ROUTES) {
      typed.post(
        `/appointments/:id/${route.path}`,
        {
          config: {
            readOnly: 'write',
            permission: route.permission,
            audits: ['appointment.status_changed'],
          },
          schema: {
            params: IdParams,
            body: TransitionRequest,
            response: { 200: AppointmentDto },
          },
        },
        (request, reply) => {
          const { audit, book, context } = requestActor(request);
          return respond(request, reply, request.params.id, () =>
            deps.withTenant(context, (tx) =>
              transitionAppointment(createSchedulingPorts(tx, { keys: deps.keys }), {
                appointmentId: request.params.id,
                action: route.action,
                actor: book,
                auditActor: audit,
                now: deps.clock(),
                expectedVersion: request.body.expectedVersion,
              }),
            ),
          );
        },
      );
    }

    // Cancelling is a patient-protective write: it stays possible when the organization is
    // read-only, because a patient must always be able to give a slot back.
    typed.post(
      '/appointments/:id/cancel',
      {
        config: {
          readOnly: 'patient_protective',
          permission: 'scheduling.book',
          audits: ['appointment.cancelled'],
        },
        schema: {
          params: IdParams,
          body: CancelAppointmentRequest,
          response: { 200: AppointmentDto },
        },
      },
      (request, reply) => {
        const { audit, book, context } = requestActor(request);
        const { expectedVersion, ...cancellation } = request.body;
        return respond(request, reply, request.params.id, () =>
          deps.withTenant(context, (tx) =>
            transitionAppointment(createSchedulingPorts(tx, { keys: deps.keys }), {
              appointmentId: request.params.id,
              action: 'cancel',
              actor: book,
              auditActor: audit,
              now: deps.clock(),
              expectedVersion,
              cancellation: {
                cancelledBy: cancellation.cancelledBy,
                reasonCode: cancellation.reasonCode,
                ...(cancellation.note === undefined ? {} : { note: cancellation.note }),
              },
            }),
          ),
        );
      },
    );

    typed.post(
      '/appointments/:id/correct',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.checkin',
          audits: ['appointment.status_corrected'],
        },
        schema: {
          params: IdParams,
          body: CorrectStatusRequest,
          response: { 200: AppointmentDto },
        },
      },
      (request, reply) => {
        const { audit, book, context } = requestActor(request);
        return respond(request, reply, request.params.id, () =>
          deps.withTenant(context, (tx) =>
            correctStatus(createSchedulingPorts(tx, { keys: deps.keys }), {
              appointmentId: request.params.id,
              toStatus: request.body.toStatus,
              reason: request.body.reason,
              actor: book,
              auditActor: audit,
              now: deps.clock(),
              expectedVersion: request.body.expectedVersion,
            }),
          ),
        );
      },
    );

    typed.post(
      '/appointments/:id/reschedule',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.book',
          audits: ['appointment.rescheduled', 'appointment.reassigned', 'appointment.overridden'],
        },
        schema: {
          params: IdParams,
          body: RescheduleRequest,
          response: { 200: AppointmentDto },
        },
      },
      (request, reply) => {
        const { actor, audit, book, context } = requestActor(request);
        return respond(request, reply, request.params.id, () =>
          deps.withTenant(context, (tx) =>
            rescheduleAppointment(createSchedulingPorts(tx, { keys: deps.keys }), {
              appointmentId: request.params.id,
              ...request.body,
              actor: book,
              auditActor: audit,
              now: deps.clock(),
              authorizeLocation: locationAuthorizer(tx, actor),
            }),
          ),
        );
      },
    );

    typed.get(
      '/appointments/:id/history',
      {
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { params: IdParams, response: { 200: AppointmentHistoryResponse } },
      },
      (request) => {
        const { context } = requestActor(request);
        return deps.withTenant(context, (tx) => appointmentHistory(tx, request.params.id));
      },
    );
  };
}
