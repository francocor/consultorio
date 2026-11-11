import { DOCUMENT_EXTENSIONS, type DocumentContentType } from '@consultorio/contracts';

/**
 * Content sniffing for uploads (documents, "Type and size validation"). The type of a file is what
 * its BYTES say, never its name or the type the client declared. Only the whitelist passes:
 * PDF, JPEG, PNG, WebP, plain text and DOCX. Executables, scripts and archives are refused, and so
 * is a file that is two things at once (a PDF with a ZIP appended, an image with a script after
 * its last byte), because such a file is the usual way to smuggle a payload past a type check.
 */

export interface DetectedType {
  mime: DocumentContentType;
  extension: string;
}

/** Why a file was refused. The message for the user is chosen from this by the caller. */
export type SniffRejection =
  'executable' | 'script' | 'archive' | 'polyglot' | 'corrupt' | 'unrecognized';

export type SniffResult = { ok: true; type: DetectedType } | { ok: false; reason: SniffRejection };

const DOCX_MIME: DocumentContentType =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const accept = (mime: DocumentContentType): SniffResult => ({
  ok: true,
  type: { mime, extension: DOCUMENT_EXTENSIONS[mime] },
});
const refuse = (reason: SniffRejection): SniffResult => ({ ok: false, reason });

const startsWith = (bytes: Buffer, ...prefix: number[]): boolean =>
  bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
const asciiAt = (bytes: Buffer, offset: number, text: string): boolean =>
  bytes.length >= offset + text.length &&
  bytes.toString('latin1', offset, offset + text.length) === text;

/** Executable formats, by their first bytes. */
function isExecutable(bytes: Buffer): boolean {
  return (
    startsWith(bytes, 0x4d, 0x5a) || // MZ: Windows / DOS executables and DLLs
    startsWith(bytes, 0x7f, 0x45, 0x4c, 0x46) || // ELF
    startsWith(bytes, 0xfe, 0xed, 0xfa, 0xce) || // Mach-O
    startsWith(bytes, 0xfe, 0xed, 0xfa, 0xcf) ||
    startsWith(bytes, 0xce, 0xfa, 0xed, 0xfe) ||
    startsWith(bytes, 0xcf, 0xfa, 0xed, 0xfe) ||
    startsWith(bytes, 0xca, 0xfe, 0xba, 0xbe) || // Java class / universal Mach-O
    startsWith(bytes, 0x00, 0x61, 0x73, 0x6d) // WebAssembly
  );
}

/** Archive and compression formats other than ZIP (ZIP is handled apart: a DOCX is a ZIP). */
function isOtherArchive(bytes: Buffer): boolean {
  return (
    asciiAt(bytes, 0, 'Rar!\x1a\x07') ||
    startsWith(bytes, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) || // 7z
    startsWith(bytes, 0x1f, 0x8b) || // gzip
    asciiAt(bytes, 0, 'BZh') ||
    startsWith(bytes, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) || // xz
    startsWith(bytes, 0x28, 0xb5, 0x2f, 0xfd) || // zstd
    asciiAt(bytes, 0, 'MSCF') || // cabinet
    asciiAt(bytes, 257, 'ustar') // tar
  );
}

function isZip(bytes: Buffer): boolean {
  return (
    startsWith(bytes, 0x50, 0x4b, 0x03, 0x04) ||
    startsWith(bytes, 0x50, 0x4b, 0x05, 0x06) ||
    startsWith(bytes, 0x50, 0x4b, 0x07, 0x08)
  );
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIZE = 22;
const MAX_EOCD_SEARCH = EOCD_SIZE + 0xffff;
const MAX_ZIP_ENTRIES = 10_000;

interface ZipDirectory {
  names: string[];
  /** True when something follows the end-of-central-directory record. */
  trailing: boolean;
}

/** Reads the names in a ZIP's central directory. Null when the structure does not hold together. */
function readZipDirectory(bytes: Buffer): ZipDirectory | null {
  const searchFrom = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (let at = bytes.length - EOCD_SIZE; at >= searchFrom; at -= 1) {
    if (bytes.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
    const entries = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 12);
    const offset = bytes.readUInt32LE(at + 16);
    const commentLength = bytes.readUInt16LE(at + 20);
    if (entries > MAX_ZIP_ENTRIES || size > at) continue;

    // The directory normally ends right where this record starts. When bytes were put in front of
    // the archive (a PDF with a ZIP appended), the stored offset is relative to the archive's own
    // start, so the position derived from the record is the one that holds.
    const names: string[] = [];
    let cursor = at - size;
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE && offset + size <= at) cursor = offset;
    for (let index = 0; index < entries; index += 1) {
      if (cursor + 46 > at || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null;
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const extraLength = bytes.readUInt16LE(cursor + 30);
      const commentLen = bytes.readUInt16LE(cursor + 32);
      if (cursor + 46 + nameLength > at) return null;
      names.push(bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength));
      cursor += 46 + nameLength + extraLength + commentLen;
    }
    return { names, trailing: at + EOCD_SIZE + commentLength !== bytes.length };
  }
  return null;
}

