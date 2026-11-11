import type { ConsentRequestStatus, Role } from '@consultorio/contracts';

/**
 * Who sees what of a patient's consents (informed-consent, "Visibility and access control"). Pure:
 * the read model gathers the facts (roles, whether the database lets this professional read the
 * patient, the organization setting) and asks here.
 *
 * - A professional who may read the patient (care relationship or sharing scope) sees the title and
 *   opens the signed record.
 * - Reception sees status and dates under the neutral label, and the title only when the
 *   organization turned on "reception sees clinical metadata". Never the record.
 * - The administration (owner, admin) never sees a title, with the setting on or off.
 * - A professional who may not read the patient is a non-clinical viewer for this patient.
 * - The patient, in the portal, sees their own consents in full.
 */
export type Viewer =
  | {
      kind: 'staff';
      roles: readonly Role[];
      /** The database lets this professional's transaction read the patient's clinical content. */
      clinicalRead: boolean;
      /** The organization setting. */
      receptionSeesClinicalMetadata: boolean;
    }
  | { kind: 'portal' };

export interface ConsentView {
  titleVisible: boolean;
  canOpen: boolean;
}

/** A signature exists once a request was signed, and stays after it was revoked. */
const HAS_RECORD: readonly ConsentRequestStatus[] = ['signed', 'revoked'];

export function viewOfConsent(viewer: Viewer, status: ConsentRequestStatus): ConsentView {
  const hasRecord = HAS_RECORD.includes(status);
  if (viewer.kind === 'portal') return { titleVisible: true, canOpen: hasRecord };
  if (viewer.clinicalRead) return { titleVisible: true, canOpen: hasRecord };
  return {
    titleVisible: viewer.receptionSeesClinicalMetadata && viewer.roles.includes('reception'),
    canOpen: false,
  };
}

/**
 * The state to show: a pending request whose date has passed is expired from that instant, even
 * before the job records it, so nobody signs it in between.
 */
export function effectiveStatus(
  status: ConsentRequestStatus,
  expiresAt: Date,
  now: Date,
): ConsentRequestStatus {
  return status === 'pending' && expiresAt.getTime() <= now.getTime() ? 'expired' : status;
}
