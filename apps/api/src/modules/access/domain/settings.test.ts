import {
  BillingSettings,
  DEFAULT_BILLING_SETTINGS,
  DEFAULT_INTEGRATION_SETTINGS,
  DEFAULT_INVOICING_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_ONLINE_BOOKING_SETTINGS,
  DEFAULT_QUIET_HOURS,
  DEFAULT_SHARED_TEMPLATES,
  DEFAULT_TELECONSULTATION_SETTINGS,
  DEFAULT_WAITLIST_SETTINGS,
  IntegrationSettings,
  InvoicingSettings,
  NotificationSettings,
  OnlineBookingSettings,
  TeleconsultationSettings,
  WaitlistSettings,
  type SettingsDto,
} from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import type { SettingsSection } from '../../../platform/settings-sections.js';

import { planSettingsUpdate, readSettings } from './settings.js';

/** The sections the modules register (see `main/wiring`). */
const SECTIONS: readonly SettingsSection[] = [
  {
    key: 'notifications',
    schema: NotificationSettings,
    defaults: DEFAULT_NOTIFICATION_SETTINGS,
  },
  {
    key: 'onlineBooking',
    schema: OnlineBookingSettings,
    defaults: DEFAULT_ONLINE_BOOKING_SETTINGS,
  },
  { key: 'waitlist', schema: WaitlistSettings, defaults: DEFAULT_WAITLIST_SETTINGS },
  {
    key: 'teleconsultation',
    schema: TeleconsultationSettings,
    defaults: DEFAULT_TELECONSULTATION_SETTINGS,
  },
  {
    key: 'integrations',
    schema: IntegrationSettings,
    defaults: DEFAULT_INTEGRATION_SETTINGS,
    fieldAudits: {
      whatsapp: 'notification.integration.changed',
      einvoicing: 'invoicing.config.changed',
    },
  },
  { key: 'billing', schema: BillingSettings, defaults: DEFAULT_BILLING_SETTINGS },
  { key: 'invoicing', schema: InvoicingSettings, defaults: DEFAULT_INVOICING_SETTINGS },
];

const defaults: SettingsDto = {
  receptionSeesClinicalMetadata: false,
  clinicalSharing: false,
  sharedTemplates: [],
  require2fa: false,
  quietHours: DEFAULT_QUIET_HOURS,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  onlineBooking: DEFAULT_ONLINE_BOOKING_SETTINGS,
  waitlist: DEFAULT_WAITLIST_SETTINGS,
  teleconsultation: DEFAULT_TELECONSULTATION_SETTINGS,
  integrations: DEFAULT_INTEGRATION_SETTINGS,
  billing: DEFAULT_BILLING_SETTINGS,
  invoicing: DEFAULT_INVOICING_SETTINGS,
};

const read = (stored: Record<string, unknown>) => readSettings(stored, SECTIONS);
const planFor = (current: SettingsDto, patch: Parameters<typeof planSettingsUpdate>[1]) =>
  planSettingsUpdate(current, patch, SECTIONS);

describe('readSettings', () => {
  it('gives every setting its safe default for an organization that never set one', () => {
    expect(read({})).toEqual(defaults);
  });

  it('reads the stored keys', () => {
    expect(
      read({
        reception_sees_clinical_metadata: true,
        clinicalSharing: true,
        sharedTemplates: ['general', 'psychology'],
        require_2fa: true,
        quiet_hours: { start: '22:00', end: '07:30' },
      }),
    ).toEqual({
      ...defaults,
      receptionSeesClinicalMetadata: true,
      clinicalSharing: true,
      sharedTemplates: ['general', 'psychology'],
      require2fa: true,
      quietHours: { start: '22:00', end: '07:30' },
    });
  });

  it('treats a value of the wrong type as the safe default: "off", never "on"', () => {
    expect(
      read({
        reception_sees_clinical_metadata: 'yes',
        clinicalSharing: 1,
        sharedTemplates: 'general',
        require_2fa: 'true',
        quiet_hours: { start: 'late', end: 3 },
      }),
    ).toEqual(defaults);
  });

  it('ignores unknown templates in the stored list', () => {
    expect(read({ sharedTemplates: ['general', 'cardiology', 7] }).sharedTemplates).toEqual([
      'general',
    ]);
  });
});

