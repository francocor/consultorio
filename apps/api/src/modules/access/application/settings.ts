import type { SettingsDto, UpdateSettingsRequest } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
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

function entryFor(event: SettingsEvent): Pick<AuditEntry, 'action' | 'metadata'> {
  switch (event.kind) {
    case 'reception_metadata':
      return {
        action: 'setting.reception_sees_clinical_metadata.changed',
        metadata: { enabled: event.enabled },
      };
    case 'sharing':
      return {
        action: 'sharing.changed',
        metadata: {
          clinicalSharing: event.clinicalSharing,
          added: event.added,
          removed: event.removed,
          psychologyShared: event.added.includes('psychology'),
        },
      };
    case 'require_2fa':
      return {
        action: 'setting.changed',
        metadata: { setting: 'require_2fa', enabled: event.enabled },
      };
    case 'quiet_hours':
      return {
        action: 'setting.changed',
        metadata: { setting: 'quiet_hours', start: event.start, end: event.end },
      };
  }
}

export function createSettingsService(): SettingsService {
  return {
    async get(tx) {
      return readSettings((await currentTenantRow(tx)).settings);
    },

    async update(tx, input) {
      const row = await currentTenantRow(tx);
      const plan = planSettingsUpdate(readSettings(row.settings), input.patch);
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
          await audit(tx, {
            ...entryFor(event),
            outcome: 'allow',
            actor: input.actor,
            resourceType: 'tenant',
            resourceId: row.id,
          });
        }
      }
      return readSettings((await currentTenantRow(tx)).settings);
    },
  };
}
