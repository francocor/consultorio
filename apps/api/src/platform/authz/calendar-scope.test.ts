import type { Role } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import type { Actor } from './actor.js';
import { calendarAccess, calendarProfessionalIds } from './calendar-scope.js';
import { can } from './can.js';

const TENANT = '0190a000-0000-7000-8000-0000000000e1';
const ME = '0190a000-0000-7000-8000-0000000000f1';
const COLLEAGUE = '0190a000-0000-7000-8000-0000000000f2';
const THIRD = '0190a000-0000-7000-8000-0000000000f3';

function staff(roles: Role[], extra: Partial<Actor> = {}): Actor {
  return {
    kind: 'staff',
    userId: '0190a000-0000-7000-8000-0000000000a1',
    tenantId: TENANT,
    membershipId: '0190a000-0000-7000-8000-0000000000a2',
    roles,
    grants: [],
    professionalId: null,
    ...extra,
  };
}

const professional = (extra: Partial<Actor> = {}) =>
  staff(['professional'], { professionalId: ME, ...extra });

describe('whose calendar a user may work in', () => {
  it('lets a professional work in their own calendar and no one else’s by default', () => {
    expect(calendarAccess(professional(), ME)).toBe(true);
    expect(calendarAccess(professional(), COLLEAGUE)).toBe(false);
  });

  it('lets a professional into the calendars they were delegated, and only those', () => {
    const actor = professional({
      grants: ['scheduling.delegated_calendar'],
      delegatedProfessionalIds: [COLLEAGUE],
    });

    expect(calendarAccess(actor, COLLEAGUE)).toBe(true);
    expect(calendarAccess(actor, THIRD)).toBe(false);
    expect(calendarAccess(actor, ME)).toBe(true);
  });

  it('does not let a delegated list work without the grant (a stale scope opens nothing)', () => {
    const actor = professional({ delegatedProfessionalIds: [COLLEAGUE] });

    expect(calendarAccess(actor, COLLEAGUE)).toBe(false);
  });

  it('gives a professional who has no valid profile no calendar of their own', () => {
    const actor = staff(['professional'], { professionalId: null });

    expect(calendarAccess(actor, ME)).toBe(false);
  });

  it.each(['owner', 'admin', 'reception'] as Role[])(
    'lets %s work in every calendar (their locations decide the rest)',
    (role) => {
      expect(calendarAccess(staff([role]), COLLEAGUE)).toBe(true);
    },
  );

  it('gives a professional who is also reception the calendars reception works in', () => {
    expect(
      calendarAccess(staff(['professional', 'reception'], { professionalId: ME }), COLLEAGUE),
    ).toBe(true);
  });

  it('never gives a patient session a staff calendar', () => {
    expect(calendarAccess({ ...staff(['patient']), kind: 'patient' }, ME)).toBe(false);
  });
});

describe('can() with the calendar of the resource', () => {
  it('allows booking in a calendar the user may work in', () => {
    expect(can(professional(), 'scheduling.book', { calendarOf: ME })).toEqual({ allowed: true });
  });

  it('denies booking in a colleague’s calendar with its own reason, so the audit says why', () => {
    expect(can(professional(), 'scheduling.book', { calendarOf: COLLEAGUE })).toEqual({
      allowed: false,
      reason: 'not_own_calendar',
    });
  });

  it('allows it after the owner delegated that calendar', () => {
    const delegated = professional({
      grants: ['scheduling.delegated_calendar'],
      delegatedProfessionalIds: [COLLEAGUE],
    });

    expect(can(delegated, 'scheduling.book', { calendarOf: COLLEAGUE })).toEqual({ allowed: true });
  });

  it('still needs the permission itself: a calendar scope is a narrowing, never a grant', () => {
    expect(can(staff(['reception']), 'scheduling.configure', { calendarOf: ME })).toEqual({
      allowed: false,
      reason: 'not_permitted',
    });
  });
});

describe('the calendars as a list for a query (JD-S3 R2-C6)', () => {
  const actors: Actor[] = [
    staff(['owner']),
    staff(['admin']),
    staff(['reception']),
    professional(),
    professional({
      grants: ['scheduling.delegated_calendar'],
      delegatedProfessionalIds: [COLLEAGUE],
    }),
    professional({ delegatedProfessionalIds: [COLLEAGUE] }),
    staff(['professional'], { professionalId: null }),
  ];

  it.each(actors.map((actor, index) => [index, actor] as const))(
    'agrees with calendarAccess for each professional (actor %i)',
    (_index, actor) => {
      const ids = calendarProfessionalIds(actor);
      for (const professionalId of [ME, COLLEAGUE, THIRD]) {
        expect(ids === 'all' || ids.includes(professionalId)).toBe(
          calendarAccess(actor, professionalId),
        );
      }
    },
  );
});
