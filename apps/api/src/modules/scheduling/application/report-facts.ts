import type { AppointmentSource, AppointmentStatus, ReportGroup } from '@consultorio/contracts';
import { sql, type SQL } from 'drizzle-orm';

import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { isClosedDay } from '../domain/holidays.js';
import { dayBounds, localParts, weekdayOfDate } from '../domain/time.js';
import {
  subtractRanges,
  workingWindows,
  type HoursPeriod,
  type HoursRow,
} from '../domain/working-hours.js';

import { createSchedulingPorts } from './drizzle-ports.js';
import { datesBetween } from './schedule-facts.js';

/**
 * What scheduling tells the reports module (reports, "Consistency with source records"): counts of
 * appointments by status, source, patient and day, derived figures from the history, and the hours
 * a professional works. The reports module asks through here and never reads these tables itself.
 *
 * Every function takes the same `ReportCohort`: a range of calendar days read in the time zone of
 * each location, a scope (who may be seen) and the narrowing filters. One cohort, one definition of
 * "the appointments of the period", so a total and the records behind it cannot disagree.
 *
 * Administrative data only: counts, durations, names of places and of the people who work there,
 * and, in `appointmentRecords`, the name of the patient. Never a note, a diagnosis or a document.
 */

/** Which appointments the viewer may see: all of them, or the ones at some locations or of some professionals. */
export type ReportAppointmentScope =
  | { kind: 'all' }
  | {
      kind: 'limited';
      locationIds: readonly string[];
      professionalIds: readonly string[];
    };

export interface ReportCohort {
  /** First calendar day, `YYYY-MM-DD`, at the location of each appointment. */
  fromDate: string;
  /** Last calendar day, both ends included. */
  toDate: string;
  scope: ReportAppointmentScope;
  locationId?: string | undefined;
  professionalId?: string | undefined;
  specialty?: string | undefined;
}

export interface AttendanceFigures {
  total: number;
  attended: number;
  noShow: number;
  cancelled: number;
}

export interface OperationalFacts {
  /** Every one of the eight statuses, zero when there is none. */
  byStatus: Record<AppointmentStatus, number>;
  sources: { staff: number; online: number; waitlistOffer: number };
  /** Minutes of the appointments that were not cancelled. */
  bookedMinutes: number;
  /** Appointments still open (not attended, no-show or cancelled) whose time is over. */
  notFinalPast: number;
  /** Appointments that were moved at least once, from `appointment_event`. */
  rescheduled: number;
  /** Appointments with a confirmation made by the patient, from `appointment_event`. */
  confirmedByPatient: number;
  /** Appointments of the period among the ones given as recovered through the waitlist. */
  recovered: number;
  patients: { new: number; returning: number };
  byDay: (AttendanceFigures & { date: string })[];
  byLocation: (AttendanceFigures & { locationId: string; name: string })[];
  byProfessional: (AttendanceFigures & { professionalId: string; name: string | null })[];
  bySpecialty: (AttendanceFigures & { specialty: string })[];
}

const STATUSES: readonly AppointmentStatus[] = [
  'pending_approval',
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
  'attended',
  'no_show',
  'cancelled',
];

/** Statuses that are not a final answer to "did the patient come?". */
const OPEN_STATUSES = ['pending_approval', 'scheduled', 'confirmed', 'checked_in', 'in_progress'];

const DAY_MS = 86_400_000;

const idList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const inList = (column: SQL, ids: readonly string[]): SQL =>
  ids.length === 0 ? sql`false` : sql`${column} IN (${idList(ids)})`;

