import {
  AppointmentDto,
  AppointmentHistoryResponse,
  BookAppointmentRequest,
  CalendarEntryDto,
  CalendarQuery,
  CalendarResponse,
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
import { calendarAccess } from '../../../platform/authz/calendar-scope.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError, conflictCode } from '../../../platform/http/problem.js';
import { refuseWhenReadOnly } from '../../../platform/read-only/index.js';
import { AccessRefused } from '../../access/index.js';
import { bookAppointment, SlotTakenError } from '../application/book-appointment.js';
import type { createCalendar } from '../application/calendar.js';
import { createSchedulingPorts } from '../application/drizzle-ports.js';
import { appointmentHistory } from '../application/history.js';
import { createHold, releaseHold } from '../application/holds.js';
import { detachPatient } from '../application/identity.js';
import {
  correctStatus,
  rescheduleAppointment,
  transitionAppointment,
  type TransitionAction,
} from '../application/lifecycle.js';
import { locationAccessOf } from '../application/location-access.js';
import {
  SlotNoLongerAvailableError,
  type BookActor,
  type LocationAuthorizer,
} from '../application/placement.js';
import type { TimeRange } from '../domain/working-hours.js';

export interface AppointmentRoutesDeps {
  withTenant: WithTenant;
  keys: TenantKeys;
  auditDeny: AuthzOptions['auditDeny'];
  clock: () => Date;
  calendar: ReturnType<typeof createCalendar>;
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
      ownProfessionalId: actor.ownProfessionalId ?? actor.professionalId,
    },
    context: { tenantId: actor.tenantId, userId: actor.userId },
  };
}

/**
 * What a use case needs to know about the limits of the actor: the calendars they may work in (a
 * professional's own and the delegated ones) and the locations they may operate in each of them.
 * Computed once per request, in its transaction, so the services never read the session.
 */
