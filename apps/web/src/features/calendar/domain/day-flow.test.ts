import type { AppointmentStatus, CalendarEntryDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { entry } from '../fixtures.js';

import { filterByPatient, groupByFlow } from './day-flow.js';

let counter = 0;
function at(status: AppointmentStatus, start: string, name = 'Paciente') {
  counter += 1;
  return entry({
    id: `0190a000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    status,
    startsAt: start,
    endsAt: new Date(new Date(start).getTime() + 30 * 60_000).toISOString(),
    patientName: `${name} ${String(counter)}`,
  });
}

describe('groupByFlow', () => {
  it('puts each appointment where the day needs it, in time order', () => {
    const items: CalendarEntryDto[] = [
      at('attended', '2026-10-17T12:00:00.000Z', 'Atendido'),
      at('scheduled', '2026-10-17T16:00:00.000Z', 'Tarde'),
      at('checked_in', '2026-10-17T14:30:00.000Z', 'Espera segunda'),
      at('in_progress', '2026-10-17T14:00:00.000Z', 'Consulta'),
      at('confirmed', '2026-10-17T15:00:00.000Z', 'Mañana'),
      at('checked_in', '2026-10-17T14:15:00.000Z', 'Espera primera'),
      at('no_show', '2026-10-17T11:00:00.000Z', 'Ausente'),
      at('pending_approval', '2026-10-17T17:00:00.000Z', 'Por aprobar'),
    ];

    const flow = groupByFlow(items);

    expect(flow.inProgress.map((item) => item.patientName.split(' ')[0])).toEqual(['Consulta']);
    // Waiting patients are served in the order they are due.
    expect(flow.waiting.map((item) => item.patientName.split(' ').slice(0, 2).join(' '))).toEqual([
      'Espera primera',
      'Espera segunda',
    ]);
    expect(flow.upcoming.map((item) => item.patientName.split(' ')[0])).toEqual([
      'Mañana',
      'Tarde',
      'Por',
    ]);
    expect(flow.closed.map((item) => item.patientName.split(' ')[0])).toEqual([
      'Ausente',
      'Atendido',
    ]);
  });

  it('leaves cancelled appointments out of the day', () => {
    const flow = groupByFlow([
      at('cancelled', '2026-10-17T12:00:00.000Z'),
      at('scheduled', '2026-10-17T13:00:00.000Z'),
    ]);

    expect(flow.upcoming).toHaveLength(1);
    expect(flow.closed).toEqual([]);
  });

  it('names who is next: the patient who has waited longest', () => {
    const flow = groupByFlow([
      at('checked_in', '2026-10-17T14:30:00.000Z', 'Segundo'),
      at('checked_in', '2026-10-17T14:00:00.000Z', 'Primero'),
    ]);

    expect(flow.next?.patientName).toMatch(/^Primero/);
    expect(groupByFlow([at('scheduled', '2026-10-17T14:00:00.000Z')]).next).toBeUndefined();
  });
});

describe('filterByPatient', () => {
  const items = [
    entry({ id: '0190a000-0000-7000-8000-0000000000a1', patientName: 'Gómez, Valentina' }),
    entry({ id: '0190a000-0000-7000-8000-0000000000a2', patientName: 'Ríos, Tomás' }),
  ];

  it('finds a patient by any part of the name, ignoring case and accents', () => {
    expect(filterByPatient(items, 'gomez').map((item) => item.patientName)).toEqual([
      'Gómez, Valentina',
    ]);
    expect(filterByPatient(items, 'TOMAS').map((item) => item.patientName)).toEqual([
      'Ríos, Tomás',
    ]);
    expect(filterByPatient(items, 'valen')).toHaveLength(1);
  });

  it('shows everything for an empty search', () => {
    expect(filterByPatient(items, '  ')).toHaveLength(2);
  });
});
