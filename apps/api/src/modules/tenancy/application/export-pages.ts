import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * The rows of an export, read a page at a time (tenancy, "Tenant cancellation export"). A contributor
 * that returns a whole array has already loaded the table, and the audit trail or the messages of an
 * organization that stayed for years are far more than a process should hold. A contributor that
 * returns what `pagedRows` makes (an async iterable) never holds more than one page: the exporter
 * (`cancellation/package-content.ts`) writes each row to the file before it asks for the next, inside
 * the transaction the contributor was given.
 */

/** Rows read per question to the database. */
export const EXPORT_PAGE_SIZE = 500;

export interface PagedRows<Raw, Cursor, Out> {
  /** Rows per page. The context of the export can lower it (a test uses a handful). */
  pageSize?: number | undefined;
  /** One page after the cursor (or the first, when null): at most `limit` rows, in the order of the export. */
  fetch: (after: Cursor | null, limit: number) => Promise<readonly Raw[]>;
  /** Where the next page starts: the position of this row in the order of the export. */
  cursorOf: (row: Raw) => Cursor;
  /** The row as the export shows it, without whatever was read only to find the next page. */
  project?: (row: Raw) => Out;
}

/** The pages themselves, for a contributor that does something to a whole page (reads the details of its rows at once). */
export async function* pagedBatches<Raw, Cursor>(options: {
  pageSize?: number | undefined;
  fetch: (after: Cursor | null, limit: number) => Promise<readonly Raw[]>;
  cursorOf: (row: Raw) => Cursor;
}): AsyncGenerator<readonly Raw[]> {
  const size = options.pageSize ?? EXPORT_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError('The page size of an export is a whole number of at least one.');
  }
  let after: Cursor | null = null;
  for (;;) {
    const page = await options.fetch(after, size);
    if (page.length > 0) yield page;
    const last = page.at(-1);
    if (page.length < size || last === undefined) return;
    after = options.cursorOf(last);
  }
}

export async function* pagedRows<Raw, Cursor, Out = Raw>(
  options: PagedRows<Raw, Cursor, Out>,
): AsyncGenerator<Out> {
  for await (const page of pagedBatches(options)) {
    for (const row of page) {
      yield options.project ? options.project(row) : (row as unknown as Out);
    }
  }
}

/**
 * The position of a row ordered by a timestamp and then by its id: both are kept as text. A JavaScript
 * date has milliseconds and a column has microseconds, so a cursor made of a `Date` would skip or repeat
 * the rows that share a millisecond; the text is read back by the database exactly as it wrote it.
 */
export interface StampCursor {
  at: string;
  id: string;
}

/** The text of a timestamp column, to select next to the row and build its cursor from. */
export function stampText(column: AnyColumn): SQL<string> {
  return sql<string>`${column}::text`;
}

/** The condition "after this row" of an ordering by `column` and then `idColumn`; none for the first page. */
export function afterStamp(
  column: AnyColumn,
  idColumn: AnyColumn,
  cursor: StampCursor | null,
): SQL | undefined {
  if (cursor === null) return undefined;
  return sql`(${column}, ${idColumn}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
}

/** A row read with the two columns that tell where it is in an ordering by a timestamp and an id. */
export interface StampRow {
  cursorAt: string;
  cursorId: string;
}

/**
 * `pagedRows` for the common order of an export, a timestamp and then the id: the contributor selects
 * `cursorAt: stampText(column)` and `cursorId: idColumn` next to the row, asks for the page after the
 * cursor (`afterStamp`), and gets the rows without those two columns, or as `project` shapes them
 * (the whole row of a table is selected as `{ row: table, cursorAt, cursorId }` and projected to `row`).
 */
export function pagedByStamp<Raw extends StampRow, Out = Omit<Raw, keyof StampRow>>(options: {
  pageSize?: number | undefined;
  fetch: (after: StampCursor | null, limit: number) => Promise<readonly Raw[]>;
  project?: (row: Raw) => Out;
}): AsyncGenerator<Out> {
  return pagedRows<Raw, StampCursor, Out>({
    pageSize: options.pageSize,
    fetch: options.fetch,
    cursorOf: (row) => ({ at: row.cursorAt, id: row.cursorId }),
    project: options.project ?? ((row) => omitCursor(row) as unknown as Out),
  });
}

/** The row without the two columns that were read only to find the next page. */
export function omitCursor<Raw extends StampRow>(row: Raw): Omit<Raw, keyof StampRow> {
  const copy: Partial<Raw> = { ...row };
  delete copy.cursorAt;
  delete copy.cursorId;
  return copy as Omit<Raw, keyof StampRow>;
}
