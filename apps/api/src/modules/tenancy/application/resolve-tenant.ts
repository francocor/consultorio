import type {
  HostContext,
  ResolveHost,
  ResolvedTenant,
} from '../../../platform/http/tenant-host.js';
import { classifyHost, type DeploymentSettings } from '../domain/host.js';

/** Finds a tenant by slug. Implemented on the database in `infrastructure/tenant-lookup.ts`. */
export type LookupTenant = (slug: string) => Promise<ResolvedTenant | null>;

/**
 * Builds the host resolver the HTTP guard calls on every request. The platform host never touches
 * the database, and a host that cannot be a tenant (wrong domain, nested subdomain, IP address)
 * is rejected before any query runs.
 */
export function createResolveHost(
  deployment: DeploymentSettings,
  lookup: LookupTenant,
): ResolveHost {
  return async (hostHeader): Promise<HostContext | null> => {
    const classification = classifyHost(hostHeader, deployment);
    switch (classification.kind) {
      case 'platform':
        return { kind: 'platform' };
      case 'unknown':
        return null;
      case 'tenant': {
        const tenant = await lookup(classification.slug);
        return tenant ? { kind: 'tenant', tenant } : null;
      }
    }
  };
}
