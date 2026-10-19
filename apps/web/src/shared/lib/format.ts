import { formatArs, parseArs, type Money } from '@consultorio/contracts';

/**
 * Locale-aware formatting for the whole app. Everything goes through `Intl` with `es-AR`, and
 * dates and times are shown in the time zone of the location (never the browser's), so a
 * professional travelling or a misconfigured device does not move an appointment.
 */

export const LOCALE = 'es-AR';
export const DEFAULT_TIME_ZONE = 'America/Argentina/Buenos_Aires';

export interface DateFormatOptions {
  timeZone?: string;
}

const MISSING = '-';

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A date-only value (a birth date) is a calendar day, not an instant: it must not shift by zone. */
function toCalendarDay(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateFormatter(options: Intl.DateTimeFormatOptions, zone: string | undefined) {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: zone ?? DEFAULT_TIME_ZONE, ...options });
}

/** `04/03/2026` */
export function formatDate(
  value: string | Date | null | undefined,
  options: DateFormatOptions = {},
): string {
  const date = toDate(value);
  return date
    ? dateFormatter({ day: '2-digit', month: '2-digit', year: 'numeric' }, options.timeZone).format(
        date,
      )
    : MISSING;
}

/** `23:30` (24-hour clock) */
export function formatTime(
  value: string | Date | null | undefined,
  options: DateFormatOptions = {},
): string {
  const date = toDate(value);
  return date
    ? dateFormatter(
        { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
        options.timeZone,
      ).format(date)
    : MISSING;
}

/** `04/03/2026, 23:30` */
export function formatDateTime(
  value: string | Date | null | undefined,
  options: DateFormatOptions = {},
): string {
  const date = toDate(value);
  return date
    ? dateFormatter(
        {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        },
        options.timeZone,
      ).format(date)
    : MISSING;
}

/** A birth date or another calendar day, shown without time zone conversion. */
export function formatCalendarDay(value: string | null | undefined): string {
  const date = toCalendarDay(value);
  return date
    ? new Intl.DateTimeFormat(LOCALE, {
        timeZone: 'UTC',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(date)
    : MISSING;
}

/**
 * `$ 1.234,50`. An amount is whole cents of ARS (the `Money` type of the contracts), the same text
 * the server writes in exports and invoices; there is no decimal-peso variant on purpose.
 */
export function formatMoney(amount: Money): string {
  return formatArs(amount);
}

/** What a person typed in an amount field (`1.234,50`), as cents; `null` when it is not an amount. */
export function parseMoney(text: string): Money | null {
  return parseArs(text);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

export type DocumentKind = 'dni' | 'passport' | 'cuit';

/** Groups an identity document the way people write it: `12.345.678`, `20-12345678-6`. */
export function formatDocument(kind: DocumentKind, value: string): string {
  if (kind === 'passport') return value.toUpperCase();
  const digits = value.replace(/\D/g, '');
  if (kind === 'cuit') {
    return digits.length === 11
      ? `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`
      : digits;
  }
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** `36 años`, or `3 meses` for a child under one year. Empty when the birth date is unknown. */
export function formatAge(birthDate: string | null | undefined, now: Date = new Date()): string {
  const born = toCalendarDay(birthDate);
  if (!born) return '';
  let months =
    (now.getUTCFullYear() - born.getUTCFullYear()) * 12 + (now.getUTCMonth() - born.getUTCMonth());
  if (now.getUTCDate() < born.getUTCDate()) months -= 1;
  if (months < 0) return '';
  const unit = months < 12 ? 'month' : 'year';
  const value = months < 12 ? months : Math.floor(months / 12);
  return new Intl.NumberFormat(LOCALE, {
    style: 'unit',
    unit,
    unitDisplay: 'long',
  }).format(value);
}

function dayParts(date: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const day = toCalendarDay(date);
  if (!day) return {};
  const parts = new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', ...options }).formatToParts(day);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** `sábado 17 de octubre` for a calendar day (`YYYY-MM-DD`). */
export function formatDayLong(date: string): string {
  const parts = dayParts(date, { weekday: 'long', day: 'numeric', month: 'long' });
  return parts['weekday']
    ? `${parts['weekday']} ${parts['day'] ?? ''} de ${parts['month'] ?? ''}`
    : MISSING;
}

/** `17 oct` */
export function formatDayShort(date: string): string {
  const parts = dayParts(date, { day: 'numeric', month: 'short' });
  return parts['day'] ? `${parts['day']} ${(parts['month'] ?? '').replace('.', '')}` : MISSING;
}

/** `sáb` */
export function formatWeekdayShort(date: string): string {
  const parts = dayParts(date, { weekday: 'short' });
  return (parts['weekday'] ?? MISSING).replace('.', '');
}

/** `octubre de 2026` */
export function formatMonthYear(date: string): string {
  const parts = dayParts(date, { month: 'long', year: 'numeric' });
  return parts['month'] ? `${parts['month']} de ${parts['year'] ?? ''}` : MISSING;
}
