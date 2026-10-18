import { DEFAULT_ONLINE_BOOKING_SETTINGS } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { draftOf, patchOf, validateRules, type RulesDraft } from './rules-form.js';

const draft = (overrides: Partial<RulesDraft> = {}): RulesDraft => ({
  ...draftOf(DEFAULT_ONLINE_BOOKING_SETTINGS),
  ...overrides,
});

describe('the draft of the rules', () => {
  it('writes every number as text and an empty cap as nothing', () => {
    expect(draftOf(DEFAULT_ONLINE_BOOKING_SETTINGS)).toEqual({
      minLeadHours: '2',
      horizonDays: '60',
      dailyCap: '',
      rescheduleDeadlineHours: '12',
      requireApproval: false,
    });
    expect(draftOf({ ...DEFAULT_ONLINE_BOOKING_SETTINGS, dailyCap: 30 }).dailyCap).toBe('30');
  });
});

describe('validateRules', () => {
  it('reads the numbers back, with no cap as null', () => {
    const result = validateRules(draft({ horizonDays: ' 90 ', dailyCap: '' }));

    expect(result.values).toEqual({
      ...DEFAULT_ONLINE_BOOKING_SETTINGS,
      horizonDays: 90,
      dailyCap: null,
    });
    expect(result.errors).toEqual({});
  });

  it.each([
    ['minLeadHours', '', 'bookingAdmin:rules.error.lead'],
    ['minLeadHours', '-1', 'bookingAdmin:rules.error.lead'],
    ['minLeadHours', '337', 'bookingAdmin:rules.error.lead'],
    ['minLeadHours', '1.5', 'bookingAdmin:rules.error.lead'],
    ['horizonDays', '0', 'bookingAdmin:rules.error.horizon'],
    ['horizonDays', '366', 'bookingAdmin:rules.error.horizon'],
    ['horizonDays', 'diez', 'bookingAdmin:rules.error.horizon'],
    ['dailyCap', '0', 'bookingAdmin:rules.error.cap'],
    ['dailyCap', '501', 'bookingAdmin:rules.error.cap'],
    ['dailyCap', 'x', 'bookingAdmin:rules.error.cap'],
    ['rescheduleDeadlineHours', '', 'bookingAdmin:rules.error.deadline'],
    ['rescheduleDeadlineHours', '400', 'bookingAdmin:rules.error.deadline'],
  ] as const)('refuses %s = "%s"', (field, value, key) => {
    const result = validateRules(draft({ [field]: value }));

    expect(result.values).toBeNull();
    expect(result.errors[field]).toBe(key);
  });

  it('accepts the edges of every range', () => {
    expect(
      validateRules(
        draft({
          minLeadHours: '0',
          horizonDays: '365',
          dailyCap: '500',
          rescheduleDeadlineHours: '336',
        }),
      ).values,
    ).toMatchObject({
      minLeadHours: 0,
      horizonDays: 365,
      dailyCap: 500,
      rescheduleDeadlineHours: 336,
    });
  });
});

describe('patchOf', () => {
  it('sends only what changed, so an audited setting is not rewritten by saving another one', () => {
    const current = DEFAULT_ONLINE_BOOKING_SETTINGS;

    expect(patchOf(current, { ...current, horizonDays: 90 })).toEqual({ horizonDays: 90 });
    expect(patchOf(current, { ...current, dailyCap: 8, requireApproval: true })).toEqual({
      dailyCap: 8,
      requireApproval: true,
    });
    expect(patchOf(current, { ...current, dailyCap: null })).toBeNull();
  });

  it('can take a cap away again', () => {
    expect(
      patchOf({ ...DEFAULT_ONLINE_BOOKING_SETTINGS, dailyCap: 8 }, DEFAULT_ONLINE_BOOKING_SETTINGS),
    ).toEqual({ dailyCap: null });
  });
});
