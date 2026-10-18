import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { allText, readPdf } from '../../../test/support/pdf.js';

import { buildExportFile } from './build-file.js';
import { writeCsv } from './csv.js';
import { dayAsText, plainAmount } from './format.js';
import type { ExportTable } from './types.js';
import { writeXlsx } from './xlsx.js';

/**
 * The three writers of an export, against golden files (`__golden__/`). `UPDATE_GOLDEN=1` rewrites
 * them; reading the diff is how a change of format is reviewed. The data has what breaks writers:
 * accents, quotes, a comma, a line break, a text that starts like a formula, a negative amount.
 */

const CREATED_AT = new Date('2031-05-12T15:30:00.000Z');
const BRANDING = { organizationName: 'Centro Médico Aillu' };

const SAMPLE: ExportTable = {
  title: 'Cobros de mayo de 2031',
  filters: [
    { label: 'Período', value: '01/05/2031 al 31/05/2031' },
    { label: 'Sede', value: 'Centro' },
  ],
  columns: [
    { key: 'date', label: 'Fecha', type: 'date', width: 2 },
    { key: 'patient', label: 'Paciente', type: 'text', width: 4 },
    { key: 'service', label: 'Servicio', type: 'text', width: 4 },
    { key: 'visits', label: 'Visitas', type: 'integer', width: 1 },
    { key: 'amount', label: 'Importe', type: 'money', width: 3 },
  ],
  rows: [
    {
      cells: {
        date: '2031-05-12',
        patient: 'Pérez, Juana "la Gallega"',
        service: 'Consulta, control',
        visits: 1,
        amount: 123_450,
      },
    },
    {
      cells: {
        date: '2031-05-13',
        patient: '=HYPERLINK("http://x")',
        service: 'Línea 1\nLínea 2',
        visits: 2,
        amount: 5,
      },
    },
    {
      cells: {
        date: '2031-05-14',
        patient: 'Núñez, Óscar',
        service: '+54 11',
        visits: 1,
        amount: -9_000,
      },
    },
    {
      cells: { date: null, patient: 'Subtotal', service: null, visits: 4, amount: 114_455 },
      emphasis: 'subtotal',
    },
  ],
};

const GOLDEN_DIR = new URL('./__golden__/', import.meta.url);
const golden = (name: string) => fileURLToPath(new URL(name, GOLDEN_DIR));

/** Compares with a golden file, or writes it when asked to (or when it does not exist yet). */
function matchGolden(name: string, actual: string): void {
  const path = golden(name);
  if (process.env['UPDATE_GOLDEN'] === '1' || !existsSync(path)) {
    writeFileSync(path, actual);
  }
  expect(actual).toBe(readFileSync(path, 'utf8'));
}

describe('amounts and days as people read them in an export', () => {
  it('writes cents as a decimal comma with no thousands separator and no float', () => {
    expect(plainAmount(123_450)).toBe('1234,50');
    expect(plainAmount(5)).toBe('0,05');
    expect(plainAmount(100)).toBe('1,00');
    expect(plainAmount(-9_000)).toBe('-90,00');
    expect(plainAmount(0)).toBe('0,00');
    expect(() => plainAmount(10.5)).toThrow(RangeError);
  });

  it('writes a calendar day as dd/mm/yyyy', () => {
    expect(dayAsText('2031-05-12')).toBe('12/05/2031');
  });
});

