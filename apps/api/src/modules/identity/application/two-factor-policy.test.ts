import type { Role } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { GRACE_PERIOD_MS, twoFactorRequirement } from './two-factor-policy.js';

const DAY = 24 * 3_600_000;
const NOW = new Date('2026-10-16T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

function requirement(
  roles: Role[],
  options: { enrolled?: boolean; firstSignInDaysAgo?: number | null; orgRequires?: boolean } = {},
) {
  return twoFactorRequirement({
    roles,
    enrolled: options.enrolled ?? false,
    firstSignInAt:
      options.firstSignInDaysAgo === undefined || options.firstSignInDaysAgo === null
        ? null
        : daysAgo(options.firstSignInDaysAgo),
    organizationRequires: options.orgRequires ?? false,
    now: NOW,
  });
}

describe('two-factor requirement (identity-access, "Two-factor authentication")', () => {
  it('has a grace period of 7 days', () => {
    expect(GRACE_PERIOD_MS).toBe(7 * DAY);
  });

  describe.each([['owner'], ['admin'], ['professional']] as [Role][])(
    'mandatory role %s',
    (role) => {
      it('is prompted to enroll during the grace period, and keeps full access', () => {
        expect(requirement([role], { firstSignInDaysAgo: 3 })).toMatchObject({ kind: 'grace' });
        expect(requirement([role], { firstSignInDaysAgo: 0 })).toMatchObject({ kind: 'grace' });
      });

      it('may only enroll once the grace period is over', () => {
        expect(requirement([role], { firstSignInDaysAgo: 8 })).toMatchObject({
          kind: 'enrollment_required',
        });
        expect(requirement([role], { firstSignInDaysAgo: 7 })).toMatchObject({
          kind: 'enrollment_required',
        });
      });

      it('is challenged for a code when already enrolled, whatever the dates', () => {
        expect(requirement([role], { enrolled: true, firstSignInDaysAgo: 30 })).toMatchObject({
          kind: 'challenge',
        });
        expect(requirement([role], { enrolled: true, firstSignInDaysAgo: 1 })).toMatchObject({
          kind: 'challenge',
        });
      });
    },
  );

  it('counts the grace from the first sign-in; with none recorded the grace starts now', () => {
    expect(requirement(['owner'], { firstSignInDaysAgo: null })).toMatchObject({ kind: 'grace' });
    expect(requirement(['owner'], { firstSignInDaysAgo: 6 }).graceEndsAt).toEqual(
      new Date(daysAgo(6).getTime() + GRACE_PERIOD_MS),
    );
  });

  describe('reception', () => {
    it('is not asked for a second factor when the organization does not require it', () => {
      expect(requirement(['reception'], { firstSignInDaysAgo: 40 })).toMatchObject({
        kind: 'optional',
      });
    });

    it('is challenged if it chose to enroll', () => {
      expect(requirement(['reception'], { enrolled: true })).toMatchObject({ kind: 'challenge' });
    });

    it('follows the same grace period when the organization requires 2FA for everyone', () => {
      expect(
        requirement(['reception'], { orgRequires: true, firstSignInDaysAgo: 2 }),
      ).toMatchObject({ kind: 'grace' });
      expect(
        requirement(['reception'], { orgRequires: true, firstSignInDaysAgo: 9 }),
      ).toMatchObject({ kind: 'enrollment_required' });
    });
  });

  it('is mandatory if any of the roles is: a receptionist who is also a professional', () => {
    expect(requirement(['reception', 'professional'], { firstSignInDaysAgo: 9 })).toMatchObject({
      kind: 'enrollment_required',
    });
  });

  it('reports when the grace ends so the screen can say so', () => {
    expect(requirement(['professional'], { firstSignInDaysAgo: 2 }).graceEndsAt).toEqual(
      new Date(daysAgo(2).getTime() + 7 * DAY),
    );
    expect(requirement(['reception'], { firstSignInDaysAgo: 2 }).graceEndsAt).toBeNull();
  });

  it('knows whether the factor is required of the user at all', () => {
    expect(requirement(['owner']).required).toBe(true);
    expect(requirement(['reception']).required).toBe(false);
    expect(requirement(['reception'], { orgRequires: true }).required).toBe(true);
    expect(requirement(['reception'], { enrolled: true }).required).toBe(false);
  });
});
