import { USAGE_WARNING_PERCENT, type UsageState } from '@consultorio/contracts';
import { DateTime } from 'luxon';

/**
 * The monthly WhatsApp quota of a professional (decision D6; spec "Quotas, usage and integration
 * switches"). Pure: counts and a limit in, a state and the thresholds out.
 */

/**
 * The calendar month of an instant as `YYYY-MM`: what usage is grouped and billed by. It is the
 * month of the organization, not of Greenwich: a message accepted at 22:00 of the last day of May
 * in Buenos Aires belongs to May. Without a zone it is UTC.
 */
export function periodOf(instant: Date, timeZone = 'UTC'): string {
  const zoned = DateTime.fromJSDate(instant, { zone: timeZone });
  return zoned.isValid ? zoned.toFormat('yyyy-MM') : instant.toISOString().slice(0, 7);
}

export function usageState(count: number, limit: number | null): UsageState {
  if (limit === null) return 'unlimited';
  if (count >= limit) return 'exhausted';
  return count * 100 >= limit * USAGE_WARNING_PERCENT ? 'warning' : 'ok';
}

/** The alert thresholds (80 and 100) that the count has reached, lowest first. */
export function thresholdsReached(count: number, limit: number | null): (80 | 100)[] {
  if (limit === null) return [];
  const reached: (80 | 100)[] = [];
  if (count * 100 >= limit * USAGE_WARNING_PERCENT) reached.push(80);
  if (count >= limit) reached.push(100);
  return reached;
}
