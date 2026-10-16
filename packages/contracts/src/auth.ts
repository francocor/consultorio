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

/** The profile of the signed-in user, as the web app needs it to draw the shell. */
export const MeResponse = z.strictObject({
  user: z.strictObject({ id: z.uuid(), email: z.email() }),
  roles: z.array(z.enum(ROLES)),
  permissions: z.array(z.enum(PERMISSIONS)),
  scope: SessionScope,
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
