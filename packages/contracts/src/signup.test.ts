import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import { isPlatformAuditAction } from './operator.js';
import {
  SIGNUP_AUDIT_ACTIONS,
  SIGNUP_ERRORS,
  SIGNUP_PLATFORM_AUDIT_ACTIONS,
  SIGNUP_PURGE_AFTER_DAYS,
  SIGNUP_TERMS_KINDS,
  SignupAcceptedResponse,
  SignupRenewRequest,
  SignupRequest,
  SignupResendRequest,
  SignupVerifiedResponse,
  SignupVerifyRequest,
} from './signup.js';

describe('signup catalogues', () => {
  it('purges an unverified signup after seven days, and asks for two separate acceptances', () => {
    expect(SIGNUP_PURGE_AFTER_DAYS).toBe(7);
    expect([...SIGNUP_TERMS_KINDS]).toEqual(['terms', 'data_processing']);
  });

  it('registers the signup actions of a living organization in the tenant catalogue, once each', () => {
    expect(SIGNUP_AUDIT_ACTIONS).toEqual(['signup.created', 'signup.verified', 'terms.accepted']);
    for (const action of SIGNUP_AUDIT_ACTIONS) {
      expect(
        AUDIT_ACTIONS.filter((known) => known === action),
        action,
      ).toHaveLength(1);
    }
  });

  it('writes the purge in the platform trail, because the organization and its trail are gone', () => {
    expect(SIGNUP_PLATFORM_AUDIT_ACTIONS).toEqual(['signup.purged']);
    for (const action of SIGNUP_PLATFORM_AUDIT_ACTIONS) {
      expect(isPlatformAuditAction(action), action).toBe(true);
      expect(AUDIT_ACTIONS as readonly string[], action).not.toContain(action);
    }
  });

  it('has an error catalog that is part of the API catalog', () => {
    const catalog: Readonly<Record<string, { status: number; i18nKey: string }>> = SIGNUP_ERRORS;
    for (const [code, entry] of Object.entries(catalog)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});

const VALID = {
  organizationName: '  Centro Salud Norte  ',
  ownerName: ' Ana Pérez ',
  email: '  Ana.Perez@Example.test ',
  password: 'una frase larga y propia',
  acceptTerms: true,
  acceptDataProcessing: true,
  challengeProof: 'prueba',
} as const;

describe('the signup request', () => {
  it('trims the names and normalizes the address, so the same person is the same address', () => {
    const parsed = SignupRequest.parse(VALID);

    expect(parsed.organizationName).toBe('Centro Salud Norte');
    expect(parsed.ownerName).toBe('Ana Pérez');
    expect(parsed.email).toBe('ana.perez@example.test');
  });

  it('carries the two acceptances as plain booleans: refusing is an answer of the API, not a malformed form', () => {
    expect(SignupRequest.safeParse({ ...VALID, acceptTerms: false }).success).toBe(true);
    expect(SignupRequest.safeParse({ ...VALID, acceptTerms: 'yes' }).success).toBe(false);
  });

  it.each([
    ['an organization name of one letter', { organizationName: 'A' }],
    ['an organization name that is only spaces', { organizationName: '    ' }],
    ['a name of 81 characters', { organizationName: 'x'.repeat(81) }],
    ['an owner name that is empty', { ownerName: '' }],
    ['an address that is not one', { email: 'sin-arroba' }],
    ['an address longer than 254 characters', { email: `${'a'.repeat(250)}@example.test` }],
    ['no proof of the challenge', { challengeProof: '' }],
    ['a password of a megabyte', { password: 'x'.repeat(1_000_000) }],
  ])('refuses %s', (_name, patch) => {
    expect(SignupRequest.safeParse({ ...VALID, ...patch }).success).toBe(false);
  });

  it('refuses a field it does not know (a visitor cannot choose the address of the organization)', () => {
    expect(SignupRequest.safeParse({ ...VALID, slug: 'mi-centro' }).success).toBe(false);
    expect(SignupRequest.safeParse({ ...VALID, status: 'active' }).success).toBe(false);
  });
});

describe('the other requests and the answers of the signup', () => {
  it('asks for a new link with an address on the platform host, and with nothing but the proof on the organization host', () => {
    expect(SignupResendRequest.parse({ email: ' Ana@Example.test ', challengeProof: 'p' })).toEqual(
      { email: 'ana@example.test', challengeProof: 'p' },
    );
    expect(SignupResendRequest.safeParse({ challengeProof: 'p' }).success).toBe(false);
    expect(SignupRenewRequest.parse({ challengeProof: 'p' })).toEqual({ challengeProof: 'p' });
    expect(
      SignupRenewRequest.safeParse({ email: 'a@example.test', challengeProof: 'p' }).success,
    ).toBe(false);
  });

  it('verifies with the token alone', () => {
    expect(SignupVerifyRequest.parse({ token: 'x'.repeat(43) })).toEqual({ token: 'x'.repeat(43) });
    expect(SignupVerifyRequest.safeParse({ token: '' }).success).toBe(false);
  });

  it('answers only that the request was received, or that the organization is active', () => {
    expect(SignupAcceptedResponse.parse({ accepted: true })).toEqual({ accepted: true });
    expect(SignupAcceptedResponse.safeParse({ accepted: true, email: 'a@b.c' }).success).toBe(
      false,
    );
    expect(SignupVerifiedResponse.parse({ verified: true })).toEqual({ verified: true });
  });

  it('has the codes the signup answers with, none of which can tell a name or an address from another', () => {
    expect(Object.keys(SIGNUP_ERRORS).sort()).toEqual([
      'signup_challenge_failed',
      'signup_link_invalid',
      'signup_terms_required',
    ]);
  });
});
