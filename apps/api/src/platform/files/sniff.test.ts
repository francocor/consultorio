import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sniffFile, type SniffResult } from './sniff.js';
import {
  buildZip,
  minimalDocx,
  minimalJpeg,
  minimalPdf,
  minimalPng,
  minimalWebp,
} from './test-files.js';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function detected(result: SniffResult): string {
  if (!result.ok) throw new Error(`expected a detected type, got rejection "${result.reason}"`);
  return result.type.mime;
}

function rejection(result: SniffResult): string {
  if (result.ok) throw new Error(`expected a rejection, got "${result.type.mime}"`);
  return result.reason;
}

describe('sniffFile: the types a document may have', () => {
  it('recognizes a PDF, a JPEG, a PNG and a WebP by their content', () => {
    expect(detected(sniffFile(minimalPdf()))).toBe(PDF);
    expect(detected(sniffFile(minimalJpeg()))).toBe('image/jpeg');
    expect(detected(sniffFile(minimalPng()))).toBe('image/png');
    expect(detected(sniffFile(minimalWebp()))).toBe('image/webp');
  });

  it('recognizes plain text, with or without a byte order mark and with accents', () => {
    const plain = Buffer.from('Resultado de laboratorio: sin hallazgos.\r\nControl en 6 meses.\n');
    const accented = Buffer.from('Indicación: reposo e hidratación. Año 2026 — ñandú.', 'utf8');
    const withMark = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);

    expect(detected(sniffFile(plain))).toBe('text/plain');
    expect(detected(sniffFile(accented))).toBe('text/plain');
    expect(detected(sniffFile(withMark))).toBe('text/plain');
  });

  it('recognizes a DOCX as a ZIP that holds the Word parts, and nothing else that is a ZIP', () => {
    expect(detected(sniffFile(minimalDocx()))).toBe(DOCX);
    const plainZip = buildZip([{ name: 'notes.txt', data: Buffer.from('hola') }]);
    expect(rejection(sniffFile(plainZip))).toBe('archive');
  });

  it('gives the extension that matches the detected type', () => {
    const result = sniffFile(minimalPdf());
    expect(result.ok && result.type.extension).toBe('pdf');
    const text = sniffFile(Buffer.from('solo texto'));
    expect(text.ok && text.type.extension).toBe('txt');
  });
});

describe('sniffFile: executables, scripts and archives are refused whatever the file is called', () => {
  it.each([
    [
      'a Windows executable',
      Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]),
      'executable',
    ],
    [
      'a Linux executable',
      Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(200)]),
      'executable',
    ],
    [
      'a macOS executable',
      Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(200)]),
      'executable',
    ],
    [
      'a Java class',
      Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe]), Buffer.alloc(200)]),
      'executable',
    ],
    [
      'a WebAssembly module',
      Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d]), Buffer.alloc(200)]),
      'executable',
    ],
  ] as const)('refuses %s', (_name, bytes, reason) => {
    expect(rejection(sniffFile(bytes))).toBe(reason);
  });

  it.each([
    ['a shell script', '#!/bin/sh\nrm -rf /\n'],
    ['a PHP file', '<?php system($_GET["c"]); ?>'],
    ['an HTML page with a script', '<html><body><script>alert(1)</script></body></html>'],
    ['a bare script tag', '<script>fetch("//evil")</script>'],
    ['an HTML document', '<!DOCTYPE html><html></html>'],
    ['an SVG image', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'],
  ])('refuses %s even though it is text', (_name, source) => {
    expect(rejection(sniffFile(Buffer.from(source)))).toBe('script');
  });

  it.each([
    ['a RAR archive', Buffer.concat([Buffer.from('Rar!\x1a\x07\x00'), Buffer.alloc(100)])],
    [
      'a 7-Zip archive',
      Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(100)]),
    ],
    ['a gzip file', Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.alloc(100)])],
    ['a bzip2 file', Buffer.concat([Buffer.from('BZh9'), Buffer.alloc(100)])],
    [
      'an xz file',
      Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.alloc(100)]),
    ],
    ['a cabinet file', Buffer.concat([Buffer.from('MSCF'), Buffer.alloc(100)])],
  ])('refuses %s', (_name, bytes) => {
    expect(rejection(sniffFile(bytes))).toBe('archive');
  });

  it('refuses a tar archive, which is recognized by the marker at offset 257', () => {
    const tar = Buffer.alloc(512);
    tar.write('ustar', 257, 'latin1');
    expect(rejection(sniffFile(tar))).toBe('archive');
  });

  it('refuses a renamed executable: the name plays no part, only the first bytes', () => {
    // "scan.pdf" whose content is a Windows executable.
    const disguised = Buffer.concat([
      Buffer.from('MZ'),
      Buffer.from('%PDF-1.4 pretend'),
      Buffer.alloc(100),
    ]);
    expect(rejection(sniffFile(disguised))).toBe('executable');
  });
});

