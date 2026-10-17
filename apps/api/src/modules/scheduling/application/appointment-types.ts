import type {
  AppointmentTypeDto,
  CreateAppointmentTypeRequest,
  UpdateAppointmentTypeRequest,
} from '@consultorio/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { professional } from '../../../db/schema/staff.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

export interface AppointmentTypeService {
  list(tx: Tx, options: { includeInactive: boolean }): Promise<AppointmentTypeDto[]>;
  get(tx: Tx, id: string): Promise<AppointmentTypeDto>;
  create(
    tx: Tx,
    input: { actor: AuditActor; request: CreateAppointmentTypeRequest },
  ): Promise<AppointmentTypeDto>;
  update(
    tx: Tx,
    input: { actor: AuditActor; id: string; request: UpdateAppointmentTypeRequest },
  ): Promise<AppointmentTypeDto>;
  setActive(
    tx: Tx,
    input: { actor: AuditActor; id: string; active: boolean },
  ): Promise<AppointmentTypeDto>;
}

const columns = {
  id: appointmentType.id,
  name: appointmentType.name,
  description: appointmentType.description,
  durationMinutes: appointmentType.durationMinutes,
  bufferMinutes: appointmentType.bufferMinutes,
  mode: appointmentType.mode,
  priceReference: appointmentType.priceReference,
  requiresApproval: appointmentType.requiresApproval,
  color: appointmentType.color,
  professionalIds: appointmentType.professionalIds,
  specialties: appointmentType.specialties,
  active: appointmentType.active,
};

function toDto(row: {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  bufferMinutes: number;
  mode: string;
  priceReference: string | null;
  requiresApproval: boolean;
  color: string | null;
  professionalIds: string[];
  specialties: string[];
  active: boolean;
}): AppointmentTypeDto {
  return { ...row, mode: row.mode === 'virtual' ? 'virtual' : 'in_person' };
}

/** A professional of another organization does not exist as far as this one can tell. */
async function requireProfessionals(tx: Tx, ids: readonly string[]): Promise<void> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return;
  const found = await tx
    .select({ id: professional.id })
    .from(professional)
    .where(inArray(professional.id, wanted));
  if (found.length !== wanted.length) throw new AppError('not_found');
}

async function load(tx: Tx, id: string) {
  const [row] = await tx.select(columns).from(appointmentType).where(eq(appointmentType.id, id));
  if (!row) throw new AppError('not_found');
  return row;
}

export function createAppointmentTypeService(): AppointmentTypeService {
  return {
    async list(tx, options) {
      const rows = await tx
        .select(columns)
        .from(appointmentType)
        .where(options.includeInactive ? undefined : eq(appointmentType.active, true))
        .orderBy(asc(appointmentType.name), asc(appointmentType.id));
      return rows.map(toDto);
    },

    async get(tx, id) {
      return toDto(await load(tx, id));
    },

    async create(tx, input) {
      await requireProfessionals(tx, input.request.professionalIds);
      const [row] = await tx
        .insert(appointmentType)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          name: input.request.name,
          description: input.request.description ?? null,
          durationMinutes: input.request.durationMinutes,
          bufferMinutes: input.request.bufferMinutes,
          mode: input.request.mode,
          priceReference: input.request.priceReference ?? null,
          requiresApproval: input.request.requiresApproval,
          color: input.request.color ?? null,
          professionalIds: input.request.professionalIds,
          specialties: input.request.specialties,
        })
        .returning(columns);
      if (!row) throw new Error('appointment type insert returned no row');
      await audit(tx, {
        action: 'appointment_type.created',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'appointment_type',
        resourceId: row.id,
      });
      return toDto(row);
    },

    async update(tx, input) {
      const current = await load(tx, input.id);
      if (input.request.professionalIds) {
        await requireProfessionals(tx, input.request.professionalIds);
      }
      const changes: Partial<typeof appointmentType.$inferInsert> = {};
      for (const key of Object.keys(input.request) as (keyof UpdateAppointmentTypeRequest)[]) {
        const next = input.request[key];
        if (next === undefined) continue;
        if (JSON.stringify(next) !== JSON.stringify(current[key])) {
          Object.assign(changes, { [key]: next });
        }
      }
      const fields = Object.keys(changes).sort();
      if (fields.length === 0) return toDto(current);

      const [row] = await tx
        .update(appointmentType)
        .set(changes)
        .where(eq(appointmentType.id, current.id))
        .returning(columns);
      if (!row) throw new AppError('not_found');
      await audit(tx, {
        action: 'appointment_type.updated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'appointment_type',
        resourceId: row.id,
        // Field names only: the trail says what changed, not the values.
        metadata: { fields },
      });
      return toDto(row);
    },

    async setActive(tx, input) {
      const current = await load(tx, input.id);
      if (current.active === input.active) return toDto(current);
      const [row] = await tx
        .update(appointmentType)
        .set({ active: input.active })
        .where(and(eq(appointmentType.id, current.id)))
        .returning(columns);
      if (!row) throw new AppError('not_found');
      await audit(tx, {
        action: input.active ? 'appointment_type.reactivated' : 'appointment_type.deactivated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'appointment_type',
        resourceId: row.id,
      });
      return toDto(row);
    },
  };
}
