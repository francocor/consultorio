import { randomUUID } from 'node:crypto';

import type { HolidayDto } from '@consultorio/contracts';

import type {
  ActiveOccupancy,
  AppointmentPatch,
  HoldRecord,
  AppointmentRecord,
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
  appointments: Map<string, AppointmentRecord>;
  holds: Map<string, HoldRecord>;
  holdUpdates: { id: string; patch: { status?: string; appointmentId?: string } }[];
  updates: { id: string; patch: AppointmentPatch }[];
  lateWindowHours: number;
  weekly: HoursRow[];
  periods: HoursPeriod[];
  blocks: TimeRange[];
  holidays: HolidayDto[];
  occupancies: ActiveOccupancy[];
  /** When true the next insert fails like the database does on an overlap (23P01). */
  failNextInsert: boolean;
  /** D18: the organization has one professional and nobody else active. */
  solo: boolean;
  /** Patients the booking actor just registered. */
  freshPatients: Set<string>;
  openedItems: {
    kind: string;
    subjectType: string;
    subjectId: string;
    locationId: string | null;
  }[];
  closedItems: { kind: string; subjectId: string; status: string; resolution: string }[];
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
    appointments: new Map(),
    holds: new Map(),
    holdUpdates: [],
    updates: [],
    lateWindowHours: 24,
    weekly: [],
    periods: [],
    blocks: [],
    holidays: [],
    occupancies: [],
    failNextInsert: false,
    solo: false,
    freshPatients: new Set(),
    openedItems: [],
    closedItems: [],
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
    findProfessional: (id) => Promise.resolve(state.professionals.get(id) ?? null),
    findLocation: (id) => Promise.resolve(state.locations.get(id) ?? null),
    findType: (id) => Promise.resolve(state.types.get(id) ?? null),
    findPatient: (id) => Promise.resolve(state.patients.get(id) ?? null),
    expireHolds: (professionalId, now) => {
      state.expired.push({ professionalId, now });
      for (const hold of state.holds.values()) {
        if (
          hold.professionalId === professionalId &&
          hold.status === 'active' &&
          hold.expiresAt.getTime() <= now.getTime()
        ) {
          hold.status = 'expired';
          state.occupancies = state.occupancies.filter((o) => o.id !== hold.id);
        }
      }
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
      for (const id of ids) {
        const hold = state.holds.get(id);
        if (hold) hold.status = 'invalidated';
      }
      state.occupancies = state.occupancies.filter((o) => !ids.includes(o.id));
      return Promise.resolve();
    },
    applyLaneMoves: (moves) => {
      state.laneMoves.push(...moves);
      for (const move of moves) {
        const found = state.occupancies.find((o) => o.id === move.id);
        if (found) found.lane = move.lane;
        const hold = state.holds.get(move.id);
        if (hold) hold.lane = move.lane;
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
          identityConfirmation: null,
          outOfHours: values.outOfHours,
          seriesId: values.seriesId ?? null,
          seriesIndex: values.seriesIndex ?? null,
          version: 1,
        },
      });
    },
    findAppointment: (id) => Promise.resolve(state.appointments.get(id) ?? null),
    updateAppointment: (id, patch) => {
      const current = state.appointments.get(id);
      if (!current) return Promise.reject(new Error('no such appointment'));
      state.updates.push({ id, patch });
      const next: AppointmentRecord = {
        ...current,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
        version: current.version + 1,
      };
      state.appointments.set(id, next);
      return Promise.resolve({
        id: next.id,
        patientId: next.patientId,
        professionalId: next.professionalId,
        locationId: next.locationId,
        appointmentTypeId: next.appointmentTypeId,
        startsAt: next.startsAt.toISOString(),
        endsAt: next.endsAt.toISOString(),
        bufferMinutes: next.bufferMinutes,
        status: next.status,
        source: next.source,
        bookedBy: next.bookedBy,
        identityConfirmed: next.identityConfirmed,
        identityConfirmation: next.identityConfirmation,
        outOfHours: next.outOfHours,
        seriesId: next.seriesId,
        seriesIndex: next.seriesIndex,
        version: next.version,
      });
    },
    lateCancellationHours: () => Promise.resolve(state.lateWindowHours),
    findHold: (id) => Promise.resolve(state.holds.get(id) ?? null),
    insertHold: (values) => {
      const hold: HoldRecord = {
        id: randomUUID(),
        ...values,
        status: 'active',
        appointmentId: null,
      };
      state.holds.set(hold.id, hold);
      state.occupancies.push({
        id: hold.id,
        kind: 'hold',
        locationId: hold.locationId,
        lane: hold.lane,
        start: hold.startsAt.getTime(),
        end: hold.endsAt.getTime() + hold.bufferMinutes * 60_000,
        holdOrigin: hold.origin,
      });
      return Promise.resolve(hold);
    },
    updateHold: (id, patch) => {
      state.holdUpdates.push({ id, patch });
      const hold = state.holds.get(id);
      if (hold) {
        if (patch.status) hold.status = patch.status;
        if (patch.appointmentId) hold.appointmentId = patch.appointmentId;
        if (patch.status && patch.status !== 'active') {
          state.occupancies = state.occupancies.filter((o) => o.id !== id);
        }
      }
      return Promise.resolve();
    },
    releaseOldestHolds: (sourceKey, keep) => {
      const mine = [...state.holds.values()].filter(
        (hold) => hold.sourceKey === sourceKey && hold.status === 'active',
      );
      for (const hold of mine.slice(0, Math.max(0, mine.length - keep))) {
        hold.status = 'released';
        state.occupancies = state.occupancies.filter((o) => o.id !== hold.id);
      }
      return Promise.resolve();
    },
    soloPractice: () => Promise.resolve(state.solo),
    isFreshPatient: (patientId) => Promise.resolve(state.freshPatients.has(patientId)),
    openWorklistItem: (item) => {
      state.openedItems.push(item);
      return Promise.resolve();
    },
    closeWorklistItem: (item) => {
      state.closedItems.push({
        kind: item.kind,
        subjectId: item.subjectId,
        status: item.status,
        resolution: item.resolution,
      });
      return Promise.resolve();
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
