import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_SHARED_TEMPLATES,
  type SettingsDto,
} from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { planSettingsUpdate, readSettings } from './settings.js';

const defaults: SettingsDto = {
  receptionSeesClinicalMetadata: false,
  clinicalSharing: false,
  sharedTemplates: [],
  require2fa: false,
  quietHours: DEFAULT_QUIET_HOURS,
};

describe('readSettings', () => {
  it('gives every setting its safe default for an organization that never set one', () => {
    expect(readSettings({})).toEqual(defaults);
  });

  it('reads the stored keys', () => {
    expect(
      readSettings({
        reception_sees_clinical_metadata: true,
        clinicalSharing: true,
        sharedTemplates: ['general', 'psychology'],
        require_2fa: true,
        quiet_hours: { start: '22:00', end: '07:30' },
      }),
    ).toEqual({
      receptionSeesClinicalMetadata: true,
      clinicalSharing: true,
      sharedTemplates: ['general', 'psychology'],
      require2fa: true,
      quietHours: { start: '22:00', end: '07:30' },
    });
  });

  it('treats a value of the wrong type as the safe default: "off", never "on"', () => {
    expect(
      readSettings({
        reception_sees_clinical_metadata: 'yes',
        clinicalSharing: 1,
        sharedTemplates: 'general',
        require_2fa: 'true',
        quiet_hours: { start: 'late', end: 3 },
      }),
    ).toEqual(defaults);
  });

  it('ignores unknown templates in the stored list', () => {
    expect(readSettings({ sharedTemplates: ['general', 'cardiology', 7] }).sharedTemplates).toEqual(
      ['general'],
    );
  });
});

describe('planSettingsUpdate', () => {
  it('seeds the shared scope with every template except psychology when sharing is first enabled', () => {
    const plan = planSettingsUpdate(defaults, { clinicalSharing: true });

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

    const plan = planSettingsUpdate(current, { clinicalSharing: true });

    if (!plan.ok) throw new Error('unexpected');
    expect(plan.stored['sharedTemplates']).toBeUndefined();
    expect(plan.events).toEqual([
      { kind: 'sharing', clinicalSharing: true, added: [], removed: [] },
    ]);
  });

  it('needs the explicit confirmation to add psychology', () => {
    const current = { ...defaults, clinicalSharing: true, sharedTemplates: ['general' as const] };

    expect(planSettingsUpdate(current, { sharedTemplates: ['general', 'psychology'] })).toEqual({
      ok: false,
      path: 'sharedTemplates',
      i18nKey: 'settings.psychology_confirmation_required',
    });
    expect(
      planSettingsUpdate(current, {
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
      planSettingsUpdate(defaults, { clinicalSharing: true, sharedTemplates: ['psychology'] }),
    ).toMatchObject({ ok: false });
  });

  it('does not ask again for psychology that is already shared, and lets it be removed freely', () => {
    const current = {
      ...defaults,
      clinicalSharing: true,
      sharedTemplates: ['general' as const, 'psychology' as const],
    };

    expect(planSettingsUpdate(current, { sharedTemplates: ['general'] })).toMatchObject({
      ok: true,
      events: [{ kind: 'sharing', added: [], removed: ['psychology'] }],
    });
    expect(planSettingsUpdate(current, { sharedTemplates: ['general', 'psychology'] })).toEqual({
      ok: true,
      stored: {},
      events: [],
    });
  });

  it('plans one event per changed setting and none for a value that did not change', () => {
    const plan = planSettingsUpdate(defaults, {
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
    const plan = planSettingsUpdate(defaults, { require2fa: true });

    expect(plan).toMatchObject({ ok: true, stored: { require_2fa: true } });
  });
});
