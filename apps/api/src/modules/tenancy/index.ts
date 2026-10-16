/**
 * Public API of the tenancy module. Other modules and the composition root import from here only.
 */
import { exportOrganization } from './application/export-contributor.js';
import type { ExportRegistry } from './application/export-registry.js';

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
