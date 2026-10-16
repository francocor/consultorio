/**
 * Public API of the tenancy module. Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';

import { exportOrganization } from './application/export-contributor.js';
import type { ExportRegistry } from './application/export-registry.js';
import { createBrandingService } from './branding/branding.js';
import { brandingRoutes } from './http/branding-routes.js';

export { readOrganizationName } from './application/organization-name.js';
export { assertCanCreateTenant } from './application/create-tenant-policy.js';
export { createExportRegistry } from './application/export-registry.js';
export type {
  ExportContext,
  ExportContributor,
  ExportKind,
  ExportRegistry,
  RegisteredContributor,
} from './application/export-registry.js';
export { createResolveHost } from './application/resolve-tenant.js';
export type { LookupTenant } from './application/resolve-tenant.js';
export { classifyHost } from './domain/host.js';
export type { DeploymentSettings, HostClassification } from './domain/host.js';
export { createTenantLookup } from './infrastructure/tenant-lookup.js';

/** Registers what tenancy contributes to the cancellation export. */
export function registerTenancyExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'tenancy', exportOrganization);
}

export interface BrandingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
}

export interface Branding {
  routes: (app: FastifyInstance) => void;
}

/** The branding of an organization: the identity screen, the logo and the public boot payload. */
export function createBranding(options: BrandingOptions): Branding {
  const identity = brandingRoutes({
    withTenant: options.withTenant,
    branding: createBrandingService(),
  });
  return {
    routes: (app) => {
      identity(app);
    },
  };
}
