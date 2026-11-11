import { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_FILES_PER_REQUEST } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { checkFile, contentTypeOf, planSelection } from './upload-rules.js';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const file = (name: string, size = 1000, type = '') => ({ name, size, type });

describe('contentTypeOf: the type to ask the server for', () => {
  it('trusts the browser when it reports an allowed type', () => {
    expect(contentTypeOf(file('x.bin', 10, PDF))).toBe(PDF);
    expect(contentTypeOf(file('x', 10, 'image/webp'))).toBe('image/webp');
  });

  it.each([
    ['informe.pdf', PDF],
    ['FOTO.JPG', 'image/jpeg'],
    ['foto.jpeg', 'image/jpeg'],
    ['radiografia.png', 'image/png'],
    ['imagen.webp', 'image/webp'],
    ['notas.txt', 'text/plain'],
    ['carta.docx', DOCX],
  ])('falls back to the extension of %s when the browser says nothing', (name, expected) => {
    expect(contentTypeOf(file(name))).toBe(expected);
  });

  it('knows nothing about other types and names without an extension', () => {
    expect(contentTypeOf(file('programa.exe', 10, 'application/x-msdownload'))).toBeNull();
    expect(contentTypeOf(file('grafico.svg', 10, 'image/svg+xml'))).toBeNull();
    expect(contentTypeOf(file('sin-extension'))).toBeNull();
    expect(contentTypeOf(file('archivo.pdf.exe'))).toBeNull();
  });
});

describe('checkFile: what is worth sending, so the person finds out early (the server decides anyway)', () => {
  it('accepts an allowed type up to the size cap', () => {
    expect(checkFile(file('a.pdf', DOCUMENT_MAX_BYTES))).toEqual({ ok: true, contentType: PDF });
    expect(checkFile(file('a.pdf', 1))).toEqual({ ok: true, contentType: PDF });
  });

  it('names the reason for each refusal', () => {
    expect(checkFile(file('a.pdf', DOCUMENT_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(checkFile(file('a.pdf', 0))).toEqual({ ok: false, reason: 'empty' });
    expect(checkFile(file('a.exe', 100))).toEqual({ ok: false, reason: 'type_not_allowed' });
  });

  it('reports a wrong type before a wrong size, which is what the person can fix first', () => {
    expect(checkFile(file('a.exe', DOCUMENT_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: 'type_not_allowed',
    });
  });
});

describe('planSelection: a pick of files becomes a list to upload and a list of refusals', () => {
  it('keeps the valid files in order and refuses the others with a reason', () => {
    const plan = planSelection(
      [file('a.pdf'), file('b.exe'), file('c.png'), file('d.pdf', DOCUMENT_MAX_BYTES + 5)],
      0,
    );

    expect(plan.accepted.map((entry) => entry.file.name)).toEqual(['a.pdf', 'c.png']);
    expect(plan.accepted.map((entry) => entry.contentType)).toEqual([PDF, 'image/png']);
    expect(plan.refused).toEqual([
      { name: 'b.exe', reason: 'type_not_allowed' },
      { name: 'd.pdf', reason: 'too_large' },
    ]);
  });

  it('stops at the number of files one request takes, counting those already waiting', () => {
    const many = Array.from({ length: DOCUMENT_MAX_FILES_PER_REQUEST + 3 }, (_, i) =>
      file(`f${String(i)}.pdf`),
    );

    const fresh = planSelection(many, 0);
    expect(fresh.accepted).toHaveLength(DOCUMENT_MAX_FILES_PER_REQUEST);
    expect(fresh.refused.map((entry) => entry.reason)).toEqual([
      'too_many',
      'too_many',
      'too_many',
    ]);

    const busy = planSelection(many, DOCUMENT_MAX_FILES_PER_REQUEST - 2);
    expect(busy.accepted).toHaveLength(2);
    expect(planSelection(many, DOCUMENT_MAX_FILES_PER_REQUEST).accepted).toHaveLength(0);
  });
});
