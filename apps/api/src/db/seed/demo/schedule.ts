import { instantAtLocalMinute, localParts } from '../../../modules/scheduling/domain/time.js';

import type { DemoDataset, DemoHours } from './dataset.js';
import { createRng } from './rng.js';

/**
 * The demo organization's agenda: appointment types, a block, a day off, a range of dates with its
 * own hours, and appointments for the previous week, this week and next week, spread across the
 * professionals with every status. It is a pure function of the dataset and of the moment the demo
 * is seeded, so the calendar always looks "current": today has patients, the past has attended and
 * missed visits, and the coming days are open.
 */

const SEED = 20_260_102;
const DAY_MS = 86_400_000;
/** Time zone of the organization's main city; "today" and the week are read in it. */
const HOME_ZONE = 'America/Argentina/Buenos_Aires';

export type DemoAppointmentStatus =
  'scheduled' | 'confirmed' | 'checked_in' | 'in_progress' | 'attended' | 'no_show' | 'cancelled';

export type DemoProfessionalKey = 'cardiology' | 'pediatrics' | 'psychology';

export interface DemoAppointmentType {
  key: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  color: string;
}

export interface DemoAppointment {
  professional: DemoProfessionalKey;
  /** Key of a location of the dataset. */
  location: string;
  /** Local date at the location, `YYYY-MM-DD`. */
  date: string;
  startMinute: number;
  type: string;
  patientIndex: number;
  status: DemoAppointmentStatus;
  /** The professional booked an existing patient for themselves: the identity review shows up. */
  selfBooked?: boolean;
}

export interface DemoSchedule {
  types: readonly DemoAppointmentType[];
  appointments: readonly DemoAppointment[];
  block: {
    professional: DemoProfessionalKey;
    location: string;
    date: string;
    startMinute: number;
    endMinute: number;
    reason: string;
  };
  dayOff: { date: string; name: string };
  period: {
    professional: DemoProfessionalKey;
    dateFrom: string;
    dateTo: string;
    reason: string;
    hours: readonly DemoHours[];
  };
}

const TYPES: readonly DemoAppointmentType[] = [
  {
    key: 'first',
    name: 'Primera consulta',
    durationMinutes: 45,
    bufferMinutes: 0,
    color: '#2563EB',
  },
  { key: 'followup', name: 'Control', durationMinutes: 20, bufferMinutes: 5, color: '#0F766E' },
  {
    key: 'checkup',
    name: 'Chequeo cardiológico',
    durationMinutes: 30,
    bufferMinutes: 10,
    color: '#B45309',
  },
  {
    key: 'child_check',
    name: 'Control de niño sano',
    durationMinutes: 30,
    bufferMinutes: 5,
    color: '#7C3AED',
  },
  {
    key: 'therapy',
    name: 'Sesión de terapia',
    durationMinutes: 50,
    bufferMinutes: 10,
    color: '#BE185D',
  },
];

const TYPES_OF: Readonly<Record<DemoProfessionalKey, readonly string[]>> = {
  cardiology: ['first', 'followup', 'checkup', 'followup'],
  pediatrics: ['first', 'child_check', 'followup', 'child_check'],
  psychology: ['therapy'],
};

const PROFESSIONALS: readonly DemoProfessionalKey[] = ['cardiology', 'pediatrics', 'psychology'];

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

interface Candidate {
  professional: DemoProfessionalKey;
  location: string;
  date: string;
  startMinute: number;
  type: DemoAppointmentType;
  startMs: number;
  endMs: number;
}

