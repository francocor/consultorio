import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { zipStream, type ZipEntry } from '../cancellation/zip.js';

import { listZip, readJsonRows, type ZipFileEntry } from './zip-read.js';

let folder: string;
const AT = new Date('2031-05-31T18:00:00.000Z');

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'zip-read-test-'));
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function write(name: string, entries: ZipEntry[]): Promise<string> {
  const path = join(folder, name);
  await pipeline(zipStream(entries), createWriteStream(path));
  return path;
}

function opened(entries: ZipFileEntry[], index: number) {
  const entry = entries[index];
  if (!entry) throw new Error(`no entry ${String(index)}`);
  return entry.open();
}

async function text(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk.toString();
  return out;
}

describe('reading a zip the writer made', () => {
  it('lists the entries with their names and sizes, and opens each one', async () => {
    const path = await write('basic.zip', [
      { name: 'a/uno.json', modifiedAt: AT, body: Buffer.from('{"uno":1}') },
      { name: 'b/niño.txt', modifiedAt: AT, body: Buffer.from('contenido '.repeat(2000)) },
      { name: 'vacio.txt', modifiedAt: AT, body: Buffer.alloc(0) },
    ]);

    const entries = await listZip(path);

    expect(entries.map((entry) => entry.name)).toEqual(['a/uno.json', 'b/niño.txt', 'vacio.txt']);
    expect(entries.map((entry) => entry.size)).toEqual([9, 20_000, 0]);
    expect(await text(opened(entries, 0))).toBe('{"uno":1}');
    expect(await text(opened(entries, 1))).toBe('contenido '.repeat(2000));
    expect(await text(opened(entries, 2))).toBe('');
  });

  it('opens entries in any order and more than once', async () => {
    const path = await write('order.zip', [
      { name: 'primero', modifiedAt: AT, body: Buffer.from('1') },
      { name: 'segundo', modifiedAt: AT, body: Buffer.from('2') },
    ]);
    const entries = await listZip(path);

    expect(await text(opened(entries, 1))).toBe('2');
    expect(await text(opened(entries, 0))).toBe('1');
    expect(await text(opened(entries, 1))).toBe('2');
  });

  it('refuses a file that is not a zip', async () => {
    const path = join(folder, 'nada.zip');
    await pipeline([Buffer.from('this is not a zip at all')], createWriteStream(path));

    await expect(listZip(path)).rejects.toThrow(/not a zip/);
  });

  it('fails on a checksum that does not match the data it inflated', async () => {
    const path = await write('crc.zip', [
      { name: 'dato', modifiedAt: AT, body: Buffer.from('algo que se puede alterar') },
    ]);
    const { readFile, writeFile } = await import('node:fs/promises');
    const bytes = await readFile(path);
    // Flip one bit of the data right after the local header (30 bytes + the name).
    const at = 30 + 'dato'.length + 3;
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    await writeFile(path, bytes);
    const entries = await listZip(path);

    await expect(text(opened(entries, 0))).rejects.toBeDefined();
  });
});

describe('reading the rows of a section', () => {
  const rows = [
    { id: 'p1', familyName: 'Ríos', visits: [1, 2] },
    { id: 'p2', familyName: 'Soto, Ana', note: 'línea con "comillas"' },
  ];

  async function section(content: string): Promise<AsyncIterable<unknown>> {
    const path = await write(`rows-${String(Math.random())}.zip`, [
      { name: 'x/y.json', modifiedAt: AT, body: Buffer.from(content) },
    ]);
    return readJsonRows(opened(await listZip(path), 0));
  }

  it('reads a list the way the package writer wrote it, row by row', async () => {
    const body = `[\n  ${rows.map((row) => JSON.stringify(row)).join(',\n  ')}\n]\n`;

    const read: unknown[] = [];
    for await (const row of await section(body)) read.push(row);

    expect(read).toEqual(rows);
  });

  it('reads an empty list as no rows', async () => {
    const read: unknown[] = [];
    for await (const row of await section('[]\n')) read.push(row);

    expect(read).toEqual([]);
  });

  it('reads a section that is a single value as no rows', async () => {
    const read: unknown[] = [];
    for await (const row of await section('{\n  "slug": "aillu",\n  "status": "cancelled"\n}\n')) {
      read.push(row);
    }

    expect(read).toEqual([]);
  });
});
