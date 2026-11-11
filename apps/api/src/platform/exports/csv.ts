import { readable } from './format.js';
import type { ExportTable } from './types.js';

/** A cell that a spreadsheet would run as a formula if it started with one of these. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * A field of a CSV: always between quotes, quotes doubled. Text that would start a formula in a
 * spreadsheet gets an apostrophe in front (CSV injection); money and dates never start with one.
 */
function field(text: string, guard: boolean): string {
  const safe = guard && FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const BOM = '﻿';

/**
 * The CSV of an export (billing-payments, "Exports"): UTF-8 with a byte order mark so a
 * spreadsheet reads the accents, every field quoted, lines ended with CRLF, a header row with the
 * labels, and amounts as `1234,50` (the es-AR decimal comma; whole cents, never a float).
 */
export function writeCsv(table: ExportTable): Buffer {
  const lines = [
    table.columns.map((column) => field(column.label, false)).join(','),
    ...table.rows.map((row) =>
      table.columns
        .map((column) =>
          field(readable(column, row.cells[column.key] ?? null, 'csv'), column.type === 'text'),
        )
        .join(','),
    ),
  ];
  return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8');
}
