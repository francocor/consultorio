import { z } from 'zod';

import { PERMISSIONS, ROLES } from './roles.js';

/** Longest password the login endpoint will hash: bounds the cost of a hostile request. */
export const LOGIN_PASSWORD_MAX = 1024;

const Email = z.string().trim().pipe(z.email().max(254));

export const LoginRequest = z.strictObject({
  email: Email,
  password: z.string().min(1).max(LOGIN_PASSWORD_MAX),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/**
 * What the next step of the sign-in is. The session itself travels in an HttpOnly cookie and is
 * never part of a response body.
 *
 * - `authenticated`: a full session was created.
 * - `totp`: the password was right and a second factor is needed; send the challenge to `/auth/2fa`.
 * - `enrollment`: a session was created, but it only reaches the two-factor enrollment endpoints.
 */
export const LoginResponse = z.discriminatedUnion('next', [
  z.strictObject({ next: z.literal('authenticated') }),
  z.strictObject({ next: z.literal('enrollment') }),
  z.strictObject({ next: z.literal('totp'), challenge: z.string().min(1) }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

export const SessionScope = z.enum(['full', 'two_factor_enrollment']);
export type SessionScope = z.infer<typeof SessionScope>;

/** Where the user stands with the second factor, so the shell can prompt or block. */
export const TwoFactorSummary = z.strictObject({
  enrolled: z.boolean(),
  /** The user is obliged to have one (mandatory role, or the organization requires it). */
  required: z.boolean(),
  /** End of the 7-day grace period for a user who is obliged but not enrolled; else null. */
  graceEndsAt: z.iso.datetime().nullable(),
});
export type TwoFactorSummary = z.infer<typeof TwoFactorSummary>;

/**
 * The state of an organization. `unverified` is a signup whose address nobody has confirmed yet: it
 * has no member, so no session, and it exists only until the link is followed or the purge removes
 * it (tenant-onboarding, Part B).
 */
export const TenantStatus = z.enum(['active', 'read_only', 'cancelled', 'unverified']);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const MeResponse = z.strictObject({
  user: z.strictObject({ id: z.uuid(), email: z.email() }),
  roles: z.array(z.enum(ROLES)),
  permissions: z.array(z.enum(PERMISSIONS)),
  scope: SessionScope,
  twoFactor: TwoFactorSummary,
  /** The state of the organization, so the shell can explain read-only mode on sign-in. */
  tenantStatus: TenantStatus,
  /**
   * True when this user runs the setup wizard and the organization has not finished it, so the app
   * takes them there after signing in (tenant-onboarding, "Setup wizard"). False for everyone else.
   */
  needsWizard: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const SessionSummary = z.strictObject({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** True for the session that made this request. */
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const SessionList = z.strictObject({ sessions: z.array(SessionSummary) });
export type SessionList = z.infer<typeof SessionList>;

const Password = z.string().min(1).max(LOGIN_PASSWORD_MAX);

/** Second step of a sign-in: the challenge from `/auth/login` plus a code OR a recovery code. */
export const TwoFactorVerifyRequest = z
  .strictObject({
    challenge: z.string().min(1).max(256),
    code: z.string().min(1).max(32).optional(),
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .refine((body) => (body.code === undefined) !== (body.recoveryCode === undefined), {
    message: 'send either code or recoveryCode',
  });
export type TwoFactorVerifyRequest = z.infer<typeof TwoFactorVerifyRequest>;

/**
 * Starts enrolling (or replacing) the second factor. A user who already has one must prove the
 * password again: replacing it is a sensitive change.
 */
export const TwoFactorEnrollStartRequest = z.strictObject({ password: Password.optional() });
export type TwoFactorEnrollStartRequest = z.infer<typeof TwoFactorEnrollStartRequest>;

export const TwoFactorEnrollStartResponse = z.strictObject({
  /** Base32 secret, for typing into an authenticator app by hand. */
  secret: z.string().min(1),
  /** The otpauth link a QR code carries. */
  otpauthUri: z.string().min(1),
});
export type TwoFactorEnrollStartResponse = z.infer<typeof TwoFactorEnrollStartResponse>;

export const TwoFactorConfirmRequest = z.strictObject({ code: z.string().min(1).max(32) });
export type TwoFactorConfirmRequest = z.infer<typeof TwoFactorConfirmRequest>;

/** Recovery codes are shown once, when they are generated. */
export const RecoveryCodesResponse = z.strictObject({ recoveryCodes: z.array(z.string()) });
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponse>;

/** Actions that need the password again: new recovery codes, turning the factor off. */
export const ReauthenticateRequest = z.strictObject({ password: Password });
export type ReauthenticateRequest = z.infer<typeof ReauthenticateRequest>;
