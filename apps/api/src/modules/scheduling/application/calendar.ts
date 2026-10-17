import type { CalendarEntryDto, CalendarQuery, CalendarResponse } from '@consultorio/contracts';
import { and, asc, eq, gt, inArray, lt, or, type SQL } from 'drizzle-orm';

import { patient } from '../../../db/schema/patients.js';
import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import { calendarAccess } from '../../../platform/authz/calendar-scope.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';

import type { BlockService } from './blocks.js';
import { auditDelegatedView, isAdministrative } from './delegated-view.js';
import { toAppointmentDto } from './drizzle-ports.js';
import type { HolidayService } from './holidays.js';
import { locationAccessOf } from './location-access.js';

/** The most appointments one answer carries; a month of a busy center is far below it. */
const DEFAULT_MAX_ENTRIES = 2000;
const DAY_MS = 86_400_000;

export interface CalendarDeps {
  blocks: BlockService;
  holidays: HolidayService;
  /** The cap of one answer; the feed says `truncated` when the window holds more. */
  maxEntries?: number;
}

export interface CalendarInput {
  query: CalendarQuery;
  actor: Actor;
  auditActor: AuditActor & { userId: string };
}

/** Whose appointments a viewer asks for when they name nobody: everyone, or their own calendars. */
function defaultProfessionals(actor: Actor): string[] | 'everyone' {
  if (isAdministrative(actor)) return 'everyone';
  return [
    ...(actor.professionalId ? [actor.professionalId] : []),
    ...(actor.delegatedProfessionalIds ?? []),
  ];
}

async function selectEntries(
  tx: Tx,
  where: SQL | undefined,
  limit: number,
): Promise<CalendarEntryDto[]> {
  const rows = await tx
    .select({
      appointment: {
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
      },
      familyName: patient.familyName,
      givenNames: patient.givenNames,
      typeName: appointmentType.name,
      typeColor: appointmentType.color,
    })
    .from(appointment)
    .innerJoin(
      patient,
      and(eq(patient.tenantId, appointment.tenantId), eq(patient.id, appointment.patientId)),
    )
    .innerJoin(
      appointmentType,
      and(
        eq(appointmentType.tenantId, appointment.tenantId),
        eq(appointmentType.id, appointment.appointmentTypeId),
      ),
    )
    .where(where)
    .orderBy(asc(appointment.startsAt), asc(appointment.id))
    .limit(limit);
  return rows.map((row) => ({
    ...toAppointmentDto(row.appointment),
    patientName: `${row.familyName}, ${row.givenNames}`,
    typeName: row.typeName,
    typeColor: row.typeColor,
  }));
}

/**
 * The SQL condition on the location of an appointment for a viewer who does not see every location:
 * the assigned ones, plus their own professional calendar when they have one. `'none'` means
 * nothing can match; `'any'` means no condition.
 */
function locationFilter(input: {
  assigned: readonly string[] | null;
  own: string | null;
  requested: string | undefined;
}): SQL | 'any' | 'none' {
  const { assigned, own, requested } = input;
  if (assigned === null) return requested ? eq(appointment.locationId, requested) : 'any';
  const ownCalendar = own === null ? undefined : eq(appointment.professionalId, own);
  if (requested !== undefined) {
    if (assigned.includes(requested)) return eq(appointment.locationId, requested);
    // Not assigned there: only their own calendar is theirs at that location.
    return ownCalendar
      ? (and(ownCalendar, eq(appointment.locationId, requested)) ?? 'none')
      : 'none';
  }
  const parts = [
    ...(assigned.length > 0 ? [inArray(appointment.locationId, [...assigned])] : []),
    ...(ownCalendar ? [ownCalendar] : []),
  ];
  return or(...parts) ?? 'none';
}

/**
 * The calendar feed (scheduling, "Calendar views"): the appointments of the professionals and
 * locations the viewer may see in a window, as administrative data only (patient name, type,
 * status, time). Reception sees the locations it works at; a professional sees their own calendar
 * and the ones delegated to them. Holds are not appointments and never appear. When a professional
 * looks at another professional's calendar the view is audited.
 */
