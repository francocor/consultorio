import {
  APPOINTMENT_STATUSES,
  type BlockDto,
  type CalendarEntryDto,
  type HolidayDto,
} from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { createI18n } from '../../../app/i18n.js';
import { LOCALE_RESOURCES } from '../../../shared/lib/locale-all.js';

import {
  backgroundsOf,
  closedDaysOf,
  statusLabel,
  STATUS_PRESENTATION,
  toCalendarEvent,
} from './calendar-events.js';

const ID = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const t = createI18n({ resources: LOCALE_RESOURCES }).t;

function entry(overrides: Partial<CalendarEntryDto> = {}): CalendarEntryDto {
  return {
    id: ID(1),
    patientId: ID(2),
    professionalId: ID(3),
    locationId: ID(4),
    appointmentTypeId: ID(5),
    startsAt: '2026-10-17T13:00:00.000Z',
    endsAt: '2026-10-17T13:30:00.000Z',
    bufferMinutes: 0,
    status: 'scheduled',
    source: 'staff',
    bookedBy: ID(6),
    identityConfirmed: true,
    identityConfirmation: null,
    outOfHours: false,
    seriesId: null,
    seriesIndex: null,
    version: 1,
    patientName: 'Gómez, Valentina',
    typeName: 'Control',
    typeColor: '#0f766e',
    mode: 'in_person',
    ...overrides,
  };
}

describe('status presentation', () => {
  it('has a distinct word for each of the eight statuses', () => {
    const words = APPOINTMENT_STATUSES.map((status) => statusLabel(t, status));

    expect(words).toEqual([
      'Pendiente de aprobación',
      'Programado',
      'Confirmado',
      'En sala',
      'En consulta',
      'Atendido',
      'Ausente',
      'Cancelado',
    ]);
    expect(new Set(words).size).toBe(8);
  });

  it('gives each status its own icon, so no two are told apart by color alone', () => {
    const icons = APPOINTMENT_STATUSES.map((status) => STATUS_PRESENTATION[status].icon);

    expect(new Set(icons).size).toBe(8);
  });
});

describe('toCalendarEvent', () => {
  const options = { resourceLabel: 'Dra. Ana Pérez', t, canMove: true };

  it('shows the patient, the type, the professional and the status as words', () => {
    const event = toCalendarEvent(entry(), options);

    expect(event).toMatchObject({
      id: ID(1),
      resourceId: ID(3),
      start: '2026-10-17T13:00:00.000Z',
      end: '2026-10-17T13:30:00.000Z',
      title: 'Gómez, Valentina',
      subtitle: 'Control',
      resourceLabel: 'Dra. Ana Pérez',
      statusLabel: 'Programado',
      accent: '#0f766e',
    });
  });

  it('marks a virtual appointment with an icon and the word "Virtual", and an in-person one with nothing', () => {
    const virtual = toCalendarEvent(entry({ mode: 'virtual' }), options);
    const inPerson = toCalendarEvent(entry({ mode: 'in_person' }), options);

    expect(virtual.marker?.label).toBe('Virtual');
    expect(virtual.marker?.icon).toBeDefined();
    expect(inPerson.marker).toBeUndefined();
  });

  it('lets only an appointment that has not started be moved, and only by someone who may book', () => {
    expect(toCalendarEvent(entry({ status: 'scheduled' }), options).movable).toBe(true);
    expect(toCalendarEvent(entry({ status: 'checked_in' }), options).movable).toBe(false);
    expect(toCalendarEvent(entry({ status: 'attended' }), options).movable).toBe(false);
    expect(
      toCalendarEvent(entry({ status: 'scheduled' }), { ...options, canMove: false }).movable,
    ).toBe(false);
  });

  it('mutes cancelled and absent appointments', () => {
    expect(toCalendarEvent(entry({ status: 'cancelled' }), options).muted).toBe(true);
    expect(toCalendarEvent(entry({ status: 'no_show' }), options).muted).toBe(true);
    expect(toCalendarEvent(entry({ status: 'confirmed' }), options).muted).toBeFalsy();
  });

  it('warns in words when the identity of the patient is not confirmed yet', () => {
    expect(toCalendarEvent(entry({ identityConfirmed: false }), options).note).toBe(
      'Identidad sin confirmar',
    );
    expect(toCalendarEvent(entry({ identityConfirmed: true }), options).note).toBeUndefined();
  });

  it('flags an out-of-hours booking in words', () => {
    expect(toCalendarEvent(entry({ outOfHours: true }), options).note).toBe('Fuera de horario');
  });
});

describe('backgrounds and closed days', () => {
  const block: BlockDto = {
    id: ID(10),
    professionalId: ID(3),
    locationId: null,
    startsAt: '2026-10-17T15:00:00.000Z',
    endsAt: '2026-10-17T16:00:00.000Z',
    reason: 'Congreso',
    seriesId: null,
  };

  it('turns a block of a professional into a band of their column', () => {
    expect(backgroundsOf([block], undefined)).toEqual([
      {
        id: ID(10),
        resourceId: ID(3),
        start: '2026-10-17T15:00:00.000Z',
        end: '2026-10-17T16:00:00.000Z',
        label: 'Congreso',
      },
    ]);
  });

  it('turns a block of a whole location into a band of every column', () => {
    const [band] = backgroundsOf([{ ...block, professionalId: null, locationId: ID(4) }], ID(4));

    expect(band?.resourceId).toBeNull();
  });

  it('leaves out the block of another location', () => {
    expect(backgroundsOf([{ ...block, professionalId: null, locationId: ID(9) }], ID(4))).toEqual(
      [],
    );
  });

  const holidays: HolidayDto[] = [
    {
      day: '2026-10-12',
      name: 'Día de la Raza',
      source: 'national',
      locationId: null,
      dayOffId: null,
    },
    {
      day: '2026-10-20',
      name: 'Cierre por obras',
      source: 'organization',
      locationId: ID(4),
      dayOffId: ID(11),
    },
  ];

  it('lists the holidays of everybody, and the days off of the chosen location only', () => {
    expect(closedDaysOf(holidays, undefined)).toEqual({ '2026-10-12': 'Día de la Raza' });
    expect(closedDaysOf(holidays, ID(4))).toEqual({
      '2026-10-12': 'Día de la Raza',
      '2026-10-20': 'Cierre por obras',
    });
    expect(closedDaysOf(holidays, ID(9))).toEqual({ '2026-10-12': 'Día de la Raza' });
  });
});
