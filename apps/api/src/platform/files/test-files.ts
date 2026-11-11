import { crc32 } from 'node:zlib';

/**
 * Small, valid files for tests and for the demo data: a PDF, a JPEG, a PNG, a WebP and a DOCX that
 * pass `sniffFile`. They are real enough for the content checks (structure, signatures) and tiny.
 * Production code never imports this module.
 */

export function minimalPdf(text = 'Documento de prueba'): Buffer {
  const body = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${text}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function minimalPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk(
      'IDAT',
      Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]),
    ),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function minimalJpeg(): Buffer {
  return Buffer.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00, // APP0
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00, // SOS
    0x12,
    0x34,
    0xff,
    0x00,
    0x56, // entropy-coded data with a stuffed 0xFF
    0xff,
    0xd9, // EOI
  ]);
}

export function minimalWebp(): Buffer {
  const chunk = Buffer.concat([
    Buffer.from('VP8L', 'latin1'),
    Buffer.from([5, 0, 0, 0]),
    Buffer.from([0x2f, 0, 0, 0, 0]),
    Buffer.alloc(1),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + chunk.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, Buffer.from('WEBP', 'latin1'), chunk]);
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** A ZIP with stored (uncompressed) entries: enough for the sniffer, which reads names only. */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localBlock = Buffer.concat([local, name, entry.data]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(localBlock);
    centrals.push(Buffer.concat([central, name]));
    offset += localBlock.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

export function minimalDocx(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
    { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
  ]);
}

/**
 * The EICAR antivirus test string: harmless, and flagged by every scanner. It is written in parts
 * so this source file is not itself flagged by the antivirus of a developer machine.
 */
export const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!',
  '$H+H*',
].join('');