/** True when the bytes end with a valid ZIP directory: the file is also an archive. */
function endsLikeZip(bytes: Buffer): boolean {
  return readZipDirectory(bytes) !== null;
}

function sniffZip(bytes: Buffer): SniffResult {
  const directory = readZipDirectory(bytes);
  if (directory === null) return refuse('corrupt');
  const names = new Set(directory.names);
  const isDocx = names.has('[Content_Types].xml') && names.has('word/document.xml');
  if (!isDocx) return refuse('archive');
  if (directory.trailing) return refuse('polyglot');
  // A Word file that carries a macro project is a program, not a document.
  if (directory.names.some((name) => /(^|\/)vbaProject\.bin$/i.test(name))) {
    return refuse('executable');
  }
  if (directory.names.some((name) => name.startsWith('/') || name.split('/').includes('..'))) {
    return refuse('corrupt');
  }
  return accept(DOCX_MIME);
}

const allZero = (bytes: Buffer, from: number): boolean => {
  for (let index = from; index < bytes.length; index += 1) if (bytes[index] !== 0) return false;
  return true;
};

function sniffPdf(bytes: Buffer): SniffResult {
  const tail = bytes.toString('latin1', Math.max(0, bytes.length - 1024));
  if (!tail.includes('%%EOF')) return refuse('corrupt');
  // A PDF whose bytes also end like a ZIP opens as either, depending on who reads it.
  if (endsLikeZip(bytes)) return refuse('polyglot');
  return accept('application/pdf');
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function sniffPng(bytes: Buffer): SniffResult {
  let offset: number = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) return refuse('corrupt');
    if (type === 'IEND') return allZero(bytes, end) ? accept('image/png') : refuse('polyglot');
    offset = end;
  }
  return refuse('corrupt');
}

/** Offset just after the EOI marker of a JPEG, walking the segments; null if it is malformed. */
function jpegEnd(bytes: Buffer): number | null {
  let offset = 2;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9) return offset + 2;
    // Markers without a length: RSTn, TEM and a stuffed zero.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x00) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
    if (marker === 0xda) {
      // After the scan header comes entropy-coded data, where 0xFF is followed by 0x00 (stuffing)
      // or a restart marker; anything else is the next real marker.
      while (offset + 1 < bytes.length) {
        const next = bytes[offset + 1] ?? 0;
        if (bytes[offset] === 0xff && next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
        offset += 1;
      }
    }
  }
  return null;
}

function sniffJpeg(bytes: Buffer): SniffResult {
  const end = jpegEnd(bytes);
  if (end === null) return refuse('corrupt');
  return allZero(bytes, end) ? accept('image/jpeg') : refuse('polyglot');
}

function sniffWebp(bytes: Buffer): SniffResult {
  const declared = bytes.readUInt32LE(4) + 8;
  if (declared > bytes.length || declared < 12) return refuse('corrupt');
  return allZero(bytes, declared) ? accept('image/webp') : refuse('polyglot');
}

const SCRIPT_START = [
  '#!',
  '<?php',
  '<?=',
  '<%',
  '<script',
  '<html',
  '<!doctype',
  '<svg',
  '<body',
  '<iframe',
  '<?xml',
];

// eslint-disable-next-line no-control-regex
const BINARY_CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;

function sniffText(bytes: Buffer): SniffResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('unrecognized');
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (BINARY_CONTROL.test(body)) return refuse('unrecognized');
  const lowered = body.trimStart().toLowerCase();
  if (SCRIPT_START.some((start) => lowered.startsWith(start)) || lowered.includes('<script')) {
    return refuse('script');
  }
  return accept('text/plain');
}

/**
 * Decides what a file is from its bytes. Pure and synchronous: it works on a buffer the caller
 * already holds (uploads are capped at 20 MB), so the same bytes can also be hashed and scanned.
 */
export function sniffFile(bytes: Buffer): SniffResult {
  if (bytes.length === 0) return refuse('unrecognized');
  if (isExecutable(bytes)) return refuse('executable');
  if (isOtherArchive(bytes)) return refuse('archive');
  if (isZip(bytes)) return sniffZip(bytes);
  if (asciiAt(bytes, 0, '#!')) return refuse('script');

  if (asciiAt(bytes, 0, '%PDF-')) return sniffPdf(bytes);
  if (startsWith(bytes, ...PNG_SIGNATURE)) return sniffPng(bytes);
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return sniffJpeg(bytes);
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return sniffWebp(bytes);

  return sniffText(bytes);
}
