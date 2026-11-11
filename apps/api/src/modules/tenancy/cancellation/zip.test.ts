import { createHash } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { crc32, inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { ZipLimitError, zipStream, type ZipEntry } from './zip.js';

/**
 * A reader of the zip format, written from the specification and independent of the writer: the
 * central directory is the authority (names, sizes, offsets), each local header is checked against
 * it, and the CRC-32 of every inflated entry is recomputed.
 */
function readZip(bytes: Buffer): { name: string; data: Buffer; modifiedAt: Date }[] {
  const endAt = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(endAt, 'end of central directory').toBeGreaterThan(-1);
  const count = bytes.readUInt16LE(endAt + 10);
  const directorySize = bytes.readUInt32LE(endAt + 12);
  const directoryOffset = bytes.readUInt32LE(endAt + 16);
  expect(directoryOffset + directorySize).toBe(endAt);

  const entries: { name: string; data: Buffer; modifiedAt: Date }[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const time = bytes.readUInt16LE(cursor + 12);
    const date = bytes.readUInt16LE(cursor + 14);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    // Bit 3: the sizes follow the data. Bit 11: the name is UTF-8.
    expect(flags & 0x0808).toBe(0x0808);
    expect(method).toBe(8);

    expect(bytes.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    expect(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8'),
    ).toBe(name);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    // The data descriptor right after the data repeats the numbers of the central directory.
    const descriptorAt = dataStart + compressedSize;
    expect(bytes.readUInt32LE(descriptorAt)).toBe(0x08074b50);
    expect(bytes.readUInt32LE(descriptorAt + 4)).toBe(crc);
    expect(bytes.readUInt32LE(descriptorAt + 8)).toBe(compressedSize);
    expect(bytes.readUInt32LE(descriptorAt + 12)).toBe(size);

    const data = inflateRawSync(compressed);
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);

    const modifiedAt = new Date(
      Date.UTC(
        1980 + (date >> 9),
        ((date >> 5) & 0xf) - 1,
        date & 0x1f,
        time >> 11,
        (time >> 5) & 0x3f,
        (time & 0x1f) * 2,
      ),
    );
    entries.push({ name, data, modifiedAt });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor).toBe(endAt - 0);
  return entries;
}

const AT = new Date('2031-05-31T18:30:42.000Z');

async function build(entries: readonly ZipEntry[]): Promise<Buffer> {
  return buffer(zipStream(entries));
}

describe('the zip writer', () => {
  it('writes entries that an independent reader opens, with the right names, bytes and dates', async () => {
    const bytes = await build([
      { name: 'organizacion.json', modifiedAt: AT, body: Buffer.from('{"nombre":"Centro Aillu"}') },
      { name: 'pacientes/lista.json', modifiedAt: AT, body: Buffer.from('[1,2,3]') },
    ]);

    const read = readZip(bytes);

    expect(read.map((entry) => entry.name)).toEqual(['organizacion.json', 'pacientes/lista.json']);
    expect(read[0]?.data.toString('utf8')).toBe('{"nombre":"Centro Aillu"}');
    expect(read[1]?.data.toString('utf8')).toBe('[1,2,3]');
    // The format keeps two-second resolution.
    expect(read[0]?.modifiedAt.toISOString()).toBe('2031-05-31T18:30:42.000Z');
  });

  it('keeps accents and eñes in a name (UTF-8) and compresses text well', async () => {
    const text = 'línea con acentos y eñe\n'.repeat(5000);
    const bytes = await build([
      { name: 'evolución/niño.txt', modifiedAt: AT, body: Buffer.from(text) },
    ]);

    const [entry] = readZip(bytes);

    expect(entry?.name).toBe('evolución/niño.txt');
    expect(entry?.data.toString('utf8')).toBe(text);
    expect(bytes.length).toBeLessThan(text.length / 10);
  });

  it('streams a body that arrives in pieces, and an empty one', async () => {
    async function* pieces() {
      for (const piece of ['uno,', 'dos,', 'tres']) {
        await Promise.resolve();
        yield Buffer.from(piece);
      }
    }
    const bytes = await build([
      { name: 'por-partes.txt', modifiedAt: AT, body: pieces() },
      { name: 'vacio.txt', modifiedAt: AT, body: Buffer.alloc(0) },
    ]);

    const read = readZip(bytes);

    expect(read[0]?.data.toString('utf8')).toBe('uno,dos,tres');
    expect(read[1]?.data.length).toBe(0);
  });

  it('produces the same bytes for the same input, so a golden file can pin the structure', async () => {
    const entries = () => [
      { name: 'a.json', modifiedAt: AT, body: Buffer.from('{"a":1}') },
      { name: 'b.json', modifiedAt: AT, body: Buffer.from('{"b":2}') },
    ];

    const first = await build(entries());
    const second = await build(entries());

    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(second).digest('hex'),
    );
  });

  it('refuses a name that could escape the folder when it is unzipped', async () => {
    for (const name of ['../fuera.txt', '/absoluto.txt', 'a/../../b.txt', 'a\\b.txt', '', 'a//b']) {
      await expect(build([{ name, modifiedAt: AT, body: Buffer.from('x') }]), name).rejects.toThrow(
        /entry name/,
      );
    }
  });

  it('stops with a typed error when a body fails halfway, instead of closing a broken archive', async () => {
    async function* broken() {
      await Promise.resolve();
      yield Buffer.from('empieza');
      throw new Error('storage went away');
    }

    await expect(build([{ name: 'roto.bin', modifiedAt: AT, body: broken() }])).rejects.toThrow(
      'storage went away',
    );
  });

  it('refuses more entries than the limit, and an entry larger than the limit', async () => {
    const files = (count: number): ZipEntry[] =>
      Array.from({ length: count }, (_, index) => ({
        name: `f${String(index)}.txt`,
        modifiedAt: AT,
        body: Buffer.from('x'),
      }));

    // Exactly at the limit is fine; one more is not.
    expect(readZip(await buffer(zipStream(files(3), { maxEntries: 3 })))).toHaveLength(3);
    await expect(buffer(zipStream(files(4), { maxEntries: 3 }))).rejects.toMatchObject({
      limit: 'entries',
    });

    const big = [{ name: 'grande.bin', modifiedAt: AT, body: Buffer.alloc(11, 1) }];
    expect(readZip(await buffer(zipStream(big, { maxEntryBytes: 11 })))).toHaveLength(1);
    await expect(buffer(zipStream(big, { maxEntryBytes: 10 }))).rejects.toBeInstanceOf(
      ZipLimitError,
    );
  });
});
