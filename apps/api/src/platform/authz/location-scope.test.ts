import { describe, expect, it } from 'vitest';

import { locationScopeOf, mayOperateAt } from './location-scope.js';

const OWN = 'professional-own';
const OTHER = 'professional-other';
const CENTRO = 'centro';
const NORTE = 'norte';

const who = (roles: string[], professionalId: string | null = null) => ({
  roles: roles as ('owner' | 'admin' | 'professional' | 'reception')[],
  professionalId,
});

describe('the location scope of a staff member', () => {
  it('is every location for the owner and the admin', () => {
    expect(locationScopeOf(who(['owner']))).toEqual({ kind: 'all' });
    expect(locationScopeOf(who(['admin']))).toEqual({ kind: 'all' });
  });

  it('is every location for a professional who is only a professional: held to calendars, not to places', () => {
    expect(locationScopeOf(who(['professional'], OWN))).toEqual({ kind: 'all' });
  });

  it('is the assigned locations for reception', () => {
    expect(locationScopeOf(who(['reception']))).toEqual({
      kind: 'assigned',
      ownProfessionalId: null,
    });
  });

  it('is the assigned locations for a professional who is also reception, plus their own calendar', () => {
    expect(locationScopeOf(who(['professional', 'reception'], OWN))).toEqual({
      kind: 'assigned',
      ownProfessionalId: OWN,
    });
  });

  it('gives a reception-and-professional without a valid profile no calendar of their own', () => {
    expect(locationScopeOf(who(['professional', 'reception'], null))).toEqual({
      kind: 'assigned',
      ownProfessionalId: null,
    });
  });

  it('lets an owner who is also a professional keep every location', () => {
    expect(locationScopeOf(who(['owner', 'professional'], OWN))).toEqual({ kind: 'all' });
  });
});

describe('operating at a location', () => {
  const assigned = [CENTRO];
  const both = locationScopeOf(who(['professional', 'reception'], OWN));
  const reception = locationScopeOf(who(['reception']));
  const everything = locationScopeOf(who(['admin']));

  it('is allowed anywhere for a scope of every location', () => {
    expect(mayOperateAt(everything, [], { locationId: NORTE, professionalId: OTHER })).toBe(true);
  });

  it('is allowed only at the assigned locations for reception, whoever the professional is', () => {
    expect(mayOperateAt(reception, assigned, { locationId: CENTRO, professionalId: OTHER })).toBe(
      true,
    );
    expect(mayOperateAt(reception, assigned, { locationId: NORTE, professionalId: OTHER })).toBe(
      false,
    );
  });

  it('follows the assignment for a reception-and-professional in the calendar of someone else', () => {
    expect(mayOperateAt(both, assigned, { locationId: CENTRO, professionalId: OTHER })).toBe(true);
    expect(mayOperateAt(both, assigned, { locationId: NORTE, professionalId: OTHER })).toBe(false);
  });

  it('is unrestricted in the own calendar of a reception-and-professional', () => {
    expect(mayOperateAt(both, assigned, { locationId: NORTE, professionalId: OWN })).toBe(true);
    expect(mayOperateAt(both, [], { locationId: NORTE, professionalId: OWN })).toBe(true);
  });

  it('allows nothing to reception without an assignment', () => {
    expect(mayOperateAt(reception, [], { locationId: CENTRO, professionalId: OTHER })).toBe(false);
  });
});
