import { APPOINTMENT_STATUSES, type AppointmentStatus } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildOperationalReport, type OperationalFacts } from './operational.js';

const LOCATION = '0190a000-0000-7000-8000-00000000000a';
const PROFESSIONAL = '0190a000-0000-7000-8000-0000000000d1';

const FILTERS = {
  from: '2031-05-01',
  to: '2031-05-31',
  locationId: null,
  professionalId: null,
  specialty: null,
  scope: 'organization' as const,
};

function statuses(counts: Partial<Record<AppointmentStatus, number>>) {
  return Object.fromEntries(
    APPOINTMENT_STATUSES.map((status) => [status, counts[status] ?? 0]),
  ) as Record<AppointmentStatus, number>;
}

function facts(overrides: Partial<OperationalFacts> = {}): OperationalFacts {
  return {
    byStatus: statuses({}),
    sources: { staff: 0, online: 0, waitlistOffer: 0 },
    bookedMinutes: 0,
    notFinalPast: 0,
    rescheduled: 0,
    confirmedByPatient: 0,
    recovered: 0,
    patients: { new: 0, returning: 0 },
    byDay: [],
    byLocation: [],
    byProfessional: [],
    bySpecialty: [],
    ...overrides,
  };
}

function report(overrides: Partial<OperationalFacts> = {}, availableMinutes = 0) {
  return buildOperationalReport({
    filters: FILTERS,
    generatedAt: new Date('2031-06-01T12:00:00.000Z'),
    facts: facts(overrides),
    availableMinutes,
  });
}

describe('buildOperationalReport: the no-show rate (D9)', () => {
  it('is 12% for 88 attended and 12 no-show appointments', () => {
    const result = report({ byStatus: statuses({ attended: 88, no_show: 12 }) });

    expect(result.noShow).toMatchObject({ attended: 88, noShow: 12, rateBp: 1200 });
    expect(result.totalAppointments).toBe(100);
  });

  it('does not move when 30 cancellations join the month, and shows them apart', () => {
    const result = report({ byStatus: statuses({ attended: 88, no_show: 12, cancelled: 30 }) });

    expect(result.noShow.rateBp).toBe(1200);
    expect(result.noShow.excluded.cancelled).toBe(30);
    expect(result.byStatus.cancelled).toBe(30);
    expect(result.totalAppointments).toBe(130);
  });

  it('leaves out, and counts, the appointments that are not in a final state yet', () => {
    const result = report({
      byStatus: statuses({
        attended: 8,
        no_show: 2,
        pending_approval: 1,
        scheduled: 4,
        confirmed: 2,
        checked_in: 1,
        in_progress: 1,
      }),
      notFinalPast: 3,
    });

    expect(result.noShow.rateBp).toBe(2000);
    expect(result.noShow.excluded).toEqual({ cancelled: 0, notFinal: 9, notFinalPast: 3 });
  });

  it('has no rate, which is not 0%, when nothing reached a final state', () => {
    const result = report({ byStatus: statuses({ scheduled: 4, cancelled: 2 }) });

    expect(result.noShow.rateBp).toBeNull();
    expect(result.noShow.excluded).toMatchObject({ cancelled: 2, notFinal: 4 });
  });

  it('counts moved appointments as what they are now, plus the derived rescheduled figure', () => {
    const result = report({ byStatus: statuses({ attended: 10 }), rescheduled: 10 });

    expect(result.byStatus.attended).toBe(10);
    expect(result.rescheduled).toBe(10);
    expect(Object.keys(result.byStatus)).not.toContain('rescheduled');
  });
});

describe('buildOperationalReport: occupancy, sources, patients, confirmations', () => {
  it('is the booked minutes over the available ones', () => {
    expect(report({ bookedMinutes: 90 }, 240).occupancy).toEqual({
      bookedMinutes: 90,
      availableMinutes: 240,
      rateBp: 3750,
    });
  });

  it('never goes over 100% (an appointment out of hours is still booked time)', () => {
    expect(report({ bookedMinutes: 300 }, 240).occupancy.rateBp).toBe(10000);
  });

  it('has no occupancy when nobody has working hours in the period', () => {
    expect(report({ bookedMinutes: 60 }, 0).occupancy).toEqual({
      bookedMinutes: 60,
      availableMinutes: 0,
      rateBp: null,
    });
  });

  it('shows the share of online bookings over all the appointments of the period', () => {
    const result = report({
      byStatus: statuses({ attended: 7, cancelled: 3 }),
      sources: { staff: 6, online: 3, waitlistOffer: 1 },
    });

    expect(result.sources).toEqual({ staff: 6, online: 3, waitlistOffer: 1, onlineShareBp: 3000 });
  });

  it('has no online share in an empty period', () => {
    expect(report().sources.onlineShareBp).toBeNull();
  });

  it('carries the slots recovered through the waitlist and the new versus returning patients', () => {
    const result = report({ recovered: 4, patients: { new: 12, returning: 30 } });

    expect(result.waitlist).toEqual({ recoveredSlots: 4 });
    expect(result.patients).toEqual({ new: 12, returning: 30 });
  });

  it('rates the confirmations over the appointments that were not cancelled', () => {
    const result = report({
      byStatus: statuses({ attended: 6, scheduled: 2, cancelled: 2 }),
      confirmedByPatient: 2,
    });

    expect(result.confirmations).toEqual({ confirmedByPatient: 2, rateBp: 2500 });
    expect(report().confirmations.rateBp).toBeNull();
  });
});

describe('buildOperationalReport: breakdowns', () => {
  it('give each row its own no-show rate from its own attended and no-show', () => {
    const result = report({
      byDay: [
        { date: '2031-05-12', total: 10, attended: 6, noShow: 2, cancelled: 2 },
        { date: '2031-05-13', total: 2, attended: 0, noShow: 0, cancelled: 2 },
      ],
      byLocation: [
        { locationId: LOCATION, name: 'Centro', total: 4, attended: 3, noShow: 1, cancelled: 0 },
      ],
      byProfessional: [
        {
          professionalId: PROFESSIONAL,
          name: null,
          total: 1,
          attended: 1,
          noShow: 0,
          cancelled: 0,
        },
      ],
      bySpecialty: [{ specialty: 'clinica', total: 5, attended: 4, noShow: 1, cancelled: 0 }],
    });

    expect(result.byDay.map((row) => row.noShowRateBp)).toEqual([2500, null]);
    expect(result.byLocation[0]).toMatchObject({ name: 'Centro', noShowRateBp: 2500 });
    expect(result.byProfessional[0]).toMatchObject({ name: null, noShowRateBp: 0 });
    expect(result.bySpecialty[0]).toMatchObject({ specialty: 'clinica', noShowRateBp: 2000 });
  });

  it('echoes the filters it was cut with and the moment it was made', () => {
    const result = report();

    expect(result.filters).toEqual(FILTERS);
    expect(result.generatedAt).toBe('2031-06-01T12:00:00.000Z');
  });
});
