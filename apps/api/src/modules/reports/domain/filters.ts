import { REPORT_MAX_SPAN_DAYS, type FieldError } from '@consultorio/contracts';

/** A range of calendar days (`YYYY-MM-DD`), both ends included, read at each location's own zone. */
export interface DateRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

/** The number of days a range covers, counting both ends. */
export function spanInDays(range: DateRange): number {
  return (
    Math.round(
      (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS,
    ) + 1
  );
}

/**
 * What is wrong with a range, as a field and the key of its es-AR message (reports, "Filters and
 * period selection"): an inverted range, or a span longer than the documented maximum. Empty when
 * the range may run. The report never runs on a range that has a problem.
 */
export function rangeProblems(range: DateRange, maxDays = REPORT_MAX_SPAN_DAYS): FieldError[] {
  const days = spanInDays(range);
  if (days < 1) return [{ path: 'to', i18nKey: 'reports.range.inverted' }];
  if (days > maxDays) return [{ path: 'to', i18nKey: 'reports.range.too_long' }];
  return [];
}
