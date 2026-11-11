import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createOwnerDb, type DbHandle } from '../../src/platform/db/pool.js';

let owner: DbHandle;

beforeAll(() => {
  owner = createOwnerDb(inject('ownerUrl'));
});

afterAll(async () => {
  await owner.close();
});

describe('seedPlatformCatalogs (run by db:migrate)', () => {
  it('loads the payers and the holidays of the years around today', async () => {
    await seedPlatformCatalogs(owner.db, new Date('2026-10-16T12:00:00Z'));

    const payers = await owner.db.execute<{ code: string }>(
      sql`select code from payer where code in ('osde', 'pami', 'particular') order by code`,
    );
    expect(payers.rows.map((row) => row.code)).toEqual(['osde', 'pami', 'particular']);
    const years = await owner.db.execute<{ year: number }>(
      sql`select distinct extract(year from date)::int as year from holiday_catalog order by 1`,
    );
    expect(years.rows.map((row) => row.year)).toEqual(
      expect.arrayContaining([2025, 2026, 2027, 2028]),
    );
  });

  it('is safe to run again', async () => {
    const count = async () =>
      (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from payer`)).rows[0]?.n;
    await seedPlatformCatalogs(owner.db, new Date('2026-10-16T12:00:00Z'));
    const before = await count();

    await seedPlatformCatalogs(owner.db, new Date('2026-10-16T12:00:00Z'));

    expect(await count()).toBe(before);
  });
});