export async function scopedActor(tx: Tx, actor: Actor, book: BookActor): Promise<BookActor> {
  const access = await locationAccessOf(tx, actor);
  return {
    ...book,
    mayUseCalendar: (professionalId) => calendarAccess(actor, professionalId),
    mayUseLocation: (locationId, professionalId) => access.may({ locationId, professionalId }),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const slotRange = (range: TimeRange) => ({ startsAt: iso(range.start), endsAt: iso(range.end) });

/**
 * The 409 for a time that is taken, with the taken range and the next free times. Every refusal of
 * an overlap reaches here as a `SlotTakenError`, the ones the database caught after the checks too
 * (the use cases convert them), so the answer always carries the same members.
 */
export function replySlotTaken(
  request: FastifyRequest,
  reply: FastifyReply,
  error: SlotTakenError,
): FastifyReply {
  const extra: SlotConflictExtension = {
    conflict: slotRange(error.conflict),
    nextSlots: error.nextSlots.map(slotRange),
  };
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
 * Reception and other staff assigned to locations operate those; owners and admins every location;
 * a professional who is only a professional is held to calendars instead of locations. A reception
 * user who is also a professional is limited to the assigned locations everywhere but in their own
 * calendar.
 */
export function locationAuthorizer(tx: Tx, actor: Actor): LocationAuthorizer {
  return async (location, professionalId) => {
    const access = await locationAccessOf(tx, actor);
    if (!access.may({ locationId: location.id, professionalId })) {
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

    /** The ports of a transaction. */
    const portsOf = (tx: Tx) => createSchedulingPorts(tx, { keys: deps.keys });

    /**
     * Runs work for the request's actor in one tenant transaction, with the actor's calendars and
     * locations resolved inside it.
     */
    function runScoped<T>(
      request: FastifyRequest,
      work: (scope: {
        tx: Tx;
        actor: Actor;
        who: BookActor;
        audit: AuditActor & { userId: string };
      }) => Promise<T>,
    ): Promise<T> {
      const { actor, audit, book, context } = requestActor(request);
      return deps.withTenant(context, async (tx) =>
        work({ tx, actor, audit, who: await scopedActor(tx, actor, book) }),
      );
    }

    /** Turns the refusals of a use case into the answers the API gives. */
    async function refusal(
      error: unknown,
      request: FastifyRequest,
      reply: FastifyReply,
      subject: { resourceType: string; resourceId?: string; professionalId?: string },
    ): Promise<FastifyReply> {
      if (error instanceof SlotTakenError) return replySlotTaken(request, reply, error);
      if (error instanceof SlotNoLongerAvailableError) {
        return replySlotNoLongerAvailable(request, reply);
      }
      if (error instanceof AccessRefused) {
        return await refuseRequest(deps.auditDeny, request, {
          reason: error.reason,
          resourceType: subject.resourceType,
          ...(subject.resourceId === undefined ? {} : { resourceId: subject.resourceId }),
          ...(subject.professionalId === undefined
            ? {}
            : { metadata: { professionalId: subject.professionalId } }),
        });
      }
      throw error;
    }

    /** Runs a use case that answers 200 with an appointment. */
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
        return await refusal(error, request, reply, {
          resourceType: 'appointment',
          resourceId: appointmentId,
        });
      }
    }

    // Reading ----------------------------------------------------------------------------------
    typed.get(
      '/appointments',
      {
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { querystring: CalendarQuery, response: { 200: CalendarResponse } },
      },
      async (request, reply) => {
        try {
          return await runScoped(request, ({ tx, actor, audit }) =>
            deps.calendar.feed(tx, { query: request.query, actor, auditActor: audit }),
          );
        } catch (error) {
          return await refusal(error, request, reply, { resourceType: 'calendar' });
        }
      },
    );

    typed.get(
      '/appointments/:id',
      {
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { params: IdParams, response: { 200: CalendarEntryDto } },
      },
      async (request, reply) => {
        try {
          return await runScoped(request, ({ tx, actor, audit }) =>
            deps.calendar.get(tx, {
              id: request.params.id,
              actor,
              auditActor: audit,
              view: 'appointment',
            }),
          );
        } catch (error) {
          return await refusal(error, request, reply, {
            resourceType: 'appointment',
            resourceId: request.params.id,
          });
        }
      },
    );

    typed.get(
      '/appointments/:id/history',
      {
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { params: IdParams, response: { 200: AppointmentHistoryResponse } },
      },
      async (request, reply) => {
        try {
          return await runScoped(request, async ({ tx, actor, audit }) => {
            // The history is as private as the appointment: same calendar, same location.
            await deps.calendar.get(tx, {
              id: request.params.id,
              actor,
              auditActor: audit,
              view: 'history',
            });
            return appointmentHistory(tx, request.params.id);
          });
        } catch (error) {
          return await refusal(error, request, reply, {
            resourceType: 'appointment',
            resourceId: request.params.id,
          });
        }
      },
    );

    // Booking -----------------------------------------------------------------------------------
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
        try {
          const created = await runScoped(request, ({ tx, actor, who, audit }) =>
            bookAppointment(portsOf(tx), {
              request: request.body,
              actor: who,
              auditActor: audit,
              now: deps.clock(),
              authorizeLocation: locationAuthorizer(tx, actor),
            }),
          );
          return await reply.code(201).send(created);
        } catch (error) {
          return await refusal(error, request, reply, {
            resourceType: 'appointment',
            professionalId: request.body.professionalId,
          });
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
        try {
          const created = await runScoped(request, ({ tx, actor, who }) =>
            createHold(portsOf(tx), {
              request: request.body,
              actor: who,
              now: deps.clock(),
              origin: 'staff',
              sourceKey: actor.userId,
              authorizeLocation: locationAuthorizer(tx, actor),
            }),
          );
          return await reply.code(201).send(created);
        } catch (error) {
          return await refusal(error, request, reply, {
            resourceType: 'slot_hold',
            professionalId: request.body.professionalId,
          });
        }
      },
    );

    typed.delete(
      '/slot-holds/:id',
      {
        config: { readOnly: 'write', permission: 'scheduling.book', audits: 'none' },
        schema: { params: IdParams, response: { 200: HoldDto } },
      },
      (request) =>
        runScoped(request, ({ tx, actor }) =>
          releaseHold(portsOf(tx), {
            holdId: request.params.id,
            sourceKey: actor.userId,
            now: deps.clock(),
          }),
        ),
    );

    // The lifecycle -----------------------------------------------------------------------------
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
        schema: { params: IdParams, body: CheckInRequest, response: { 200: AppointmentDto } },
      },
      (request, reply) =>
        respond(request, reply, request.params.id, () =>
          runScoped(request, ({ tx, who, audit }) =>
            transitionAppointment(portsOf(tx), {
              appointmentId: request.params.id,
              action: 'check_in',
              actor: who,
              auditActor: audit,
              now: deps.clock(),
              expectedVersion: request.body.expectedVersion,
              confirmIdentity: request.body.confirmIdentity,
            }),
          ),
        ),
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
        schema: { params: IdParams, body: DetachPatientRequest, response: { 200: AppointmentDto } },
      },
      (request, reply) => {
        const body = request.body;
        return respond(request, reply, request.params.id, () =>
          runScoped(request, ({ tx, who, audit }) =>
            detachPatient(portsOf(tx), {
              appointmentId: request.params.id,
              actor: who,
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
          schema: { params: IdParams, body: TransitionRequest, response: { 200: AppointmentDto } },
        },
        (request, reply) =>
          respond(request, reply, request.params.id, () =>
            runScoped(request, ({ tx, who, audit }) =>
              transitionAppointment(portsOf(tx), {
                appointmentId: request.params.id,
                action: route.action,
                actor: who,
                auditActor: audit,
                now: deps.clock(),
                expectedVersion: request.body.expectedVersion,
              }),
            ),
          ),
      );
    }

    // Cancelling is patient-protective when the patient asks for it: it stays possible when the
    // organization is read-only, because a patient must always be able to give a slot back. The
    // organization or a professional cancelling for their own reasons is an ordinary write.
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
        const { expectedVersion, ...cancellation } = request.body;
        if (cancellation.cancelledBy !== 'patient') refuseWhenReadOnly(request);
        return respond(request, reply, request.params.id, () =>
          runScoped(request, ({ tx, who, audit }) =>
            transitionAppointment(portsOf(tx), {
              appointmentId: request.params.id,
              action: 'cancel',
              actor: who,
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
        schema: { params: IdParams, body: CorrectStatusRequest, response: { 200: AppointmentDto } },
      },
      (request, reply) =>
        respond(request, reply, request.params.id, () =>
          runScoped(request, ({ tx, who, audit }) =>
            correctStatus(portsOf(tx), {
              appointmentId: request.params.id,
              toStatus: request.body.toStatus,
              reasonCode: request.body.reasonCode,
              note: request.body.note,
              actor: who,
              auditActor: audit,
              now: deps.clock(),
              expectedVersion: request.body.expectedVersion,
            }),
          ),
        ),
    );

    typed.post(
      '/appointments/:id/reschedule',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.book',
          audits: ['appointment.rescheduled', 'appointment.reassigned', 'appointment.overridden'],
        },
        schema: { params: IdParams, body: RescheduleRequest, response: { 200: AppointmentDto } },
      },
      (request, reply) =>
        respond(request, reply, request.params.id, () =>
          runScoped(request, ({ tx, actor, who, audit }) =>
            rescheduleAppointment(portsOf(tx), {
              appointmentId: request.params.id,
              ...request.body,
              actor: who,
              auditActor: audit,
              now: deps.clock(),
              authorizeLocation: locationAuthorizer(tx, actor),
            }),
          ),
        ),
    );
  };
}
