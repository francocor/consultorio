import { describe, expect, it } from 'vitest';

import { attachmentHeader } from './attachment-header.js';

describe('the header of a file the portal hands over', () => {
  it('saves the file instead of opening it, with the name twice', () => {
    expect(attachmentHeader('receta.pdf')).toBe(
      'attachment; filename="receta.pdf"; filename*=UTF-8\'\'receta.pdf',
    );
  });

  it('keeps an accent in the real name and gives old clients a plain one', () => {
    const header = attachmentHeader('Análisis de sangre.pdf');

    expect(header).toContain('filename="Analisis de sangre.pdf"');
    expect(header).toContain("filename*=UTF-8''An%C3%A1lisis%20de%20sangre.pdf");
  });

  it('cannot be split by a line break in the name', () => {
    const header = attachmentHeader('a.pdf\r\nSet-Cookie: x=1');

    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('\n')).toHaveLength(1);
  });

  it('cannot end the quoted name early or climb a directory', () => {
    const header = attachmentHeader('x".pdf; filename="../../etc/passwd');

    expect(header).not.toContain('../');
    const quoted = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
    expect(quoted).not.toContain('"');
    expect(quoted).not.toContain('/');
    expect(quoted).not.toContain(';');
  });

  it('has a name even when nothing of the original can be shown', () => {
    expect(attachmentHeader('日本語')).toContain('filename="archivo"');
    expect(attachmentHeader('日本語')).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E");
  });
});
