/**
 * Who counts as an "active professional" (subscriptions, "Per-active-professional pricing"). The
 * definition is one function, so billing, the plan limit and the WhatsApp quota can never disagree.
 *
 * A member counts on a day when ALL of these were true on that day:
 *
 * 1. the membership is `active` (not deactivated);
 * 2. the membership holds the `professional` role;
 * 3. the professional profile is `active` (an enabled profile).
 *
 * Reception and administration seats are free and unlimited, and an owner or an admin who is not
 * also a professional does not count. A professional who is deactivated keeps their records: the
 * count only decides the price.
 */

export interface ProfessionalSeatFacts {
  membershipStatus: string;
  roles: readonly string[];
  /** The status of the profile, or null when the member has none. */
  profileStatus: string | null;
}

export function isActiveProfessional(facts: ProfessionalSeatFacts): boolean {
  return (
    facts.membershipStatus === 'active' &&
    facts.roles.includes('professional') &&
    facts.profileStatus === 'active'
  );
}

/** How many of these members count. */
export function countActiveProfessionals(members: readonly ProfessionalSeatFacts[]): number {
  return members.filter(isActiveProfessional).length;
}

/** Whether adding a member with these roles takes a seat that is priced and limited. */
export function takesProfessionalSeat(roles: readonly string[]): boolean {
  return roles.includes('professional');
}
