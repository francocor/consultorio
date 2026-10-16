import type { Holiday } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';

import type { Db } from '../../platform/db/pool.js';
import { holidayCatalog } from '../schema/platform-catalogs.js';

const COUNTRY = 'AR';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Year the data below was last checked against the official calendar. */
export const AR_HOLIDAYS_REVIEWED = '2026';

/**
 * Bridge days ("feriados puente con fines turisticos") declared by decree, per year. Nobody has
 * declared bridge days for 2027 and 2028 yet. The platform operator adds them to the catalog table
 * when they are published, with no release (country-rules-ar, "Catalog updated mid-year").
 */
const BRIDGE_DAYS: Readonly<Record<number, readonly string[]>> = {
  2026: ['2026-03-23', '2026-07-10', '2026-12-07'],
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Easter Sunday of a Gregorian year (Meeus/Jones/Butcher), as an ISO date. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(utc(year, month, day));
}

/**
 * Ley 27.399, article 6: a movable holiday that falls on a Tuesday or Wednesday moves to the
 * previous Monday, and one that falls on a Thursday or Friday moves to the following Monday.
 */
function moveToMonday(date: Date): Date {
  switch (date.getUTCDay()) {
    case 2:
      return addDays(date, -1);
    case 3:
      return addDays(date, -2);
    case 4:
      return addDays(date, 4);
    case 5:
      return addDays(date, 3);
    default:
      return date;
  }
}

const IMMOVABLE: readonly [month: number, day: number, name: string][] = [
  [1, 1, 'Año Nuevo'],
  [3, 24, 'Día Nacional de la Memoria por la Verdad y la Justicia'],
  [4, 2, 'Día del Veterano y de los Caídos en la Guerra de Malvinas'],
  [5, 1, 'Día del Trabajador'],
  [5, 25, 'Día de la Revolución de Mayo'],
  [6, 20, 'Paso a la Inmortalidad del General Manuel Belgrano'],
  [7, 9, 'Día de la Independencia'],
  [12, 8, 'Inmaculada Concepción de María'],
  [12, 25, 'Navidad'],
];

const MOVABLE: readonly [month: number, day: number, name: string][] = [
  [6, 17, 'Paso a la Inmortalidad del General Martín Miguel de Güemes'],
  [8, 17, 'Paso a la Inmortalidad del General José de San Martín'],
  [10, 12, 'Día del Respeto a la Diversidad Cultural'],
  [11, 20, 'Día de la Soberanía Nacional'],
];

const BRIDGE_NAME = 'Feriado puente turístico';

/** National holidays of Argentina for one year, sorted by date. Pure: no clock, no database. */
export function arHolidays(year: number): Holiday[] {
  const holiday = (date: Date | string, name: string, kind: Holiday['kind']): Holiday => ({
    country: COUNTRY,
    date: typeof date === 'string' ? date : isoDate(date),
    name,
    kind,
  });

  const easter = new Date(`${easterSunday(year)}T00:00:00Z`);
  const list: Holiday[] = [
    ...IMMOVABLE.map(([month, day, name]) => holiday(utc(year, month, day), name, 'national')),
    ...MOVABLE.map(([month, day, name]) =>
      holiday(moveToMonday(utc(year, month, day)), name, 'national'),
    ),
    holiday(addDays(easter, -48), 'Carnaval', 'national'),
    holiday(addDays(easter, -47), 'Carnaval', 'national'),
    holiday(addDays(easter, -2), 'Viernes Santo', 'national'),
    ...(BRIDGE_DAYS[year] ?? []).map((date) => holiday(date, BRIDGE_NAME, 'bridge')),
  ];

  return list.sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * Loads the holidays of the given years into the platform catalog. Idempotent: running it again
 * changes nothing, and an existing (country, date, name) only has its kind refreshed. Platform
 * tables are not writable by the runtime role, so this runs on the owner connection (seeding and
 * the operator console), never in a request.
 */
export async function seedArHolidays(db: Db, years: readonly number[]): Promise<void> {
  const rows = years.flatMap((year) => arHolidays(year));
  if (rows.length === 0) return;
  await db
    .insert(holidayCatalog)
    .values(rows)
    .onConflictDoUpdate({
      target: [holidayCatalog.country, holidayCatalog.date, holidayCatalog.name],
      set: { kind: sql`excluded.kind` },
    });
}
