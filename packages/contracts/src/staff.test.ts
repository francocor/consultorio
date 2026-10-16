import { describe, expect, it } from 'vitest';

import {
  InviteStaffRequest,
  ProfessionalProfileRequest,
  SetWeeklyHoursRequest,
  StaffMemberDto,
  WeeklyInterval,
} from './staff.js';

const LOCATION = '0190a000-0000-7000-8000-0000000000aa';

describe('staff contracts', () => {
  it('cannot even name the verification of a matricula', () => {
    const request = {
      fullName: 'Ana Pérez',
      specialties: ['nutrition'],
      matricula: { jurisdiction: 'AR-B', number: '12345' },
    };

    expect(ProfessionalProfileRequest.safeParse(request).success).toBe(true);
    expect(
      ProfessionalProfileRequest.safeParse({ ...request, matriculaStatus: 'verified' }).success,
    ).toBe(false);
    expect(
      ProfessionalProfileRequest.safeParse({
        ...request,
        matricula: { ...request.matricula, status: 'verified' },
      }).success,
    ).toBe(false);
    expect(
      ProfessionalProfileRequest.safeParse({ ...request, verifiedByOperator: 'x' }).success,
    ).toBe(false);
  });

  it('keeps several specialties, refuses none and refuses repeats', () => {
    const base = { fullName: 'Ana', matricula: null };

    expect(
      ProfessionalProfileRequest.safeParse({ ...base, specialties: ['medicine', 'nutrition'] })
        .success,
    ).toBe(true);
    expect(ProfessionalProfileRequest.safeParse({ ...base, specialties: [] }).success).toBe(false);
    expect(
      ProfessionalProfileRequest.safeParse({ ...base, specialties: ['Medicine', 'medicine'] })
        .success,
    ).toBe(false);
  });

  it('takes roles and email in an invitation, never a password or a tenant', () => {
    expect(
      InviteStaffRequest.safeParse({ email: ' Ana@Clinica.example ', roles: ['reception'] }).data,
    ).toEqual({ email: 'Ana@Clinica.example', roles: ['reception'] });
    expect(
      InviteStaffRequest.safeParse({ email: 'a@b.example', roles: ['reception'], password: 'x' })
        .success,
    ).toBe(false);
    expect(InviteStaffRequest.safeParse({ email: 'a@b.example', roles: ['patient'] }).success).toBe(
      false,
    );
    expect(InviteStaffRequest.safeParse({ email: 'nope', roles: ['reception'] }).success).toBe(
      false,
    );
  });

  it('describes a directory row with private fields that may be null', () => {
    const row = StaffMemberDto.parse({
      membershipId: LOCATION,
      displayName: 'Ana',
      roles: ['reception'],
      status: 'active',
      email: null,
      locations: [],
      professional: null,
    });

    expect(row.email).toBeNull();
  });
});

describe('weekly hours', () => {
  const interval = { locationId: LOCATION, weekday: 1, start: '09:00', end: '13:00' };

  it('accepts an interval and an end at midnight', () => {
    expect(WeeklyInterval.safeParse(interval).success).toBe(true);
    expect(WeeklyInterval.safeParse({ ...interval, end: '24:00' }).success).toBe(true);
  });

  it.each([
    { weekday: 0 },
    { weekday: 8 },
    { start: '9:00' },
    { start: '25:00' },
    { end: '13:60' },
    { locationId: 'x' },
  ])('refuses %j', (patch) => {
    expect(WeeklyInterval.safeParse({ ...interval, ...patch }).success).toBe(false);
  });

  it('replaces the whole schedule, and may be empty', () => {
    expect(SetWeeklyHoursRequest.safeParse({ hours: [] }).success).toBe(true);
    expect(SetWeeklyHoursRequest.safeParse({ hours: [interval] }).success).toBe(true);
  });
});
