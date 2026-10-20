import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { createInflateRaw, crc32 } from 'node:zlib';

/**
 * A reader for the zips this product writes (`cancellation/zip.ts`), enough to take a package apart
 * when a release is built: the central directory names every entry, and an entry is inflated as a
 * stream that checks its CRC-32 when it ends. Not a general zip reader: no encryption, no zip64, no
 * method but deflate, which is all the writer ever produces.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
/** The end record can be followed by a comment of up to 65,535 bytes. */
const END_SEARCH_BYTES = 22 + 65_535;

export interface ZipFileEntry {
  name: string;
  /** Uncompressed size. */
  size: number;
  /** The inflated content, checked against its CRC-32 at the end. */
  open(): Readable;
}

export async function listZip(path: string): Promise<ZipFileEntry[]> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const tailLength = Math.min(size, END_SEARCH_BYTES);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    let endAt = -1;
    for (let index = tailLength - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) {
        endAt = index;
        break;
      }
    }
    if (endAt < 0) throw new Error('not a zip: no end of central directory');
    const count = tail.readUInt16LE(endAt + 10);
    const directorySize = tail.readUInt32LE(endAt + 12);
    const directoryOffset = tail.readUInt32LE(endAt + 16);

    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directorySize, directoryOffset);
    const entries: ZipFileEntry[] = [];
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      if (directory.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) {
        throw new Error('not a zip: bad central directory');
      }
      const crc = directory.readUInt32LE(cursor + 16);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const entrySize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const localOffset = directory.readUInt32LE(cursor + 42);
      const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      cursor += 46 + nameLength + extraLength + commentLength;

      entries.push({
        name,
        size: entrySize,
        open() {
          const output = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              callback(null, chunk);
            },
          });
          void (async () => {
            const handle = await open(path, 'r');
            try {
              const header = Buffer.alloc(30);
              await handle.read(header, 0, 30, localOffset);
              if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
                throw new Error('not a zip: bad local header');
              }
              const dataStart =
                localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
              let running = 0;
              let inflated = 0;
              const inflate = createInflateRaw();
              const source =
                compressedSize === 0
                  ? Readable.from([])
                  : createReadStream(path, {
                      start: dataStart,
                      end: dataStart + compressedSize - 1,
                    });
              source.on('error', (error: Error) => inflate.destroy(error));
              source.pipe(inflate);
              for await (const chunk of inflate as AsyncIterable<Buffer>) {
                running = crc32(chunk, running);
                inflated += chunk.length;
                if (!output.write(chunk)) {
                  await new Promise((resolve) => output.once('drain', resolve));
                }
              }
              if (running !== crc || inflated !== entrySize) {
                throw new Error(`bad checksum in ${name}`);
              }
              output.end();
            } catch (error) {
              output.destroy(
                error instanceof Error ? error : new Error('could not read the entry'),
              );
            } finally {
              await handle.close();
            }
          })();
          return output;
        },
      });
    }
    return entries;
  } finally {
    await file.close();
  }
}

/**
 * The rows of a section file as the package writer made it: `[`, one row of JSON on each line (a comma
 * after all but the last) and `]`. A file that is not a list (a section that is one value) has no rows.
 */
export async function* readJsonRows(stream: Readable): AsyncGenerator {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let first = true;
  for await (const raw of lines) {
    const line = raw.trim();
    if (first) {
      first = false;
      if (line !== '[' && line !== '[]') {
        // A single value, not a list: it has no rows. Stop reading the file.
        lines.close();
        stream.destroy();
        return;
      }
      if (line === '[]') return;
      continue;
    }
    if (line === ']' || line === '') continue;
    yield JSON.parse(line.endsWith(',') ? line.slice(0, -1) : line) as unknown;
  }
}
