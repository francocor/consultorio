/**
 * Read-only categories. Every API route and every job declares exactly one (tenancy, requirement
 * "Read-only tenant and its allowlist"). The first nine are the shared allowlist, in the order the
 * spec lists them; `write` is everything else and is refused in a read-only tenant.
 */
export const ROUTE_CATEGORIES = [
  'read',
  'audit_write',
  'auth',
  'export',
  'subscription',
  'patient_protective',
  'rectification_addendum',
  'afip_submission',
  'webhook',
  'write',
] as const;
export type RouteCategory = (typeof ROUTE_CATEGORIES)[number];

export const READ_ONLY_ALLOWLIST: readonly RouteCategory[] = ROUTE_CATEGORIES.filter(
  (category) => category !== 'write',
);

/** True for the nine allowlisted categories. Unknown values are refused (fail closed). */
export function isAllowedWhenReadOnly(category: RouteCategory): boolean {
  return READ_ONLY_ALLOWLIST.includes(category);
}
