import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/** Owner, admin and reception work in every calendar of their locations as part of their job. */
export const isAdministrative = (actor: Actor) =>
  actor.roles.some((role) => role === 'owner' || role === 'admin' || role === 'reception');

/**
 * Whether looking at this professional's calendar is a look at somebody else's: a professional
 * reading a colleague's calendar that was delegated to them (scheduling, "Scheduling authorization
 * and audit"). Administrative staff are not audited for their ordinary work.
 */
export function viewsOthersCalendar(actor: Actor, professionalId: string): boolean {
  return (
    !isAdministrative(actor) &&
    actor.professionalId !== null &&
    actor.professionalId !== professionalId
  );
}

export type DelegatedView = 'appointment' | 'history' | 'availability';

/**
 * Audits a look at one appointment, its history or the free time of a colleague's calendar, the
 * same `calendar_viewed` event as the feed writes. Call it only after access was granted: a
 * refused look is a denial of its own.
 */
export async function auditDelegatedView(
  tx: Tx,
  input: {
    actor: Actor;
    auditActor: AuditActor & { userId: string };
    professionalId: string;
    view: DelegatedView;
    /** The appointment looked at, when the view is about one. */
    appointmentId?: string;
  },
): Promise<void> {
  if (!viewsOthersCalendar(input.actor, input.professionalId)) return;
  await audit(tx, {
    action: 'appointment.calendar_viewed',
    outcome: 'allow',
    actor: input.auditActor,
    resourceType: input.appointmentId === undefined ? 'calendar' : 'appointment',
    resourceId: input.appointmentId ?? input.professionalId,
    metadata: { view: input.view, professionalId: input.professionalId },
  });
}