describe('the CSV', () => {
  it('matches the golden file: BOM, every field quoted, CRLF, the formula guard', () => {
    const bytes = writeCsv(SAMPLE);

    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    matchGolden('sample.csv', bytes.toString('utf8').replaceAll('\r\n', '<CRLF>\n'));
  });

  it('quotes a comma, a quote and a line break, and neutralizes a text that starts like a formula', () => {
    const text = writeCsv(SAMPLE).toString('utf8');

    expect(text).toContain('"Pérez, Juana ""la Gallega"""');
    expect(text).toContain('"Línea 1\nLínea 2"');
    expect(text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(text).toContain(`"'+54 11"`);
    // Money is not text: a negative amount is written as it is, not as a formula.
    expect(text).toContain('"-90,00"');
    expect(text.split('\r\n').length).toBe(6);
  });
});

describe('the spreadsheet', () => {
  async function read(bytes: Buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    return workbook;
  }

  it('matches the golden reading: real numbers with two decimals, real dates, bold subtotal', async () => {
    const bytes = await writeXlsx(SAMPLE, {
      createdAt: CREATED_AT,
      creator: BRANDING.organizationName,
    });
    const workbook = await read(bytes);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('the workbook has no sheet');

    const reading = {
      creator: workbook.creator,
      created: workbook.created.toISOString(),
      sheet: sheet.name,
      rows: sheet
        .getSheetValues()
        .slice(1)
        .map((row) =>
          Array.isArray(row)
            ? row.slice(1).map((cell) => (cell instanceof Date ? cell.toISOString() : cell))
            : row,
        ),
      amountFormat: sheet.getColumn(5).numFmt,
      dateFormat: sheet.getColumn(1).numFmt,
      boldRows: [1, 2, 3, 4, 5].filter((index) => {
        // A row that was never styled has no font at all, whatever the typings promise.
        const font = sheet.getRow(index).font as Partial<ExcelJS.Font> | undefined;
        return font?.bold === true;
      }),
    };

    matchGolden('sample.xlsx.json', `${JSON.stringify(reading, null, 2)}\n`);
    const amountOf = (index: number) => {
      const row = reading.rows[index];
      return Array.isArray(row) ? row[4] : undefined;
    };
    expect(amountOf(1)).toBe(1234.5);
    expect(amountOf(3)).toBe(-90);
  });

  it('keeps a text that starts like a formula as text', async () => {
    const workbook = await read(
      await writeXlsx(SAMPLE, { createdAt: CREATED_AT, creator: BRANDING.organizationName }),
    );
    const cell = workbook.worksheets[0]?.getCell('B3');

    expect(cell?.value).toBe('=HYPERLINK("http://x")');
    expect(cell?.type).toBe(ExcelJS.ValueType.String);
  });
});

describe('the PDF', () => {
  it('matches the golden reading and is the same bytes for the same data', async () => {
    const first = await buildExportFile(SAMPLE, 'pdf', {
      branding: BRANDING,
      createdAt: CREATED_AT,
    });
    const second = await buildExportFile(SAMPLE, 'pdf', {
      branding: BRANDING,
      createdAt: CREATED_AT,
    });
    const reading = readPdf(first.bytes);

    expect(first.contentType).toBe('application/pdf');
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(reading.info['Title']).toBe('Cobros de mayo de 2031');
    matchGolden('sample.pdf.txt', `${String(reading.pages)} page(s)\n${allText(reading)}\n`);
    expect(allText(reading)).toContain('$ 1.234,50');
    expect(allText(reading)).toContain('-$ 90,00');
  });

  it('leaves out the columns marked as not for the page', async () => {
    const narrow: ExportTable = {
      ...SAMPLE,
      columns: SAMPLE.columns.map((column) =>
        column.key === 'service' ? { ...column, pdf: false } : column,
      ),
    };

    const built = await buildExportFile(narrow, 'pdf', {
      branding: BRANDING,
      createdAt: CREATED_AT,
    });

    expect(allText(readPdf(built.bytes))).not.toContain('Servicio');
    expect(allText(readPdf(built.bytes))).toContain('Paciente');
  });
});

describe('the file for a format', () => {
  it('says its content type and extension', async () => {
    const options = { branding: BRANDING, createdAt: CREATED_AT };

    const csv = await buildExportFile(SAMPLE, 'csv', options);
    const xlsx = await buildExportFile(SAMPLE, 'xlsx', options);

    expect(csv).toMatchObject({ contentType: 'text/csv; charset=utf-8', extension: 'csv' });
    expect(xlsx.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(xlsx.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
