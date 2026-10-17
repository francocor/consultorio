import type { Db } from '../../platform/db/pool.js';

import { seedArHolidays } from './ar-holidays.js';
import { seedArPayers } from './ar-payers.js';

/** Years of holidays kept loaded: last year (reports) up to two years ahead (scheduling). */
const YEARS_BEFORE = 1;
const YEARS_AFTER = 2;

/**
 * Loads the platform catalogs every organization reads: the Argentine payers and the holidays of
 * the years around today. Idempotent. Platform tables are not writable by the runtime role, so this
 * runs on the owner connection, after the migrations (`pnpm db:migrate`).
 */
export async function seedPlatformCatalogs(db: Db, now: Date = new Date()): Promise<void> {
  const year = now.getUTCFullYear();
  const years = Array.from(
    { length: YEARS_BEFORE + YEARS_AFTER + 1 },
    (_, index) => year - YEARS_BEFORE + index,
  );
  await seedArPayers(db);
  await seedArHolidays(db, years);
}
