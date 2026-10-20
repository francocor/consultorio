import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Reads a zip from the bytes, written from the format and independent of the writer in the code under
 * test: the central directory is the authority, every entry is inflated and its CRC-32 is checked.
 * Tests use it to look inside a package of the cancellation export or of a release.
 */
export function readZip(bytes: Buffer): Map<string, Buffer> {
  const endAt = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('not a zip: no end of central directory');
  const count = bytes.readUInt16LE(endAt + 10);
  let cursor = bytes.readUInt32LE(endAt + 16);

  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central directory header');
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    const dataStart =
      localOffset +
      30 +
      bytes.readUInt16LE(localOffset + 26) +
      bytes.readUInt16LE(localOffset + 28);
    const data = inflateRawSync(bytes.subarray(dataStart, dataStart + compressedSize));
    if (crc32(data) !== crc) throw new Error(`bad checksum in ${name}`);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Every text entry of a zip joined, to look for a phrase that must (or must not) be anywhere in it. */
export function allTextOf(entries: ReadonlyMap<string, Buffer>): string {
  return [...entries.entries()]
    .filter(([name]) => !name.endsWith('.pdf'))
    .map(([, data]) => data.toString('utf8'))
    .join('\n');
}
