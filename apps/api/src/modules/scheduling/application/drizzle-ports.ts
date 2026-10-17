import type { AppointmentDto } from '@consultorio/contracts';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';

import { patient } from '../../../db/schema/patients.js';
import {
  appointmentType,
  professionalHoursException,
  scheduleBlock,
} from '../../../db/schema/scheduling-config.js';
import { appointment, appointmentEvent, slotHold } from '../../../db/schema/scheduling.js';
import { professional, professionalHours } from '../../../db/schema/staff.js';
import { location, tenant } from '../../../db/schema/tenant.js';
import { audit } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { isSoloPractice } from '../domain/identity-confirmation.js';
import type { HoursPeriod, HoursRow } from '../domain/working-hours.js';

import { createHolidayService } from './holidays.js';
import type { ActiveOccupancy, AppointmentRecord, HoldRecord, SchedulingPorts } from './ports.js';
import { createWorklistService } from './worklist.js';

const EXCLUSION_VIOLATION = '23P01';

/** A patient registered this recently by the person booking counts as created in the same action. */
const FRESH_PATIENT_MS = 15 * 60_000;

/** The SQLSTATE of a database failure, whichever layer wrapped it. */
export function sqlStateOf(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  const direct = (error as { code?: unknown } | null)?.code;
  return typeof direct === 'string' ? direct : undefined;
}

export function isExclusionViolation(error: unknown): boolean {
  return sqlStateOf(error) === EXCLUSION_VIOLATION;
}

export const appointmentColumns = {
  id: appointment.id,
  patientId: appointment.patientId,
  professionalId: appointment.professionalId,
  locationId: appointment.locationId,
  appointmentTypeId: appointment.appointmentTypeId,
  startsAt: appointment.startsAt,
  endsAt: appointment.endsAt,
  bufferMinutes: appointment.bufferMinutes,
  status: appointment.status,
  source: appointment.source,
  bookedBy: appointment.bookedBy,
  identityConfirmed: appointment.identityConfirmed,
  identityConfirmation: appointment.identityConfirmation,
  outOfHours: appointment.outOfHours,
  seriesId: appointment.seriesId,
  seriesIndex: appointment.seriesIndex,
  version: appointment.version,
};

export function toAppointmentDto(row: {
  id: string;
  patientId: string;
  professionalId: string;
  locationId: string;
  appointmentTypeId: string;
  startsAt: Date;
  endsAt: Date;
  bufferMinutes: number;
  status: string;
  source: string;
  bookedBy: string | null;
  identityConfirmed: boolean;
  identityConfirmation: string | null;
  outOfHours: boolean;
  seriesId: string | null;
  seriesIndex: number | null;
  version: number;
}): AppointmentDto {
  return {
    ...row,
    identityConfirmation:
      row.identityConfirmation === 'staff' || row.identityConfirmation === 'self_confirmed'
        ? row.identityConfirmation
        : null,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status as AppointmentDto['status'],
    source: row.source as AppointmentDto['source'],
  };
}

function toHoldRecord(row: typeof slotHold.$inferSelect): HoldRecord {
  return {
    id: row.id,
    professionalId: row.professionalId,
    locationId: row.locationId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    bufferMinutes: row.bufferMinutes,
    lane: row.lane,
    status: row.status as HoldRecord['status'],
    expiresAt: row.expiresAt,
    origin: row.origin === 'public' ? 'public' : 'staff',
    sourceKey: row.sourceKey,
    appointmentId: row.appointmentId,
  };
}

interface OccupancyRow extends Record<string, unknown> {
  appointment_id: string | null;
  slot_hold_id: string | null;
  location_id: string;
  lane: number;
  start_ms: string;
  end_ms: string;
  hold_origin: string | null;
}

