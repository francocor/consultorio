import { describe, expect, it } from 'vitest';

import {
  CreateBlockRequest,
  CreateDayOffRequest,
  CreateAppointmentTypeRequest,
  SetHoursPeriodRequest,
  UpdateAppointmentTypeRequest,
} from './scheduling-config.js';

const LOCATION = '0190a000-0000-7000-8000-0000000000aa';
const DOCTOR = '0190a000-0000-7000-8000-0000000000bb';

describe('appointment type contracts', () => {
  const valid = { name: 'First consultation', durationMinutes: 45, mode: 'in_person' } as const;

  it('accepts a type with only the required fields and fills the defaults', () => {
    const parsed = CreateAppointmentTypeRequest.parse(valid);

    expect(parsed).toMatchObject({
      bufferMinutes: 0,
      requiresApproval: false,
      professionalIds: [],
      specialties: [],
    });
  });

  it.each([0, -1, 1.5, 1441])('rejects a duration of %s minutes', (durationMinutes) => {
    expect(CreateAppointmentTypeRequest.safeParse({ ...valid, durationMinutes }).success).toBe(
      false,
    );
  });

  it('rejects a negative buffer, an unknown mode, a blank name and a colour that is not hex', () => {
    expect(CreateAppointmentTypeRequest.safeParse({ ...valid, bufferMinutes: -5 }).success).toBe(
      false,
    );
    expect(CreateAppointmentTypeRequest.safeParse({ ...valid, mode: 'phone' }).success).toBe(false);
    expect(CreateAppointmentTypeRequest.safeParse({ ...valid, name: '   ' }).success).toBe(false);
    expect(CreateAppointmentTypeRequest.safeParse({ ...valid, color: 'blue' }).success).toBe(false);
    expect(CreateAppointmentTypeRequest.safeParse({ ...valid, color: '#1D4ED8' }).success).toBe(
      true,
    );
  });

  it('refuses a field the client must not choose (the tenant, the active flag on create)', () => {
    expect(CreateAppointmentTypeRequest.safeParse({ ...valid, tenantId: LOCATION }).success).toBe(
      false,
    );
    expect(CreateAppointmentTypeRequest.safeParse({ ...valid, active: false }).success).toBe(false);
  });

  it('lets an update change one field and refuses an empty update', () => {
    expect(UpdateAppointmentTypeRequest.safeParse({ durationMinutes: 20 }).success).toBe(true);
    expect(UpdateAppointmentTypeRequest.safeParse({}).success).toBe(false);
    expect(UpdateAppointmentTypeRequest.safeParse({ durationMinutes: 0 }).success).toBe(false);
  });
});

describe('block contracts', () => {
  const valid = {
    professionalId: DOCTOR,
    startsAt: '2026-12-20T03:00:00-03:00',
    endsAt: '2026-12-31T03:00:00-03:00',
    reason: 'Vacation',
  };

  it('accepts a block for a professional, for a location, or for both', () => {
    expect(CreateBlockRequest.safeParse(valid).success).toBe(true);
    expect(
      CreateBlockRequest.safeParse({ ...valid, professionalId: undefined, locationId: LOCATION })
        .success,
    ).toBe(true);
    expect(CreateBlockRequest.safeParse({ ...valid, locationId: LOCATION }).success).toBe(true);
  });

  it('refuses a block that names neither, or ends before it starts', () => {
    expect(CreateBlockRequest.safeParse({ ...valid, professionalId: undefined }).success).toBe(
      false,
    );
    expect(CreateBlockRequest.safeParse({ ...valid, endsAt: valid.startsAt }).success).toBe(false);
    expect(
      CreateBlockRequest.safeParse({ ...valid, endsAt: '2026-12-19T03:00:00-03:00' }).success,
    ).toBe(false);
  });

  it('needs a reason and refuses an unreasonably long block', () => {
    expect(CreateBlockRequest.safeParse({ ...valid, reason: '' }).success).toBe(false);
    expect(
      CreateBlockRequest.safeParse({ ...valid, endsAt: '2028-12-31T03:00:00-03:00' }).success,
    ).toBe(false);
  });

  it('accepts a weekly recurrence by count or by end date, not both, and bounds the count', () => {
    const weekly = (extra: object) => ({ ...valid, recurrence: { frequency: 'weekly', ...extra } });

    expect(CreateBlockRequest.safeParse(weekly({ count: 8 })).success).toBe(true);
    expect(CreateBlockRequest.safeParse(weekly({ until: '2027-03-01' })).success).toBe(true);
    expect(CreateBlockRequest.safeParse(weekly({ count: 8, until: '2027-03-01' })).success).toBe(
      false,
    );
    expect(CreateBlockRequest.safeParse(weekly({})).success).toBe(false);
    expect(CreateBlockRequest.safeParse(weekly({ count: 1 })).success).toBe(false);
    expect(CreateBlockRequest.safeParse(weekly({ count: 105 })).success).toBe(false);
  });
});

describe('day off and hours period contracts', () => {
  it('accepts a day off for the organization or for one location', () => {
    expect(CreateDayOffRequest.safeParse({ day: '2026-09-17', name: 'Patron saint' }).success).toBe(
      true,
    );
    expect(
      CreateDayOffRequest.safeParse({ day: '2026-09-17', name: 'Closure', locationId: LOCATION })
        .success,
    ).toBe(true);
    expect(CreateDayOffRequest.safeParse({ day: '17/09/2026', name: 'x' }).success).toBe(false);
  });

  it('accepts a period with intervals, or an empty one that means "not working"', () => {
    const period = {
      dateFrom: '2026-12-01',
      dateTo: '2026-12-15',
      hours: [{ locationId: LOCATION, weekday: 1, start: '09:00', end: '13:00' }],
    };

    expect(SetHoursPeriodRequest.safeParse(period).success).toBe(true);
    expect(SetHoursPeriodRequest.safeParse({ ...period, hours: [] }).success).toBe(true);
  });

  it('refuses a period that ends before it starts or lasts more than a year', () => {
    const base = { hours: [] };

    expect(
      SetHoursPeriodRequest.safeParse({ ...base, dateFrom: '2026-12-15', dateTo: '2026-12-01' })
        .success,
    ).toBe(false);
    expect(
      SetHoursPeriodRequest.safeParse({ ...base, dateFrom: '2026-01-01', dateTo: '2027-06-01' })
        .success,
    ).toBe(false);
  });
});
