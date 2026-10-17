import { describe, expect, it } from 'vitest';

import { cancelReasonForAppointment } from './validity.js';

const now = new Date('2031-05-11T10:00:00.000Z');
const startsAt = new Date('2031-05-12T13:00:00.000Z');
const planned = { patientId: 'patient-1', plannedStartsAt: startsAt };
const live = { status: 'scheduled', startsAt, patientId: 'patient-1' };

describe('cancelReasonForAppointment', () => {
  it('lets a message through while its appointment is live, unmoved and in the future', () => {
    expect(cancelReasonForAppointment({ now, message: planned, appointment: live })).toBeNull();
    expect(
      cancelReasonForAppointment({
        now,
        message: planned,
        appointment: { ...live, status: 'confirmed' },
      }),
    ).toBeNull();
  });

  it('cancels for an appointment that was cancelled or no longer exists', () => {
    expect(
      cancelReasonForAppointment({
        now,
        message: planned,
        appointment: { ...live, status: 'cancelled' },
      }),
    ).toBe('appointment_cancelled');
    expect(cancelReasonForAppointment({ now, message: planned, appointment: null })).toBe(
      'appointment_cancelled',
    );
  });

  it.each(['attended', 'no_show', 'in_progress', 'checked_in'])(
    'cancels for an appointment that is already %s',
    (status) => {
      expect(
        cancelReasonForAppointment({ now, message: planned, appointment: { ...live, status } }),
      ).toBe('appointment_over');
    },
  );

  it('cancels once the start has passed, and at the very instant of the start', () => {
    expect(cancelReasonForAppointment({ now: startsAt, message: planned, appointment: live })).toBe(
      'appointment_over',
    );
    expect(
      cancelReasonForAppointment({
        now: new Date(startsAt.getTime() + 1),
        message: planned,
        appointment: live,
      }),
    ).toBe('appointment_over');
    expect(
      cancelReasonForAppointment({
        now: new Date(startsAt.getTime() - 1),
        message: planned,
        appointment: live,
      }),
    ).toBeNull();
  });

  it('cancels when the appointment moved or went to another patient since it was planned', () => {
    const moved = { ...live, startsAt: new Date('2031-05-14T13:00:00.000Z') };
    const reassigned = { ...live, patientId: 'patient-2' };

    expect(cancelReasonForAppointment({ now, message: planned, appointment: moved })).toBe(
      'appointment_changed',
    );
    expect(cancelReasonForAppointment({ now, message: planned, appointment: reassigned })).toBe(
      'appointment_changed',
    );
  });

  it('does not send for an appointment still waiting for approval', () => {
    expect(
      cancelReasonForAppointment({
        now,
        message: planned,
        appointment: { ...live, status: 'pending_approval' },
      }),
    ).toBe('appointment_changed');
  });

  it('has nothing to check for a message that is not about an appointment', () => {
    expect(
      cancelReasonForAppointment({
        now,
        message: { patientId: 'patient-1', plannedStartsAt: null },
        appointment: null,
        appointmentBound: false,
      }),
    ).toBeNull();
  });
});
