import type { Role } from '@consultorio/contracts';

/**
 * Who is acting, as the authorization engine sees them. Built on the server from the session, the
 * membership and the database, never from anything the client sent.
 *
 * - `kind: 'staff'` is a member of the organization's staff.
 * - `kind: 'patient'` is the old marker of a patient session inside the staff shape. It is kept so
 *   that every staff route denies it by default; a person signed in to the portal is a
 *   `PortalActor` (below).
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
  /**
   * The member's own professional profile, whatever its state (no matricula yet, inactive). The
   * identity rules (D14) ask "is this my own appointment?" with it, so they do not depend on the
   * clinical gate. Absent means the same as `professionalId`.
   */
  ownProfessionalId?: string | null;
  /**
   * The professionals whose calendars this member was delegated (`scheduling.delegated_calendar`,
   * with a scope). Empty or absent without a live grant.
   */
  delegatedProfessionalIds?: readonly string[];
}

/**
 * A person signed in to the patient portal (ADR-008), as the authorization engine sees them: a
 * class apart from the staff `Actor`, with no roles, no grants and no professional profile. Built on
 * the server from the portal session (`psid`) and the database, never from anything the client
 * sent. It holds only the permissions of `PORTAL_ACTOR_PERMISSIONS`; every staff route denies it by
 * default.
 */
export interface PortalActor {
  kind: 'portal';
  tenantId: string;
  /** The portal identity (one per email per organization). */
  identityId: string;
  /**
   * The link the person picked as the subject of what they read (`portal_link`), validated to
   * belong to the identity. Null until they pick one. Every portal query runs for this subject only.
   */
  linkId: string | null;
}

export function isPortalActor(actor: Actor | PortalActor): actor is PortalActor {
  return actor.kind === 'portal';
}
