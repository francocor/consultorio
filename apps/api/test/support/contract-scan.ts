/**
 * Looks for object or interface members that name a tenant or organization identifier:
 * `tenantId`, `tenant_id`, `organizationId`, `organization_id` (optionally quoted or optional).
 * Matches whole names only, so `tenantIdentifierLabel` is not a hit, and comments are skipped.
 */
const TENANT_MEMBER =
  /(?:^|[{,;\s])['"]?(tenantId|tenant_id|organizationId|organization_id)['"]?\s*\??\s*:/g;

export function findTenantIdentifiers(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return [...withoutComments.matchAll(TENANT_MEMBER)].map((match) => match[1] ?? '');
}