describe('sniffFile: polyglots and damaged files', () => {
  it('refuses a PDF that is also a ZIP (an archive appended after the PDF)', () => {
    const zip = buildZip([{ name: 'payload.exe', data: Buffer.from('MZ evil') }]);
    const polyglot = Buffer.concat([minimalPdf(), zip]);
    expect(rejection(sniffFile(polyglot))).toBe('polyglot');
  });

  it('refuses an image with data appended after the end of the picture', () => {
    const png = Buffer.concat([minimalPng(), Buffer.from('<?php evil(); ?>')]);
    const jpeg = Buffer.concat([minimalJpeg(), Buffer.from('MZ and more bytes')]);
    const webp = Buffer.concat([minimalWebp(), Buffer.from('trailing payload')]);

    expect(rejection(sniffFile(png))).toBe('polyglot');
    expect(rejection(sniffFile(jpeg))).toBe('polyglot');
    expect(rejection(sniffFile(webp))).toBe('polyglot');
  });

  it('accepts trailing zero padding after an image, which some devices add', () => {
    const padded = Buffer.concat([minimalJpeg(), Buffer.alloc(16)]);
    expect(detected(sniffFile(padded))).toBe('image/jpeg');
  });

  it('refuses a truncated PDF and a PNG with a broken chunk length', () => {
    const truncated = minimalPdf().subarray(0, 12);
    const png = minimalPng();
    png.writeUInt32BE(0x7fffffff, 8);

    expect(rejection(sniffFile(truncated))).toBe('corrupt');
    expect(rejection(sniffFile(png))).toBe('corrupt');
  });

  it('refuses a DOCX that carries a macro project', () => {
    const withMacro = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
      { name: 'word/vbaProject.bin', data: Buffer.from('macro') },
    ]);
    expect(rejection(sniffFile(withMacro))).toBe('executable');
  });

  it('refuses text with binary content and files it cannot recognize', () => {
    const binaryText = Buffer.concat([
      Buffer.from('parece texto'),
      Buffer.from([0x00, 0x01, 0x02]),
    ]);
    const unknown = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);

    expect(rejection(sniffFile(binaryText))).toBe('unrecognized');
    expect(rejection(sniffFile(unknown))).toBe('unrecognized');
    expect(rejection(sniffFile(Buffer.alloc(0)))).toBe('unrecognized');
  });
});

describe('sniffFile: any bytes at all', () => {
  const PREFIXES = [
    Buffer.alloc(0),
    Buffer.from('%PDF-'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from('RIFF....WEBP'),
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  ];

  it('never throws and answers with a type or a reason, whatever the content', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PREFIXES),
        fc.uint8Array({ maxLength: 600 }),
        (prefix, tail) => {
          const result = sniffFile(Buffer.concat([prefix, Buffer.from(tail)]));
          return result.ok ? result.type.mime.length > 0 : result.reason.length > 0;
        },
      ),
      { numRuns: 400 },
    );
  });

  it('never says a file is allowed when it starts like an executable', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (tail) => {
        const dos = sniffFile(Buffer.concat([Buffer.from('MZ'), Buffer.from(tail)]));
        const elf = sniffFile(
          Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(tail)]),
        );
        return !dos.ok && !elf.ok;
      }),
      { numRuns: 200 },
    );
  });
});
