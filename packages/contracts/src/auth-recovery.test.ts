import { describe, expect, it } from 'vitest';

import {
  InvitationAcceptRequest,
  PasswordResetCompleteRequest,
  PasswordResetRequest,
} from './auth-recovery.js';

import * as contracts from './index.js';

describe('password reset requests', () => {
  it('ask by email only, trimmed', () => {
    expect(PasswordResetRequest.parse({ email: ' Ana@Clinica.example ' })).toEqual({
      email: 'Ana@Clinica.example',
    });
    expect(
      PasswordResetRequest.safeParse({ email: 'ana@clinica.example', userId: 'x' }).success,
    ).toBe(false);
    expect(PasswordResetRequest.safeParse({ email: 'nope' }).success).toBe(false);
  });

  it('complete with a token and the new password, nothing that names a user', () => {
    expect(PasswordResetCompleteRequest.safeParse({ token: 't', password: 'p' }).success).toBe(
      true,
    );
    expect(
      PasswordResetCompleteRequest.safeParse({ token: 't', password: 'p', userId: 'someone-else' })
        .success,
    ).toBe(false);
    expect(PasswordResetCompleteRequest.safeParse({ token: 't' }).success).toBe(false);
    expect(
      PasswordResetCompleteRequest.safeParse({ token: 't', password: 'x'.repeat(1025) }).success,
    ).toBe(false);
  });

  it('accepting an invitation takes a token and a password, and no roles', () => {
    expect(InvitationAcceptRequest.safeParse({ token: 't', password: 'p' }).success).toBe(true);
    expect(
      InvitationAcceptRequest.safeParse({ token: 't', password: 'p', roles: ['owner'] }).success,
    ).toBe(false);
  });
});

describe('no request schema lets one user set the password of another (IDA-08, AUZ-03)', () => {
  /** Name and field names of every exported request schema. */
  const exported: Record<string, unknown> = contracts;
  const requests: [string, string[]][] = Object.entries(exported).flatMap(([name, value]) => {
    if (!name.endsWith('Request') || typeof value !== 'object' || value === null) return [];
    const shape = (value as { shape?: Record<string, unknown> }).shape;
    return shape === undefined ? [] : [[name, Object.keys(shape)] as [string, string[]]];
  });

  it('finds the request schemas (the scan is not silently empty)', () => {
    expect(requests.length).toBeGreaterThan(5);
  });

  it('only a fixed set of requests carries a password, and none of them also names a user', () => {
    const carryingPassword = requests
      .filter(([, keys]) => keys.some((key) => /password/i.test(key)))
      .map(([name]) => name)
      .sort();

    expect(carryingPassword).toEqual(
      [
        'InvitationAcceptRequest',
        'LoginRequest',
        'PasswordResetCompleteRequest',
        'ReauthenticateRequest',
        'TwoFactorEnrollStartRequest',
      ].sort(),
    );
    for (const [name, keys] of requests) {
      if (!keys.some((key) => /password/i.test(key))) continue;
      expect(
        keys.filter(
          (key) => /^(user|target|account|member)(id)?$/i.test(key) || /userid/i.test(key),
        ),
        name,
      ).toEqual([]);
    }
  });
});
