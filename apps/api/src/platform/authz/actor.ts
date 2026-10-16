import type { Role } from '@consultorio/contracts';

/**
 * Who is acting, as the authorization engine sees them. Built on the server from the session, the
 * membership and the database, never from anything the client sent.
 *
 * - `kind: 'staff'` is a member of the organization's staff.
 * - `kind: 'patient'` is a patient portal session (a separate class, ADR-008). Patient sessions do
 *   not exist yet; the class is here so every staff route denies it by default from the start.
 */
export interface Actor {
  kind: 'staff' | 'patient';
  userId: string;
  tenantId: string;
  membershipId: string;
  roles: readonly Role[];
  /** Grantable permissions given to this user by an owner or admin (`permission_grant`). */
  grants: readonly string[];
  /**
   * The professional profile id, set ONLY when the user holds an active professional profile with
   * a recorded, correctly formatted matricula (see `professional-gate.ts`). The one door to
   * clinical work: nothing else sets it.
   */
  professionalId: string | null;
}
