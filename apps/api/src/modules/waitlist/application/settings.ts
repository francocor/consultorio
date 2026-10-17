import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_WAITLIST_SETTINGS,
  QuietHours,
  WaitlistSettings,
} from '@consultorio/contracts';

import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/** The settings the waitlist reads, with their defaults applied. */
export interface WaitlistConfig {
  waitlist: WaitlistSettings;
  quietHours: QuietHours;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What the organization stores, on top of the defaults. A section that does not satisfy its schema
 * as a whole counts as the defaults, never as something half valid.
 */
export function readWaitlistConfig(stored: Record<string, unknown>): WaitlistConfig {
  const section = stored['waitlist'];
  const merged = isRecord(section)
    ? WaitlistSettings.safeParse({ ...DEFAULT_WAITLIST_SETTINGS, ...section })
    : undefined;
  const quiet = QuietHours.safeParse(stored['quiet_hours']);
  return {
    waitlist: merged?.success ? merged.data : DEFAULT_WAITLIST_SETTINGS,
    quietHours: quiet.success ? quiet.data : DEFAULT_QUIET_HOURS,
  };
}

/** The waitlist settings of the organization of the transaction. */
export async function loadWaitlistConfig(tx: Tx): Promise<WaitlistConfig> {
  const [row] = await tx.select({ settings: tenant.settings }).from(tenant);
  return readWaitlistConfig(row?.settings ?? {});
}
