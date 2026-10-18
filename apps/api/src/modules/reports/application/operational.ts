import type {
  AppliedReportFilters,
  OperationalReportResponse,
  ReportFilters,
  ReportRecordsQuery,
  ReportRecordsResponse,
} from '@consultorio/contracts';

import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import {
  appointmentRecords,
  availableMinutes,
  operationalFacts,
  type AttendanceFigures,
  type OperationalFacts,
  type ReportCohort,
} from '../../scheduling/index.js';
import { recoveredAppointmentIds } from '../../waitlist/index.js';
import { noShowRateBp, ratioBp } from '../domain/rates.js';

import type { ReportScope } from './scope.js';

export type { OperationalFacts } from '../../scheduling/index.js';

/** Statuses in which nobody has said yet whether the patient came. */
const NOT_FINAL = [
  'pending_approval',
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
] as const;

const FULL = 10_000;

const withRate = <T extends AttendanceFigures>(row: T): T & { noShowRateBp: number | null } => ({
  ...row,
  noShowRateBp: noShowRateBp({ attended: row.attended, noShow: row.noShow }),
});

/**
 * The operational report from the counts scheduling and the waitlist gave (reports, "Operational
 * reports"). Pure: the rules of the figures live here and nowhere else.
 *
 * - The no-show rate is no-show over attended plus no-show (D9). Cancelled appointments, and the
 *   ones not yet in a final state, are in neither side; they are counted apart so a reader sees what
 *   the rate leaves out.
 * - "Rescheduled" is not a status. It is the count of appointments moved at least once, from history.
 * - Occupancy is booked minutes over the available ones; with no working hours there is none.
 */
export function buildOperationalReport(input: {
  filters: AppliedReportFilters;
  generatedAt: Date;
  facts: OperationalFacts;
  availableMinutes: number;
}): OperationalReportResponse {
  const { facts } = input;
  const attended = facts.byStatus.attended;
  const noShow = facts.byStatus.no_show;
  const cancelled = facts.byStatus.cancelled;
  const total = Object.values(facts.byStatus).reduce((sum, count) => sum + count, 0);
  const notFinal = NOT_FINAL.reduce((sum, status) => sum + facts.byStatus[status], 0);
  const occupancyRate = ratioBp(facts.bookedMinutes, input.availableMinutes);

  return {
    filters: input.filters,
    generatedAt: input.generatedAt.toISOString(),
    totalAppointments: total,
    byStatus: facts.byStatus,
    noShow: {
      attended,
      noShow,
      rateBp: noShowRateBp({ attended, noShow }),
      excluded: { cancelled, notFinal, notFinalPast: facts.notFinalPast },
    },
    occupancy: {
      bookedMinutes: facts.bookedMinutes,
      availableMinutes: input.availableMinutes,
      rateBp: occupancyRate === null ? null : Math.min(FULL, occupancyRate),
    },
    patients: facts.patients,
    rescheduled: facts.rescheduled,
    sources: { ...facts.sources, onlineShareBp: ratioBp(facts.sources.online, total) },
    waitlist: { recoveredSlots: facts.recovered },
    confirmations: {
      confirmedByPatient: facts.confirmedByPatient,
      rateBp: ratioBp(facts.confirmedByPatient, total - cancelled),
    },
    byDay: facts.byDay.map(withRate),
    byLocation: facts.byLocation.map(withRate),
    byProfessional: facts.byProfessional.map(withRate),
    bySpecialty: facts.bySpecialty.map(withRate),
  };
}

// Running a report -------------------------------------------------------------------------------

export interface ReportDeps {
  keys: TenantKeys;
  clock: () => Date;
}

/** What scheduling is asked to count for a scope. */
export function cohortScope(scope: ReportScope): ReportCohort['scope'] {
  if (scope.kind === 'organization') return { kind: 'all' };
  if (scope.kind === 'locations') {
    return {
      kind: 'limited',
      locationIds: scope.locationIds,
      professionalIds: scope.professionalIds,
    };
  }
  return { kind: 'limited', locationIds: [], professionalIds: [scope.professionalId] };
}

/** The cohort scheduling counts for a scope and the filters of a request. */
export function cohortOf(scope: ReportScope, filters: ReportFilters): ReportCohort {
  return {
    fromDate: filters.from,
    toDate: filters.to,
    scope: cohortScope(scope),
    locationId: filters.locationId,
    professionalId: filters.professionalId,
    specialty: filters.specialty,
  };
}

/** The filters as the server applied them, for the screen and for an export to show. */
export function appliedFilters(scope: ReportScope, filters: ReportFilters): AppliedReportFilters {
  return {
    from: filters.from,
    to: filters.to,
    locationId: filters.locationId ?? null,
    professionalId: filters.professionalId ?? null,
    specialty: filters.specialty ?? null,
    scope: scope.kind,
  };
}

export async function operationalReport(
  tx: Tx,
  request: { scope: ReportScope; filters: ReportFilters },
  deps: ReportDeps,
): Promise<OperationalReportResponse> {
  const cohort = cohortOf(request.scope, request.filters);
  const now = deps.clock();
  const recoveredIds = await recoveredAppointmentIds(tx, cohort);
  // One query at a time: all of them share the connection of the transaction.
  const facts = await operationalFacts(tx, cohort, { now, recoveredIds });
  const available = await availableMinutes(tx, cohort, { keys: deps.keys });
  return buildOperationalReport({
    filters: appliedFilters(request.scope, request.filters),
    generatedAt: now,
    facts,
    availableMinutes: available,
  });
}

export async function operationalRecords(
  tx: Tx,
  request: { scope: ReportScope; query: ReportRecordsQuery },
): Promise<ReportRecordsResponse> {
  const { query } = request;
  const cohort = cohortOf(request.scope, query);
  const recoveredIds = query.group === 'recovered' ? await recoveredAppointmentIds(tx, cohort) : [];
  const page = await appointmentRecords(tx, cohort, {
    group: query.group,
    limit: query.limit,
    offset: query.offset,
    recoveredIds,
  });
  return {
    filters: appliedFilters(request.scope, query),
    group: query.group,
    total: page.total,
    limit: query.limit,
    offset: query.offset,
    records: page.records.map((record) => ({
      ...record,
      startsAt: record.startsAt.toISOString(),
    })),
  };
}
