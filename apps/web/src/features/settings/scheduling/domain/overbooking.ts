import type {
  ProfessionalDto,
  ProfessionalProfileRequest,
  StaffMemberDto,
} from '@consultorio/contracts';

const MAX_CAPACITY = 20;

/** The number of simultaneous appointments typed by a person: a whole number from 1 to 20. */
export function parseCapacity(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_CAPACITY ? value : null;
}

/**
 * Overbooking (two or more simultaneous appointments) is a decision with consequences for the
 * agenda, so switching it on or raising it asks first. Going back to one, or lowering it, does not.
 */
export function needsConfirmation(current: number, next: number): boolean {
  return next >= 2 && next > current;
}

/**
 * The full profile with a new capacity. The API saves a profile as a whole, so every other field
 * is carried over unchanged. A profile with no discipline cannot be saved (the API requires one).
 */
export function profileRequestFor(
  profile: ProfessionalDto,
  member: StaffMemberDto,
  capacity: number,
): ProfessionalProfileRequest | null {
  if (profile.specialties.length === 0) return null;
  return {
    fullName: profile.fullName ?? member.displayName ?? '',
    specialties: profile.specialties,
    matricula: profile.matricula
      ? { jurisdiction: profile.matricula.jurisdiction, number: profile.matricula.number }
      : null,
    maxSimultaneous: capacity,
  };
}
