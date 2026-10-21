import { describe, expect, it } from 'vitest';

import { EXPORT_PAGE_SIZE, pagedBatches, pagedByStamp, pagedRows } from './export-pages.js';

/** A table of `total` rows with ids 1..total, read the way a contributor reads it: after a cursor, a page. */
function table(total: number) {
  const asked: { after: number | null; limit: number }[] = [];
  const fetch = (after: number | null, limit: number) => {
    asked.push({ after, limit });
    const start = after === null ? 1 : after + 1;
    const rows: { id: number }[] = [];
    for (let id = start; id <= Math.min(total, start + limit - 1); id += 1) rows.push({ id });
    return Promise.resolve(rows);
  };
  return { asked, fetch };
}

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const found: T[] = [];
  for await (const row of rows) found.push(row);
  return found;
}

describe('the rows of an export, a page at a time', () => {
  it('gives every row once and in order, however the pages fall', async () => {
    for (const [total, pageSize] of [
      [10, 3],
      [9, 3],
      [1, 5],
      [7, 1],
      [0, 4],
    ] as const) {
      const source = table(total);

      const rows = await collect(
        pagedRows({ pageSize, fetch: source.fetch, cursorOf: (row) => row.id }),
      );

      expect(
        rows.map((row) => row.id),
        `${String(total)} rows, pages of ${String(pageSize)}`,
      ).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    }
  });

  it('never asks for more than a page, and asks after the last row it was given', async () => {
    const source = table(10);

    await collect(pagedRows({ pageSize: 4, fetch: source.fetch, cursorOf: (row) => row.id }));

    expect(source.asked).toEqual([
      { after: null, limit: 4 },
      { after: 4, limit: 4 },
      { after: 8, limit: 4 },
    ]);
  });

  it('stops at a page that is not full, and asks once more after an exact multiple', async () => {
    const short = table(6);
    const exact = table(8);

    await collect(pagedRows({ pageSize: 4, fetch: short.fetch, cursorOf: (row) => row.id }));
    await collect(pagedRows({ pageSize: 4, fetch: exact.fetch, cursorOf: (row) => row.id }));

    // 6 rows in pages of 4: the second page is short, so there is nothing more to ask.
    expect(short.asked.map((call) => call.after)).toEqual([null, 4]);
    // 8 rows: the second page is full, and only a third question finds nothing, which is how the end is known.
    expect(exact.asked.map((call) => call.after)).toEqual([null, 4, 8]);
  });

  it('does not read the next page until the consumer wants it (a consumer that stops costs one page)', async () => {
    const source = table(1000);

    for await (const row of pagedRows({
      pageSize: 5,
      fetch: source.fetch,
      cursorOf: (current) => current.id,
    })) {
      if (row.id === 3) break;
    }

    expect(source.asked).toHaveLength(1);
  });

  it('gives the rows the shape the caller asks for, without the cursor it needed to read them', async () => {
    const source = table(3);

    const rows = await collect(
      pagedRows({
        pageSize: 2,
        fetch: source.fetch,
        cursorOf: (row) => row.id,
        project: (row) => ({ number: row.id * 10 }),
      }),
    );

    expect(rows).toEqual([{ number: 10 }, { number: 20 }, { number: 30 }]);
  });

  it('keeps the page small enough that a table of any size never sits in memory', () => {
    expect(EXPORT_PAGE_SIZE).toBeGreaterThanOrEqual(100);
    expect(EXPORT_PAGE_SIZE).toBeLessThanOrEqual(1000);
  });

  it('refuses a page size that is not a positive whole number (the loop would never end)', async () => {
    const source = table(3);

    await expect(
      collect(pagedRows({ pageSize: 0, fetch: source.fetch, cursorOf: (row) => row.id })),
    ).rejects.toThrow(/page size/);
  });

  it('pages by a timestamp and an id: the cursor is the text of the last row, and it is not in the rows that come out', async () => {
    const stamps = [
      '2026-10-01 10:00:00.123456+00',
      '2026-10-01 10:00:00.123456+00',
      '2026-10-02 08:00:00+00',
    ];
    const asked: ({ at: string; id: string } | null)[] = [];

    const rows = await collect(
      pagedByStamp({
        pageSize: 2,
        fetch: (after, limit) => {
          asked.push(after);
          const from = after === null ? 0 : Number(after.id) + 1;
          return Promise.resolve(
            stamps.slice(from, from + limit).map((at, index) => ({
              name: `row ${String(from + index)}`,
              cursorAt: at,
              cursorId: String(from + index),
            })),
          );
        },
      }),
    );

    expect(rows).toEqual([{ name: 'row 0' }, { name: 'row 1' }, { name: 'row 2' }]);
    // Two rows share the instant to the microsecond: the cursor keeps all of it.
    expect(asked).toEqual([null, { at: '2026-10-01 10:00:00.123456+00', id: '1' }]);
  });

  it('gives whole pages to a contributor that works on a page at a time, and no empty one', async () => {
    const source = table(9);

    const pages = await collect(
      pagedBatches({ pageSize: 3, fetch: source.fetch, cursorOf: (row) => row.id }),
    );

    expect(pages.map((page) => page.map((row) => row.id))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    // The question after the last full page found nothing, and that is not a page.
    expect(source.asked).toHaveLength(4);
  });
});
