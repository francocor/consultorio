import { AppointmentMessagesResponse, ResendMessageRequest } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { appointment } from '../../../db/schema/scheduling.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { visibleLocationIds } from '../../access/index.js';
import {
  appointmentMessages,
  resendReminder,
  type ResendDeps,
} from '../application/message-log.js';

export interface MessageRoutesDeps extends ResendDeps {
  withTenant: WithTenant;
}

const Params = z.strictObject({ id: z.uuid() });

function actorOf(request: FastifyRequest) {
  const actor = request.actor;
  if (!actor) throw new AppError('unauthenticated');
  return actor;
}

/**
 * Reception works the appointments of the locations it is assigned to: an appointment elsewhere,
 * or in another organization, does not exist for it (the same answer for both).
 */
async function assertVisible(
  tx: Tx,
  actor: ReturnType<typeof actorOf>,
  appointmentId: string,
): Promise<void> {
  const [row] = await tx
    .select({ locationId: appointment.locationId })
    .from(appointment)
    .where(eq(appointment.id, appointmentId));
  if (!row) throw new AppError('not_found');
  const visible = await visibleLocationIds(tx, {
    roles: actor.roles,
    membershipId: actor.membershipId,
  });
  if (visible !== 'all' && !visible.includes(row.locationId)) throw new AppError('not_found');
}

export function messageRoutes(deps: MessageRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/appointments/:id/messages',
      {
        config: { readOnly: 'read', permission: 'notifications.log.read' },
        schema: { params: Params, response: { 200: AppointmentMessagesResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
          await assertVisible(tx, actor, request.params.id);
          return appointmentMessages(tx, request.params.id);
        });
      },
    );

    typed.post(
      '/appointments/:id/messages/resend',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.book',
          audits: ['notification.resend'],
        },
        schema: {
          params: Params,
          body: ResendMessageRequest,
          response: { 200: AppointmentMessagesResponse },
        },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
          await assertVisible(tx, actor, request.params.id);
          return resendReminder(deps, tx, {
            appointmentId: request.params.id,
            channel: request.body.channel,
            actor: { ...request.auditActor, userId: actor.userId },
          });
        });
      },
    );
  };
}
