import { and, eq, gt, sql } from 'drizzle-orm';

import { patientRecordChange } from '../../../db/schema/portal.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { RECENT_RECORD_CHANGE_DAYS } from '../domain/record-change.js';

export type StaffGateCode = 'portal_recent_identity_change' | 'portal_owner_or_admin_required';

/**
 * A member of the staff who is not an owner or an administrator asked for something that gives
 * somebody access to a patient's record, and the record is not in a state where they may (JD-S5
 * R2-2). The route turns it into the answer with its code and writes the refusal in the trail.
 */
export class PortalStaffRefused extends Error {
  constructor(
    readonly code: StaffGateCode,
    readonly patientId: string,
  ) {
    super(code);
    this.name = 'PortalStaffRefused';
  }
}

/**
 * Whether the e-mail or the birth date of the record changed in the last seven days. The week is
 * counted by the clock of the database, the one that wrote the change (the trigger of `patient`).
 */
export async function hasRecentRecordChange(tx: Tx, patientId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: patientRecordChange.id })
    .from(patientRecordChange)
    .where(
      and(
        eq(patientRecordChange.patientId, patientId),
        gt(
          patientRecordChange.createdAt,
          sql`now() - make_interval(days => ${RECENT_RECORD_CHANGE_DAYS})`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The gate every way of giving access to a patient goes through, for the staff:
 *
 * - for seven days after the e-mail or the birth date of the record changed, only an owner or an
 *   administrator may invite the patient or a representative, or link a representative;
 * - a representative for a patient whose record has no e-mail (nobody to tell) is for an owner or an
 *   administrator too.
 *
 * It answers whether an owner or an administrator used the exception, so the trail says so.
 */
export async function assertMayGiveAccess(
  tx: Tx,
  input: {
    patientId: string;
    ownerOrAdmin: boolean;
    /** The access is for a representative (not for the patient). */
    representative: boolean;
    recordEmail: string | null;
  },
): Promise<{ afterRecordChange: boolean }> {
  const recent = await hasRecentRecordChange(tx, input.patientId);
  const nobodyToTell =
    input.representative && (input.recordEmail === null || input.recordEmail.trim() === '');
  if (!input.ownerOrAdmin) {
    if (recent) throw new PortalStaffRefused('portal_recent_identity_change', input.patientId);
    if (nobodyToTell)
      throw new PortalStaffRefused('portal_owner_or_admin_required', input.patientId);
  }
  return { afterRecordChange: recent || nobodyToTell };
}
