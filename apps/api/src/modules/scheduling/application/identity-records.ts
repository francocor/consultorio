import type { AuditActor } from '../../../platform/audit/writer.js';
import type { IdentityConfirmation } from '../domain/identity-confirmation.js';

import type { AppointmentRecord, SchedulingPorts } from './ports.js';

/**
 * What every way of confirming an identity writes once the appointment row is updated: the
 * history event, the audit entry (a sole professional's own confirmation carries its own marker,
 * D18) and the closing of the identity review on the worklist.
 */
export async function recordIdentityConfirmed(
  ports: SchedulingPorts,
  input: {
    record: AppointmentRecord;
    how: IdentityConfirmation;
    channel: 'worklist' | 'check_in';
    actor: AuditActor & { userId: string };
  },
): Promise<void> {
  const selfConfirmed = input.how === 'self_confirmed';
  await ports.insertEvent({
    appointmentId: input.record.id,
    kind: 'identity_confirmed',
    actorUserId: input.actor.userId,
    actorKind: 'staff',
    details: { how: input.how, channel: input.channel },
  });
  await ports.audit({
    action: selfConfirmed
      ? 'appointment.identity.self_confirmed'
      : 'appointment.identity.confirmed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'appointment',
    resourceId: input.record.id,
    patientId: input.record.patientId,
    metadata: { how: input.how, channel: input.channel },
  });
  await ports.closeWorklistItem({
    kind: 'identity_review',
    subjectType: 'appointment',
    subjectId: input.record.id,
    status: 'resolved',
    resolution: selfConfirmed ? 'identity_self_confirmed' : 'identity_confirmed',
    actor: input.actor,
  });
}
