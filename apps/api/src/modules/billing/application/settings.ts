import { BillingSettings, DEFAULT_BILLING_SETTINGS } from '@consultorio/contracts';

import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What the organization stores, on top of the defaults. A section that does not satisfy its schema
 * as a whole counts as the defaults, never as something half valid.
 */
export function readBillingSettings(stored: Record<string, unknown>): BillingSettings {
  const section = stored['billing'];
  if (!isRecord(section)) return DEFAULT_BILLING_SETTINGS;
  const merged = BillingSettings.safeParse({ ...DEFAULT_BILLING_SETTINGS, ...section });
  return merged.success ? merged.data : DEFAULT_BILLING_SETTINGS;
}

/** The billing settings of the organization of the transaction. */
export async function loadBillingSettings(tx: Tx): Promise<BillingSettings> {
  const [row] = await tx.select({ settings: tenant.settings }).from(tenant);
  return readBillingSettings(row?.settings ?? {});
}
