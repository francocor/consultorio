import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  countActiveProfessionals,
  isActiveProfessional,
  takesProfessionalSeat,
  type ProfessionalSeatFacts,
} from './active-professional.js';
import {
  dayOf,
  daysBetween,
  daysLeftIncludingToday,
  daysOfPeriod,
  endOfPeriodOf,
  nextPeriod,
  periodBounds,
  periodOf,
  previousPeriod,
} from './periods.js';
import { checkProfessionalSeats, professionalImpact, type PlanLimits } from './plan-limits.js';
import { proratedPrice, splitPrice } from './proration.js';

const professional = (overrides: Partial<ProfessionalSeatFacts> = {}): ProfessionalSeatFacts => ({
  membershipStatus: 'active',
  roles: ['professional'],
  profileStatus: 'active',
  ...overrides,
});

describe('who counts as an active professional', () => {
  it('counts 2 professionals, 4 reception users and 1 admin as 2', () => {
    const members: ProfessionalSeatFacts[] = [
      professional(),
      professional({ roles: ['professional', 'admin'] }),
      ...Array.from({ length: 4 }, () =>
        professional({ roles: ['reception'], profileStatus: null }),
      ),
      professional({ roles: ['admin'], profileStatus: null }),
    ];

    expect(countActiveProfessionals(members)).toBe(2);
  });

  it('does not count a deactivated member, a professional without an enabled profile or one without a profile', () => {
    expect(isActiveProfessional(professional({ membershipStatus: 'deactivated' }))).toBe(false);
    expect(isActiveProfessional(professional({ profileStatus: 'inactive' }))).toBe(false);
    expect(isActiveProfessional(professional({ profileStatus: null }))).toBe(false);
    expect(isActiveProfessional(professional())).toBe(true);
  });

  it('counts an owner who is also a professional, and not an owner who is not', () => {
    expect(isActiveProfessional(professional({ roles: ['owner', 'professional'] }))).toBe(true);
    expect(isActiveProfessional(professional({ roles: ['owner'], profileStatus: null }))).toBe(
      false,
    );
  });

  it('takes a priced seat only for the professional role', () => {
    expect(takesProfessionalSeat(['professional'])).toBe(true);
    expect(takesProfessionalSeat(['owner', 'professional'])).toBe(true);
    expect(takesProfessionalSeat(['reception'])).toBe(false);
    expect(takesProfessionalSeat(['admin'])).toBe(false);
  });
});

