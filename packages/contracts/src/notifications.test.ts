import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import {
  AppointmentMessagesResponse,
  APPOINTMENT_MESSAGE_KINDS,
  DEFAULT_NOTIFICATION_SETTINGS,
  EMAIL_ONLY_MESSAGE_KINDS,
  MESSAGE_CANCEL_REASONS,
  MESSAGE_CHANNELS,
  MESSAGE_FAILURE_REASONS,
  MESSAGE_KINDS,
  MAX_MANUAL_RESENDS,
  MESSAGE_STATUSES,
  NOTIFICATION_AUDIT_ACTIONS,
  NOTIFICATION_ERRORS,
  NotificationSettings,
  ResendMessageRequest,
  SimulatorInboundRequest,
  SimulatorModeRequest,
  SimulatorStatusRequest,
  SimulatorUnreachableRequest,
  UsageResponse,
  USAGE_WARNING_PERCENT,
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

describe('message kinds', () => {
  it('splits every kind into appointment messages and email-only messages, with no overlap', () => {
    expect([...APPOINTMENT_MESSAGE_KINDS]).toEqual(['reminder', 'confirmation', 'waitlist_offer']);
    expect([...EMAIL_ONLY_MESSAGE_KINDS]).toEqual([
      'otp_code',
      'invitation',
      'password_reset',
      'portal_notice',
      'consent_request',
      'invoice',
      'subscription_notice',
    ]);
    expect([...MESSAGE_KINDS].sort()).toEqual(
      [...APPOINTMENT_MESSAGE_KINDS, ...EMAIL_ONLY_MESSAGE_KINDS].sort(),
    );
  });

  it('names why a message is cancelled and why it failed, with the reasons the spec asks for', () => {
    expect(MESSAGE_CANCEL_REASONS).toEqual(
      expect.arrayContaining(['tenant_read_only', 'demo_tenant', 'opted_out', 'offer_expired']),
    );
    expect(MESSAGE_FAILURE_REASONS).toEqual(
      expect.arrayContaining(['not_on_whatsapp', 'template_rejected', 'invalid_number']),
    );
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

describe('the shapes of the WhatsApp simulator console', () => {
  it('accepts a status report, a reply, a mode and an unreachable number, and nothing else', () => {
    expect(SimulatorStatusRequest.parse({ status: 'delivered' })).toEqual({ status: 'delivered' });
    expect(
      SimulatorStatusRequest.parse({ status: 'failed', errorCode: 'not_on_whatsapp' }),
    ).toEqual({
      status: 'failed',
      errorCode: 'not_on_whatsapp',
    });
    expect(SimulatorStatusRequest.safeParse({ status: 'accepted' }).success).toBe(false);
    expect(SimulatorInboundRequest.parse({ from: '+5491144445555', text: '1' })).toEqual({
      from: '+5491144445555',
      text: '1',
    });
    expect(SimulatorInboundRequest.safeParse({ from: '+5491144445555' }).success).toBe(false);
    expect(SimulatorModeRequest.parse({ mode: 'down' })).toEqual({ mode: 'down' });
    expect(SimulatorModeRequest.safeParse({ mode: 'broken' }).success).toBe(false);
    expect(
      SimulatorUnreachableRequest.parse({ number: '+5491144445555', unreachable: true }),
    ).toEqual({
      number: '+5491144445555',
      unreachable: true,
    });
    expect(SimulatorUnreachableRequest.safeParse({ number: '+5491144445555' }).success).toBe(false);
  });
});

describe('the channel, usage and message log shapes', () => {
  it('catalogs the errors of the module with a status and an es-AR message key', () => {
    expect(Object.keys(NOTIFICATION_ERRORS).sort()).toEqual([
      'channel_opted_out',
      'patient_without_email',
      'patient_without_phone',
      'resend_limit_reached',
      'resend_unavailable',
    ]);
    for (const [code, entry] of Object.entries(NOTIFICATION_ERRORS)) {
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
    expect(ERROR_CATALOG.channel_opted_out.status).toBe(409);
  });

  it('reads the usage of a month as counts per professional, with the state of the quota', () => {
    const parsed = UsageResponse.parse({
      period: '2031-05',
      professionals: [
        {
          professionalId: '0190a000-0000-7000-8000-000000000001',
          name: null,
          count: 12,
          limit: null,
          state: 'unlimited',
        },
        {
          professionalId: '0190a000-0000-7000-8000-000000000002',
          name: 'Dra. Ríos',
          count: 170,
          limit: 200,
          state: 'warning',
        },
      ],
    });

    expect(parsed.professionals.map((entry) => entry.state)).toEqual(['unlimited', 'warning']);
    expect(UsageResponse.safeParse({ period: '2031-5', professionals: [] }).success).toBe(false);
    expect(USAGE_WARNING_PERCENT).toBe(80);
  });

  it('allows three manual resends per appointment and no more in the log', () => {
    expect(MAX_MANUAL_RESENDS).toBe(3);
    expect(
      AppointmentMessagesResponse.safeParse({
        messages: [],
        noAutomatedReminders: false,
        resendsLeft: 4,
      }).success,
    ).toBe(false);
    expect(ResendMessageRequest.parse({ channel: 'email' })).toEqual({ channel: 'email' });
    expect(ResendMessageRequest.safeParse({ channel: 'sms' }).success).toBe(false);
  });
});
