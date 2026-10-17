import type { Role } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { evaluateRoleChange, type RoleChangeInput } from './role-change.js';

function change(overrides: {
  actor?: Role[];
  target?: Role[];
  next: Role[];
  otherActiveOwners?: number;
  self?: boolean;
  targetStatus?: 'active' | 'deactivated';
}): RoleChangeInput {
  return {
    actor: { membershipId: 'actor', roles: overrides.actor ?? ['owner'] },
    target: {
      membershipId: overrides.self ? 'actor' : 'target',
      roles: overrides.target ?? ['reception'],
      status: overrides.targetStatus ?? 'active',
    },
    newRoles: overrides.next,
    otherActiveOwners: overrides.otherActiveOwners ?? 1,
  };
}

describe('evaluateRoleChange', () => {
  it('lets an owner change the roles of a colleague', () => {
    expect(evaluateRoleChange(change({ next: ['professional', 'reception'] }))).toEqual({
      ok: true,
    });
  });

  it('lets an admin hand out the roles inside the admin ceiling', () => {
    expect(evaluateRoleChange(change({ actor: ['admin'], next: ['admin', 'reception'] }))).toEqual({
      ok: true,
    });
  });

  it('refuses an admin who tries to grant the professional role to a colleague (D19)', () => {
    expect(
      evaluateRoleChange(
        change({ actor: ['admin'], target: ['reception'], next: ['professional'] }),
      ),
    ).toEqual({ ok: false, reason: 'above_ceiling' });
    expect(
      evaluateRoleChange(
        change({ actor: ['admin'], target: ['reception'], next: ['reception', 'professional'] }),
      ),
    ).toEqual({ ok: false, reason: 'above_ceiling' });
  });

  it('lets an owner grant the professional role', () => {
    expect(
      evaluateRoleChange(change({ target: ['reception'], next: ['reception', 'professional'] })),
    ).toEqual({ ok: true });
  });

  it('lets an admin manage a professional who already is one: keep the role or step them down', () => {
    expect(
      evaluateRoleChange(
        change({ actor: ['admin'], target: ['professional'], next: ['professional', 'admin'] }),
      ),
    ).toEqual({ ok: true });
    expect(
      evaluateRoleChange(
        change({ actor: ['admin'], target: ['professional'], next: ['reception'] }),
      ),
    ).toEqual({ ok: true });
  });

  it.each<[string, Parameters<typeof change>[0]]>([
    ['an owner promoting themselves', { self: true, target: ['owner'], next: ['owner', 'admin'] }],
    ['an admin promoting themselves', { actor: ['admin'], self: true, next: ['owner'] }],
    ['an owner demoting themselves', { self: true, target: ['owner'], next: ['reception'] }],
    [
      'a reception user (no power at all)',
      { actor: ['reception'], target: ['professional'], next: ['reception'] },
    ],
  ])('refuses %s', (_name, input) => {
    expect(evaluateRoleChange(change(input)).ok).toBe(false);
  });

  it('names the reason: self', () => {
    expect(evaluateRoleChange(change({ self: true, next: ['owner'] }))).toEqual({
      ok: false,
      reason: 'self',
    });
  });

  it('names the reason: above the ceiling, for the new roles', () => {
    expect(evaluateRoleChange(change({ actor: ['admin'], next: ['owner'] }))).toEqual({
      ok: false,
      reason: 'above_ceiling',
    });
  });

  it('names the reason: above the ceiling, because the target already is an owner', () => {
    expect(
      evaluateRoleChange(change({ actor: ['admin'], target: ['owner'], next: ['reception'] })),
    ).toEqual({ ok: false, reason: 'above_ceiling' });
  });

  it('protects the last owner', () => {
    expect(
      evaluateRoleChange(change({ target: ['owner'], next: ['admin'], otherActiveOwners: 0 })),
    ).toEqual({ ok: false, reason: 'last_owner' });
  });

  it('lets an owner step down when another owner remains', () => {
    expect(
      evaluateRoleChange(change({ target: ['owner'], next: ['admin'], otherActiveOwners: 1 })),
    ).toEqual({ ok: true });
  });

  it('does not count an owner who keeps the owner role as a loss', () => {
    expect(
      evaluateRoleChange(
        change({ target: ['owner'], next: ['owner', 'professional'], otherActiveOwners: 0 }),
      ),
    ).toEqual({ ok: true });
  });

  it('refuses an empty set of roles and the patient role', () => {
    expect(evaluateRoleChange(change({ next: [] }))).toEqual({
      ok: false,
      reason: 'invalid_roles',
    });
    expect(evaluateRoleChange(change({ next: ['patient'] }))).toEqual({
      ok: false,
      reason: 'invalid_roles',
    });
  });

  it('refuses to change a deactivated member', () => {
    expect(
      evaluateRoleChange(change({ targetStatus: 'deactivated', next: ['reception'] })),
    ).toEqual({ ok: false, reason: 'inactive_target' });
  });
});
