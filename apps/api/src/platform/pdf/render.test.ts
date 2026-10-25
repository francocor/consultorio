import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { allText, readPdf } from '../../../test/support/pdf.js';

import { pdfSafeText, renderPdf, type RenderPdfInput } from './render.js';

const CREATED_AT = new Date('2026-10-17T15:30:00.000Z');

const GOLDEN = fileURLToPath(new URL('./__golden__/frame.txt', import.meta.url));

const base: RenderPdfInput = {
  title: 'Resumen de cobros',
  branding: {
    organizationName: 'Centro Médico Aillu',
    subtitle: 'Av. Corrientes 1234, Ciudad de Buenos Aires - CUIT 30-12345678-1',
  },
  createdAt: CREATED_AT,
  subject: 'Cobros de octubre',
  blocks: [
    { kind: 'heading', text: 'Cobros del 1 al 17 de octubre de 2026' },
    {
      kind: 'paragraph',
      text: 'Niño, año, ¿cuánto? Ñandú - Ángel - Ésta - Íntegro - Ópera - Último - pingüino.',
    },
    {
      kind: 'fields',
      rows: [
        { label: 'Sede', value: 'Palermo' },
        { label: 'Total cobrado', value: '$ 1.234,50' },
      ],
    },
    {
      kind: 'table',
      columns: [
        { header: 'Fecha', width: 2 },
        { header: 'Paciente', width: 5 },
        { header: 'Importe', width: 3, align: 'right' },
      ],
      rows: [
        ['17/10/2026', 'Pérez, Juana', '$ 35.000,00'],
        ['17/10/2026', 'Gómez, Luis', '$ 12.500,50'],
      ],
    },
  ],
  footer: 'Documento generado por el sistema',
};

describe('renderPdf (the shared frame of every PDF the worker renders)', () => {
  // The first PDF loads the fonts and the image library, which takes seconds when the PC is busy (the whole
  // monorepo is being tested at once): that cost is paid here, once, and not inside the first test.
  beforeAll(async () => {
    await renderPdf(base);
  }, 120_000);

  it('renders a PDF with the title, author and creation date it was given', async () => {
    const bytes = await renderPdf(base);
    const reading = readPdf(bytes);

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(reading.pages).toBe(1);
    expect(reading.info['Title']).toBe('Resumen de cobros');
    expect(reading.info['Author']).toBe('Centro Médico Aillu');
    expect(reading.info['Subject']).toBe('Cobros de octubre');
    expect(reading.info['CreationDate']).toContain('20261017');
  });

  it('renders the same bytes for the same data: the metadata is fixed, nothing is random', async () => {
    const first = await renderPdf(base);
    const second = await renderPdf(base);

    expect(second.equals(first)).toBe(true);
  });

  it('matches the golden reading of the frame (header, blocks, table, footer, page numbers)', async () => {
    const reading = readPdf(await renderPdf(base));
    const current = `${JSON.stringify(
      { pages: reading.pages, info: reading.info, texts: reading.texts },
      null,
      2,
    )}\n`;

    if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, current, 'utf8');

    expect(current).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('writes the accents and the eñe of es-AR, and the peso amounts as typed', async () => {
    const text = allText(readPdf(await renderPdf(base)));

    for (const expected of ['Niño', 'año', '¿cuánto?', 'Ñandú', 'pingüino', '$ 1.234,50']) {
      expect(text, expected).toContain(expected);
    }
  });

  it('puts the organization in the header and the footer text with the page number on the page', async () => {
    const text = allText(readPdf(await renderPdf(base)));

    expect(text).toContain('Centro Médico Aillu');
    expect(text).toContain('CUIT 30-12345678-1');
    expect(text).toContain('Documento generado por el sistema');
    expect(text).toContain('Página 1 de 1');
  });

  it('marks every page as simulated when asked, and only then', async () => {
    const mark = 'DOCUMENTO DE PRUEBA SIN VALIDEZ FISCAL';

    const plain = allText(readPdf(await renderPdf(base)));
    const simulated = readPdf(await renderPdf({ ...base, watermark: mark }));

    expect(plain).not.toContain(mark);
    expect(simulated.pages).toBe(1);
    expect(allText(simulated)).toContain(mark);
  });

  it('carries on over several pages: the table header repeats, the footer and the mark are on each page', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => [
      '17/10/2026',
      `Paciente número ${String(index + 1)}`,
      '$ 1.000,00',
    ]);
    const long: RenderPdfInput = {
      ...base,
      watermark: 'SIMULADO',
      blocks: [
        {
          kind: 'table',
          columns: [
            { header: 'Fecha', width: 2 },
            { header: 'Paciente', width: 5 },
            { header: 'Importe', width: 3, align: 'right' },
          ],
          rows,
        },
      ],
    };

    const reading = readPdf(await renderPdf(long));

    expect(reading.pages).toBeGreaterThan(1);
    reading.texts.forEach((page, index) => {
      expect(page, `page ${String(index + 1)}`).toContain(
        `Página ${String(index + 1)} de ${String(reading.pages)}`,
      );
      expect(page, `page ${String(index + 1)}`).toContain('SIMULADO');
      expect(page, `page ${String(index + 1)}`).toContain('Importe');
    });
  });

  it('draws an image block, for the QR of an invoice', async () => {
    const qr = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer();

    const bytes = await renderPdf({
      ...base,
      blocks: [{ kind: 'image', data: qr, size: 90, align: 'right' }],
    });

    expect(readPdf(bytes).pages).toBe(1);
    expect(bytes.toString('latin1')).toContain('/Subtype /Image');
  });

  it('gives an empty document its one page, with the header and the footer', async () => {
    const reading = readPdf(await renderPdf({ ...base, blocks: [] }));

    expect(reading.pages).toBe(1);
  });
});

describe('pdfSafeText (the standard fonts only draw WinAnsi)', () => {
  it('keeps Spanish text, the euro sign and typographic quotes', () => {
    const text = 'Niño año ¿Cuánto? ¡Hola! € “comillas” — raya';

    expect(pdfSafeText(text)).toBe(text);
  });

  it('replaces what the font cannot draw with a question mark instead of printing garbage', () => {
    expect(pdfSafeText('flecha → y 漢字')).toBe('flecha ? y ??');
  });

  it('keeps line breaks and drops the other control characters', () => {
    expect(pdfSafeText('uno\ndos\u0000tres\u0007')).toBe('uno\ndostres');
  });
});
