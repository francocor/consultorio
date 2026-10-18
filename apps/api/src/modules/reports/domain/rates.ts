/**
 * Ratios of the reports, in basis points (1/100 of a percent): 1200 is 12.00%. Integers, so a rate
 * reads the same on the server, in the browser and in an export, with no float to round twice.
 */

/** `numerator / denominator` in basis points, rounded half up; null when there is nothing to divide by. */
export function ratioBp(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.floor((numerator * 20_000 + denominator) / (2 * denominator));
}

/**
 * The no-show rate (decision D9): no-show over attended plus no-show. Cancelled appointments and the
 * ones not yet in a final attendance state are not in either side; the caller counts them apart.
 * Null when no appointment reached a final state: "no data" is not "0%".
 */
export function noShowRateBp(counts: { attended: number; noShow: number }): number | null {
  return ratioBp(counts.noShow, counts.attended + counts.noShow);
}
