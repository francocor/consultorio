import type { Role } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { canGrantRoles, rolesInviterMayGrant } from './invitation-ceiling.js';

describe('who may invite whom (authorization, "No self-assignment or silent escalation of roles")', () => {
  it('lets an owner invite any staff role', () => {
    expect(rolesInviterMayGrant(['owner']).sort()).toEqual(
      ['admin', 'owner', 'professional', 'reception'].sort(),
    );
  });

  it('lets an admin invite everything except an owner', () => {
    expect(rolesInviterMayGrant(['admin']).sort()).toEqual(
      ['admin', 'professional', 'reception'].sort(),
    );
  });

  it('gives professionals and reception no power to invite, and patients none either', () => {
    expect(rolesInviterMayGrant(['professional'])).toEqual([]);
    expect(rolesInviterMayGrant(['reception'])).toEqual([]);
    expect(rolesInviterMayGrant(['patient'])).toEqual([]);
    expect(rolesInviterMayGrant([])).toEqual([]);
  });

  it('takes the widest ceiling when a user holds several roles', () => {
    expect(rolesInviterMayGrant(['reception', 'owner'])).toContain('owner');
    expect(rolesInviterMayGrant(['professional', 'admin'])).not.toContain('owner');
  });

  it.each([
    [['admin'], ['reception'], true],
    [['admin'], ['professional', 'reception'], true],
    [['admin'], ['owner'], false],
    [['admin'], ['reception', 'owner'], false],
    [['owner'], ['owner', 'professional'], true],
    [['reception'], ['reception'], false],
    [['owner'], [], false],
    [['owner'], ['patient'], false],
  ] as [Role[], Role[], boolean][])('inviter %j granting %j is %s', (inviter, granted, allowed) => {
    expect(canGrantRoles(inviter, granted)).toBe(allowed);
  });
});
