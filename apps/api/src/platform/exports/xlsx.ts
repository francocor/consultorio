import ExcelJS from 'exceljs';

import type { ExportTable } from './types.js';

/** A calendar day as the instant a spreadsheet stores: midnight UTC, shown as dd/mm/yyyy. */
function dayAsDate(day: string): Date | string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? day : date;
}

/**
 * An amount for a spreadsheet cell. A cell holds a number, so this is the one place where cents
 * become pesos with decimals. A division by 100 of a whole number of cents gives the double nearest
 * to the amount (IEEE division is correctly rounded), which a spreadsheet shows to the cent;
 * nothing is calculated with the result here.
 */
function pesos(cents: number): number {
  return cents / 100;
}

/**
 * The spreadsheet of an export: one sheet with a bold header, real numbers for the amounts (with
 * two decimals), real dates, and the subtotal and total rows in bold. The creation date is an
 * input, never "now", so the same data gives the same cells.
 */
export async function writeXlsx(
  table: ExportTable,
  options: { createdAt: Date; creator: string },
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = options.creator;
  workbook.created = options.createdAt;
  workbook.modified = options.createdAt;
  const sheet = workbook.addWorksheet(table.title.slice(0, 31).replaceAll(/[\\/*?:[\]]/g, ' '));

  sheet.columns = table.columns.map((column) => ({
    header: column.label,
    key: column.key,
    width: Math.max(12, Math.min(40, column.label.length + 6)),
  }));
  sheet.getRow(1).font = { bold: true };

  for (const row of table.rows) {
    const added = sheet.addRow(
      Object.fromEntries(
        table.columns.map((column) => {
          const cell = row.cells[column.key] ?? null;
          if (cell === null) return [column.key, null];
          if (column.type === 'money' && typeof cell === 'number') return [column.key, pesos(cell)];
          if (column.type === 'date' && typeof cell === 'string')
            return [column.key, dayAsDate(cell)];
          return [column.key, cell];
        }),
      ),
    );
    if (row.emphasis) added.font = { bold: true };
  }
  table.columns.forEach((column, index) => {
    const target = sheet.getColumn(index + 1);
    if (column.type === 'money') target.numFmt = '#,##0.00';
    if (column.type === 'date') target.numFmt = 'dd/mm/yyyy';
    if (column.type === 'integer') target.numFmt = '0';
  });

  const bytes = await workbook.xlsx.writeBuffer();
  return Buffer.from(bytes);
}
