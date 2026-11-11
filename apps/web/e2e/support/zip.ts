import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/**
 * Reads the files of a downloaded ZIP from its central directory (the packages are written with data
 * descriptors, so the local headers do not carry the sizes). No zip64: the packages never use it.
 */
export function readZip(path: string): Map<string, Buffer> {
  const buffer = readFileSync(path);
  expectSignature(buffer, 0, 0x04034b50, 'the file starts like a zip');

  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('the zip has no end of central directory');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);

  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    expectSignature(buffer, cursor, 0x02014b50, 'a central directory entry');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    expectSignature(buffer, local, 0x04034b50, 'a local header');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    files.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
  }
  return files;
}

function expectSignature(buffer: Buffer, at: number, signature: number, what: string): void {
  if (buffer.readUInt32LE(at) !== signature) throw new Error(`not a zip: ${what}`);
}

/** Every file of the zip joined, to look for a word in the whole package. */
export function textOf(files: Map<string, Buffer>): string {
  return [...files.values()].map((file) => file.toString('utf8')).join('\n');
}
