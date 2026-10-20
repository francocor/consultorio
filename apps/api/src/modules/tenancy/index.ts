/**
 * Public API of the tenancy module. Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';

import { exportOrganization } from './application/export-contributor.js';
import type { ExportRegistry } from './application/export-registry.js';
import { createSupportGrants } from './application/support-grants.js';
import { createBootService, type BootDeps } from './branding/boot.js';
import { createBrandingService } from './branding/branding.js';
import { createLogoService } from './branding/logo-service.js';
import { bootRoutes } from './http/boot-routes.js';
import { brandingRoutes } from './http/branding-routes.js';
import { supportRoutes } from './http/support-routes.js';

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
export { createTenantLifecycle } from './application/lifecycle.js';
export type {
  CancellationSource,
  TenantCancelledEvent,
  TenantCancelledHandler,
  TenantCancelledPort,
  TenantLifecycle,
} from './application/lifecycle.js';
export { createCancellation } from './cancellation/cancellation.js';
export type { Cancellation, CancellationOptions } from './cancellation/cancellation.js';
export {
  CANCELLATION_EXPORT_JOB,
  createCancellationExportJob,
} from './cancellation/build-export.js';
export type { CancellationExportDeps } from './cancellation/build-export.js';
export { enqueuePendingExports } from './cancellation/queue.js';
export { operatorCancelRoutes } from './cancellation/http/operator-cancel-routes.js';
export { createArchive } from './archive/archive.js';
export type { Archive, ArchiveOptions } from './archive/archive.js';
export type * from './archive/ports.js';
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
  /** Where logos are stored. Absent: logo upload answers "unavailable". */
  storage?: ObjectStorage | undefined;
  /** What the public boot payload needs from the deployment. */
  boot: BootDeps;
}

export interface SupportAccess {
  routes: (app: FastifyInstance) => void;
}

/** The organization's side of support access: open and close the window for the platform. */
export function createSupportAccess(options: { withTenant: WithTenant }): SupportAccess {
  return {
    routes: supportRoutes({ withTenant: options.withTenant, grants: createSupportGrants() }),
  };
}

export interface Branding {
  routes: (app: FastifyInstance) => void;
}

/** The branding of an organization: the identity screen, the logo and the public boot payload. */
export function createBranding(options: BrandingOptions): Branding {
  const identity = brandingRoutes({
    withTenant: options.withTenant,
    branding: createBrandingService(),
    logo: createLogoService({ storage: options.storage }),
  });
  const boot = bootRoutes({
    withTenant: options.withTenant,
    boot: createBootService(options.boot),
  });
  return {
    routes: (app) => {
      identity(app);
      boot(app);
    },
  };
}
