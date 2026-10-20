export {
  SIGNUP_ERRORS,
  SIGNUP_AUDIT_ACTIONS,
  SIGNUP_PLATFORM_AUDIT_ACTIONS,
} from './signup-catalog.js';

/**
 * Contracts of the signup (a visitor creates an organization, verifies the address, and becomes the
 * owner of an active one). This file holds what is certain from the design; the signup track
 * (S6.02, S6.07) adds its request and response shapes below, in this file only. The response of a
 * signup must be the same whether or not the name or the email already existed (F11).
 */

/** An unverified organization and its owner are hard-deleted after this many days (`signup.purge`). */
export const SIGNUP_PURGE_AFTER_DAYS = 7;

/** The two acceptances a signup asks for, each with its own version: the terms and the data processing. */
export const SIGNUP_TERMS_KINDS = ['terms', 'data_processing'] as const;
export type SignupTermsKind = (typeof SIGNUP_TERMS_KINDS)[number];