/** The Drizzle implementation of the scheduling port, inside one tenant transaction. */
export function createSchedulingPorts(tx: Tx, deps: { keys: TenantKeys }): SchedulingPorts {
  const holidays = createHolidayService();
  const worklist = createWorklistService({ keys: deps.keys });

  return {
    async lockProfessional(id) {
      const [row] = await tx
        .select({
          id: professional.id,
          membershipId: professional.membershipId,
          status: professional.status,
          maxSimultaneous: professional.maxSimultaneous,
          specialties: professional.specialties,
        })
        .from(professional)
        .where(eq(professional.id, id))
        .for('update');
      return row ? { ...row, status: row.status === 'active' ? 'active' : 'inactive' } : null;
    },

    async findLocation(id) {
      const [row] = await tx
        .select({ id: location.id, timeZone: location.timeZone, active: location.active })
        .from(location)
        .where(eq(location.id, id));
      return row ?? null;
    },

    async findType(id) {
      const [row] = await tx
        .select({
          id: appointmentType.id,
          durationMinutes: appointmentType.durationMinutes,
          bufferMinutes: appointmentType.bufferMinutes,
          active: appointmentType.active,
          requiresApproval: appointmentType.requiresApproval,
          professionalIds: appointmentType.professionalIds,
          specialties: appointmentType.specialties,
        })
        .from(appointmentType)
        .where(eq(appointmentType.id, id));
      return row ?? null;
    },

    async findPatient(id) {
      const [row] = await tx
        .select({ id: patient.id, status: patient.status })
        .from(patient)
        .where(eq(patient.id, id));
      return row ? { id: row.id, status: row.status === 'active' ? 'active' : 'inactive' } : null;
    },

    async expireHolds(professionalId, now) {
      await tx
        .update(slotHold)
        .set({ status: 'expired' })
        .where(
          and(
            eq(slotHold.professionalId, professionalId),
            eq(slotHold.status, 'active'),
            lte(slotHold.expiresAt, now),
          ),
        );
    },

    async hours(professionalId, _locationId, fromDate, toDate) {
      const weekly: HoursRow[] = await tx
        .select({
          locationId: professionalHours.locationId,
          weekday: professionalHours.weekday,
          startMinute: professionalHours.startMinute,
          endMinute: professionalHours.endMinute,
        })
        .from(professionalHours)
        .where(
          and(
            eq(professionalHours.professionalId, professionalId),
            isNull(professionalHours.removedAt),
          ),
        );
      const exceptions = await tx
        .select()
        .from(professionalHoursException)
        .where(
          and(
            eq(professionalHoursException.professionalId, professionalId),
            isNull(professionalHoursException.removedAt),
            lte(professionalHoursException.dateFrom, toDate),
            gte(professionalHoursException.dateTo, fromDate),
          ),
        )
        .orderBy(asc(professionalHoursException.dateFrom), asc(professionalHoursException.id));
      const periods = new Map<string, HoursPeriod & { rows: HoursRow[] }>();
      for (const row of exceptions) {
        let period = periods.get(row.periodId);
        if (!period) {
          period = { dateFrom: row.dateFrom, dateTo: row.dateTo, rows: [] };
          periods.set(row.periodId, period);
        }
        if (
          row.locationId !== null &&
          row.weekday !== null &&
          row.startMinute !== null &&
          row.endMinute !== null
        ) {
          period.rows.push({
            locationId: row.locationId,
            weekday: row.weekday,
            startMinute: row.startMinute,
            endMinute: row.endMinute,
          });
        }
      }
      return { weekly, periods: [...periods.values()] };
    },

    async blocks(professionalId, locationId, range) {
      const rows = await tx
        .select({ startsAt: scheduleBlock.startsAt, endsAt: scheduleBlock.endsAt })
        .from(scheduleBlock)
        .where(
          and(
            isNull(scheduleBlock.removedAt),
            lt(scheduleBlock.startsAt, new Date(range.end)),
            gt(scheduleBlock.endsAt, new Date(range.start)),
            or(
              // The professional's own block, everywhere or at this location.
              and(
                eq(scheduleBlock.professionalId, professionalId),
                or(isNull(scheduleBlock.locationId), eq(scheduleBlock.locationId, locationId)),
              ),
              // A block of the whole location.
              and(isNull(scheduleBlock.professionalId), eq(scheduleBlock.locationId, locationId)),
            ),
          ),
        );
      return rows.map((row) => ({ start: row.startsAt.getTime(), end: row.endsAt.getTime() }));
    },

    holidays: (fromDate, toDate) => holidays.holidaysBetween(tx, fromDate, toDate),

    async occupancies(professionalId, range) {
      const result = await tx.execute<OccupancyRow>(sql`
        SELECT o.appointment_id, o.slot_hold_id, o.location_id, o.lane,
               (extract(epoch from lower(o.during)) * 1000)::bigint AS start_ms,
               (extract(epoch from upper(o.during)) * 1000)::bigint AS end_ms,
               h.origin AS hold_origin
          FROM slot_occupancy o
          LEFT JOIN slot_hold h ON h.tenant_id = o.tenant_id AND h.id = o.slot_hold_id
         WHERE o.professional_id = ${professionalId}
           AND o.active
           AND o.during && tstzrange(${new Date(range.start).toISOString()}::timestamptz, ${new Date(range.end).toISOString()}::timestamptz, '[)')
         ORDER BY lower(o.during), o.id`);
      return result.rows.map((row): ActiveOccupancy => ({
        id: row.appointment_id ?? row.slot_hold_id ?? '',
        kind: row.appointment_id ? 'appointment' : 'hold',
        locationId: row.location_id,
        lane: row.lane,
        start: Number(row.start_ms),
        end: Number(row.end_ms),
        ...(row.hold_origin === 'public' || row.hold_origin === 'staff'
          ? { holdOrigin: row.hold_origin }
          : {}),
      }));
    },

    async invalidateHolds(holdIds) {
      if (holdIds.length === 0) return;
      await tx
        .update(slotHold)
        .set({ status: 'invalidated' })
        .where(and(inArray(slotHold.id, [...holdIds]), eq(slotHold.status, 'active')));
    },

    async applyLaneMoves(moves) {
      if (moves.length === 0) return;
      // Rows trade lanes: the intermediate state may overlap, so the check waits for the end of
      // the moves and runs right there (IMMEDIATE), before anything else is written.
      await tx.execute(sql`SET CONSTRAINTS slot_occupancy_no_overlap DEFERRED`);
      for (const move of moves) {
        if (move.kind === 'appointment') {
          await tx.update(appointment).set({ lane: move.lane }).where(eq(appointment.id, move.id));
        } else {
          await tx.update(slotHold).set({ lane: move.lane }).where(eq(slotHold.id, move.id));
        }
      }
      await tx.execute(sql`SET CONSTRAINTS slot_occupancy_no_overlap IMMEDIATE`);
    },

    async insertAppointment(values) {
      try {
        // A savepoint, so a refused overlap does not abort the transaction: the caller still has to
        // read the free slots to answer with.
        const row = await tx.transaction(async (inner) => {
          const [created] = await inner
            .insert(appointment)
            .values({
              tenantId: sql`current_setting('app.tenant_id')::uuid`,
              ...values,
              seriesId: values.seriesId ?? null,
              seriesIndex: values.seriesIndex ?? null,
            })
            .returning(appointmentColumns);
          return created;
        });
        if (!row) throw new Error('appointment insert returned no row');
        return { ok: true as const, appointment: toAppointmentDto(row) };
      } catch (error) {
        if (isExclusionViolation(error))
          return { ok: false as const, reason: 'slot_taken' as const };
        throw error;
      }
    },

    async findAppointment(id, options) {
      const query = tx.select().from(appointment).where(eq(appointment.id, id));
      const [row] = await (options?.lock ? query.for('update') : query);
      if (!row) return null;
      return {
        ...row,
        status: row.status as AppointmentRecord['status'],
        source: row.source as AppointmentRecord['source'],
        identityConfirmation:
          row.identityConfirmation === 'staff' || row.identityConfirmation === 'self_confirmed'
            ? row.identityConfirmation
            : null,
      };
    },

    async updateAppointment(id, patch) {
      const [row] = await tx
        .update(appointment)
        .set({ ...patch, version: sql`${appointment.version} + 1` })
        .where(eq(appointment.id, id))
        .returning(appointmentColumns);
      if (!row) throw new Error('appointment update matched no row');
      return toAppointmentDto(row);
    },

    async lateCancellationHours() {
      const [row] = await tx.select({ settings: tenant.settings }).from(tenant);
      const value = row?.settings['late_cancellation_hours'];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 24;
    },

    async findHold(id, options) {
      const query = tx.select().from(slotHold).where(eq(slotHold.id, id));
      const [row] = await (options?.lock ? query.for('update') : query);
      return row ? toHoldRecord(row) : null;
    },

    async insertHold(values) {
      const [row] = await tx
        .insert(slotHold)
        .values({ tenantId: sql`current_setting('app.tenant_id')::uuid`, ...values })
        .returning();
      if (!row) throw new Error('hold insert returned no row');
      return toHoldRecord(row);
    },

    async updateHold(id, patch) {
      await tx.update(slotHold).set(patch).where(eq(slotHold.id, id));
    },

    async releaseOldestHolds(sourceKey, keep) {
      const mine = await tx
        .select({ id: slotHold.id })
        .from(slotHold)
        .where(and(eq(slotHold.sourceKey, sourceKey), eq(slotHold.status, 'active')))
        .orderBy(desc(slotHold.createdAt), desc(slotHold.id))
        .offset(keep);
      if (mine.length === 0) return;
      await tx
        .update(slotHold)
        .set({ status: 'released' })
        .where(
          inArray(
            slotHold.id,
            mine.map((row) => row.id),
          ),
        );
    },

    async soloPractice() {
      const result = await tx.execute<{ professionals: number; others: number }>(sql`
        SELECT
          (SELECT count(*)::int
             FROM professional p
             JOIN membership m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
            WHERE p.status = 'active' AND m.status = 'active') AS professionals,
          (SELECT count(*)::int
             FROM membership m
            WHERE m.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM professional p
                 WHERE p.tenant_id = m.tenant_id AND p.membership_id = m.id AND p.status = 'active'
              )) AS others`);
      const row = result.rows[0];
      return isSoloPractice({
        activeProfessionals: row?.professionals ?? 0,
        otherActiveMembers: row?.others ?? 0,
      });
    },

    async isFreshPatient(patientId, userId, now) {
      const since = new Date(now.getTime() - FRESH_PATIENT_MS).toISOString();
      const result = await tx.execute<{ fresh: boolean }>(sql`
        SELECT (
          EXISTS (
            SELECT 1 FROM patient_version v
             WHERE v.patient_id = ${patientId} AND v.version = 1 AND v.changed_by = ${userId}::uuid
               AND v.created_at >= ${since}::timestamptz
          )
          AND NOT EXISTS (SELECT 1 FROM appointment a WHERE a.patient_id = ${patientId})
        ) AS fresh`);
      return result.rows[0]?.fresh === true;
    },

    async openWorklistItem(item) {
      await worklist.openItem(tx, {
        kind: item.kind,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        locationId: item.locationId ?? undefined,
      });
    },

    async closeWorklistItem(item) {
      await worklist.closeBySubject(tx, item);
    },

    async insertEvent(event) {
      await tx.insert(appointmentEvent).values({
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        appointmentId: event.appointmentId,
        kind: event.kind,
        fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus ?? null,
        actorUserId: event.actorUserId,
        actorKind: event.actorKind,
        details: event.details ?? {},
      });
    },

    audit: (event) => audit(tx, event),
  };
}
