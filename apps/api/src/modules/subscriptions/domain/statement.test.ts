import { STATEMENT_COLLECTION_DELAY_DAYS, money } from '@consultorio/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { daysOfPeriod } from './periods.js';
import {
  buildStatement,
  collectAfter,
  mayCollect,
  type StatementPlan,
  type StatementProfessional,
} from './statement.js';

const PLAN: StatementPlan = {
  pricePerProfessionalCents: 1_800_000,
  whatsappQuotaPerProfessional: 200,
  overageUnitPriceCents: 5_000,
};

const MARCH = daysOfPeriod('2026-03');
const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1)}`);

const professional = (
  id: string,
  days: readonly string[] = MARCH,
  messages = 0,
): StatementProfessional => ({
  id,
  name: id.toUpperCase(),
  days,
  eventIds: ids(id, messages),
});

const build = (
  professionals: StatementProfessional[],
  overrides: { cap?: number; billingStartDay?: string } = {},
) =>
  buildStatement({
    period: '2026-03',
    plan: PLAN,
    billingStartDay: overrides.billingStartDay ?? '2026-01-01',
    overageCapMessages: overrides.cap ?? 1_000,
    professionals,
  });

describe('the statement of a period', () => {
  it('lists the professionals counted, the unit price and the total of a full month', () => {
    const statement = build([professional('a'), professional('b'), professional('c')]);

    expect(statement).toMatchObject({
      period: '2026-03',
      professionalsCounted: 3,
      baseCents: 5_400_000,
      overageUnits: 0,
      overageCents: 0,
      totalCents: 5_400_000,
    });
    expect(statement?.lines.map((line) => line.kind)).toEqual([
      'professional',
      'professional',
      'professional',
    ]);
  });

  it('prorates a professional who was active part of the month, by the day, to the cent', () => {
    const statement = build([professional('a'), professional('b', MARCH.slice(0, 10))]);

    // 10 of 31 days of 1.800.000 cents: 580.645,16 -> 580.645.
    expect(statement?.lines[1]).toMatchObject({
      kind: 'professional',
      days: 10,
      daysInPeriod: 31,
      amountCents: 580_645,
    });
    expect(statement?.baseCents).toBe(1_800_000 + 580_645);
  });

  it('does not bill the days of the trial, and bills nobody who was only in the trial', () => {
    const afterTrial = build([professional('a'), professional('b', MARCH.slice(0, 10))], {
      billingStartDay: '2026-03-11',
    });

    expect(afterTrial?.professionalsCounted).toBe(1);
    // 21 of 31 days.
    expect(afterTrial?.lines[0]).toMatchObject({ days: 21, amountCents: 1_219_355 });
    expect(build([professional('a', MARCH.slice(0, 5))], { billingStartDay: '2026-03-06' })).toBe(
      null,
    );
  });

  it('gives no statement when nobody was active', () => {
    expect(build([])).toBeNull();
  });

  it('bills the messages beyond the quota, traced to the counted messages and not to their text', () => {
    const statement = build([professional('a', MARCH, 230), professional('b', MARCH, 150)]);

    expect(statement?.overageUnits).toBe(30);
    expect(statement?.overageCents).toBe(150_000);
    expect(statement?.totalCents).toBe(3_600_000 + 150_000);
    const overage = statement?.lines.find((line) => line.kind === 'overage');
    expect(overage).toMatchObject({
      professionalId: 'a',
      quota: 200,
      used: 230,
      units: 30,
      unitPriceCents: 5_000,
      amountCents: 150_000,
    });
    // The 30 messages after the 200 of the quota, by id.
    expect(overage?.kind === 'overage' ? overage.eventIds : []).toEqual(ids('a', 230).slice(200));
  });

  it('prorates the quota of a professional who was active part of the month', () => {
    const statement = build([professional('a', MARCH.slice(0, 15), 120)]);

    // 15 of 31 days of 200 messages: 96,77 -> 97.
    const overage = statement?.lines.find((line) => line.kind === 'overage');
    expect(overage).toMatchObject({ quota: 97, used: 120, units: 23 });
  });

  it('gives quota for the days of the trial too', () => {
    const statement = build([professional('a', MARCH, 210)], { billingStartDay: '2026-03-16' });

    const overage = statement?.lines.find((line) => line.kind === 'overage');
    expect(overage).toMatchObject({ quota: 200, units: 10 });
  });

  it('never bills more overage messages than the cap of the organization, shared by the lines', () => {
    const statement = build([professional('a', MARCH, 250), professional('b', MARCH, 250)], {
      cap: 30,
    });

    expect(statement?.overageUnits).toBe(30);
    const units = statement?.lines.flatMap((line) => (line.kind === 'overage' ? [line.units] : []));
    expect(units).toEqual([15, 15]);
    expect(statement?.overageCents).toBe(30 * 5_000);
  });

  it('bills no overage at all when the cap is zero', () => {
    const statement = build([professional('a', MARCH, 500)], { cap: 0 });

    expect(statement?.overageUnits).toBe(0);
    expect(statement?.lines.every((line) => line.kind === 'professional')).toBe(true);
    expect(statement?.totalCents).toBe(1_800_000);
  });

  it('is deterministic: the order of the input does not change the statement', () => {
    const a = professional('a', MARCH, 230);
    const b = professional('b', MARCH.slice(0, 12), 90);

    expect(build([a, b])).toEqual(build([b, a]));
  });

  it('adds up: base plus overage is the total, and every line is in the totals', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            active: fc.integer({ min: 1, max: 31 }),
            messages: fc.integer({ min: 0, max: 400 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 0, max: 31 }),
        (specs, cap, trialDays) => {
          const professionals = specs.map((spec, index) =>
            professional(`p${String(index)}`, MARCH.slice(0, spec.active), spec.messages),
          );
          const statement = build(professionals, { cap, billingStartDay: MARCH[trialDays] });
          if (statement === null) return;
          const base = statement.lines.reduce(
            (sum, line) => sum + (line.kind === 'professional' ? line.amountCents : 0),
            0,
          );
          const overage = statement.lines.reduce(
            (sum, line) => sum + (line.kind === 'overage' ? line.amountCents : 0),
            0,
          );
          const units = statement.lines.reduce(
            (sum, line) => sum + (line.kind === 'overage' ? line.units : 0),
            0,
          );
          expect(statement.baseCents).toBe(base);
          expect(statement.overageCents).toBe(overage);
          expect(statement.totalCents).toBe(base + overage);
          expect(statement.overageUnits).toBe(units);
          expect(units).toBeLessThanOrEqual(cap);
          for (const line of statement.lines) {
            if (line.kind === 'overage') {
              expect(line.units).toBeLessThanOrEqual(line.used - line.quota);
              expect(line.eventIds).toHaveLength(line.units);
            }
          }
        },
      ),
    );
  });
});

describe('when a statement may be collected', () => {
  const published = new Date('2026-04-01T12:00:00.000Z');
  const statement = {
    publishedAt: published,
    collectAfter: collectAfter(published),
    totalCents: 5_400_000,
    collectedCents: 0,
  };

  it('waits the days the owner has to see it, after it was published', () => {
    expect(collectAfter(published).getTime() - published.getTime()).toBe(
      STATEMENT_COLLECTION_DELAY_DAYS * 86_400_000,
    );
    expect(STATEMENT_COLLECTION_DELAY_DAYS).toBeGreaterThanOrEqual(3);
  });

  it('refuses before the window, and allows from the instant it ends', () => {
    const justBefore = new Date(statement.collectAfter.getTime() - 1);

    expect(mayCollect(statement, justBefore, 5_400_000)).toEqual({
      allowed: false,
      reason: 'too_early',
    });
    expect(mayCollect(statement, statement.collectAfter, 5_400_000)).toEqual({
      allowed: true,
      maxCents: 5_400_000,
    });
  });

  it('refuses what was not published', () => {
    expect(
      mayCollect({ ...statement, publishedAt: null }, new Date('2030-01-01T00:00:00.000Z'), 1),
    ).toEqual({ allowed: false, reason: 'not_published' });
  });

  it('never takes the collected total above the statement total', () => {
    const later = new Date('2026-05-01T00:00:00.000Z');
    const partial = { ...statement, collectedCents: 5_000_000 };

    expect(mayCollect(partial, later, 400_000)).toEqual({ allowed: true, maxCents: 400_000 });
    expect(mayCollect(partial, later, 400_001)).toEqual({
      allowed: false,
      reason: 'nothing_left',
    });
    expect(mayCollect({ ...statement, collectedCents: 5_400_000 }, later, 1)).toEqual({
      allowed: false,
      reason: 'nothing_left',
    });
    expect(mayCollect(statement, later, 0)).toEqual({ allowed: false, reason: 'nothing_left' });
  });

  it('holds for any statement, instant and amount: collecting is allowed only when published, after the window, and within the total', () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 10 * 86_400_000 }), { nil: null }),
        fc.integer({ min: 0, max: 20 * 86_400_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: -10, max: 12_000_000 }),
        (publishedOffset, nowOffset, total, collectedRaw, amount) => {
          const base = new Date('2026-04-01T00:00:00.000Z').getTime();
          const publishedAt = publishedOffset === null ? null : new Date(base + publishedOffset);
          const collected = Math.min(collectedRaw, total);
          const now = new Date(base + nowOffset);
          const verdict = mayCollect(
            {
              publishedAt,
              collectAfter: collectAfter(publishedAt ?? new Date(base)),
              totalCents: money(total),
              collectedCents: collected,
            },
            now,
            amount,
          );
          if (verdict.allowed) {
            expect(publishedAt).not.toBeNull();
            expect(now.getTime()).toBeGreaterThanOrEqual(
              (publishedAt?.getTime() ?? 0) + STATEMENT_COLLECTION_DELAY_DAYS * 86_400_000,
            );
            expect(amount).toBeGreaterThan(0);
            expect(collected + amount).toBeLessThanOrEqual(total);
          }
        },
      ),
    );
  });
});