export function createCalendar(deps: CalendarDeps) {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  return {
    /** One appointment as the calendar shows it, if the viewer may work in its calendar and location. */
    async get(
      tx: Tx,
      input: {
        id: string;
        actor: Actor;
        /** Who is looking, so a look at a colleague's calendar is audited. */
        auditActor: AuditActor & { userId: string };
        /** Whether the look is at the appointment itself or at its history. */
        view: 'appointment' | 'history';
      },
    ): Promise<CalendarEntryDto> {
      const [entry] = await selectEntries(tx, eq(appointment.id, input.id), 1);
      if (!entry) throw new AppError('not_found');
      if (!calendarAccess(input.actor, entry.professionalId)) {
        throw new AccessRefused('not_own_calendar');
      }
      const access = await locationAccessOf(tx, input.actor);
      if (!access.may({ locationId: entry.locationId, professionalId: entry.professionalId })) {
        throw new AccessRefused('location_not_assigned');
      }
      await auditDelegatedView(tx, {
        actor: input.actor,
        auditActor: input.auditActor,
        professionalId: entry.professionalId,
        view: input.view,
        appointmentId: entry.id,
      });
      return entry;
    },

    async feed(tx: Tx, input: CalendarInput): Promise<CalendarResponse> {
      const { query, actor } = input;
      const requested = query.professionalIds;

      // A professional works in their calendar and the ones delegated to them, and no others.
      if (requested?.some((id) => !calendarAccess(actor, id))) {
        throw new AccessRefused('not_own_calendar');
      }
      const professionals = requested ?? defaultProfessionals(actor);

      // Reception reads the locations it works at, and a professional who is also reception reads
      // their own calendar everywhere; asking for another location is a denial.
      const access = await locationAccessOf(tx, actor);
      const own = access.scope.kind === 'assigned' ? access.scope.ownProfessionalId : null;
      const assigned = access.scope.kind === 'all' ? null : access.assigned;
      if (query.locationId && assigned && !assigned.includes(query.locationId) && own === null) {
        throw new AccessRefused('location_not_assigned');
      }
      const locationWhere = locationFilter({
        assigned,
        own,
        requested: query.locationId,
      });

      const from = new Date(query.from);
      const to = new Date(query.to);
      const empty =
        (professionals !== 'everyone' && professionals.length === 0) || locationWhere === 'none';
      // One more than the cap is read, only to know whether something is missing.
      const found = empty
        ? []
        : await selectEntries(
            tx,
            and(
              lt(appointment.startsAt, to),
              gt(appointment.endsAt, from),
              ...(professionals === 'everyone'
                ? []
                : [inArray(appointment.professionalId, professionals)]),
              ...(locationWhere === 'any' ? [] : [locationWhere]),
            ),
            maxEntries + 1,
          );
      const truncated = found.length > maxEntries;
      const appointments = truncated ? found.slice(0, maxEntries) : found;

      const blocks = (await deps.blocks.list(tx, { from: query.from, to: query.to })).filter(
        (block) =>
          (professionals === 'everyone' ||
            block.professionalId === null ||
            professionals.includes(block.professionalId)) &&
          (assigned === null ||
            block.locationId === null ||
            (query.locationId === undefined
              ? assigned.includes(block.locationId)
              : block.locationId === query.locationId && assigned.includes(block.locationId)) ||
            (own !== null && block.professionalId === own)),
      );
      const holidays = await deps.holidays.holidaysBetween(
        tx,
        new Date(from.getTime() - DAY_MS).toISOString().slice(0, 10),
        new Date(to.getTime() + DAY_MS).toISOString().slice(0, 10),
      );

      // A professional looking at a colleague's calendar (delegated to them) is audited; reception,
      // admin and owner work in every calendar of their locations as part of their job.
      const viewsOthers =
        !isAdministrative(actor) &&
        actor.professionalId !== null &&
        professionals !== 'everyone' &&
        professionals.some((id) => id !== actor.professionalId);
      if (viewsOthers) {
        await audit(tx, {
          action: 'appointment.calendar_viewed',
          outcome: 'allow',
          actor: input.auditActor,
          resourceType: 'calendar',
          metadata: {
            professionals: professionals.length,
            from: query.from,
            to: query.to,
          },
        });
      }
      return { appointments, blocks, holidays, truncated };
    },
  };
}
