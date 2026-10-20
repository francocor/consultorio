import { z } from 'zod';

import { LOGIN_PASSWORD_MAX } from './auth.js';

export {
  SIGNUP_ERRORS,
  SIGNUP_AUDIT_ACTIONS,
  SIGNUP_PLATFORM_AUDIT_ACTIONS,
} from './signup-catalog.js';

/**
 * Contracts of the signup (a visitor creates an organization, verifies the address, and becomes the
 * owner of an active one). The answer of a signup is the same whether or not the name or the email
 * already existed (F11): it says the request was received and nothing else.
 */

/** An unverified organization and its owner are hard-deleted after this many days (`signup.purge`). */
export const SIGNUP_PURGE_AFTER_DAYS = 7;

/** The two acceptances a signup asks for, each with its own version: the terms and the data processing. */
export const SIGNUP_TERMS_KINDS = ['terms', 'data_processing'] as const;
export type SignupTermsKind = (typeof SIGNUP_TERMS_KINDS)[number];

// The shapes -------------------------------------------------------------------------------------

const ChallengeProof = z.string().min(1).max(512);
const SignupEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));

/**
 * The form of the signup. The visitor gives a name for the organization, never an address for it:
 * the platform generates that (tenancy, F11). The two acceptances are booleans so that refusing is
 * an answer of the API (`signup_terms_required`) and not a malformed request. The password is
 * checked by the password rules of the API, which only it has; here only its size is bounded.
 */
export const SignupRequest = z.strictObject({
  organizationName: z.string().trim().min(2).max(80),
  ownerName: z.string().trim().min(2).max(100),
  email: SignupEmail,
  password: z.string().min(1).max(LOGIN_PASSWORD_MAX),
  acceptTerms: z.boolean(),
  acceptDataProcessing: z.boolean(),
  challengeProof: ChallengeProof,
});
export type SignupRequest = z.infer<typeof SignupRequest>;

/** Asks for the verification link again, from the platform host, with the address of the signup. */
export const SignupResendRequest = z.strictObject({
  email: SignupEmail,
  challengeProof: ChallengeProof,
});
export type SignupResendRequest = z.infer<typeof SignupResendRequest>;

/**
 * Asks for a new verification link from the host of the organization itself (the page of a link
 * that expired). The organization is the host's, so the request names nobody.
 */
export const SignupRenewRequest = z.strictObject({ challengeProof: ChallengeProof });
export type SignupRenewRequest = z.infer<typeof SignupRenewRequest>;

/** The token of the emailed link. */
export const SignupVerifyRequest = z.strictObject({ token: z.string().min(1).max(512) });
export type SignupVerifyRequest = z.infer<typeof SignupVerifyRequest>;

/** The only thing a signup or a request for a new link says: it was received. */
export const SignupAcceptedResponse = z.strictObject({ accepted: z.literal(true) });
export type SignupAcceptedResponse = z.infer<typeof SignupAcceptedResponse>;

/** The organization is active and the owner is signed in; the session itself travels in the cookie. */
export const SignupVerifiedResponse = z.strictObject({ verified: z.literal(true) });
export type SignupVerifiedResponse = z.infer<typeof SignupVerifiedResponse>;
