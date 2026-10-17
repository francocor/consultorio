import {
  AppointmentDto,
  BookAppointmentRequest,
  effectivePermissions,
  type SlotConflictExtension,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError, conflictCode } from '../../../platform/http/problem.js';
import { AccessRefused, visibleLocationIds } from '../../access/index.js';
import {
  bookAppointment,
  SlotTakenError,
  type BookActor,
} from '../application/book-appointment.js';
import { createSchedulingPorts, isExclusionViolation } from '../application/drizzle-ports.js';
import type { LocationRecord } from '../application/ports.js';
import type { TimeRange } from '../domain/working-hours.js';

export interface AppointmentRoutesDeps {
  withTenant: WithTenant;
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

export function appointmentRoutes(deps: AppointmentRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

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
            bookAppointment(createSchedulingPorts(tx), {
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
  };
}
