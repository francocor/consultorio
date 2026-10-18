import {
  DEFAULT_INTEGRATION_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_ONLINE_BOOKING_SETTINGS,
  IntegrationSettings,
  NotificationSettings,
  OnlineBookingSettings,
} from '@consultorio/contracts';

import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

export interface BookingSettings {
  booking: OnlineBookingSettings;
  /** The organization's video switch (`settings.integrations.video`). */
  videoEnabled: boolean;
  /** Neutral wording: the professional and the type of visit are left out of what a link shows. */
  hideProfessional: boolean;
  hideAppointmentType: boolean;
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
  const notifications = NotificationSettings.safeParse({
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...asObject(stored['notifications']),
  });
  const wording = notifications.success ? notifications.data : DEFAULT_NOTIFICATION_SETTINGS;
  return {
    booking: booking.success ? booking.data : DEFAULT_ONLINE_BOOKING_SETTINGS,
    videoEnabled: (integrations.success ? integrations.data : DEFAULT_INTEGRATION_SETTINGS).video,
    hideProfessional: wording.hideProfessional,
    hideAppointmentType: wording.hideAppointmentType,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
