import { randomUUID } from 'node:crypto';

import type { HolidayDto } from '@consultorio/contracts';

import type {
  ActiveOccupancy,
  LaneMoveCommand,
  LocationRecord,
  NewAppointment,
  NewEvent,
  PatientRecord,
  ProfessionalRecord,
  SchedulingPorts,
  TypeRecord,
} from '../modules/scheduling/application/ports.js';
import type {
  HoursPeriod,
  HoursRow,
  TimeRange,
} from '../modules/scheduling/domain/working-hours.js';
import type { AuditEventInput } from '../platform/audit/writer.js';

/** The world the in-memory ports serve, and what the use case did to it. */
export interface FakeSchedulingState {
  professionals: Map<string, ProfessionalRecord>;
  locations: Map<string, LocationRecord>;
  types: Map<string, TypeRecord>;
  patients: Map<string, PatientRecord>;
  weekly: HoursRow[];
  periods: HoursPeriod[];
  blocks: TimeRange[];
  holidays: HolidayDto[];
  occupancies: ActiveOccupancy[];
  /** When true the next insert fails like the database does on an overlap (23P01). */
  failNextInsert: boolean;
  // What happened.
  inserted: NewAppointment[];
  events: NewEvent[];
  audits: AuditEventInput[];
  invalidatedHolds: string[];
  laneMoves: LaneMoveCommand[];
  expired: { professionalId: string; now: Date }[];
  locked: string[];
}

export function createFakeSchedulingPorts(overrides: Partial<FakeSchedulingState> = {}): {
  ports: SchedulingPorts;
  state: FakeSchedulingState;
} {
  const state: FakeSchedulingState = {
    professionals: new Map(),
    locations: new Map(),
    types: new Map(),
    patients: new Map(),
    weekly: [],
    periods: [],
    blocks: [],
    holidays: [],
    occupancies: [],
    failNextInsert: false,
    inserted: [],
    events: [],
    audits: [],
    invalidatedHolds: [],
    laneMoves: [],
    expired: [],
    locked: [],
    ...overrides,
  };

  const ports: SchedulingPorts = {
    lockProfessional: (id) => {
      state.locked.push(id);
      return Promise.resolve(state.professionals.get(id) ?? null);
    },
    findLocation: (id) => Promise.resolve(state.locations.get(id) ?? null),
    findType: (id) => Promise.resolve(state.types.get(id) ?? null),
    findPatient: (id) => Promise.resolve(state.patients.get(id) ?? null),
    expireHolds: (professionalId, now) => {
      state.expired.push({ professionalId, now });
      return Promise.resolve();
    },
    hours: () => Promise.resolve({ weekly: state.weekly, periods: state.periods }),
    blocks: (_professionalId, _locationId, range) =>
      Promise.resolve(
        state.blocks.filter((block) => block.start < range.end && range.start < block.end),
      ),
    holidays: (from, to) =>
      Promise.resolve(state.holidays.filter((holiday) => holiday.day >= from && holiday.day <= to)),
    occupancies: (_professionalId, range) =>
      Promise.resolve(state.occupancies.filter((o) => o.start < range.end && range.start < o.end)),
    invalidateHolds: (ids) => {
      state.invalidatedHolds.push(...ids);
      state.occupancies = state.occupancies.filter((o) => !ids.includes(o.id));
      return Promise.resolve();
    },
    applyLaneMoves: (moves) => {
      state.laneMoves.push(...moves);
      for (const move of moves) {
        const found = state.occupancies.find((o) => o.id === move.id);
        if (found) found.lane = move.lane;
      }
      return Promise.resolve();
    },
    insertAppointment: (values) => {
      if (state.failNextInsert) {
        state.failNextInsert = false;
        return Promise.resolve({ ok: false as const, reason: 'slot_taken' as const });
      }
      state.inserted.push(values);
      const id = randomUUID();
      state.occupancies.push({
        id,
        kind: 'appointment',
        locationId: values.locationId,
        lane: values.lane,
        start: values.startsAt.getTime(),
        end: values.endsAt.getTime() + values.bufferMinutes * 60_000,
      });
      return Promise.resolve({
        ok: true as const,
        appointment: {
          id,
          patientId: values.patientId,
          professionalId: values.professionalId,
          locationId: values.locationId,
          appointmentTypeId: values.appointmentTypeId,
          startsAt: values.startsAt.toISOString(),
          endsAt: values.endsAt.toISOString(),
          bufferMinutes: values.bufferMinutes,
          status: values.status,
          source: values.source,
          bookedBy: values.bookedBy,
          identityConfirmed: values.identityConfirmed,
          outOfHours: values.outOfHours,
          seriesId: values.seriesId ?? null,
          seriesIndex: values.seriesIndex ?? null,
          version: 1,
        },
      });
    },
    insertEvent: (event) => {
      state.events.push(event);
      return Promise.resolve();
    },
    audit: (event) => {
      state.audits.push(event);
      return Promise.resolve();
    },
  };
  return { ports, state };
}
