import type { SettingsDto, UpdateSettingsRequest } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { SettingsSectionRegistry } from '../../../platform/settings-sections.js';
import {
  planSettingsUpdate,
  readSettings,
  type SettingsEvent,
  type StoredSettings,
} from '../domain/settings.js';

export interface SettingsService {
  get(tx: Tx): Promise<SettingsDto>;
  update(tx: Tx, input: { actor: AuditActor; patch: UpdateSettingsRequest }): Promise<SettingsDto>;
}

async function currentTenantRow(tx: Tx): Promise<{ id: string; settings: StoredSettings }> {
  const [row] = await tx.select({ id: tenant.id, settings: tenant.settings }).from(tenant);
  if (!row) throw new AppError('not_found');
  return row;
}

type AuditEntry = Parameters<typeof audit>[1];

type Entry = Pick<AuditEntry, 'action' | 'metadata'>;

function entriesFor(event: SettingsEvent): Entry[] {
  switch (event.kind) {
    case 'reception_metadata':
      return [
        {
          action: 'setting.reception_sees_clinical_metadata.changed',
          metadata: { enabled: event.enabled },
        },
      ];
    case 'sharing':
      return [
        {
          action: 'sharing.changed',
          metadata: {
            clinicalSharing: event.clinicalSharing,
            added: event.added,
            removed: event.removed,
            psychologyShared: event.added.includes('psychology'),
          },
        },
      ];
    case 'require_2fa':
      return [
        { action: 'setting.changed', metadata: { setting: 'require_2fa', enabled: event.enabled } },
      ];
    case 'quiet_hours':
      return [
        {
          action: 'setting.changed',
          metadata: { setting: 'quiet_hours', start: event.start, end: event.end },
        },
      ];
    case 'section':
      // The generic entry names the fields, never their values; a field with an action of its own
      // (the WhatsApp switch) adds that entry too.
      return [
        {
          action: 'setting.changed',
          metadata: { setting: event.section, changedFields: event.changedFields },
        },
        ...event.fieldAudits.map((field): Entry => ({
          action: field.action,
          metadata: {
            setting: event.section,
            field: field.field,
            ...(field.enabled === undefined ? {} : { enabled: field.enabled }),
          },
        })),
      ];
  }
}

export interface SettingsServiceOptions {
  /** The sections the modules registered (main/wiring). */
  sections: SettingsSectionRegistry;
}

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const sections = () => options.sections.sections();
  return {
    async get(tx) {
      return readSettings((await currentTenantRow(tx)).settings, sections());
    },

    async update(tx, input) {
      const row = await currentTenantRow(tx);
      const plan = planSettingsUpdate(
        readSettings(row.settings, sections()),
        input.patch,
        sections(),
      );
      if (!plan.ok) {
        throw new AppError('validation_failed', [{ path: plan.path, i18nKey: plan.i18nKey }]);
      }

      if (plan.events.length > 0) {
        // A merge, so keys this code does not know about (other modules' settings) survive.
        await tx
          .update(tenant)
          .set({ settings: sql`${tenant.settings} || ${JSON.stringify(plan.stored)}::jsonb` })
          .where(eq(tenant.id, row.id));
        for (const event of plan.events) {
          for (const entry of entriesFor(event)) {
            await audit(tx, {
              ...entry,
              outcome: 'allow',
              actor: input.actor,
              resourceType: 'tenant',
              resourceId: row.id,
            });
          }
        }
      }
      return readSettings((await currentTenantRow(tx)).settings, sections());
    },
  };
}
