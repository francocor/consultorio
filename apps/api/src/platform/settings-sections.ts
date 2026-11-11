import {
  SETTINGS_SECTION_KEYS,
  type AuditAction,
  type SettingsSectionKey,
} from '@consultorio/contracts';
import type { z } from 'zod';

/**
 * A section of the organization settings that a capability module owns (notifications, online
 * booking, the waitlist, teleconsultation, integrations). The module registers it from its wiring
 * file; the access module merges every registered section into `GET|PATCH /settings`, stores it
 * under its own key of `tenant.settings` and audits each change as `setting.changed`.
 *
 * The shape of a section is a contract (`packages/contracts`), so the screens can use it; the
 * registry only decides which sections this deployment serves.
 */
export interface SettingsSection {
  key: SettingsSectionKey;
  /** The whole section. A partial change is merged onto the current value before it is checked. */
  schema: z.ZodType<Record<string, unknown>>;
  /** What an organization that never set the section has. It must satisfy the schema. */
  defaults: Readonly<Record<string, unknown>>;
  /**
   * Fields whose change is also audited under a more specific action, next to the generic
   * `setting.changed` (for example the WhatsApp switch is `notification.integration.changed`).
   */
  fieldAudits?: Readonly<Record<string, AuditAction>>;
}

export interface SettingsSectionRegistry {
  register(section: SettingsSection): void;
  /** In registration order. */
  sections(): readonly SettingsSection[];
  get(key: SettingsSectionKey): SettingsSection | undefined;
}

export function createSettingsSectionRegistry(): SettingsSectionRegistry {
  const registered = new Map<SettingsSectionKey, SettingsSection>();

  return {
    register(section) {
      if (!SETTINGS_SECTION_KEYS.includes(section.key)) {
        throw new Error(`The settings section "${section.key}" is not declared in the contracts.`);
      }
      if (registered.has(section.key)) {
        throw new Error(`The settings section "${section.key}" is registered twice.`);
      }
      if (!section.schema.safeParse(section.defaults).success) {
        throw new Error(
          `The settings section "${section.key}" has defaults that its own schema rejects.`,
        );
      }
      registered.set(section.key, section);
    },
    sections: () => [...registered.values()],
    get: (key) => registered.get(key),
  };
}
