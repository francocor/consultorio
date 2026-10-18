import type { Role } from '@consultorio/contracts';

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
  { ok: true } | { ok: false; reason: 'location_outside_scope' | 'professional_outside_scope' };

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
