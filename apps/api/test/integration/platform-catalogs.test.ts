import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { seedArHolidays } from '../../src/db/seed/ar-holidays.js';
import { arPayers, seedArPayers } from '../../src/db/seed/ar-payers.js';
import { createCatalogReader } from '../../src/platform/country/catalog-reader.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';

let owner: DbHandle;
let runtime: DbHandle;

/** Other test files add their own payers to the shared database, so only the seeded ones are counted. */
const seededCodes = new Set(arPayers.map((payer) => payer.code));

beforeAll(async () => {
  owner = createOwnerDb(inject('ownerUrl'));
  runtime = createRuntimeDb(inject('runtimeUrl'));
  await seedArHolidays(owner.db, [2026, 2027, 2028]);
  await seedArPayers(owner.db);
});

afterAll(async () => {
  await Promise.all([owner.close(), runtime.close()]);
});

async function count(table: 'holiday_catalog' | 'payer'): Promise<number> {
  const result = await owner.db.execute<{ n: number }>(
    sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
  );
  return result.rows[0]?.n ?? -1;
}

describe('uuid v7 default', () => {
  it('generates version 7 ids that sort by creation time', async () => {
    const first = await owner.db.execute<{ id: string }>(sql`SELECT app.uuid_v7()::text AS id`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await owner.db.execute<{ id: string }>(sql`SELECT app.uuid_v7()::text AS id`);

    const [a, b] = [first.rows[0]?.id ?? '', second.rows[0]?.id ?? ''];
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('holiday_catalog', () => {
  it('holds the seeded Argentine holidays of 2026 to 2028', async () => {
    const result = await owner.db.execute<{ year: number; n: number }>(
      sql`SELECT extract(year FROM date)::int AS year, count(*)::int AS n
            FROM holiday_catalog WHERE country = 'AR' GROUP BY 1 ORDER BY 1`,
    );

    // Other suites load the catalogs around today's date too, and the operator suite adds a few
    // holidays to a far year of its own: the three years the scheduling tests rely on must be
    // there, each with a full calendar.
    const years = result.rows.map((row) => row.year);
    expect(years).toEqual(expect.arrayContaining([2026, 2027, 2028]));
    for (const row of result.rows.filter((entry) => entry.year >= 2026 && entry.year <= 2028)) {
      expect(row.n).toBeGreaterThan(14);
    }
  });

  it('seeding again changes nothing (idempotent loaders)', async () => {
    const before = [await count('holiday_catalog'), await count('payer')];

    await seedArHolidays(owner.db, [2026, 2027, 2028]);
    await seedArPayers(owner.db);

    expect([await count('holiday_catalog'), await count('payer')]).toEqual(before);
  });

  it('rejects a duplicate (country, date, name)', async () => {
    await expect(
      owner.db.execute(
        sql`INSERT INTO holiday_catalog (country, date, name, kind)
              VALUES ('AR', '2026-12-25', 'Navidad', 'national')`,
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('rejects an unknown kind', async () => {
    await expect(
      owner.db.execute(
        sql`INSERT INTO holiday_catalog (country, date, name, kind)
              VALUES ('AR', '2026-12-26', 'Invented', 'sale')`,
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('payer', () => {
  it('holds the seeded payers including the self-pay option', async () => {
    const rows = await owner.db.execute<{ code: string; kind: string }>(
      sql`SELECT code, kind FROM payer WHERE country = 'AR' ORDER BY code`,
    );

    expect(rows.rows.filter((row) => seededCodes.has(row.code))).toHaveLength(arPayers.length);
    expect(rows.rows).toContainEqual({ code: 'particular', kind: 'private' });
  });

  it('rejects a duplicate (country, code)', async () => {
    await expect(
      owner.db.execute(
        sql`INSERT INTO payer (country, code, name, kind) VALUES ('AR', 'osde', 'Other', 'prepaga')`,
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});

describe('platform tables are read-only for the runtime role', () => {
  it('lets app_rw read them without a tenant context', async () => {
    const rows = await runtime.db.execute<{ name: string }>(
      sql`SELECT name FROM holiday_catalog WHERE date = '2026-12-25'`,
    );

    expect(rows.rows).toEqual([{ name: 'Navidad' }]);
  });

  it.each([
    [
      'insert into holiday_catalog',
      sql`INSERT INTO holiday_catalog (country, date, name, kind) VALUES ('AR', '2030-01-01', 'X', 'national')`,
    ],
    ['update holiday_catalog', sql`UPDATE holiday_catalog SET name = 'x'`],
    ['delete from holiday_catalog', sql`DELETE FROM holiday_catalog`],
    [
      'insert into payer',
      sql`INSERT INTO payer (country, code, name, kind) VALUES ('AR', 'x', 'x', 'prepaga')`,
    ],
    ['update payer', sql`UPDATE payer SET name = 'x'`],
    ['delete from payer', sql`DELETE FROM payer`],
  ])('refuses to %s', async (_label, statement) => {
    await expect(runtime.db.execute(statement)).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('catalog reader (what the country pack reads)', () => {
  it('returns the holidays of a year, with names and kinds, as app_rw', async () => {
    const reader = createCatalogReader(runtime.db);

    const holidays = await reader.holidays('AR', 2026);

    expect(holidays).toContainEqual({
      country: 'AR',
      date: '2026-12-25',
      name: 'Navidad',
      kind: 'national',
    });
    expect(holidays.every((holiday) => holiday.date.startsWith('2026'))).toBe(true);
    expect(holidays.map((holiday) => holiday.date)).toEqual(
      [...holidays.map((holiday) => holiday.date)].sort(),
    );
  });

  it('sees a holiday the operator adds after the application started (no release needed)', async () => {
    const reader = createCatalogReader(runtime.db);
    await owner.db.execute(
      sql`INSERT INTO holiday_catalog (country, date, name, kind)
            VALUES ('AR', '2026-09-15', 'Extra bridge day', 'bridge')`,
    );

    const holidays = await reader.holidays('AR', 2026);

    expect(holidays.map((holiday) => holiday.name)).toContain('Extra bridge day');
    await owner.db.execute(sql`DELETE FROM holiday_catalog WHERE name = 'Extra bridge day'`);
  });

  it('returns no holidays for a country without a catalog', async () => {
    const holidays = await createCatalogReader(runtime.db).holidays('XX', 2026);

    expect(holidays).toEqual([]);
  });

  it('returns the payer catalog of a country', async () => {
    const payers = await createCatalogReader(runtime.db).payers('AR');

    expect(payers.filter((payer) => seededCodes.has(payer.code))).toHaveLength(arPayers.length);
    expect(payers).toContainEqual({
      country: 'AR',
      code: 'particular',
      name: 'Particular',
      kind: 'private',
    });
  });
});
