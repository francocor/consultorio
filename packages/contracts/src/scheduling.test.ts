import { describe, expect, it } from 'vitest';

import {
  APPOINTMENT_STATUSES,
  BookAppointmentRequest,
  SlotConflictExtension,
  isAppointmentStatus,
} from './scheduling.js';

const ID = '0190a000-0000-7000-8000-0000000000aa';

const base = {
  patientId: ID,
  professionalId: ID,
  locationId: ID,
  appointmentTypeId: ID,
};

describe('appointment statuses', () => {
  it('are exactly the eight of the scheduling spec', () => {
    expect([...APPOINTMENT_STATUSES]).toEqual([
      'pending_approval',
      'scheduled',
      'confirmed',
      'checked_in',
      'in_progress',
      'attended',
      'no_show',
      'cancelled',
    ]);
    expect(isAppointmentStatus('rescheduled')).toBe(false);
    expect(isAppointmentStatus('cancelled')).toBe(true);
  });
});

describe('BookAppointmentRequest', () => {
  it('accepts an instant', () => {
    const parsed = BookAppointmentRequest.safeParse({
      ...base,
      startsAt: '2026-12-01T13:00:00.000Z',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a local time at the location, with the occurrence for a repeated hour', () => {
    expect(
      BookAppointmentRequest.safeParse({
        ...base,
        local: { date: '2026-10-25', time: '02:30', occurrence: 'second' },
      }).success,
    ).toBe(true);
    expect(
      BookAppointmentRequest.safeParse({ ...base, local: { date: '2026-10-25', time: '02:30' } })
        .success,
    ).toBe(true);
  });

  it('needs exactly one way to say when', () => {
    expect(BookAppointmentRequest.safeParse(base).success).toBe(false);
    expect(
      BookAppointmentRequest.safeParse({
        ...base,
        startsAt: '2026-12-01T13:00:00.000Z',
        local: { date: '2026-12-01', time: '10:00' },
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed instant, date, time and occurrence', () => {
    for (const body of [
      { startsAt: 'tomorrow' },
      { startsAt: '2026-12-01T13:00:00' },
      { local: { date: '2026-02-30', time: '10:00' } },
      { local: { date: '2026-12-01', time: '25:00' } },
      { local: { date: '2026-12-01', time: '10:00', occurrence: 'third' } },
    ]) {
      expect(BookAppointmentRequest.safeParse({ ...base, ...body }).success).toBe(false);
    }
  });

  it('ignores who created it and which organization: both come from the session', () => {
    const parsed = BookAppointmentRequest.parse({
      ...base,
      startsAt: '2026-12-01T13:00:00.000Z',
      createdBy: 'someone-else',
      bookedBy: ID,
      tenantId: ID,
      identityConfirmed: false,
      status: 'attended',
    });

    expect(parsed).not.toHaveProperty('createdBy');
    expect(parsed).not.toHaveProperty('bookedBy');
    expect(parsed).not.toHaveProperty('tenantId');
    expect(parsed).not.toHaveProperty('identityConfirmed');
    expect(parsed).not.toHaveProperty('status');
  });

  it('needs a reason for an override of hours, blocks and holidays', () => {
    const at = { startsAt: '2026-12-01T13:00:00.000Z' };

    expect(
      BookAppointmentRequest.safeParse({
        ...base,
        ...at,
        overrideHours: { reason: 'Urgent follow-up' },
      }).success,
    ).toBe(true);
    expect(
      BookAppointmentRequest.safeParse({ ...base, ...at, overrideHours: { reason: '  ' } }).success,
    ).toBe(false);
    expect(BookAppointmentRequest.safeParse({ ...base, ...at, overrideHours: {} }).success).toBe(
      false,
    );
  });
});

describe('SlotConflictExtension', () => {
  it('carries the conflicting range and the next free slots, and nothing about the patient', () => {
    const body = {
      conflict: { startsAt: '2026-12-01T13:00:00.000Z', endsAt: '2026-12-01T13:30:00.000Z' },
      nextSlots: [{ startsAt: '2026-12-01T13:30:00.000Z', endsAt: '2026-12-01T14:00:00.000Z' }],
    };

    expect(SlotConflictExtension.safeParse(body).success).toBe(true);
    expect(SlotConflictExtension.safeParse({ ...body, patientName: 'Ana' }).success).toBe(false);
  });
});
