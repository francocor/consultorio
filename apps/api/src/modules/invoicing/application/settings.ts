import { DEFAULT_INVOICING_SETTINGS, InvoicingSettings } from '@consultorio/contracts';

import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The organization row, with the settings invoicing reads. */
export interface OrganizationFacts {
  id: string;
  country: string;
  isDemo: boolean;
  /** `settings.integrations.einvoicing`: the organization switched e-invoicing on. */
  enabled: boolean;
  outageThresholdHours: number;
}

/**
 * Reads the organization of the transaction (row level security leaves only its own row). A
 * damaged setting counts as its default (off, 24 hours): a broken value can never switch
 * invoicing on.
 */
export async function loadOrganization(tx: Tx): Promise<OrganizationFacts> {
  const [row] = await tx
    .select({
      id: tenant.id,
      country: tenant.country,
      isDemo: tenant.isDemo,
      settings: tenant.settings,
    })
    .from(tenant);
  if (!row) throw new AppError('not_found');

  const integrations = row.settings['integrations'];
  const invoicing = row.settings['invoicing'];
  const parsed = InvoicingSettings.safeParse({
    ...DEFAULT_INVOICING_SETTINGS,
    ...(isRecord(invoicing) ? invoicing : {}),
  });
  return {
    id: row.id,
    country: row.country,
    isDemo: row.isDemo,
    enabled: isRecord(integrations) && integrations['einvoicing'] === true,
    outageThresholdHours: parsed.success
      ? parsed.data.outageThresholdHours
      : DEFAULT_INVOICING_SETTINGS.outageThresholdHours,
  };
}
