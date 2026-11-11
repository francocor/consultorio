import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_WAITLIST_SETTINGS,
  NotificationSettings,
  WaitlistSettings,
} from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createSettingsSectionRegistry, type SettingsSection } from './settings-sections.js';

const notifications: SettingsSection = {
  key: 'notifications',
  schema: NotificationSettings,
  defaults: DEFAULT_NOTIFICATION_SETTINGS,
};
const waitlist: SettingsSection = {
  key: 'waitlist',
  schema: WaitlistSettings,
  defaults: DEFAULT_WAITLIST_SETTINGS,
};

describe('settings section registry', () => {
  it('lists the sections that modules registered, in the order they did', () => {
    const registry = createSettingsSectionRegistry();

    registry.register(waitlist);
    registry.register(notifications);

    expect(registry.sections().map((section) => section.key)).toEqual([
      'waitlist',
      'notifications',
    ]);
    expect(registry.get('waitlist')).toBe(waitlist);
    expect(registry.get('integrations')).toBeUndefined();
  });

  it('refuses a section registered twice: the second module would silently replace the first', () => {
    const registry = createSettingsSectionRegistry();
    registry.register(notifications);

    expect(() => {
      registry.register(notifications);
    }).toThrow(/notifications.*twice/);
  });

  it('refuses a section whose defaults its own schema rejects, when it is registered', () => {
    const registry = createSettingsSectionRegistry();

    expect(() => {
      registry.register({
        key: 'waitlist',
        schema: WaitlistSettings,
        defaults: { ...DEFAULT_WAITLIST_SETTINGS, maxActiveEntries: 0 },
      });
    }).toThrow(/waitlist.*defaults/);
  });

  it('refuses a key the contracts do not declare: the response schema would reject it later', () => {
    const registry = createSettingsSectionRegistry();

    expect(() => {
      registry.register({
        key: 'payroll' as never,
        schema: z.strictObject({ on: z.boolean() }),
        defaults: { on: false },
      });
    }).toThrow(/payroll/);
  });
});
