import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { contentDisposition, sanitizeFileName } from './file-name.js';

describe('sanitizeFileName: the name is shown back as text and never decides where a file goes', () => {
  it.each([
    ['resultado.pdf', 'resultado.pdf'],
    ['Análisis de sangre 2026.pdf', 'Análisis de sangre 2026.pdf'],
    ['../../other-tenant/file.pdf', 'file.pdf'],
    ['..\\..\\windows\\system32\\config.txt', 'config.txt'],
    ['/etc/passwd', 'passwd'],
    ['C:\\Users\\paciente\\dni.png', 'dni.png'],
    ['  espacios.pdf  ', 'espacios.pdf'],
    ['...ocultos.txt', 'ocultos.txt'],
  ])('turns %j into %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it('removes control characters and the invisible characters that disguise an extension', () => {
    expect(sanitizeFileName('factura\u0000.pdf')).toBe('factura.pdf');
    expect(sanitizeFileName('linea\r\nnueva.pdf')).toBe('lineanueva.pdf');
    // U+202E reverses what follows: "exe.fdp" would read as "pdf.exe".
    expect(sanitizeFileName('informe\u202Efdp.exe')).toBe('informefdp.exe');
    expect(sanitizeFileName('a\u200Bb.pdf')).toBe('ab.pdf');
  });

  it('falls back to a neutral name when nothing usable is left', () => {
    expect(sanitizeFileName('')).toBe('archivo');
    expect(sanitizeFileName('   ')).toBe('archivo');
    expect(sanitizeFileName('....')).toBe('archivo');
    expect(sanitizeFileName('../../')).toBe('archivo');
  });

  it('keeps a long name within 200 characters and keeps its extension', () => {
    const long = `${'a'.repeat(400)}.pdf`;

    const cleaned = sanitizeFileName(long);

    expect(cleaned.length).toBeLessThanOrEqual(200);
    expect(cleaned.endsWith('.pdf')).toBe(true);
  });

  it('never returns a path separator, a control character or an empty string, whatever it is given', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (input) => {
        const cleaned = sanitizeFileName(input);
        // eslint-disable-next-line no-control-regex
        return cleaned.length > 0 && !/[/\\\u0000-\u001f\u007f]/.test(cleaned) && cleaned !== '..';
      }),
      { numRuns: 500 },
    );
  });
});

describe('contentDisposition: the download header cannot be bent by a file name', () => {
  it('is an attachment with an ASCII fallback and the real name in UTF-8', () => {
    const header = contentDisposition('Análisis ñandú.pdf');

    expect(header).toBe(
      `attachment; filename="An_lisis__and_.pdf"; filename*=UTF-8''An%C3%A1lisis%20%C3%B1and%C3%BA.pdf`,
    );
  });

  it('cannot carry a quote, a line break or a second header', () => {
    const header = contentDisposition('a"; filename="evil.exe\r\nSet-Cookie: x=1.pdf');

    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith('attachment; filename="')).toBe(true);
    expect(header.match(/filename="/g)).toHaveLength(1);
    expect(header).not.toContain('Set-Cookie: x=1"');
  });

  it('uses the neutral name when there is nothing to show', () => {
    expect(contentDisposition('')).toBe(`attachment; filename="archivo"; filename*=UTF-8''archivo`);
  });
});
