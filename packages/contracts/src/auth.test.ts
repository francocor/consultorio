import { describe, expect, it } from 'vitest';

import {
  LoginRequest,
  LoginResponse,
  MeResponse,
  ReauthenticateRequest,
  SessionList,
  TwoFactorEnrollStartRequest,
  TwoFactorVerifyRequest,
} from './auth.js';
import { ERROR_CATALOG } from './errors.js';

describe('LoginRequest', () => {
  it('accepts an email and a password and trims the email', () => {
    expect(LoginRequest.parse({ email: '  Ana@Clinica.example ', password: 'x' })).toEqual({
      email: 'Ana@Clinica.example',
      password: 'x',
    });
  });

  it.each([
    ['a malformed email', { email: 'not-an-email', password: 'x' }],
    ['an empty password', { email: 'ana@clinica.example', password: '' }],
    [
      'a huge password (hashing it would be a denial-of-service vector)',
      {
        email: 'ana@clinica.example',
        password: 'x'.repeat(1025),
      },
    ],
    [
      'an extra field such as a tenant or role claim',
      {
        email: 'ana@clinica.example',
        password: 'x',
        role: 'owner',
      },
    ],
    ['a missing password', { email: 'ana@clinica.example' }],
  ])('rejects %s', (_label, body) => {
    expect(LoginRequest.safeParse(body).success).toBe(false);
  });
});

describe('LoginResponse', () => {
  it('describes a signed-in user without any token (the token travels in the cookie)', () => {
    expect(LoginResponse.parse({ next: 'authenticated' })).toEqual({ next: 'authenticated' });
  });

  it('carries the challenge only when a second factor is needed', () => {
    expect(LoginResponse.parse({ next: 'totp', challenge: 'abc' })).toEqual({
      next: 'totp',
      challenge: 'abc',
    });
    expect(LoginResponse.safeParse({ next: 'totp' }).success).toBe(false);
    expect(LoginResponse.safeParse({ next: 'authenticated', challenge: 'abc' }).success).toBe(
      false,
    );
  });

  it('knows the enrollment-only outcome', () => {
    expect(LoginResponse.parse({ next: 'enrollment' })).toEqual({ next: 'enrollment' });
  });
});

describe('MeResponse and SessionList', () => {
  it('accepts the profile of the current session', () => {
    const me = {
      user: { id: '0190a000-0000-7000-8000-000000000001', email: 'ana@clinica.example' },
      roles: ['owner', 'professional'],
      permissions: ['patients.read'],
      scope: 'full',
      twoFactor: { enrolled: false, required: true, graceEndsAt: '2026-10-23T10:00:00.000Z' },
      tenantStatus: 'read_only',
    };

    expect(MeResponse.parse(me)).toEqual(me);
    expect(MeResponse.safeParse({ ...me, roles: ['superuser'] }).success).toBe(false);
    expect(MeResponse.safeParse({ ...me, tenantStatus: 'frozen' }).success).toBe(false);
  });

  it('lists sessions with the one in use flagged', () => {
    const sessions = [
      {
        id: '0190a000-0000-7000-8000-000000000002',
        createdAt: '2026-10-16T10:00:00.000Z',
        lastSeenAt: '2026-10-16T10:05:00.000Z',
        expiresAt: '2026-10-23T10:00:00.000Z',
        ip: '203.0.113.7',
        userAgent: 'Firefox',
        current: true,
      },
    ];

    expect(SessionList.parse({ sessions })).toEqual({ sessions });
    expect(SessionList.safeParse({ sessions: [{ ...sessions[0], current: 'yes' }] }).success).toBe(
      false,
    );
  });
});

describe('error catalog additions for authentication', () => {
  it('has the enrollment-required denial as a 403', () => {
    expect(ERROR_CATALOG.two_factor_enrollment_required.status).toBe(403);
    expect(ERROR_CATALOG.two_factor_enrollment_required.i18nKey).toBe(
      'errors.two_factor_enrollment_required',
    );
  });
});

describe('two-factor requests', () => {
  it('verify takes a challenge and exactly one of code or recoveryCode', () => {
    expect(TwoFactorVerifyRequest.safeParse({ challenge: 'c', code: '123456' }).success).toBe(true);
    expect(TwoFactorVerifyRequest.safeParse({ challenge: 'c', recoveryCode: 'abcd' }).success).toBe(
      true,
    );
    expect(TwoFactorVerifyRequest.safeParse({ challenge: 'c' }).success).toBe(false);
    expect(
      TwoFactorVerifyRequest.safeParse({ challenge: 'c', code: '123456', recoveryCode: 'abcd' })
        .success,
    ).toBe(false);
    expect(TwoFactorVerifyRequest.safeParse({ code: '123456' }).success).toBe(false);
  });

  it('enrollment start takes an optional password and nothing else', () => {
    expect(TwoFactorEnrollStartRequest.safeParse({}).success).toBe(true);
    expect(TwoFactorEnrollStartRequest.safeParse({ password: 'x' }).success).toBe(true);
    expect(TwoFactorEnrollStartRequest.safeParse({ password: '' }).success).toBe(false);
    expect(TwoFactorEnrollStartRequest.safeParse({ userId: 'someone-else' }).success).toBe(false);
  });

  it('re-authentication needs the password', () => {
    expect(ReauthenticateRequest.safeParse({ password: 'x' }).success).toBe(true);
    expect(ReauthenticateRequest.safeParse({}).success).toBe(false);
  });
});
