import type { Holiday, PayerSeed } from '@consultorio/contracts';
import { and, asc, eq, gte, lt } from 'drizzle-orm';

import { holidayCatalog, payer } from '../../db/schema/platform-catalogs.js';
import type { Db } from '../db/pool.js';

import type { CatalogReader } from './country-pack.js';

/**
 * Reads the platform catalogs. They carry no tenant data and no row level security, so these
 * queries run on the runtime connection without `withTenant`. A holiday the operator adds is
 * visible on the next call, which is what lets the catalog change without a release.
 */
export function createCatalogReader(db: Db): CatalogReader {
  return {
    async holidays(country, year): Promise<Holiday[]> {
      const rows = await db
        .select()
        .from(holidayCatalog)
        .where(
          and(
            eq(holidayCatalog.country, country),
            gte(holidayCatalog.date, `${String(year)}-01-01`),
            lt(holidayCatalog.date, `${String(year + 1)}-01-01`),
          ),
        )
        .orderBy(asc(holidayCatalog.date), asc(holidayCatalog.name));
      return rows.map((row) => ({
        country: row.country,
        date: row.date,
        name: row.name,
        kind: row.kind === 'bridge' ? 'bridge' : 'national',
      }));
    },

    async payers(country): Promise<PayerSeed[]> {
      const rows = await db
        .select()
        .from(payer)
        .where(and(eq(payer.country, country), eq(payer.active, true)))
        .orderBy(asc(payer.name));
      return rows.map((row) => ({
        country: row.country,
        code: row.code,
        name: row.name,
        kind: row.kind === 'obra_social' || row.kind === 'prepaga' ? row.kind : 'private',
      }));
    },
  };
}
