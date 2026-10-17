import {
  DEFAULT_INTEGRATION_SETTINGS,
  DEFAULT_ONLINE_BOOKING_SETTINGS,
  IntegrationSettings,
  OnlineBookingSettings,
} from '@consultorio/contracts';

import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

export interface BookingSettings {
  booking: OnlineBookingSettings;
  /** The organization's video switch (`settings.integrations.video`). */
  videoEnabled: boolean;
}

/**
 * The online-booking rules of the organization: its `onlineBooking` section over the defaults, and
 * the video switch. A stored value that no longer satisfies the schema counts as the default (every
 * doubt is the conservative setting), never as an error that closes the page.
 */
export async function readBookingSettings(tx: Tx): Promise<BookingSettings> {
  const [row] = await tx.select({ settings: tenant.settings }).from(tenant);
  const stored = row?.settings ?? {};

  const booking = OnlineBookingSettings.safeParse({
    ...DEFAULT_ONLINE_BOOKING_SETTINGS,
    ...asObject(stored['onlineBooking']),
  });
  const integrations = IntegrationSettings.safeParse({
    ...DEFAULT_INTEGRATION_SETTINGS,
    ...asObject(stored['integrations']),
  });
  return {
    booking: booking.success ? booking.data : DEFAULT_ONLINE_BOOKING_SETTINGS,
    videoEnabled: (integrations.success ? integrations.data : DEFAULT_INTEGRATION_SETTINGS).video,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
