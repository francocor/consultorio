import { renderPdf, type PdfBranding } from '../pdf/render.js';

import { readable } from './format.js';
import type { ExportTable } from './types.js';

/**
 * The printable document of an export, through the shared PDF frame (header with the branding,
 * footer with page numbers): the title, what was asked for, and the table. Columns marked
 * `pdf: false` stay out, because a page is narrower than a sheet.
 */
export function writePdf(
  table: ExportTable,
  options: { branding: PdfBranding; createdAt: Date },
): Promise<Buffer> {
  const columns = table.columns.filter((column) => column.pdf !== false);
  return renderPdf({
    title: table.title,
    branding: options.branding,
    createdAt: options.createdAt,
    subject: table.title,
    footer: table.title,
    blocks: [
      { kind: 'heading', text: table.title },
      ...(table.filters.length > 0
        ? [{ kind: 'fields' as const, rows: table.filters.map((entry) => ({ ...entry })) }]
        : []),
      { kind: 'spacer', height: 6 },
      {
        kind: 'table',
        columns: columns.map((column) => ({
          header: column.label,
          width: column.width ?? 1,
          ...(column.type === 'money' || column.type === 'integer'
            ? { align: 'right' as const }
            : {}),
        })),
        rows: table.rows.map((row) =>
          columns.map((column) => readable(column, row.cells[column.key] ?? null, 'pdf')),
        ),
      },
    ],
  });
}
