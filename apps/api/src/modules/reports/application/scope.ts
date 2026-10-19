import type { Role } from '@consultorio/contracts';

import type { MoneyScope } from '../../billing/index.js';

/**
 * Who may read which figures (reports, "Role-scoped visibility"). This is the ONE place that
 * decides it; the queries only apply what it returns, so a screen, a drill-down and an export cannot
 * disagree.
 *
 * - Owner and admin read the whole organization.
 * - A professional reads their own appointments only.
 * - Reception reads the locations it works at, and never revenue by professional. A reception user
 *   who is also a professional adds their own appointments, wherever they are.
 * - A patient session, or a user with no role that reads reports, reads nothing.
 */
export type ReportScope =
  | { kind: 'organization' }
  | {
      kind: 'locations';
      locationIds: readonly string[];
      /** Professionals whose appointments are read wherever they happen (the viewer's own). */
      professionalIds: readonly string[];
    }
  | { kind: 'professional'; professionalId: string };

export interface ScopeViewer {
  kind: 'staff' | 'patient';
  roles: readonly Role[];
  /** The viewer's own professional profile, whatever its state; null when they have none. */
  professionalId: string | null;
  /** The locations of the viewer's membership (live assignments). */
  assignedLocationIds: readonly string[];
}

export function resolveScope(viewer: ScopeViewer): ReportScope | null {
  if (viewer.kind !== 'staff') return null;
  const has = (role: Role) => viewer.roles.includes(role);
  if (has('owner') || has('admin')) return { kind: 'organization' };
  if (has('reception')) {
    return {
      kind: 'locations',
      locationIds: viewer.assignedLocationIds,
      professionalIds:
        has('professional') && viewer.professionalId !== null ? [viewer.professionalId] : [],
    };
  }
  if (has('professional') && viewer.professionalId !== null) {
    return { kind: 'professional', professionalId: viewer.professionalId };
  }
  return null;
}

/** Revenue by professional is for the organization, and for a professional about themselves. */
export function canSeeRevenueByProfessional(scope: ReportScope): boolean {
  return scope.kind !== 'locations';
}

export interface FilterChoice {
  locationId?: string | undefined;
  professionalId?: string | undefined;
}

export type FilterCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'location_outside_scope'
        | 'professional_outside_scope'
        | 'revenue_by_professional_denied'
        | 'cash_report_outside_scope';
    };

/**
 * A filter narrows a report, it never widens it: a location the viewer does not work at, or a
 * colleague's figures asked by a professional, are refused (and audited by the route) instead of
 * quietly answered with an empty report.
 */
export function checkFilters(scope: ReportScope, filters: FilterChoice): FilterCheck {
  if (
    scope.kind === 'locations' &&
    filters.locationId !== undefined &&
    !scope.locationIds.includes(filters.locationId)
  ) {
    return { ok: false, reason: 'location_outside_scope' };
  }
  if (
    scope.kind === 'professional' &&
    filters.professionalId !== undefined &&
    filters.professionalId !== scope.professionalId
  ) {
    return { ok: false, reason: 'professional_outside_scope' };
  }
  return { ok: true };
}

/**
 * The financial report adds one rule to the others: reception never reaches revenue by professional,
 * so a filter by professional (which would show the revenue of that one person) is refused. A
 * reception user who is also a professional may ask for their own figures.
 */
export function checkFinancialFilters(scope: ReportScope, filters: FilterChoice): FilterCheck {
  if (
    scope.kind === 'locations' &&
    filters.professionalId !== undefined &&
    !scope.professionalIds.includes(filters.professionalId)
  ) {
    const location = checkFilters(scope, { locationId: filters.locationId });
    return location.ok ? { ok: false, reason: 'revenue_by_professional_denied' } : location;
  }
  return checkFilters(scope, filters);
}

/**
 * The cash register report is a report about a location's drawer: the organization reads every
 * one, reception the ones it works at, and a professional none (the money of the drawer is not
 * theirs, whatever they were paid).
 */
export function canSeeCashReport(scope: ReportScope): boolean {
  return scope.kind !== 'professional';
}

export function checkCashFilters(
  scope: ReportScope,
  filters: { locationId?: string | undefined },
): FilterCheck {
  if (!canSeeCashReport(scope)) return { ok: false, reason: 'cash_report_outside_scope' };
  return checkFilters(scope, { locationId: filters.locationId });
}

/** What billing is asked to read for a scope: every charge, or the ones of some locations and professionals. */
export function moneyScope(scope: ReportScope): MoneyScope {
  if (scope.kind === 'organization') return { kind: 'all' };
  if (scope.kind === 'locations') {
    return {
      kind: 'limited',
      locationIds: scope.locationIds,
      professionalIds: scope.professionalIds,
    };
  }
  return { kind: 'limited', locationIds: [], professionalIds: [scope.professionalId] };
}
