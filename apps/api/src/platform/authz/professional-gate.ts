import type { Role } from '@consultorio/contracts';

/** The part of a professional profile the gate looks at (`professional` table, S1.19). */
export interface ProfessionalProfile {
  id: string;
  status: 'active' | 'inactive';
  matricula: string | null;
  matriculaJurisdiction: string | null;
}

/** Where profiles come from. The staff module implements it; until then nothing is a professional. */
export interface ProfessionalRepo {
  findByMembership(tenantId: string, membershipId: string): Promise<ProfessionalProfile | null>;
}

/** Format check of a registration number for a jurisdiction, from the country pack. */
export type MatriculaValidator = (jurisdiction: string, value: string) => boolean;

/** No profiles exist before the staff module: nobody passes the gate, so nothing clinical opens. */
export const noProfessionals: ProfessionalRepo = {
  findByMembership: () => Promise.resolve(null),
};

/** The ids a member's professional profile gives them. */
export interface ProfessionalIds {
  /** The clinical gate: set only for an active profile with a valid recorded matricula. */
  professionalId: string | null;
  /**
   * The member's own professional profile, whatever its state and whatever their roles now. It
   * answers "is this appointment mine?" for the identity rules (D14), which must not depend on the
   * clinical gate: a profile without a matricula yet is still the person's own calendar, and a
   * member who lost the professional role keeps the appointments that were theirs.
   */
  ownProfessionalId: string | null;
}

/**
 * Looks the profile of a member up once and derives both ids. A failure to look it up is NOT
 * swallowed: the caller cannot tell whether the member has a profile, and the identity rules must
 * not guess "no" (fail closed).
 */
export async function resolveProfessionalIds(
  member: { tenantId: string; membershipId: string; roles: readonly Role[] },
  profiles: ProfessionalRepo,
  validateMatricula: MatriculaValidator,
): Promise<ProfessionalIds> {
  // Any member is looked up: one who lost the professional role keeps their profile, and with it
  // the appointments that were theirs (D14). Only the gate below depends on the role.
  const profile = await profiles.findByMembership(member.tenantId, member.membershipId);
  if (!profile) return { professionalId: null, ownProfessionalId: null };
  const gated =
    member.roles.includes('professional') &&
    profile.status === 'active' &&
    !!profile.matricula &&
    !!profile.matriculaJurisdiction &&
    validateMatricula(profile.matriculaJurisdiction, profile.matricula);
  return { professionalId: gated ? profile.id : null, ownProfessionalId: profile.id };
}

/**
 * The professional gate (ADR-003, point 3). The id that unlocks clinical work is derived ONLY
 * from an ACTIVE professional profile with a RECORDED matricula of a valid format. It is not
 * derived from a role: an owner who is also a professional gets it through their profile, like
 * anyone else. Verifying the matricula with the college is not needed to treat patients (it is
 * needed to issue e-prescriptions, checked where those are issued).
 *
 * Any failure to find out is a refusal.
 */
export async function deriveProfessionalId(
  member: { tenantId: string; membershipId: string; roles: readonly Role[] },
  profiles: ProfessionalRepo,
  validateMatricula: MatriculaValidator,
): Promise<string | null> {
  try {
    return (await resolveProfessionalIds(member, profiles, validateMatricula)).professionalId;
  } catch {
    return null;
  }
}
