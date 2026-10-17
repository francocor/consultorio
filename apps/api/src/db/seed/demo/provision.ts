import { createTenantLookup } from '../../../modules/tenancy/index.js';
import { createCatalogReader } from '../../../platform/country/catalog-reader.js';
import { getCountryPack } from '../../../platform/country/country-pack.js';
import type { Db } from '../../../platform/db/pool.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { tenant } from '../../schema/tenant.js';

import { buildDemoDataset } from './dataset.js';

export interface ProvisionedDemoTenant {
  id: string;
  slug: string;
  created: boolean;
}

/**
 * Finds the demo organization of this slug or creates it. A tenant is inserted under a context
 * whose tenant id is the new row's own id, the same way the operator console does it. An existing
 * organization that is not flagged as a demo one is refused: this must never turn a real
 * organization into a demo one, or the other way around (the flag is fixed at creation).
 */
export async function ensureDemoTenant(
  db: Db,
  withTenant: WithTenant,
  slug: string,
): Promise<ProvisionedDemoTenant> {
  const existing = await createTenantLookup(db)(slug);
  if (existing) {
    if (!existing.isDemo) {
      throw new Error(`The organization "${slug}" exists and is not a demo organization.`);
    }
    return { id: existing.id, slug, created: false };
  }
  const id = uuidv7();
  const branding = buildDemoDataset().branding;
  await withTenant({ tenantId: id, userId: SYSTEM_USER_ID }, (tx) =>
    tx.insert(tenant).values({
      id,
      slug,
      isDemo: true,
      billingExempt: true,
      theme: { displayName: branding.displayName },
    }),
  );
  return { id, slug, created: true };
}

/** Key and version of the data-processing consent text of Argentina, from the country pack. */
export function consentTextFor(db: Db): { textKey: string; version: string } {
  const pack = getCountryPack('AR', createCatalogReader(db));
  const consent = pack.ok ? pack.value.personalData.dataProcessingConsent : undefined;
  return {
    textKey: consent?.textKey ?? 'consent.data_processing',
    version: consent?.version ?? '1',
  };
}
