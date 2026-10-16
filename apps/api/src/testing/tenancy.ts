import type { DeploymentSettings } from '../modules/tenancy/domain/host.js';
import type { ResolvedTenant } from '../platform/http/tenant-host.js';

export const TEST_TENANT: ResolvedTenant = {
  id: '0190a000-0000-7000-8000-0000000000e1',
  slug: 'test-tenant',
  status: 'active',
  readOnlySince: null,
  isDemo: false,
  country: 'AR',
};

export interface TestTenancy {
  deployment: DeploymentSettings;
  lookupTenant: (slug: string) => Promise<ResolvedTenant | null>;
}

/**
 * Tenancy options for tests that are not about tenancy: single mode pins every host to one fixed
 * tenant, so any request resolves without a database.
 */
export function testTenancy(tenants: readonly ResolvedTenant[] = [TEST_TENANT]): TestTenancy {
  return {
    deployment: { mode: 'single', slug: TEST_TENANT.slug },
    lookupTenant: (slug) => Promise.resolve(tenants.find((tenant) => tenant.slug === slug) ?? null),
  };
}
