import { REPORT_MAX_SPAN_DAYS, type OperationalReportResponse } from '@consultorio/contracts';

import { DEFAULT_TIME_ZONE } from '../../../shared/lib/format.js';

export interface Period {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

/** The calendar day an instant is, at the clinic (never the browser's zone), as `YYYY-MM-DD`. */
function dayAtClinic(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The month the report opens on: the first to the last day of the month `now` falls in, at the clinic. */
export function currentMonth(now: Date): Period {
  const today = dayAtClinic(now);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = today.slice(0, 7);
  return { from: `${prefix}-01`, to: `${prefix}-${String(last).padStart(2, '0')}` };
}

export type RangeIssue = 'missing' | 'inverted' | 'too_long';

/**
 * What is wrong with a range, if anything, so the filter bar can say it before asking. The server
 * checks the same two rules (a report never runs on a range it refuses).
 */
export function rangeIssue(range: Period): RangeIssue | null {
  if (range.from === '' || range.to === '') return 'missing';
  const days =
    Math.round(
      (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS,
    ) + 1;
  if (days < 1) return 'inverted';
  return days > REPORT_MAX_SPAN_DAYS ? 'too_long' : null;
}

type Day = OperationalReportResponse['byDay'][number];

export interface SeriesRow {
  /** `YYYY-MM-DD` for a day, `YYYY-MM` for a month. */
  key: string;
  total: number;
  attended: number;
  noShow: number;
  cancelled: number;
}

/**
 * The days of a report as a series for a chart and its table: one row per day, or one per month when
 * the days reach over more than two months (a bar per day of a year cannot be read on a phone).
 */
export function groupDays(days: readonly Day[]): { unit: 'day' | 'month'; rows: SeriesRow[] } {
  const first = days[0]?.date;
  const last = days.at(-1)?.date;
  const months =
    first && last
      ? (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
        Number(last.slice(5, 7)) -
        Number(first.slice(5, 7)) +
        1
      : 0;
  if (months <= 2) {
    return {
      unit: 'day',
      rows: days.map(({ date, total, attended, noShow, cancelled }) => ({
        key: date,
        total,
        attended,
        noShow,
        cancelled,
      })),
    };
  }
  const byMonth = new Map<string, SeriesRow>();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    const row = byMonth.get(key) ?? { key, total: 0, attended: 0, noShow: 0, cancelled: 0 };
    row.total += day.total;
    row.attended += day.attended;
    row.noShow += day.noShow;
    row.cancelled += day.cancelled;
    byMonth.set(key, row);
  }
  return { unit: 'month', rows: [...byMonth.values()] };
}
