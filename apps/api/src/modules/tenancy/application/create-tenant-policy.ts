import { AppError } from '../../../platform/http/problem.js';
import type { DeploymentSettings } from '../domain/host.js';

/**
 * A single-tenant instance hosts exactly one organization (tenancy, "Single-tenant deployment by
 * configuration"). Called before the operator console or any provisioning path creates a tenant.
 *
 * @param existingTenants how many tenants the instance already has
 * @param slug the slug of the tenant about to be created, when known
 */
export function assertCanCreateTenant(
  deployment: DeploymentSettings,
  existingTenants: number,
  slug?: string,
): void {
  if (deployment.mode === 'multi') return;
  if (existingTenants >= 1) throw new AppError('forbidden');
  if (slug !== undefined && slug !== deployment.slug) throw new AppError('forbidden');
}
