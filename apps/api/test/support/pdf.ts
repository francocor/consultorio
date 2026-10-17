import { inflateSync } from 'node:zlib';

/**
 * Reads back the PDFs the product renders, for tests (billing exports, invoices, the shared frame).
 * It understands only what `@react-pdf/renderer` writes with the standard fonts: Flate-compressed
 * content streams, text as hexadecimal strings in the WinAnsi encoding, a plain info dictionary.
 * It is not a PDF parser; it is enough to say "this page says that".
 */
export interface PdfReading {
  /** The number of pages. */
  pages: number;
  /** The text of each page, one string per page, runs joined by a single space. */
  texts: string[];
  /** The document information (title, author, creation date, ...), decoded. */
  info: Record<string, string>;
}

function inflateStreams(pdf: string): string[] {
  const streams: string[] = [];
  for (const match of pdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const raw = match[1];
    if (raw === undefined) continue;
    try {
      streams.push(inflateSync(Buffer.from(raw, 'latin1')).toString('latin1'));
    } catch {
      // An image or a font program: not a content stream.
    }
  }
  return streams;
}

/** The text runs of one decoded content stream: every `[<hex> n <hex>] TJ`. */
function textOf(content: string): string {
  const runs: string[] = [];
  for (const match of content.matchAll(/\[((?:<[0-9a-fA-F]*>|\s|-?[0-9.]+)*)\]\s*TJ/g)) {
    const pieces = [...(match[1] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)].map((hex) =>
      Buffer.from(hex[1] ?? '', 'hex').toString('latin1'),
    );
    runs.push(pieces.join(''));
  }
  // A line that wraps ends in a space of its own: the page reads with single spaces.
  return runs.join(' ').replace(/ {2,}/g, ' ');
}

/** A PDF text string: PDFDocEncoding, or UTF-16BE when it starts with the byte order mark. */
function decodeTextString(raw: string): string {
  const bytes = Buffer.from(raw, 'latin1');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  }
  return raw;
}

export function readPdf(bytes: Buffer): PdfReading {
  const pdf = bytes.toString('latin1');
  const pageObjects = pdf.match(/\/Type \/Page(?!s)/g) ?? [];
  const texts = inflateStreams(pdf)
    .filter((content) => content.includes('BT'))
    .map(textOf);

  // The information dictionary points at one object per value: `/Title 17 0 R`.
  const info: Record<string, string> = {};
  const dictionary = /<<\s*\/Producer[^>]*>>/.exec(pdf)?.[0] ?? '';
  for (const entry of dictionary.matchAll(/\/([A-Za-z]+)\s+(\d+) 0 R/g)) {
    const key = entry[1];
    const object = new RegExp(`\\n${entry[2] ?? ''} 0 obj\\n\\(([\\s\\S]*?)\\)\\nendobj`).exec(pdf);
    if (key !== undefined && object?.[1] !== undefined) info[key] = decodeTextString(object[1]);
  }
  return { pages: pageObjects.length, texts, info };
}

/** Everything the document says, page after page, as one string to look into. */
export function allText(reading: PdfReading): string {
  return reading.texts.join('\n');
}
