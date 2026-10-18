import type { PdfBranding } from '../pdf/render.js';

import { writeCsv } from './csv.js';
import { writePdf } from './pdf.js';
import { EXPORT_CONTENT_TYPES, type ExportFileFormat, type ExportTable } from './types.js';
import { writeXlsx } from './xlsx.js';

export interface BuiltFile {
  bytes: Buffer;
  contentType: string;
  extension: ExportFileFormat;
}

/** Writes the table in the format that was asked for. */
export async function buildExportFile(
  table: ExportTable,
  format: ExportFileFormat,
  options: { branding: PdfBranding; createdAt: Date },
): Promise<BuiltFile> {
  const bytes =
    format === 'csv'
      ? writeCsv(table)
      : format === 'xlsx'
        ? await writeXlsx(table, {
            createdAt: options.createdAt,
            creator: options.branding.organizationName,
          })
        : await writePdf(table, options);
  return { bytes, contentType: EXPORT_CONTENT_TYPES[format], extension: format };
}
