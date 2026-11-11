import { allocateProportional, money, type Money } from '@consultorio/contracts';

/**
 * How a professional who is active for part of a period is charged (subscriptions, "Per-active-
 * professional pricing"; documented in `docs/billing-model.md` and shown to the owner before they
 * confirm a change).
 *
 * The rule: the monthly price is split over the days of the period, a day at a time. A professional
 * who is active `activeDays` of the `daysInPeriod` pays that share of the price, in whole cents. The
 * split uses the allocation of money (largest remainder, ties to the earliest part), so the days a
 * professional was active and the days they were not always add up to the price of the period, to
 * the cent, however the days are cut.
 */
export function proratedPrice(priceCents: number, activeDays: number, daysInPeriod: number): Money {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
    throw new RangeError('A price is a whole number of cents, zero or more.');
  }
  if (!Number.isInteger(daysInPeriod) || daysInPeriod < 1) {
    throw new RangeError('A period has at least one day.');
  }
  if (!Number.isInteger(activeDays) || activeDays < 0 || activeDays > daysInPeriod) {
    throw new RangeError('The active days are between zero and the days of the period.');
  }
  if (activeDays === 0) return money(0);
  const [share] = allocateProportional(money(priceCents), [activeDays, daysInPeriod - activeDays]);
  return share ?? money(0);
}

/**
 * Cuts the price of a period over spans of days (one per professional, or one per stretch of a
 * professional's period). The parts add up to the price of the days they cover.
 */
export function splitPrice(priceCents: number, days: readonly number[]): Money[] {
  return allocateProportional(money(priceCents), days);
}
