import { formatArs, money } from '@consultorio/contracts';

import type { ExportCell, ExportColumn } from './types.js';

/** `1234,50`: an amount for a spreadsheet in es-AR, with no thousands separator and no sign of currency. */
export function plainAmount(cents: number): string {
  const amount = money(cents);
  const sign = amount < 0 ? '-' : '';
  const absolute = Math.abs(amount);
  const pesos = Math.trunc(absolute / 100);
  const rest = String(absolute % 100).padStart(2, '0');
  return `${sign}${String(pesos)},${rest}`;
}

/** `12/05/2031` for a calendar day `2031-05-12`. */
export function dayAsText(day: string): string {
  const [year, month, date] = day.split('-');
  return year && month && date ? `${date}/${month}/${year}` : day;
}

/** The text a person reads for a cell, the same in a PDF and (except money) in a CSV. */
export function readable(column: ExportColumn, cell: ExportCell, style: 'csv' | 'pdf'): string {
  if (cell === null) return '';
  switch (column.type) {
    case 'money':
      return typeof cell === 'number'
        ? style === 'pdf'
          ? formatArs(money(cell))
          : plainAmount(cell)
        : '';
    case 'date':
      return typeof cell === 'string' ? dayAsText(cell) : '';
    case 'integer':
      return typeof cell === 'number' ? String(Math.trunc(cell)) : '';
    case 'text':
      return String(cell);
  }
}
