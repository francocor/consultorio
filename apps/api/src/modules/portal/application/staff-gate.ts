import { and, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';

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
 * The rows of a patient that keep the public registration closed until an owner or an administrator
 * invites the patient (JD-S5 R3-4, R4-1), and that no invitation has opened yet:
 *
 * - a change flagged `registration_requires_invitation` (an address given to a record that had none,
 *   or a notice that was given up);
 * - a notice that nobody was told, whatever its age: the address is still on the row, it was neither
 *   sent nor given up. From day 7 until the sweep gives it up both the week and the flag are down, so
 *   a worker that is down would open the registration of a record whose previous address was never
 *   warned. Fail-safe: untold means closed.
 */
const closesRegistration = () =>
  and(
    isNull(patientRecordChange.invitationOpenedAt),
    or(
      eq(patientRecordChange.registrationRequiresInvitation, true),
      and(
        isNotNull(patientRecordChange.noticeEmail),
        isNull(patientRecordChange.noticeSentAt),
        isNull(patientRecordChange.noticeExpiredAt),
      ),
    ),
  );

/**
 * Whether the PUBLIC registration of the patient (document number plus e-mail, no invitation) is
 * closed (JD-S5 R3-4, R4-1): a change gave an e-mail to a record that had none, or the notice to the
 * previous address could not be told (or has not been told yet), and no owner or administrator has
 * invited the patient since. Nobody who knew the old record was warned, so the week of R2-2 is not
 * enough.
 */
export async function isRegistrationClosed(tx: Tx, patientId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: patientRecordChange.id })
    .from(patientRecordChange)
    .where(and(eq(patientRecordChange.patientId, patientId), closesRegistration()))
    .limit(1);
  return row !== undefined;
}

/**
 * An owner or an administrator invited the patient: the public registration is open again, for the
 * flagged changes and for the notices nobody was told (R4-1). The day is the clock of the database,
 * like the rest of this table. It answers whether it opened anything.
 */
export async function openRegistration(tx: Tx, patientId: string): Promise<boolean> {
  const opened = await tx
    .update(patientRecordChange)
    .set({ invitationOpenedAt: sql`now()` })
    .where(and(eq(patientRecordChange.patientId, patientId), closesRegistration()))
    .returning({ id: patientRecordChange.id });
  return opened.length > 0;
}

/**
 * The gate every way of giving access to a patient goes through, for the staff:
 *
 * - for seven days after the e-mail or the birth date of the record changed, only an owner or an
 *   administrator may invite the patient or a representative, or link a representative;
 * - a representative for a patient whose record has no e-mail (nobody to tell) is for an owner or an
 *   administrator too, and so is one for a patient whose registration is closed (JD-S5 R3-4: the
 *   address on the record was never confirmed by anybody);
 * - while the registration of the patient is closed, inviting the patient is for an owner or an
 *   administrator, and doing it opens the registration (`opensRegistration`).
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
): Promise<{ afterRecordChange: boolean; opensRegistration: boolean }> {
  const recent = await hasRecentRecordChange(tx, input.patientId);
  const closed = await isRegistrationClosed(tx, input.patientId);
  const nobodyToTell =
    input.representative &&
    (input.recordEmail === null || input.recordEmail.trim() === '' || closed);
  const needsOwnerOrAdmin = nobodyToTell || (!input.representative && closed);
  if (!input.ownerOrAdmin) {
    if (recent) throw new PortalStaffRefused('portal_recent_identity_change', input.patientId);
    if (needsOwnerOrAdmin) {
      throw new PortalStaffRefused('portal_owner_or_admin_required', input.patientId);
    }
  }
  return {
    afterRecordChange: recent || nobodyToTell,
    opensRegistration: !input.representative && closed && input.ownerOrAdmin,
  };
}
