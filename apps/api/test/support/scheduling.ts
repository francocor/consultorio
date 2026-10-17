import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { appointmentType } from '../../src/db/schema/scheduling-config.js';
import { appointment, slotHold } from '../../src/db/schema/scheduling.js';
import { location } from '../../src/db/schema/tenant.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';

import { asTenant } from './tenants.js';
import { createTestProfessional } from './users.js';

export interface SchedulingWorld {
  tenantId: string;
  locationId: string;
  otherLocationId: string;
  professionalId: string;
  typeId: string;
  patientId: string;
}

let counter = 0;

/** Inserts a patient directly (the schema tests do not go through the API). */
export async function insertPatient(tx: Tx, tenantId: string): Promise<string> {
  counter += 1;
  const result = await tx.execute<{ id: string }>(
    sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date)
          VALUES (${tenantId}, ${`Paciente${String(counter)}`}, 'Nombre', '1990-01-01')
          RETURNING id`,
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('patient insert returned no id');
  return id;
}

/**
 * Everything an appointment needs, created straight in the database: two locations, a
 * professional, a 30 minute type and a patient. Callers add what the test is about.
 */
export async function createSchedulingWorld(
  runtime: DbHandle,
  tenantId: string,
  options: { maxSimultaneous?: number; bufferMinutes?: number } = {},
): Promise<SchedulingWorld> {
  const doctor = await createTestProfessional(runtime, tenantId);
  return asTenant(runtime, tenantId, async (tx) => {
    const places = await tx
      .insert(location)
      .values([
        { tenantId, name: 'Norte', timeZone: 'America/Argentina/Buenos_Aires' },
        { tenantId, name: 'Sur', timeZone: 'America/Argentina/Buenos_Aires' },
      ])
      .returning({ id: location.id });
    const [type] = await tx
      .insert(appointmentType)
      .values({
        tenantId,
        name: 'Consulta',
        durationMinutes: 30,
        bufferMinutes: options.bufferMinutes ?? 0,
      })
      .returning({ id: appointmentType.id });
    if (options.maxSimultaneous && options.maxSimultaneous > 1) {
      await tx.execute(
        sql`UPDATE professional SET max_simultaneous = ${options.maxSimultaneous} WHERE id = ${doctor.professionalId}`,
      );
    }
    return {
      tenantId,
      locationId: places[0]?.id ?? '',
      otherLocationId: places[1]?.id ?? '',
      professionalId: doctor.professionalId,
      typeId: type?.id ?? '',
      patientId: await insertPatient(tx, tenantId),
    };
  });
}

/** `10:00` of a fixed day, as an instant, plus minutes. Keeps the tests readable. */
export function at(minutesAfterTen: number, day = '2031-05-12'): Date {
  return new Date(Date.parse(`${day}T10:00:00.000Z`) + minutesAfterTen * 60_000);
}

export interface AppointmentSpec {
  professionalId?: string;
  locationId?: string;
  patientId?: string;
  start: Date;
  minutes?: number;
  bufferMinutes?: number;
  lane?: number;
  status?: string;
  identityConfirmed?: boolean;
}

/** Inserts an appointment row (the occupancy trigger mirrors it). */
export async function insertAppointment(tx: Tx, world: SchedulingWorld, spec: AppointmentSpec) {
  const minutes = spec.minutes ?? 30;
  const [row] = await tx
    .insert(appointment)
    .values({
      tenantId: world.tenantId,
      patientId: spec.patientId ?? world.patientId,
      professionalId: spec.professionalId ?? world.professionalId,
      locationId: spec.locationId ?? world.locationId,
      appointmentTypeId: world.typeId,
      startsAt: spec.start,
      endsAt: new Date(spec.start.getTime() + minutes * 60_000),
      bufferMinutes: spec.bufferMinutes ?? 0,
      lane: spec.lane ?? 1,
      status: spec.status ?? 'scheduled',
      identityConfirmed: spec.identityConfirmed ?? true,
      bookedBy: randomUUID(),
    })
    .returning();
  if (!row) throw new Error('appointment insert returned no row');
  return row;
}

export interface HoldSpec {
  professionalId?: string;
  locationId?: string;
  start: Date;
  minutes?: number;
  lane?: number;
  status?: string;
  sourceKey?: string;
  expiresAt?: Date;
}

export async function insertHold(tx: Tx, world: SchedulingWorld, spec: HoldSpec) {
  const minutes = spec.minutes ?? 30;
  const [row] = await tx
    .insert(slotHold)
    .values({
      tenantId: world.tenantId,
      professionalId: spec.professionalId ?? world.professionalId,
      locationId: spec.locationId ?? world.locationId,
      startsAt: spec.start,
      endsAt: new Date(spec.start.getTime() + minutes * 60_000),
      lane: spec.lane ?? 1,
      status: spec.status ?? 'active',
      expiresAt: spec.expiresAt ?? new Date(Date.now() + 10 * 60_000),
      sourceKey: spec.sourceKey ?? randomUUID(),
    })
    .returning();
  if (!row) throw new Error('hold insert returned no row');
  return row;
}

/** The occupancy rows of a professional, oldest first, as plain facts. */
export async function occupancyOf(tx: Tx, professionalId: string) {
  const result = await tx.execute<{
    lane: number;
    active: boolean;
    during: string;
    appointment_id: string | null;
    slot_hold_id: string | null;
  }>(
    sql`SELECT lane, active, during::text AS during, appointment_id, slot_hold_id
          FROM slot_occupancy WHERE professional_id = ${professionalId} ORDER BY created_at, id`,
  );
  return result.rows;
}
