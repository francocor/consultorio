import { asc } from 'drizzle-orm';

import { location, tenant, tenantFeature } from '../../../db/schema/tenant.js';

import type { ExportContributor } from './export-registry.js';

/**
 * Administrative export part owned by tenancy: the organization configuration, its locations and
 * its feature flags. The transaction is bound to the exporting tenant, so row level security
 * limits every query to that tenant even if a filter were forgotten. No clinical content here.
 */
export const exportOrganization: ExportContributor = async ({ tx }) => {
  const [organization] = await tx
    .select({
      slug: tenant.slug,
      status: tenant.status,
      country: tenant.country,
      theme: tenant.theme,
      settings: tenant.settings,
      createdAt: tenant.createdAt,
    })
    .from(tenant);
  const locations = await tx
    .select({
      name: location.name,
      timeZone: location.timeZone,
      active: location.active,
    })
    .from(location)
    .orderBy(asc(location.name));
  const features = await tx
    .select({ feature: tenantFeature.feature, enabled: tenantFeature.enabled })
    .from(tenantFeature)
    .orderBy(asc(tenantFeature.feature));

  return { organization, locations, features };
};
