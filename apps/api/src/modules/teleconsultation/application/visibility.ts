import type { Actor } from '../../../platform/authz/actor.js';
import { calendarAccess } from '../../../platform/authz/calendar-scope.js';
import { locationScopeOf, mayOperateAt } from '../../../platform/authz/location-scope.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { visibleLocationIds } from '../../access/index.js';

import type { AppointmentVideoFacts } from './video-state.js';

/**
 * Whether a member of the staff works in the calendar and at the location of this appointment: the
 * same rule the calendar applies (own calendar, delegated calendars, the locations of reception),
 * so the video side never shows what the calendar would not.
 */
export async function mayWorkOn(
  tx: Tx,
  actor: Actor,
  appointment: Pick<AppointmentVideoFacts, 'professionalId' | 'locationId'>,
): Promise<boolean> {
  if (!calendarAccess(actor, appointment.professionalId)) return false;
  const scope = locationScopeOf(actor);
  const visible =
    scope.kind === 'all'
      ? 'all'
      : await visibleLocationIds(tx, { roles: actor.roles, membershipId: actor.membershipId });
  return mayOperateAt(
    visible === 'all' ? { kind: 'all' } : scope,
    visible === 'all' ? [] : visible,
    { locationId: appointment.locationId, professionalId: appointment.professionalId },
  );
}

/** The caller may not do this to this appointment. The route answers 403 and records the denial. */
export class VideoAccessRefused extends Error {
  readonly reason: 'calendar_not_accessible' | 'not_the_assigned_professional';

  constructor(reason: VideoAccessRefused['reason']) {
    super(reason);
    this.name = 'VideoAccessRefused';
    this.reason = reason;
  }
}