describe('planSettingsUpdate', () => {
  it('seeds the shared scope with every template except psychology when sharing is first enabled', () => {
    const plan = planFor(defaults, { clinicalSharing: true });

    expect(plan).toMatchObject({ ok: true, stored: { clinicalSharing: true } });
    if (!plan.ok) throw new Error('unexpected');
    expect(plan.stored['sharedTemplates']).toEqual([...DEFAULT_SHARED_TEMPLATES]);
    expect(plan.stored['sharedTemplates']).not.toContain('psychology');
    expect(plan.events).toEqual([
      {
        kind: 'sharing',
        clinicalSharing: true,
        added: [...DEFAULT_SHARED_TEMPLATES],
        removed: [],
      },
    ]);
  });

  it('keeps the scope the owner already configured when sharing is switched back on', () => {
    const current = { ...defaults, sharedTemplates: ['general' as const] };

    const plan = planFor(current, { clinicalSharing: true });

    if (!plan.ok) throw new Error('unexpected');
    expect(plan.stored['sharedTemplates']).toBeUndefined();
    expect(plan.events).toEqual([
      { kind: 'sharing', clinicalSharing: true, added: [], removed: [] },
    ]);
  });

  it('needs the explicit confirmation to add psychology', () => {
    const current = { ...defaults, clinicalSharing: true, sharedTemplates: ['general' as const] };

    expect(planFor(current, { sharedTemplates: ['general', 'psychology'] })).toEqual({
      ok: false,
      path: 'sharedTemplates',
      i18nKey: 'settings.psychology_confirmation_required',
    });
    expect(
      planFor(current, {
        sharedTemplates: ['general', 'psychology'],
        confirmPsychologySharing: true,
      }),
    ).toMatchObject({
      ok: true,
      events: [{ kind: 'sharing', added: ['psychology'], removed: [] }],
    });
  });

  it('needs the confirmation even when sharing is enabled in the same request', () => {
    expect(
      planFor(defaults, { clinicalSharing: true, sharedTemplates: ['psychology'] }),
    ).toMatchObject({ ok: false });
  });

  it('does not ask again for psychology that is already shared, and lets it be removed freely', () => {
    const current = {
      ...defaults,
      clinicalSharing: true,
      sharedTemplates: ['general' as const, 'psychology' as const],
    };

    expect(planFor(current, { sharedTemplates: ['general'] })).toMatchObject({
      ok: true,
      events: [{ kind: 'sharing', added: [], removed: ['psychology'] }],
    });
    expect(planFor(current, { sharedTemplates: ['general', 'psychology'] })).toEqual({
      ok: true,
      stored: {},
      events: [],
    });
  });

  it('plans one event per changed setting and none for a value that did not change', () => {
    const plan = planFor(defaults, {
      receptionSeesClinicalMetadata: true,
      require2fa: false,
      quietHours: { start: '22:00', end: '07:00' },
    });

    expect(plan).toEqual({
      ok: true,
      stored: {
        reception_sees_clinical_metadata: true,
        quiet_hours: { start: '22:00', end: '07:00' },
      },
      events: [
        { kind: 'reception_metadata', enabled: true },
        { kind: 'quiet_hours', start: '22:00', end: '07:00' },
      ],
    });
  });

  it('stores require_2fa under the key the sign-in already reads', () => {
    const plan = planFor(defaults, { require2fa: true });

    expect(plan).toMatchObject({ ok: true, stored: { require_2fa: true } });
  });
});