export function buildDemoSchedule(data: DemoDataset, now: Date): DemoSchedule {
  const rng = createRng(SEED);
  const zoneOf = (locationKey: string) =>
    data.locations.find((place) => place.key === locationKey)?.timeZone ?? HOME_ZONE;
  const hoursOf = (professional: DemoProfessionalKey): readonly DemoHours[] =>
    data.staff.find((person) => person.key === professional)?.professional?.hours ?? [];
  const typeOf = (key: string): DemoAppointmentType => {
    const found = TYPES.find((type) => type.key === key);
    if (!found) throw new Error(`unknown demo appointment type ${key}`);
    return found;
  };

  const today = localParts(HOME_ZONE, now).date;
  const monday = addDays(today, -(weekdayOf(today) - 1));

  // The closures first, so the appointments are placed around them.
  const block = {
    professional: 'pediatrics' as const,
    location: 'central',
    date: addDays(monday, 8),
    startMinute: 14 * 60,
    endMinute: 17 * 60,
    reason: 'Capacitación del equipo',
  };
  const dayOff = { date: addDays(monday, 11), name: 'Aniversario de la sede (día no laborable)' };
  const period = {
    professional: 'cardiology' as const,
    dateFrom: addDays(monday, 14),
    dateTo: addDays(monday, 20),
    reason: 'Horario reducido de verano',
    hours: [1, 3, 5].map((weekday): DemoHours => ({
      location: 'central',
      weekday,
      startMinute: 9 * 60,
      endMinute: 11 * 60,
    })),
  };

  const candidates: Candidate[] = [];
  const patientsByDay = new Map<string, Set<number>>();
  for (let offset = -7; offset <= 13; offset += 1) {
    const date = addDays(monday, offset);
    if (date === dayOff.date) continue;
    for (const professional of PROFESSIONALS) {
      for (const row of hoursOf(professional).filter((r) => r.weekday === weekdayOf(date))) {
        const zone = zoneOf(row.location);
        let cursor = row.startMinute;
        let placed = 0;
        while (placed < 5) {
          const type = typeOf(rng.pick(TYPES_OF[professional]));
          if (cursor + type.durationMinutes > row.endMinute) break;
          const skip = placed > 0 && rng.next() < 0.22;
          const inBlock =
            professional === block.professional &&
            date === block.date &&
            cursor < block.endMinute &&
            block.startMinute < cursor + type.durationMinutes + type.bufferMinutes;
          if (!skip && !inBlock) {
            const startMs = instantAtLocalMinute(zone, date, cursor).getTime();
            candidates.push({
              professional,
              location: row.location,
              date,
              startMinute: cursor,
              type,
              startMs,
              endMs: startMs + type.durationMinutes * 60_000,
            });
            placed += 1;
          }
          cursor += type.durationMinutes + type.bufferMinutes + rng.pick([0, 0, 15, 30]);
        }
      }
    }
  }

  // A patient at most once a day. Pediatrics sees the children of the organization, the other
  // professionals its adults, so the agenda reads like a real clinic.
  const isChild = (index: number) => (data.patients[index]?.birthDate ?? '0000') >= '2008';
  const pools: Record<DemoProfessionalKey, number[]> = {
    cardiology: [],
    pediatrics: [],
    psychology: [],
  };
  data.patients.forEach((_patient, index) => {
    if (isChild(index)) pools.pediatrics.push(index);
    else {
      pools.cardiology.push(index);
      pools.psychology.push(index);
    }
  });
  const nowMs = now.getTime();
  const appointments: DemoAppointment[] = [];
  const past: number[] = [];
  let upcomingTodayLeft = 1;
  for (const candidate of candidates.sort((a, b) => a.startMs - b.startMs)) {
    const taken = patientsByDay.get(candidate.date) ?? new Set<number>();
    const pool = pools[candidate.professional].filter((index) => !taken.has(index));
    if (pool.length === 0) continue;
    const patientIndex = rng.pick(pool);
    taken.add(patientIndex);
    patientsByDay.set(candidate.date, taken);

    let status: DemoAppointmentStatus;
    if (candidate.endMs <= nowMs) {
      status = 'attended';
      past.push(appointments.length);
    } else if (candidate.startMs <= nowMs) {
      status = 'in_progress';
    } else if (
      candidate.date === today &&
      candidate.startMs - nowMs <= 2 * 3_600_000 &&
      upcomingTodayLeft > 0
    ) {
      status = 'checked_in';
      upcomingTodayLeft -= 1;
    } else {
      const roll = rng.next();
      status = roll < 0.6 ? 'scheduled' : roll < 0.92 ? 'confirmed' : 'cancelled';
    }
    appointments.push({
      professional: candidate.professional,
      location: candidate.location,
      date: candidate.date,
      startMinute: candidate.startMinute,
      type: candidate.type.key,
      patientIndex,
      status,
    });
  }

  // History is not all attendance: some visits were missed, some were cancelled.
  past.forEach((index, order) => {
    const entry = appointments[index];
    if (!entry) return;
    if (order % 6 === 1) entry.status = 'no_show';
    else if (order % 6 === 4) entry.status = 'cancelled';
  });

  // One booking the professional made for themselves: the identity review shows up for reception.
  const selfBooked = appointments.find(
    (entry) =>
      entry.professional === 'cardiology' &&
      entry.date > today &&
      (entry.status === 'scheduled' || entry.status === 'confirmed'),
  );
  if (selfBooked) selfBooked.selfBooked = true;

  return { types: TYPES, appointments, block, dayOff, period };
}
