/**
 * How this deployment maps a request host to a tenant.
 * - multi: tenants live at `{slug}.baseDomain`; `platformHost` serves the operator console.
 * - single: one tenant is pinned by configuration and the host is ignored.
 */
export type DeploymentSettings =
  { mode: 'multi'; baseDomain: string; platformHost: string } | { mode: 'single'; slug: string };

export type HostClassification =
  { kind: 'tenant'; slug: string } | { kind: 'platform' } | { kind: 'unknown' };

/** A DNS label that is also a valid tenant slug: 2 to 63 characters, lowercase, inner hyphens. */
const SLUG_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
/** Host names only: letters, digits, hyphens and dots, with an optional numeric port. */
const HOST_WITH_PORT = /^([a-z0-9.-]+)(?::\d{1,5})?$/;

/** Lowercases, drops the port and the trailing dot of a Host header. Null if it is not a plain host name. */
function hostName(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = HOST_WITH_PORT.exec(header.trim().toLowerCase());
  const name = match?.[1]?.replace(/\.$/, '');
  return name ? name : null;
}

/**
 * Pure classification of a Host header. It never looks at any other header, so a spoofed
 * `X-Tenant-Id` cannot influence which tenant a request belongs to.
 *
 * `platform` as a subdomain is reserved by the platform host check running first; tenant creation
 * must also reject reserved slugs.
 */
export function classifyHost(
  header: string | undefined,
  deployment: DeploymentSettings,
): HostClassification {
  if (deployment.mode === 'single') {
    return { kind: 'tenant', slug: deployment.slug };
  }

  const host = hostName(header);
  if (host === null) return { kind: 'unknown' };
  if (host === deployment.platformHost.toLowerCase()) return { kind: 'platform' };

  const suffix = `.${deployment.baseDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return { kind: 'unknown' };
  const label = host.slice(0, -suffix.length);
  return SLUG_LABEL.test(label) ? { kind: 'tenant', slug: label } : { kind: 'unknown' };
}