describe('settings sections', () => {
  it('reads each section from its own key and fills what is missing with the defaults', () => {
    const settings = read({
      waitlist: { offerWindowMinutes: 45 },
      notifications: { reminderLeadHours: [48, 2], hideProfessional: true },
    });

    expect(settings.waitlist).toEqual({ ...DEFAULT_WAITLIST_SETTINGS, offerWindowMinutes: 45 });
    expect(settings.notifications).toEqual({
      reminderLeadHours: [48, 2],
      hideProfessional: true,
      hideAppointmentType: false,
    });
    expect(settings.onlineBooking).toEqual(DEFAULT_ONLINE_BOOKING_SETTINGS);
  });

  it('treats a damaged section as its defaults, never as something half valid', () => {
    const settings = read({
      waitlist: { maxActiveEntries: 'many' },
      notifications: 'on',
      integrations: { whatsapp: 'yes', video: false },
      teleconsultation: [15],
    });

    expect(settings.waitlist).toEqual(DEFAULT_WAITLIST_SETTINGS);
    expect(settings.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(settings.integrations).toEqual(DEFAULT_INTEGRATION_SETTINGS);
    expect(settings.teleconsultation).toEqual(DEFAULT_TELECONSULTATION_SETTINGS);
  });

  it('stores a changed section whole under its key and plans one event naming the fields', () => {
    const result = planFor(defaults, { waitlist: { offerWindowMinutes: 20, maxActiveEntries: 5 } });

    expect(result).toEqual({
      ok: true,
      stored: { waitlist: { ...DEFAULT_WAITLIST_SETTINGS, offerWindowMinutes: 20 } },
      events: [
        {
          kind: 'section',
          section: 'waitlist',
          changedFields: ['offerWindowMinutes'],
          fieldAudits: [],
        },
      ],
    });
  });

  it('plans nothing for a section value that did not change', () => {
    expect(planFor(defaults, { notifications: { reminderLeadHours: [24] } })).toEqual({
      ok: true,
      stored: {},
      events: [],
    });
  });

  it('keeps the fields a partial change does not mention', () => {
    const current = {
      ...defaults,
      onlineBooking: { ...DEFAULT_ONLINE_BOOKING_SETTINGS, dailyCap: 30 },
    };

    const result = planFor(current, { onlineBooking: { requireApproval: true } });

    expect(result).toMatchObject({
      ok: true,
      stored: { onlineBooking: { dailyCap: 30, requireApproval: true, horizonDays: 60 } },
    });
  });

  it('adds the specific audit of a field that has one, next to the generic section event', () => {
    const result = planFor(defaults, { integrations: { whatsapp: false, video: true } });

    expect(result).toEqual({
      ok: true,
      stored: { integrations: { whatsapp: false, video: true, einvoicing: false } },
      events: [
        {
          kind: 'section',
          section: 'integrations',
          changedFields: ['whatsapp'],
          fieldAudits: [
            { action: 'notification.integration.changed', field: 'whatsapp', enabled: false },
          ],
        },
      ],
    });
  });

  it('audits the e-invoicing switch as a change of the invoicing configuration', () => {
    const result = planFor(defaults, { integrations: { einvoicing: true } });

    expect(result).toEqual({
      ok: true,
      stored: { integrations: { whatsapp: true, video: true, einvoicing: true } },
      events: [
        {
          kind: 'section',
          section: 'integrations',
          changedFields: ['einvoicing'],
          fieldAudits: [{ action: 'invoicing.config.changed', field: 'einvoicing', enabled: true }],
        },
      ],
    });
  });

  it('reads the Stage 4 sections with their defaults, and keeps e-invoicing off for an old record', () => {
    const settings = read({ integrations: { whatsapp: false, video: true } });

    expect(settings.integrations).toEqual({ whatsapp: false, video: true, einvoicing: false });
    expect(settings.billing).toEqual({ lateFeeEnabled: false, lateFeeAmount: 0 });
    expect(settings.invoicing).toEqual({ outageThresholdHours: 24 });
  });

  it('plans a change of the billing and invoicing sections like any other', () => {
    expect(planFor(defaults, { invoicing: { outageThresholdHours: 48 } })).toMatchObject({
      ok: true,
      stored: { invoicing: { outageThresholdHours: 48 } },
    });
    expect(
      planFor(defaults, { billing: { lateFeeEnabled: true, lateFeeAmount: 500_000 } }),
    ).toMatchObject({
      ok: true,
      stored: { billing: { lateFeeEnabled: true, lateFeeAmount: 500_000 } },
    });
  });

  it('refuses a value the whole section would not accept once merged', () => {
    const stricter: readonly SettingsSection[] = [
      {
        key: 'waitlist',
        schema: WaitlistSettings.refine(
          (value) => value.offerWindowMinutes <= value.minOfferLeadMinutes,
          'the offer cannot outlast the lead time',
        ),
        defaults: DEFAULT_WAITLIST_SETTINGS,
      },
    ];

    expect(
      planSettingsUpdate(defaults, { waitlist: { offerWindowMinutes: 90 } }, stricter),
    ).toEqual({
      ok: false,
      path: 'waitlist',
      i18nKey: 'settings.section_value_invalid',
    });
  });
});
