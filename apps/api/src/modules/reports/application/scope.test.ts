import { describe, expect, it } from 'vitest';

import {
  canSeeCashReport,
  canSeeRevenueByProfessional,
  checkCashFilters,
  checkFilters,
  checkFinancialFilters,
  moneyScope,
  resolveScope,
  type ScopeViewer,
} from './scope.js';

const CENTRO = '0190a000-0000-7000-8000-00000000000a';
const NORTE = '0190a000-0000-7000-8000-00000000000b';
const SUR = '0190a000-0000-7000-8000-00000000000c';
const DRA_PAZ = '0190a000-0000-7000-8000-0000000000d1';
const DR_RIOS = '0190a000-0000-7000-8000-0000000000d2';

function viewer(overrides: Partial<ScopeViewer>): ScopeViewer {
  return {
    kind: 'staff',
    roles: [],
    professionalId: null,
    assignedLocationIds: [],
    ...overrides,
  };
}

describe('resolveScope: what each role is allowed to read', () => {
  it('owner and admin read the whole organization', () => {
    expect(resolveScope(viewer({ roles: ['owner'] }))).toEqual({ kind: 'organization' });
    expect(resolveScope(viewer({ roles: ['admin'] }))).toEqual({ kind: 'organization' });
  });

  it('an owner who is also a professional still reads the whole organization', () => {
    expect(
      resolveScope(viewer({ roles: ['owner', 'professional'], professionalId: DRA_PAZ })),
    ).toEqual({ kind: 'organization' });
  });

  it('a professional reads only their own appointments', () => {
    expect(resolveScope(viewer({ roles: ['professional'], professionalId: DRA_PAZ }))).toEqual({
      kind: 'professional',
      professionalId: DRA_PAZ,
    });
  });

  it('a professional without a profile has nothing to read', () => {
    expect(resolveScope(viewer({ roles: ['professional'], professionalId: null }))).toBeNull();
  });

  it('reception reads the locations it works at', () => {
    expect(
      resolveScope(viewer({ roles: ['reception'], assignedLocationIds: [CENTRO, NORTE] })),
    ).toEqual({ kind: 'locations', locationIds: [CENTRO, NORTE], professionalIds: [] });
  });

  it('reception with no location assigned reads nothing, but is not refused', () => {
    expect(resolveScope(viewer({ roles: ['reception'] }))).toEqual({
      kind: 'locations',
      locationIds: [],
      professionalIds: [],
    });
  });

  it('reception who is also a professional adds their own appointments, not the others', () => {
    expect(
      resolveScope(
        viewer({
          roles: ['reception', 'professional'],
          professionalId: DRA_PAZ,
          assignedLocationIds: [CENTRO],
        }),
      ),
    ).toEqual({ kind: 'locations', locationIds: [CENTRO], professionalIds: [DRA_PAZ] });
  });

  it('a patient session has no access to reports', () => {
    expect(resolveScope(viewer({ kind: 'patient', roles: ['owner'] }))).toBeNull();
  });

  it('a user with no role has no access', () => {
    expect(resolveScope(viewer({ roles: [] }))).toBeNull();
  });
});

describe('canSeeRevenueByProfessional', () => {
  it('is true for the organization and for a professional (their own), false for reception', () => {
    expect(canSeeRevenueByProfessional({ kind: 'organization' })).toBe(true);
    expect(canSeeRevenueByProfessional({ kind: 'professional', professionalId: DRA_PAZ })).toBe(
      true,
    );
    expect(
      canSeeRevenueByProfessional({
        kind: 'locations',
        locationIds: [CENTRO],
        professionalIds: [],
      }),
    ).toBe(false);
  });
});

describe('checkFilters: a filter may narrow the report, never widen it', () => {
  const reception = {
    kind: 'locations',
    locationIds: [CENTRO],
    professionalIds: [],
  } as const;
  const professional = { kind: 'professional', professionalId: DRA_PAZ } as const;

  it('lets the organization filter by anything', () => {
    expect(
      checkFilters({ kind: 'organization' }, { locationId: SUR, professionalId: DR_RIOS }),
    ).toEqual({ ok: true });
  });

  it('refuses a location outside the locations of reception', () => {
    expect(checkFilters(reception, { locationId: SUR })).toEqual({
      ok: false,
      reason: 'location_outside_scope',
    });
    expect(checkFilters(reception, { locationId: CENTRO })).toEqual({ ok: true });
  });

  it('lets reception narrow to a professional inside its locations', () => {
    expect(checkFilters(reception, { professionalId: DR_RIOS })).toEqual({ ok: true });
  });

  it('refuses a professional asking for a colleague, and lets them ask for themselves', () => {
    expect(checkFilters(professional, { professionalId: DR_RIOS })).toEqual({
      ok: false,
      reason: 'professional_outside_scope',
    });
    expect(checkFilters(professional, { professionalId: DRA_PAZ })).toEqual({ ok: true });
    expect(checkFilters(professional, { locationId: SUR })).toEqual({ ok: true });
  });

  it('accepts no filters at all', () => {
    expect(checkFilters(reception, {})).toEqual({ ok: true });
    expect(checkFilters(professional, {})).toEqual({ ok: true });
  });
});

