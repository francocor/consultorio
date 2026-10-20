/**
 * The parts of the cancellation export that can grow with the years of an organization are async
 * iterables, read a page at a time inside the transaction of the contributor (`pagedRows`); the
 * exporter writes them row by row. A test that looks at what a contributor produced wants the lists:
 * `settled` consumes every such section into an array, and must be awaited INSIDE the callback that
 * owns the transaction, because the pages are read from it.
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

export async function settled<T>(part: Promise<T> | T): Promise<T> {
  const value = await part;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const sections: Record<string, unknown> = {};
  for (const [name, section] of Object.entries(value)) {
    if (isAsyncIterable(section)) {
      const rows: unknown[] = [];
      for await (const row of section) rows.push(row);
      sections[name] = rows;
    } else {
      sections[name] = section;
    }
  }
  return sections as T;
}
