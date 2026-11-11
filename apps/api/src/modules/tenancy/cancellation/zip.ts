import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';

/**
 * A streaming zip writer for the packages of the cancellation export. The packages can be large (a
 * clinic's whole history with its attached files), so nothing here holds an entry in memory: each
 * body is read piece by piece, hashed, deflated and handed on as it comes, and the sizes and the
 * checksum go in a data descriptor after the data (flag bit 3), which is why the writer never needs
 * to know a length up front.
 *
 * Deliberately small: deflate only, no encryption, no zip64. A package past the limits of the plain
 * format (4 GiB per entry or per archive, 65,535 entries) fails with a `ZipLimitError` and the job
 * records `package_too_large`, instead of writing an archive that some readers would open wrong.
 *
 * The output is deterministic: the date of every entry is an input (the job's clock), entries are
 * written in the order they come, and the deflate level is fixed.
 */

const LOCAL_FILE_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** Bit 3: sizes after the data. Bit 11: the name is UTF-8. */
const FLAGS = 0x0808;
const METHOD_DEFLATE = 8;
/** Version needed to extract: 2.0 (deflate, data descriptor, directories). */
const VERSION = 20;

const MAX_ENTRIES = 0xfffe;
const MAX_UINT32 = 0xffff_ffff;

export class ZipLimitError extends Error {
  constructor(readonly limit: 'entries' | 'entry_bytes' | 'archive_bytes') {
    super(`The package is past what the zip format can hold (${limit}).`);
    this.name = 'ZipLimitError';
  }
}

export interface ZipEntry {
  /** A relative path with `/` separators; no `..`, no leading `/`, no empty segment. */
  name: string;
  /** Goes into the entry as its modification date (two second resolution). */
  modifiedAt: Date;
  body: Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export interface ZipOptions {
  /** The most bytes of one entry (before compression). Defaults to the format's 4 GiB - 1. */
  maxEntryBytes?: number;
  /** The most entries. Defaults to the format's 65,534 (a tool lowers it to prove the refusal). */
  maxEntries?: number;
}

/** What the central directory remembers of each entry. */
interface Written {
  nameBytes: Buffer;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function assertEntryName(name: string): void {
  const segments = name.split('/');
  if (
    name === '' ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('entry name refused: it must be a relative path inside the package');
  }
}

/** MS-DOS date and time of an instant, in UTC. The format starts in 1980 and counts two seconds. */
function dosDateTime(at: Date): { dosDate: number; dosTime: number } {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    dosDate: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    dosTime:
      (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
  };
}

function localHeader(entry: Written): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_HEADER, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(FLAGS, 6);
  header.writeUInt16LE(METHOD_DEFLATE, 8);
  header.writeUInt16LE(entry.dosTime, 10);
  header.writeUInt16LE(entry.dosDate, 12);
  // CRC-32 and both sizes are zero here: they follow the data.
  header.writeUInt16LE(entry.nameBytes.length, 26);
  return Buffer.concat([header, entry.nameBytes]);
}

function dataDescriptor(entry: Written): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
  descriptor.writeUInt32LE(entry.crc, 4);
  descriptor.writeUInt32LE(entry.compressedSize, 8);
  descriptor.writeUInt32LE(entry.size, 12);
  return descriptor;
}

function centralHeader(entry: Written): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(VERSION, 6);
  header.writeUInt16LE(FLAGS, 8);
  header.writeUInt16LE(METHOD_DEFLATE, 10);
  header.writeUInt16LE(entry.dosTime, 12);
  header.writeUInt16LE(entry.dosDate, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.nameBytes.length, 28);
  header.writeUInt32LE(entry.localOffset, 42);
  return Buffer.concat([header, entry.nameBytes]);
}

function endRecord(count: number, directorySize: number, directoryOffset: number): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(directorySize, 12);
  record.writeUInt32LE(directoryOffset, 16);
  return record;
}

/**
 * Deflates one body and yields the compressed pieces, counting what went in. `pipeline` carries the
 * backpressure in both directions: a slow consumer of the zip slows the read of the body, so a large
 * body is never buffered, and an error in the body destroys the deflate stream and surfaces here.
 */
async function* deflated(
  body: ZipEntry['body'],
  tally: { crc: number; size: number; compressed: number },
  maxEntryBytes: number,
): AsyncGenerator<Buffer> {
  const source = body instanceof Uint8Array ? Readable.from([body]) : Readable.from(body);
  const count = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      tally.crc = crc32(chunk, tally.crc);
      tally.size += chunk.length;
      if (tally.size > maxEntryBytes) {
        callback(new ZipLimitError('entry_bytes'));
        return;
      }
      callback(null, chunk);
    },
  });
  const compress = createDeflateRaw({ level: 6 });
  const finished = pipeline(source, count, compress);
  // Avoid an unhandled rejection if the consumer stops reading before the pipeline ends.
  finished.catch(() => undefined);
  for await (const piece of compress as AsyncIterable<Buffer>) {
    tally.compressed += piece.length;
    yield piece;
  }
  await finished;
}

async function* zipPieces(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  options: ZipOptions,
): AsyncGenerator<Buffer> {
  const maxEntryBytes = Math.min(options.maxEntryBytes ?? MAX_UINT32, MAX_UINT32);
  const maxEntries = Math.min(options.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES);
  const written: Written[] = [];
  let offset = 0;

  for await (const entry of entries) {
    assertEntryName(entry.name);
    if (written.length >= maxEntries) throw new ZipLimitError('entries');
    const { dosDate, dosTime } = dosDateTime(entry.modifiedAt);
    const record: Written = {
      nameBytes: Buffer.from(entry.name, 'utf8'),
      dosDate,
      dosTime,
      crc: 0,
      compressedSize: 0,
      size: 0,
      localOffset: offset,
    };
    const header = localHeader(record);
    offset += header.length;
    yield header;

    const tally = { crc: 0, size: 0, compressed: 0 };
    for await (const piece of deflated(entry.body, tally, maxEntryBytes)) {
      offset += piece.length;
      if (offset > MAX_UINT32) throw new ZipLimitError('archive_bytes');
      yield piece;
    }
    record.crc = tally.crc;
    record.size = tally.size;
    record.compressedSize = tally.compressed;
    const descriptor = dataDescriptor(record);
    offset += descriptor.length;
    yield descriptor;
    written.push(record);
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const record of written) {
    const header = centralHeader(record);
    directorySize += header.length;
    yield header;
  }
  if (directoryOffset + directorySize > MAX_UINT32) throw new ZipLimitError('archive_bytes');
  yield endRecord(written.length, directorySize, directoryOffset);
}

/**
 * The archive as a readable stream. Pull it with `pipeline`, to a file or to the storage; the
 * entries are read lazily, one at a time.
 */
export function zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  options: ZipOptions = {},
): Readable {
  return Readable.from(zipPieces(entries, options), { objectMode: false });
}
