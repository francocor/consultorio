/**
 * What an export lists, independent of the file it becomes. A module (billing today, the reports
 * later) describes WHAT it exports as an `ExportTable`; the writers of this folder turn it into CSV,
 * a spreadsheet or a PDF. Money is always whole cents (`Money`): the writers decide how a person
 * reads it, so no module formats an amount on its own.
 */

/**
 * - `text`: written as it is.
 * - `money`: whole cents of ARS (an integer); read as `1234,50` in CSV, as a number in a
 *   spreadsheet and as `$ 1.234,50` in a PDF.
 * - `date`: a calendar day, `YYYY-MM-DD`; read as `dd/mm/yyyy`.
 * - `integer`: a count.
 */
export type ExportCellType = 'text' | 'money' | 'date' | 'integer';

export interface ExportColumn {
  key: string;
  /** The header, in the language of the product (es-AR). */
  label: string;
  type: ExportCellType;
  /** A weight in the PDF: the columns share the page in proportion to it. Defaults to 1. */
  width?: number;
  /** False keeps a column out of the PDF (a page is narrower than a sheet). Defaults to true. */
  pdf?: boolean;
}

export type ExportCell = string | number | null;

export interface ExportRow {
  cells: Readonly<Record<string, ExportCell>>;
  /** A subtotal or a total row: shown in bold in a PDF and a spreadsheet. */
  emphasis?: 'subtotal' | 'total';
}

export interface ExportTable {
  title: string;
  /** What was asked for, as label and value: the period, the place, the payer. */
  filters: readonly { label: string; value: string }[];
  columns: readonly ExportColumn[];
  rows: readonly ExportRow[];
}

export const EXPORT_CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

export type ExportFileFormat = keyof typeof EXPORT_CONTENT_TYPES;