describe('checkFinancialFilters: reception never reaches revenue by professional', () => {
  const reception = {
    kind: 'locations',
    locationIds: [CENTRO],
    professionalIds: [],
  } as const;
  const receptionWhoIsAlsoAProfessional = {
    kind: 'locations',
    locationIds: [CENTRO],
    professionalIds: [DRA_PAZ],
  } as const;
  const professional = { kind: 'professional', professionalId: DRA_PAZ } as const;

  it('refuses a professional filter from reception, because it would reveal the revenue of one person', () => {
    expect(checkFinancialFilters(reception, { professionalId: DR_RIOS })).toEqual({
      ok: false,
      reason: 'revenue_by_professional_denied',
    });
  });

  it('lets a reception user who is also a professional ask for their own figures only', () => {
    expect(
      checkFinancialFilters(receptionWhoIsAlsoAProfessional, { professionalId: DRA_PAZ }),
    ).toEqual({ ok: true });
    expect(
      checkFinancialFilters(receptionWhoIsAlsoAProfessional, { professionalId: DR_RIOS }),
    ).toEqual({ ok: false, reason: 'revenue_by_professional_denied' });
  });

  it('keeps the rules of every report: a place outside reception, a colleague of a professional', () => {
    expect(checkFinancialFilters(reception, { locationId: SUR })).toEqual({
      ok: false,
      reason: 'location_outside_scope',
    });
    expect(checkFinancialFilters(professional, { professionalId: DR_RIOS })).toEqual({
      ok: false,
      reason: 'professional_outside_scope',
    });
    expect(checkFinancialFilters({ kind: 'organization' }, { professionalId: DR_RIOS })).toEqual({
      ok: true,
    });
    expect(checkFinancialFilters(reception, { locationId: CENTRO })).toEqual({ ok: true });
  });
});

describe('the cash register report', () => {
  it('is for the organization and for reception, never for a professional', () => {
    expect(canSeeCashReport({ kind: 'organization' })).toBe(true);
    expect(
      canSeeCashReport({ kind: 'locations', locationIds: [CENTRO], professionalIds: [] }),
    ).toBe(true);
    expect(canSeeCashReport({ kind: 'professional', professionalId: DRA_PAZ })).toBe(false);
  });

  it('refuses a location outside the ones reception works at, and a professional altogether', () => {
    const reception = { kind: 'locations', locationIds: [CENTRO], professionalIds: [] } as const;

    expect(checkCashFilters(reception, { locationId: SUR })).toEqual({
      ok: false,
      reason: 'location_outside_scope',
    });
    expect(checkCashFilters(reception, { locationId: CENTRO })).toEqual({ ok: true });
    expect(checkCashFilters({ kind: 'organization' }, { locationId: SUR })).toEqual({ ok: true });
    expect(checkCashFilters({ kind: 'professional', professionalId: DRA_PAZ }, {})).toEqual({
      ok: false,
      reason: 'cash_report_outside_scope',
    });
  });
});

describe('moneyScope: what billing is asked to read for a scope', () => {
  it('reads everything for the organization', () => {
    expect(moneyScope({ kind: 'organization' })).toEqual({ kind: 'all' });
  });

  it('reads the locations of reception, and the own appointments of a reception user who is a professional', () => {
    expect(
      moneyScope({ kind: 'locations', locationIds: [CENTRO], professionalIds: [DRA_PAZ] }),
    ).toEqual({
      kind: 'limited',
      locationIds: [CENTRO],
      professionalIds: [DRA_PAZ],
    });
  });

  it('reads only the own appointments of a professional, at any location', () => {
    expect(moneyScope({ kind: 'professional', professionalId: DRA_PAZ })).toEqual({
      kind: 'limited',
      locationIds: [],
      professionalIds: [DRA_PAZ],
    });
  });
});
