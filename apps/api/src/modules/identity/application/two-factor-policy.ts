import type { Role } from '@consultorio/contracts';

/** A user in a mandatory role has 7 days from the first sign-in to enroll. */
export const GRACE_PERIOD_MS = 7 * 24 * 3_600_000;

/** Roles for which two-factor authentication is mandatory, whatever the organization decides. */
const MANDATORY_ROLES: readonly Role[] = ['owner', 'admin', 'professional'];

export type TwoFactorRequirementKind =
  /** Enrolled: a valid second factor is needed after the password. */
  | 'challenge'
  /** Required but not enrolled, inside the grace period: full access plus a prompt to enroll. */
  | 'grace'
  /** Required, not enrolled, grace over: the session only reaches the enrollment endpoints. */
  | 'enrollment_required'
  /** Not required and not enrolled (reception in an organization that does not ask for it). */
  | 'optional';

export interface TwoFactorRequirement {
  kind: TwoFactorRequirementKind;
  /** Whether the user is obliged to have a second factor (enrolled or not). */
  required: boolean;
  /** End of the grace period; null when no grace applies. */
  graceEndsAt: Date | null;
}

export interface TwoFactorRequirementInput {
  roles: readonly Role[];
  enrolled: boolean;
  /** Null until the first successful sign-in: the grace then starts with this one. */
  firstSignInAt: Date | null;
  /** The organization's setting `require_2fa`, which extends the obligation to reception. */
  organizationRequires: boolean;
  now: Date;
}

/**
 * What the sign-in must do about the second factor. Pure: the clock is a parameter.
 *
 * Mandatory for owner, admin and professional, with a 7-day grace period counted from the first
 * sign-in; optional for reception unless the organization requires it for everyone, in which
 * case the same grace applies. Anyone who enrolled is challenged, whatever their role.
 */
export function twoFactorRequirement(input: TwoFactorRequirementInput): TwoFactorRequirement {
  const mandatory =
    input.organizationRequires || input.roles.some((role) => MANDATORY_ROLES.includes(role));
  const graceEndsAt = mandatory
    ? new Date((input.firstSignInAt ?? input.now).getTime() + GRACE_PERIOD_MS)
    : null;

  if (input.enrolled) return { kind: 'challenge', required: mandatory, graceEndsAt: null };
  if (!mandatory) return { kind: 'optional', required: false, graceEndsAt: null };

  return input.now.getTime() < (graceEndsAt?.getTime() ?? 0)
    ? { kind: 'grace', required: true, graceEndsAt }
    : { kind: 'enrollment_required', required: true, graceEndsAt };
}