describe('the billing calendar', () => {
  it('puts an instant in the month and the day of Buenos Aires, not of Greenwich', () => {
    // 01:30 UTC of the 1st of November is still the 31st of October in Argentina (UTC-3).
    const instant = new Date('2026-11-01T01:30:00.000Z');

    expect(periodOf(instant)).toBe('2026-10');
    expect(dayOf(instant)).toBe('2026-10-31');
    expect(periodOf(new Date('2026-11-01T03:00:00.000Z'))).toBe('2026-11');
  });

  it('bounds a period by the start of the month and the start of the next one', () => {
    const october = periodBounds('2026-10');
    const february = periodBounds('2028-02');

    expect(october.start.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(october.end.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(october.days).toBe(31);
    expect(february.days).toBe(29);
    expect(() => periodBounds('2026-13')).toThrow(RangeError);
  });

  it('walks to the next and the previous period, over a year', () => {
    expect(nextPeriod('2026-12')).toBe('2027-01');
    expect(previousPeriod('2027-01')).toBe('2026-12');
    expect(previousPeriod('2026-03')).toBe('2026-02');
    expect(endOfPeriodOf(new Date('2026-10-20T15:00:00.000Z')).toISOString()).toBe(
      '2026-11-01T03:00:00.000Z',
    );
  });

  it('counts the days left of a period including today', () => {
    expect(daysLeftIncludingToday(new Date('2026-10-20T15:00:00.000Z'))).toBe(12);
    expect(daysLeftIncludingToday(new Date('2026-10-31T20:00:00.000Z'))).toBe(1);
    expect(daysLeftIncludingToday(new Date('2026-10-01T04:00:00.000Z'))).toBe(31);
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31);
  });

  it('lists the days of a period in order', () => {
    const days = daysOfPeriod('2026-02');

    expect(days).toHaveLength(28);
    expect(days[0]).toBe('2026-02-01');
    expect(days[27]).toBe('2026-02-28');
  });
});

describe('the proration of a professional who is active part of a period', () => {
  it('charges the whole price for the whole period and nothing for no days', () => {
    expect(proratedPrice(1_800_000, 31, 31)).toBe(1_800_000);
    expect(proratedPrice(1_800_000, 0, 31)).toBe(0);
  });

  it('charges a share by the day: 12 of 31 days of ARS 18.000,00', () => {
    // 1,800,000 * 12 / 31 = 696,774.19... -> 696,774 and the cent that is left goes to the larger remainder.
    expect(proratedPrice(1_800_000, 12, 31)).toBe(696_774);
    expect(proratedPrice(1_800_000, 19, 31)).toBe(1_103_226);
    expect(proratedPrice(1_800_000, 12, 31) + proratedPrice(1_800_000, 19, 31)).toBe(1_800_000);
  });

  it('refuses a number of days that no period has', () => {
    expect(() => proratedPrice(100, 32, 31)).toThrow(RangeError);
    expect(() => proratedPrice(100, -1, 31)).toThrow(RangeError);
    expect(() => proratedPrice(100, 1, 0)).toThrow(RangeError);
    expect(() => proratedPrice(10.5, 1, 31)).toThrow(RangeError);
  });

  it('property: the days a professional was active and the days they were not split the price to the cent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 28, max: 31 }),
        fc.integer({ min: 0, max: 31 }),
        (price, daysInPeriod, requested) => {
          const active = Math.min(requested, daysInPeriod);
          const [share, rest] = splitPrice(price, [active, daysInPeriod - active]);

          expect((share ?? 0) + (rest ?? 0)).toBe(price);
          expect(proratedPrice(price, active, daysInPeriod)).toBe(share);
        },
      ),
    );
  });

  it('property: cutting a period into any stretches gives parts that sum to the price of the period', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 8 }),
        (price, stretches) => {
          const parts = splitPrice(price, stretches);

          expect(parts.reduce((sum, part) => sum + part, 0)).toBe(price);
          for (const part of parts) expect(part).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('the plan limit and the impact of adding a professional', () => {
  const plan: PlanLimits = { pricePerProfessionalCents: 1_800_000, maxActiveProfessionals: 3 };

  it('refuses a fourth professional on a plan of three, with the numbers for the upgrade path', () => {
    expect(checkProfessionalSeats(plan, 3)).toEqual({
      allowed: false,
      reason: 'professional_limit',
      limit: 3,
      current: 3,
    });
    expect(checkProfessionalSeats(plan, 2)).toEqual({ allowed: true });
    expect(checkProfessionalSeats(plan, 2, 2).allowed).toBe(false);
  });

  it('shows the price change and the proration of the rest of the period before the owner confirms', () => {
    const impact = professionalImpact({
      plan,
      activeNow: 2,
      additional: 1,
      daysLeft: 12,
      daysInPeriod: 31,
    });

    expect(impact.monthlyCents).toEqual({ now: 3_600_000, after: 5_400_000 });
    expect(impact.monthlyDifferenceCents).toBe(1_800_000);
    expect(impact.proratedThisPeriodCents).toBe(696_774);
    expect(impact.activeProfessionals).toEqual({ now: 2, after: 3 });
    expect(impact.limit).toEqual({ max: 3, reached: false });
  });

  it('says the limit is reached when the change would pass it', () => {
    const impact = professionalImpact({
      plan,
      activeNow: 3,
      additional: 1,
      daysLeft: 31,
      daysInPeriod: 31,
    });

    expect(impact.limit).toEqual({ max: 3, reached: true });
    expect(impact.proratedThisPeriodCents).toBe(1_800_000);
  });
});
