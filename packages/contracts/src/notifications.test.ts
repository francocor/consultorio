import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  MESSAGE_CHANNELS,
  MESSAGE_STATUSES,
  NOTIFICATION_AUDIT_ACTIONS,
  NotificationSettings,
} from './notifications.js';

describe('notification catalogues', () => {
  it('has the channels of the product: email and WhatsApp, no SMS', () => {
    expect([...MESSAGE_CHANNELS]).toEqual(['email', 'whatsapp']);
  });

  it('has the message statuses of the design, in the order a message moves through them', () => {
    expect([...MESSAGE_STATUSES]).toEqual([
      'queued',
      'sent',
      'delivered',
      'read',
      'failed',
      'cancelled',
    ]);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(NOTIFICATION_AUDIT_ACTIONS).toEqual([
      'notification.optout.recorded',
      'notification.optin.recorded',
      'notification.resend',
      'notification.integration.changed',
    ]);
    for (const action of NOTIFICATION_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });
});

describe('notification settings', () => {
  it('defaults to one reminder 24 hours before the start and no neutral wording', () => {
    expect(NotificationSettings.parse(DEFAULT_NOTIFICATION_SETTINGS)).toEqual({
      reminderLeadHours: [24],
      hideProfessional: false,
      hideAppointmentType: false,
    });
  });

  it('accepts up to three different lead times, or none to stop reminders', () => {
    const base = DEFAULT_NOTIFICATION_SETTINGS;

    expect(
      NotificationSettings.safeParse({ ...base, reminderLeadHours: [72, 24, 2] }).success,
    ).toBe(true);
    expect(NotificationSettings.safeParse({ ...base, reminderLeadHours: [] }).success).toBe(true);
    expect(
      NotificationSettings.safeParse({ ...base, reminderLeadHours: [72, 48, 24, 2] }).success,
    ).toBe(false);
    expect(NotificationSettings.safeParse({ ...base, reminderLeadHours: [24, 24] }).success).toBe(
      false,
    );
    expect(NotificationSettings.safeParse({ ...base, reminderLeadHours: [0] }).success).toBe(false);
    expect(NotificationSettings.safeParse({ ...base, reminderLeadHours: [1.5] }).success).toBe(
      false,
    );
  });

  it('refuses a key it does not know', () => {
    expect(
      NotificationSettings.safeParse({ ...DEFAULT_NOTIFICATION_SETTINGS, sendAt: '09:00' }).success,
    ).toBe(false);
  });
});
