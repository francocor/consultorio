import { describe, expect, it } from 'vitest';

import {
  APPOINTMENT_STATUSES,
  BookAppointmentRequest,
  CancelAppointmentRequest,
  CorrectStatusRequest,
  RescheduleRequest,
  SlotConflictExtension,
  TransitionRequest,
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

describe('lifecycle requests', () => {
  it('accept an optional version and nothing else on a plain transition', () => {
    expect(TransitionRequest.safeParse({}).success).toBe(true);
    expect(TransitionRequest.safeParse({ expectedVersion: 3 }).success).toBe(true);
    expect(TransitionRequest.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(TransitionRequest.safeParse({ status: 'attended' }).success).toBe(false);
  });

  it('cancel needs who cancelled and a reason code, and bounds the free text', () => {
    const ok = { cancelledBy: 'patient', reasonCode: 'illness' };

    expect(CancelAppointmentRequest.safeParse(ok).success).toBe(true);
    expect(CancelAppointmentRequest.safeParse({ ...ok, note: 'x'.repeat(200) }).success).toBe(true);
    expect(CancelAppointmentRequest.safeParse({ ...ok, note: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(CancelAppointmentRequest.safeParse({ reasonCode: 'illness' }).success).toBe(false);
    expect(CancelAppointmentRequest.safeParse({ ...ok, cancelledBy: 'landlord' }).success).toBe(
      false,
    );
    expect(CancelAppointmentRequest.safeParse({ ...ok, reasonCode: 'because' }).success).toBe(
      false,
    );
  });

  it('a correction needs a status of the eight and a reason', () => {
    expect(
      CorrectStatusRequest.safeParse({ toStatus: 'attended', reason: 'Arrived late' }).success,
    ).toBe(true);
    expect(CorrectStatusRequest.safeParse({ toStatus: 'attended', reason: '' }).success).toBe(
      false,
    );
    expect(CorrectStatusRequest.safeParse({ toStatus: 'rescheduled', reason: 'x' }).success).toBe(
      false,
    );
  });

  it('a reschedule needs the version and at least one thing to change', () => {
    const at = '2026-12-01T13:00:00.000Z';

    expect(RescheduleRequest.safeParse({ expectedVersion: 1, startsAt: at }).success).toBe(true);
    expect(RescheduleRequest.safeParse({ expectedVersion: 1, professionalId: ID }).success).toBe(
      true,
    );
    expect(RescheduleRequest.safeParse({ startsAt: at }).success).toBe(false);
    expect(RescheduleRequest.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(
      RescheduleRequest.safeParse({
        expectedVersion: 1,
        startsAt: at,
        local: { date: '2026-12-01', time: '10:00' },
      }).success,
    ).toBe(false);
  });
});
