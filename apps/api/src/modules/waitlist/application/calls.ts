import type { WaitlistCallReason } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';

import { waitlistCall } from '../../../db/schema/waitlist.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { SchedulingPorts } from '../../scheduling/index.js';

export interface CallSlot {
  entryId: string;
  professionalId: string;
  locationId: string;
  appointmentTypeId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Shows reception a slot to fill by phone, with the entry to call: the slot is kept in
 * `waitlist_call` and the reception worklist gets its pointer (`waitlist_manual_contact`, one open
 * item per entry). Showing the same slot for the same entry twice is a no-op.
 */
export async function recordCall(
  tx: Tx,
  ports: SchedulingPorts,
  slot: CallSlot,
  reason: WaitlistCallReason,
): Promise<void> {
  await tx
    .insert(waitlistCall)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      entryId: slot.entryId,
      professionalId: slot.professionalId,
      locationId: slot.locationId,
      appointmentTypeId: slot.appointmentTypeId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      reason,
    })
    .onConflictDoNothing();
  await ports.openWorklistItem({
    kind: 'waitlist_manual_contact',
    subjectType: 'waitlist_entry',
    subjectId: slot.entryId,
    locationId: slot.locationId,
  });
}
