import { GRANTABLE } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { evaluateGrant, scopeAllowedFor } from './grant-rules.js';

const base = { actorMembershipId: 'a', targetMembershipId: 't' };

describe('evaluateGrant', () => {
  it.each(GRANTABLE)('accepts %s for a colleague', (permission) => {
    expect(evaluateGrant({ ...base, permission })).toEqual({ ok: true });
  });

  it.each([
    'clinical.note.read',
    'clinical.anamnesis.write',
    'clinical.prescription.read',
    'CLINICAL.note.read',
  ])('names %s as clinical', (permission) => {
    expect(evaluateGrant({ ...base, permission })).toEqual({ ok: false, reason: 'clinical' });
  });

  it.each(['patients.read', 'billing.manage', 'staff.manage', 'made.up', '', 'cash'])(
    'refuses %j as outside the fixed set',
    (permission) => {
      expect(evaluateGrant({ ...base, permission })).toEqual({
        ok: false,
        reason: 'not_grantable',
      });
    },
  );

  it('refuses a grant to oneself, whatever the permission', () => {
    expect(
      evaluateGrant({
        actorMembershipId: 'a',
        targetMembershipId: 'a',
        permission: 'cash.operate',
      }),
    ).toEqual({ ok: false, reason: 'self' });
  });
});

describe('scopeAllowedFor', () => {
  it('lets only a delegated calendar carry a scope', () => {
    expect(scopeAllowedFor('scheduling.delegated_calendar', { professionalIds: ['x'] })).toBe(true);
    expect(scopeAllowedFor('cash.operate', { professionalIds: ['x'] })).toBe(false);
    expect(scopeAllowedFor('cash.operate', undefined)).toBe(true);
  });

  it('needs a scope for a delegated calendar', () => {
    expect(scopeAllowedFor('scheduling.delegated_calendar', undefined)).toBe(false);
  });
});
