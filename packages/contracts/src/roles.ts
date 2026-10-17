/**
 * Roles and the permission catalog. This is CODE, not data (ADR-003): no tenant setting, grant or
 * screen can add a permission to a role, and the clinical group exists only for professionals.
 * `roles.test.ts` fails the build if that ever stops being true.
 */

/** A user may hold several roles in one organization (an owner who is also a professional). */
export const ROLES = ['owner', 'admin', 'professional', 'reception', 'patient'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that exist inside an organization's staff. `patient` is never granted to staff. */
export const STAFF_ROLES = [
  'owner',
  'admin',
  'professional',
  'reception',
] as const satisfies readonly Role[];
export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * What a person may HAND OUT, in an invitation or by adding a role to an existing member.
 *
 * Decision D19: only the owner brings professionals into the organization. A professional is the
 * only role that opens clinical records, and an unverified registration is enough to do clinical
 * work (D1), so an admin who could create a professional account would hold a second, clinical
 * account of their own. The owner already controls the organization, which bounds that risk to
 * the owner.
 */
const GRANT_CEILING: Partial<Record<Role, readonly Role[]>> = {
  owner: ['owner', 'admin', 'professional', 'reception'],
  // An admin cannot create an owner (escalation above themselves) or a professional (D19).
  admin: ['admin', 'reception'],
};

/**
 * Whose roles a person may MANAGE: edit the roles of, deactivate, reactivate. An admin still
 * looks after the professionals who already work in the organization (a departing professional
 * must be deactivated by whoever is on duty), but never touches an owner.
 */
const MANAGE_CEILING: Partial<Record<Role, readonly Role[]>> = {
  owner: ['owner', 'admin', 'professional', 'reception'],
  admin: ['admin', 'professional', 'reception'],
};

function ceilingOf(
  ceiling: Partial<Record<Role, readonly Role[]>>,
  grantorRoles: readonly Role[],
): Set<Role> {
  const allowed = new Set<Role>();
  for (const role of grantorRoles) {
    for (const granted of ceiling[role] ?? []) allowed.add(granted);
  }
  return allowed;
}

/**
 * The roles a person holding `grantorRoles` may hand out, in an invitation or in a role change.
 * Professionals, reception and patients hand out nothing.
 */
export function rolesInviterMayGrant(grantorRoles: readonly Role[]): StaffRole[] {
  const allowed = ceilingOf(GRANT_CEILING, grantorRoles);
  return STAFF_ROLES.filter((role) => allowed.has(role));
}

/** True when every role in `roles` is inside the grantor's ceiling, and there is at least one. */
export function canGrantRoles(grantorRoles: readonly Role[], roles: readonly Role[]): boolean {
  if (roles.length === 0) return false;
  const allowed: readonly Role[] = rolesInviterMayGrant(grantorRoles);
  return roles.every((role) => allowed.includes(role));
}

/** True when a person with `actorRoles` may manage someone who holds `targetRoles`. */
export function canManageRoles(actorRoles: readonly Role[], targetRoles: readonly Role[]): boolean {
  if (targetRoles.length === 0) return false;
  const allowed = ceilingOf(MANAGE_CEILING, actorRoles);
  return targetRoles.every((role) => allowed.has(role));
}

/**
 * True when `actorRoles` may turn `currentRoles` into `newRoles`: the member must be inside what
 * the actor manages, and only the roles that are being ADDED must be inside what the actor hands
 * out. Keeping a role the member already has is not a grant.
 */
export function canChangeRoles(
  actorRoles: readonly Role[],
  currentRoles: readonly Role[],
  newRoles: readonly Role[],
): boolean {
  if (newRoles.length === 0 || !canManageRoles(actorRoles, currentRoles)) return false;
  const added = newRoles.filter((role) => !currentRoles.includes(role));
  return added.length === 0 || canGrantRoles(actorRoles, added);
}

export const PERMISSIONS = [
  // Organization administration (non-clinical).
  'tenant.settings.manage',
  'tenant.branding.manage',
  // Opens a time-boxed window for the platform to help with configuration (owner only).
  'tenant.support.manage',
  'staff.manage',
  // Every staff member sees the directory (names, roles, disciplines, locations).
  'staff.directory.read',
  'permissions.grant',
  'locations.manage',
  'audit.read',
  'audit.export',
  'reports.read',
  'billing.manage',
  // Patients (demographics are organization-wide).
  'patients.read',
  'patients.write',
  'patients.administer',
  'patients.safety_flag.read',
  // Scheduling.
  'scheduling.read',
  'scheduling.book',
  'scheduling.checkin',
  'scheduling.override_hours',
  'scheduling.register_past',
  'scheduling.delegated_calendar',
  // Money.
  'payments.read',
  'payments.write',
  'cash.operate',
  // Clinical content: professionals only, and never grantable.
  'clinical.note.read',
  'clinical.note.write',
  'clinical.note.sign',
  'clinical.note.mark_error',
  'clinical.addendum.create',
  'clinical.anamnesis.read',
  'clinical.anamnesis.write',
  'clinical.document.read',
  // Uploads a clinical document, hides it, or reclassifies one. Never grantable.
  'clinical.document.write',
  'clinical.prescription.read',
  'clinical.search',
  // Patient portal.
  'portal.self.read',
  'portal.appointment.cancel',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type ClinicalPermission = Extract<Permission, `clinical.${string}`>;

export function isClinicalPermission(permission: string): permission is ClinicalPermission {
  return permission.startsWith('clinical.');
}

const CLINICAL: readonly ClinicalPermission[] = PERMISSIONS.filter(isClinicalPermission);

const ADMINISTRATION = [
  'tenant.settings.manage',
  'tenant.branding.manage',
  'staff.manage',
  'staff.directory.read',
  'permissions.grant',
  'locations.manage',
  'audit.read',
  'audit.export',
  'reports.read',
  'patients.read',
  'patients.write',
  'patients.administer',
  'patients.safety_flag.read',
  'scheduling.read',
  'scheduling.book',
  'scheduling.checkin',
  'scheduling.override_hours',
  'scheduling.register_past',
  'scheduling.delegated_calendar',
  'payments.read',
  'payments.write',
  'cash.operate',
] as const satisfies readonly Permission[];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Owner and admin are the same non-clinical bundle; only the owner manages the subscription.
  owner: [...ADMINISTRATION, 'billing.manage', 'tenant.support.manage'],
  admin: ADMINISTRATION,
  professional: [
    'staff.directory.read',
    'patients.read',
    'patients.write',
    'patients.safety_flag.read',
    'scheduling.read',
    'scheduling.book',
    'scheduling.checkin',
    'payments.read',
    ...CLINICAL,
  ],
  // Reception holds patient administration and the cash register by default.
  reception: [
    'staff.directory.read',
    'patients.read',
    'patients.write',
    'patients.administer',
    'patients.safety_flag.read',
    'scheduling.read',
    'scheduling.book',
    'scheduling.checkin',
    'payments.read',
    'payments.write',
    'cash.operate',
  ],
  patient: ['portal.self.read', 'portal.appointment.cancel'],
};

/**
 * The only permissions an owner/admin can hand out per user (`permission_grant`). Non-clinical by
 * construction; the database repeats the rule with `CHECK (permission NOT LIKE 'clinical.%')`.
 */
export const GRANTABLE = [
  'scheduling.override_hours',
  'scheduling.register_past',
  'scheduling.delegated_calendar',
  'cash.operate',
  'patients.administer',
] as const satisfies readonly Permission[];
export type GrantablePermission = (typeof GRANTABLE)[number];

function isGrantable(permission: string): permission is GrantablePermission {
  return GRANTABLE.some((grantable) => grantable === permission);
}

/** Effective permissions = role permissions + (grants that are inside GRANTABLE). */
export function effectivePermissions(
  roles: readonly Role[],
  grants: readonly string[],
): Permission[] {
  const result = new Set<Permission>(roles.flatMap((role) => ROLE_PERMISSIONS[role]));
  for (const grant of grants) {
    if (isGrantable(grant)) result.add(grant);
  }
  return [...result];
}

export interface ClinicalLeak {
  where: string;
  permission: string;
}

/**
 * Finds clinical permissions held by any role other than `professional`, or listed as grantable.
 * The catalog test asserts this is empty, and asserts the function does detect a corrupted catalog.
 */
export function findClinicalLeaks(
  rolePermissions: Record<Role, readonly string[]>,
  grantable: readonly string[],
): ClinicalLeak[] {
  const leaks: ClinicalLeak[] = [];
  for (const role of ROLES) {
    if (role === 'professional') continue;
    for (const permission of rolePermissions[role]) {
      if (isClinicalPermission(permission)) leaks.push({ where: `role:${role}`, permission });
    }
  }
  for (const permission of grantable) {
    if (isClinicalPermission(permission)) leaks.push({ where: 'grantable', permission });
  }
  return leaks;
}
