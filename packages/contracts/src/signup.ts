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
 * Control characters (line breaks, tabs, NUL), format characters (bidirectional overrides, zero
 * width) and the Unicode line and paragraph separators. A name is written into an email, so none of
 * these may reach it (JD-S6 R1-S6-10).
 */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A name typed by a visitor and shown or emailed as it is: one line of visible characters. */
function plainName(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !HIDDEN_CHARACTER.test(value), {
      message: 'The name has hidden characters',
    });
}

/**
 * The form of the signup. The visitor gives a name for the organization, never an address for it:
 * the platform generates that (tenancy, F11). It carries NO password and NO acceptance: whoever
 * types an address on this public form has not proved it is theirs, so anything chosen here (a
 * password, an acceptance of the terms) would be the choice of a stranger. The person who owns the
 * address sets the password and accepts the terms on the page of the emailed link
 * (`SignupVerifyRequest`, JD-S6 R1-S6-3).
 */
export const SignupRequest = z.strictObject({
  organizationName: plainName(2, 80),
  ownerName: plainName(2, 100),
  email: SignupEmail,
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

/**
 * The token of the emailed link, with the password the owner chooses now and the two acceptances.
 * The acceptances are booleans so that refusing is an answer of the API (`signup_terms_required`)
 * and not a malformed request. The password is checked by the password rules of the API, which only
 * it has; here only its size is bounded.
 */
export const SignupVerifyRequest = z.strictObject({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(LOGIN_PASSWORD_MAX),
  acceptTerms: z.boolean(),
  acceptDataProcessing: z.boolean(),
});
export type SignupVerifyRequest = z.infer<typeof SignupVerifyRequest>;

/** The only thing a signup or a request for a new link says: it was received. */
export const SignupAcceptedResponse = z.strictObject({ accepted: z.literal(true) });
export type SignupAcceptedResponse = z.infer<typeof SignupAcceptedResponse>;

/** The organization is active and the owner is signed in; the session itself travels in the cookie. */
export const SignupVerifiedResponse = z.strictObject({ verified: z.literal(true) });
export type SignupVerifiedResponse = z.infer<typeof SignupVerifiedResponse>;