const OPEN_LIST = sql.join(
  OPEN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

const FROM_LOCATED = sql`
  FROM appointment a
  JOIN location l ON l.tenant_id = a.tenant_id AND l.id = a.location_id`;

const FROM_APPOINTMENTS = sql`${FROM_LOCATED}
  JOIN professional p ON p.tenant_id = a.tenant_id AND p.id = a.professional_id`;

/**
 * The appointments of a cohort. The professional is joined only when the cohort filters by
 * specialty (the specialties are theirs): joining it for every appointment of a year would cost a
 * lookup each, to read what twenty professionals could be asked once, after the counting.
 */
const fromCohort = (cohort: ReportCohort): SQL =>
  cohort.specialty === undefined ? FROM_LOCATED : FROM_APPOINTMENTS;

// These two read small partial indexes (migration 0430): the moves, and the confirmations by a patient.
const WAS_RESCHEDULED = sql`EXISTS (
  SELECT 1 FROM appointment_event e
   WHERE e.tenant_id = a.tenant_id AND e.appointment_id = a.id AND e.kind = 'rescheduled')`;

const WAS_CONFIRMED_BY_PATIENT = sql`EXISTS (
  SELECT 1 FROM appointment_event e
   WHERE e.tenant_id = a.tenant_id AND e.appointment_id = a.id
     AND e.kind = 'status_changed' AND e.to_status = 'confirmed' AND e.actor_kind = 'patient')`;

/**
 * The condition that makes a cohort. The first two comparisons are a coarse window in UTC (a zone
 * is at most 14 hours from it) that the index on `(tenant_id, starts_at)` can use; the next two are
 * the exact days at the zone of each appointment's location.
 */
function cohortCondition(cohort: ReportCohort): SQL {
  const coarseFrom = new Date(Date.parse(`${cohort.fromDate}T00:00:00Z`) - DAY_MS).toISOString();
  const coarseTo = new Date(Date.parse(`${cohort.toDate}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  const parts: SQL[] = [
    sql`a.starts_at >= ${coarseFrom}::timestamptz`,
    sql`a.starts_at < ${coarseTo}::timestamptz`,
    sql`a.starts_at >= ((${cohort.fromDate}::date)::timestamp AT TIME ZONE l.time_zone)`,
    sql`a.starts_at < ((${cohort.toDate}::date + 1)::timestamp AT TIME ZONE l.time_zone)`,
  ];
  if (cohort.scope.kind === 'limited') {
    const either = [
      ...(cohort.scope.locationIds.length > 0
        ? [inList(sql`a.location_id`, cohort.scope.locationIds)]
        : []),
      ...(cohort.scope.professionalIds.length > 0
        ? [inList(sql`a.professional_id`, cohort.scope.professionalIds)]
        : []),
    ];
    parts.push(either.length > 0 ? sql`(${sql.join(either, sql` OR `)})` : sql`false`);
  }
  if (cohort.locationId !== undefined) parts.push(sql`a.location_id = ${cohort.locationId}::uuid`);
  if (cohort.professionalId !== undefined) {
    parts.push(sql`a.professional_id = ${cohort.professionalId}::uuid`);
  }
  if (cohort.specialty !== undefined) parts.push(sql`${cohort.specialty} = ANY(p.specialties)`);
  return sql.join(parts, sql` AND `);
}

interface CountRow extends Record<string, unknown> {
  dim: 'status' | 'day' | 'location' | 'professional' | 'specialty';
  key: string;
  label: string | null;
  total: number;
  attended: number;
  no_show: number;
  cancelled: number;
  /** Only the rows of the status dimension carry these. */
  staff: number | null;
  online: number | null;
  waitlist_offer: number | null;
  booked_minutes: number | null;
  past_open: number | null;
  rescheduled: number | null;
  confirmed_by_patient: number | null;
  recovered: number | null;
}

const attendance = (row: CountRow): AttendanceFigures => ({
  total: row.total,
  attended: row.attended,
  noShow: row.no_show,
  cancelled: row.cancelled,
});

/** The attendance figures of every group of the counts query. */
const FIGURES = sql`count(*)::int AS total,
  count(*) FILTER (WHERE status = 'attended')::int AS attended,
  count(*) FILTER (WHERE status = 'no_show')::int AS no_show,
  count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled`;

/** What only the status rows add up: sources, minutes and the figures derived from history. */
const STATUS_EXTRAS = sql`count(*) FILTER (WHERE source = 'staff')::int AS staff,
  count(*) FILTER (WHERE source = 'online')::int AS online,
  count(*) FILTER (WHERE source = 'waitlist_offer')::int AS waitlist_offer,
  coalesce(sum(minutes) FILTER (WHERE status <> 'cancelled'), 0)::int AS booked_minutes,
  count(*) FILTER (WHERE past_open)::int AS past_open,
  count(*) FILTER (WHERE rescheduled)::int AS rescheduled,
  count(*) FILTER (WHERE confirmed)::int AS confirmed_by_patient,
  count(*) FILTER (WHERE recovered)::int AS recovered`;

const NO_EXTRAS = sql`NULL::int AS staff, NULL::int AS online, NULL::int AS waitlist_offer,
  NULL::int AS booked_minutes, NULL::int AS past_open, NULL::int AS rescheduled,
  NULL::int AS confirmed_by_patient, NULL::int AS recovered`;

/**
 * The counts behind the operational report for a cohort. `recoveredIds` are the appointments that
 * the waitlist module says were recovered through an accepted offer; `now` decides which open
 * appointments are late for a status.
 *
 * One pass over the appointments of the period (the cohort), with the facts of each one worked out
 * once (its day at the location, whether it was moved or confirmed by the patient), and then every
 * grouping is added up from that: by status, day, location, professional and specialty.
 */
export async function operationalFacts(
  tx: Tx,
  cohort: ReportCohort,
  input: { now: Date; recoveredIds: readonly string[] },
): Promise<OperationalFacts> {
  const where = cohortCondition(cohort);
  const recovered = inList(sql`a.id`, input.recoveredIds);

  const counts = await tx.execute<CountRow>(sql`
    WITH c AS MATERIALIZED (
      SELECT a.status, a.source,
             (a.starts_at AT TIME ZONE l.time_zone)::date AS day,
             a.location_id, l.name AS location_name, a.professional_id,
             extract(epoch FROM (a.ends_at - a.starts_at)) / 60 AS minutes,
             (a.status IN (${OPEN_LIST}) AND a.ends_at <= ${input.now.toISOString()}::timestamptz) AS past_open,
             ${WAS_RESCHEDULED} AS rescheduled,
             ${WAS_CONFIRMED_BY_PATIENT} AS confirmed,
             ${recovered} AS recovered
        ${fromCohort(cohort)}
       WHERE ${where}
    ),
    by_professional AS (
      SELECT professional_id, ${FIGURES} FROM c GROUP BY professional_id
    )
    SELECT 'status' AS dim, status AS key, NULL::text AS label, ${FIGURES}, ${STATUS_EXTRAS}
      FROM c GROUP BY status
    UNION ALL
    SELECT 'day', day::text, NULL, ${FIGURES}, ${NO_EXTRAS}
      FROM c GROUP BY day
    UNION ALL
    SELECT 'location', location_id::text, location_name, ${FIGURES}, ${NO_EXTRAS}
      FROM c GROUP BY location_id, location_name
    UNION ALL
    SELECT 'professional', g.professional_id::text, m.display_name,
           g.total, g.attended, g.no_show, g.cancelled, ${NO_EXTRAS}
      FROM by_professional g
      JOIN professional p ON p.id = g.professional_id
      JOIN membership m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
    UNION ALL
    SELECT 'specialty', s.specialty, NULL, sum(g.total)::int, sum(g.attended)::int,
           sum(g.no_show)::int, sum(g.cancelled)::int, ${NO_EXTRAS}
      FROM by_professional g
      JOIN professional p ON p.id = g.professional_id
      CROSS JOIN LATERAL unnest(p.specialties) AS s(specialty)
     GROUP BY s.specialty
    ORDER BY dim, key`);

  const rows = counts.rows;
  const of = (dim: CountRow['dim']) => rows.filter((row) => row.dim === dim);

  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
    AppointmentStatus,
    number
  >;
  const facts = {
    sources: { staff: 0, online: 0, waitlistOffer: 0 },
    bookedMinutes: 0,
    notFinalPast: 0,
    rescheduled: 0,
    confirmedByPatient: 0,
    recovered: 0,
  };
  for (const row of of('status')) {
    byStatus[row.key as AppointmentStatus] = row.total;
    facts.sources.staff += row.staff ?? 0;
    facts.sources.online += row.online ?? 0;
    facts.sources.waitlistOffer += row.waitlist_offer ?? 0;
    facts.bookedMinutes += row.booked_minutes ?? 0;
    facts.notFinalPast += row.past_open ?? 0;
    facts.rescheduled += row.rescheduled ?? 0;
    facts.confirmedByPatient += row.confirmed_by_patient ?? 0;
    facts.recovered += row.recovered ?? 0;
  }

  // New against returning: a patient is new when nothing earlier than their first appointment of
  // the period was booked and kept (cancelled appointments never counted as a visit).
  const patients = await tx.execute<{ new: number; total: number }>(sql`
    WITH w AS (
      SELECT a.tenant_id, a.patient_id, min(a.starts_at) AS first_at
        ${fromCohort(cohort)}
       WHERE ${where} AND a.status <> 'cancelled'
       GROUP BY a.tenant_id, a.patient_id
    )
    SELECT count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM appointment earlier
              WHERE earlier.tenant_id = w.tenant_id AND earlier.patient_id = w.patient_id
                AND earlier.status <> 'cancelled' AND earlier.starts_at < w.first_at
           ))::int AS new,
           count(*)::int AS total
      FROM w`);
  const patientRow = patients.rows[0];

  const byName = <T extends { name: string | null }>(a: T, b: T) =>
    (a.name ?? '').localeCompare(b.name ?? '', 'es');
  return {
    byStatus,
    ...facts,
    patients: {
      new: patientRow?.new ?? 0,
      returning: (patientRow?.total ?? 0) - (patientRow?.new ?? 0),
    },
    byDay: of('day').map((row) => ({ date: row.key, ...attendance(row) })),
    byLocation: of('location')
      .map((row) => ({ locationId: row.key, name: row.label ?? '', ...attendance(row) }))
      .sort(byName),
    byProfessional: of('professional')
      .map((row) => ({ professionalId: row.key, name: row.label, ...attendance(row) }))
      .sort(byName),
    bySpecialty: of('specialty').map((row) => ({ specialty: row.key, ...attendance(row) })),
  };
}

// Available time ---------------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/** The hours of a professional at a location on a date, in minutes of the wall clock. */
function wallMinutesOn(
  hours: { weekly: readonly HoursRow[]; periods: readonly HoursPeriod[] },
  locationId: string,
  date: string,
): number {
  const weekday = weekdayOfDate(date);
  const period = hours.periods.find((item) => item.dateFrom <= date && date <= item.dateTo);
  return (period ? period.rows : hours.weekly)
    .filter((row) => row.locationId === locationId && row.weekday === weekday)
    .reduce((total, row) => total + Math.max(0, row.endMinute - row.startMinute), 0);
}

/**
 * Minutes the professionals of the cohort are available in its days: their working hours at each
 * location (weekly hours or the hours of a period of dates), minus the blocks, minus the days the
 * location is closed, times the number of appointments each can hold at once.
 *
 * Hours are minutes of the wall clock at the location. A day no block touches is counted by
 * arithmetic (a year of twenty professionals must not turn into thousands of zone conversions); a
 * day a block touches is cut exactly, in instants, so a block of two hours takes two hours.
 */
export async function availableMinutes(
  tx: Tx,
  cohort: ReportCohort,
  deps: { keys: TenantKeys },
): Promise<number> {
  const ports = createSchedulingPorts(tx, { keys: deps.keys });
  const conditions: SQL[] = [sql`p.status = 'active'`];
  if (cohort.professionalId !== undefined) {
    conditions.push(sql`p.id = ${cohort.professionalId}::uuid`);
  }
  if (cohort.specialty !== undefined)
    conditions.push(sql`${cohort.specialty} = ANY(p.specialties)`);
  const professionals = await tx.execute<{ id: string; max_simultaneous: number }>(sql`
    SELECT p.id, p.max_simultaneous FROM professional p WHERE ${sql.join(conditions, sql` AND `)}`);

  const dates = datesBetween(cohort.fromDate, cohort.toDate);
  const holidays = await ports.holidays(cohort.fromDate, cohort.toDate);
  const places = new Map<string, { zone: string; closed: Set<string> } | null>();
  const placeOf = async (locationId: string) => {
    if (!places.has(locationId)) {
      const found = await ports.findLocation(locationId);
      places.set(
        locationId,
        found
          ? {
              zone: found.timeZone,
              closed: new Set(
                dates.filter((date) => isClosedDay(holidays, date, locationId) !== null),
              ),
            }
          : null,
      );
    }
    return places.get(locationId) ?? null;
  };
  const mayCount = (locationId: string, professionalId: string) =>
    (cohort.scope.kind === 'all' ||
      cohort.scope.locationIds.includes(locationId) ||
      cohort.scope.professionalIds.includes(professionalId)) &&
    (cohort.locationId === undefined || cohort.locationId === locationId);

  let minutes = 0;
  for (const professional of professionals.rows) {
    const hours = await ports.hours(professional.id, '', cohort.fromDate, cohort.toDate);
    const locationIds = new Set([
      ...hours.weekly.map((row) => row.locationId),
      ...hours.periods.flatMap((period) => period.rows.map((row) => row.locationId)),
    ]);
    for (const locationId of [...locationIds].sort()) {
      if (!mayCount(locationId, professional.id)) continue;
      const place = await placeOf(locationId);
      if (!place) continue;

      const range = {
        start: dayBounds(place.zone, cohort.fromDate).start.getTime(),
        end: dayBounds(place.zone, cohort.toDate).end.getTime(),
      };
      const blocks = await ports.blocks(professional.id, locationId, range);
      const touched = new Set<string>();
      for (const block of blocks) {
        const first = localParts(place.zone, new Date(block.start)).date;
        const last = localParts(place.zone, new Date(block.end - 1)).date;
        for (const date of datesBetween(
          first < cohort.fromDate ? cohort.fromDate : first,
          last > cohort.toDate ? cohort.toDate : last,
        )) {
          touched.add(date);
        }
      }

      let worked = 0;
      for (const date of dates) {
        if (place.closed.has(date)) continue;
        if (!touched.has(date)) {
          worked += wallMinutesOn(hours, locationId, date);
          continue;
        }
        const windows = workingWindows({
          zone: place.zone,
          locationId,
          dates: [date],
          weekly: hours.weekly,
          periods: hours.periods,
        });
        worked += subtractRanges(windows, blocks).reduce(
          (total, window) => total + Math.round((window.end - window.start) / MINUTE_MS),
          0,
        );
      }
      minutes += worked * professional.max_simultaneous;
    }
  }
  return minutes;
}

// Records ----------------------------------------------------------------------------------------

export interface AppointmentRecord {
  appointmentId: string;
  startsAt: Date;
  localDate: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  rescheduled: boolean;
  patientId: string;
  patientName: string;
  locationId: string;
  locationName: string;
  professionalId: string;
  professionalName: string | null;
  appointmentTypeName: string;
}

interface RecordRow extends Record<string, unknown> {
  appointment_id: string;
  starts_at: Date;
  local_date: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  rescheduled: boolean;
  patient_id: string;
  patient_name: string;
  location_id: string;
  location_name: string;
  professional_id: string;
  professional_name: string | null;
  type_name: string;
}

function groupCondition(group: ReportGroup, recoveredIds: readonly string[]): SQL {
  switch (group) {
    case 'all':
      return sql`true`;
    case 'rescheduled':
      return WAS_RESCHEDULED;
    case 'online':
      return sql`a.source = 'online'`;
    case 'recovered':
      return inList(sql`a.id`, recoveredIds);
    default:
      return sql`a.status = ${group}`;
  }
}

/**
 * The appointments behind a figure, one page of them in order of time, with how many there are in
 * all. Administrative columns and the name of the patient (identification) only.
 */
export async function appointmentRecords(
  tx: Tx,
  cohort: ReportCohort,
  input: { group: ReportGroup; limit: number; offset: number; recoveredIds: readonly string[] },
): Promise<{ total: number; records: AppointmentRecord[] }> {
  const where = sql`${cohortCondition(cohort)} AND ${groupCondition(input.group, input.recoveredIds)}`;
  const count = await tx.execute<{ total: number }>(sql`
    SELECT count(*)::int AS total ${FROM_APPOINTMENTS} WHERE ${where}`);

  const page = await tx.execute<RecordRow>(sql`
    SELECT a.id AS appointment_id, a.starts_at,
           (a.starts_at AT TIME ZONE l.time_zone)::date::text AS local_date,
           a.status, a.source, ${WAS_RESCHEDULED} AS rescheduled,
           a.patient_id, (pt.family_name || ', ' || pt.given_names) AS patient_name,
           a.location_id, l.name AS location_name,
           a.professional_id, m.display_name AS professional_name,
           t.name AS type_name
      ${FROM_APPOINTMENTS}
      JOIN membership m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
      JOIN patient pt ON pt.tenant_id = a.tenant_id AND pt.id = a.patient_id
      JOIN appointment_type t ON t.tenant_id = a.tenant_id AND t.id = a.appointment_type_id
     WHERE ${where}
     ORDER BY a.starts_at, a.id
     LIMIT ${input.limit} OFFSET ${input.offset}`);

  return {
    total: count.rows[0]?.total ?? 0,
    records: page.rows.map((row) => ({
      appointmentId: row.appointment_id,
      startsAt: new Date(row.starts_at),
      localDate: row.local_date,
      status: row.status,
      source: row.source,
      rescheduled: row.rescheduled,
      patientId: row.patient_id,
      patientName: row.patient_name,
      locationId: row.location_id,
      locationName: row.location_name,
      professionalId: row.professional_id,
      professionalName: row.professional_name,
      appointmentTypeName: row.type_name,
    })),
  };
}

// Professionals of a scope -----------------------------------------------------------------------

export interface ReportProfessional {
  id: string;
  name: string | null;
  specialties: string[];
}

/**
 * The active professionals a viewer may filter a report by: everyone for the whole organization,
 * and otherwise the ones given and the ones who work at the locations given.
 */
export async function reportProfessionals(
  tx: Tx,
  scope: ReportAppointmentScope,
): Promise<ReportProfessional[]> {
  let visible = sql`true`;
  if (scope.kind === 'limited') {
    const either = [
      ...(scope.professionalIds.length > 0 ? [inList(sql`p.id`, scope.professionalIds)] : []),
      ...(scope.locationIds.length > 0
        ? [
            sql`EXISTS (
              SELECT 1 FROM professional_hours h
               WHERE h.tenant_id = p.tenant_id AND h.professional_id = p.id
                 AND h.removed_at IS NULL AND ${inList(sql`h.location_id`, scope.locationIds)})`,
          ]
        : []),
    ];
    visible = either.length > 0 ? sql`(${sql.join(either, sql` OR `)})` : sql`false`;
  }
  const result = await tx.execute<{ id: string; name: string | null; specialties: string[] }>(sql`
    SELECT p.id, m.display_name AS name, p.specialties
      FROM professional p
      JOIN membership m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
     WHERE p.status = 'active' AND ${visible}
     ORDER BY m.display_name NULLS LAST, p.id`);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    specialties: row.specialties,
  }));
}
