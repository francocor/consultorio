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
  if (!member.roles.includes('professional')) return null;
  try {
    const profile = await profiles.findByMembership(member.tenantId, member.membershipId);
    if (profile?.status !== 'active') return null;
    if (!profile.matricula || !profile.matriculaJurisdiction) return null;
    return validateMatricula(profile.matriculaJurisdiction, profile.matricula) ? profile.id : null;
  } catch {
    return null;
  }
}
