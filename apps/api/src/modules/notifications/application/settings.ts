import {
  DEFAULT_INTEGRATION_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_QUIET_HOURS,
  IntegrationSettings,
  NotificationSettings,
  QuietHours,
} from '@consultorio/contracts';

import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/** The settings messaging reads, with their defaults applied. */
export interface MessagingSettings {
  notifications: NotificationSettings;
  quietHours: QuietHours;
  /** The WhatsApp switch of the organization. */
  whatsappEnabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What the organization stores, on top of the defaults. A section that does not satisfy its schema
 * as a whole counts as the defaults, never as something half valid: a damaged setting cannot turn
 * a channel on.
 */
export function readMessagingSettings(stored: Record<string, unknown>): MessagingSettings {
  const section = <T>(
    parse: (value: unknown) => { success: true; data: T } | { success: false },
    value: unknown,
    defaults: T,
  ): T => {
    const merged = isRecord(value) ? parse({ ...(defaults as object), ...value }) : undefined;
    return merged?.success ? merged.data : defaults;
  };

  const notifications = section(
    (value) => NotificationSettings.safeParse(value),
    stored['notifications'],
    DEFAULT_NOTIFICATION_SETTINGS,
  );
  const integrations = section(
    (value) => IntegrationSettings.safeParse(value),
    stored['integrations'],
    DEFAULT_INTEGRATION_SETTINGS,
  );
  const quiet = QuietHours.safeParse(stored['quiet_hours']);
  return {
    notifications,
    quietHours: quiet.success ? quiet.data : DEFAULT_QUIET_HOURS,
    whatsappEnabled: integrations.whatsapp,
  };
}

/** The messaging settings of the organization of the transaction. */
export async function loadMessagingSettings(tx: Tx): Promise<MessagingSettings> {
  const [row] = await tx.select({ settings: tenant.settings }).from(tenant);
  return readMessagingSettings(row?.settings ?? {});
}
