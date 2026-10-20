import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  packageEntries,
  type PackageReport,
  type PackageSource,
  type ReadAttachment,
} from './package-content.js';
import { ClinicalKeyInAdministrativePartError } from './redaction.js';
import type { ZipEntry } from './zip.js';

const AT = new Date('2031-05-31T18:00:00.000Z');
let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'package-content-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Reads every entry's bytes the way the zip would, one after the other. */
async function collect(entries: AsyncIterable<ZipEntry>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const entry of entries) {
    const body =
      entry.body instanceof Uint8Array
        ? Buffer.from(entry.body)
        : await buffer(Readable.from(entry.body as AsyncIterable<Uint8Array>));
    out.set(entry.name, body.toString('utf8'));
  }
  return out;
}

const source = (name: string, value: unknown): PackageSource => ({
  name,
  run: async (sink) => sink(value),
});

const noAttachments: ReadAttachment = () => Promise.resolve(null);

function build(
  kind: 'administrative' | 'clinical',
  sources: PackageSource[],
  extra: {
    readAttachment?: ReadAttachment;
    onRow?: (contributor: string, section: string, rows: number) => void;
  } = {},
) {
  let report: PackageReport | undefined;
  const entries = packageEntries({
    kind,
    sources,
    workDir,
    modifiedAt: AT,
    readAttachment: extra.readAttachment ?? noAttachments,
    ...(extra.onRow ? { onRow: extra.onRow } : {}),
    trailer: (final) => {
      report = final;
      return Promise.resolve([
        { name: 'manifest.json', modifiedAt: AT, body: Buffer.from(JSON.stringify(final)) },
      ]);
    },
  });
  return { entries, report: () => report };
}

describe('the entries of a package', () => {
  it('turns each section of a contributor into a JSON file, and counts the rows of a list', async () => {
    const { entries, report } = build('administrative', [
      source('patients', {
        patients: [
          { id: 'p1', familyName: 'Ríos' },
          { id: 'p2', familyName: 'Soto' },
        ],
        organization: { slug: 'aillu', status: 'cancelled' },
      }),
    ]);

    const files = await collect(entries);

    expect([...files.keys()]).toEqual([
      'patients/patients.json',
      'patients/organization.json',
      'manifest.json',
    ]);
    expect(JSON.parse(files.get('patients/patients.json') ?? '')).toEqual([
      { id: 'p1', familyName: 'Ríos' },
      { id: 'p2', familyName: 'Soto' },
    ]);
    expect(JSON.parse(files.get('patients/organization.json') ?? '')).toEqual({
      slug: 'aillu',
      status: 'cancelled',
    });
    expect(report()?.sections).toEqual([
      { contributor: 'patients', section: 'patients', path: 'patients/patients.json', rows: 2 },
      {
        contributor: 'patients',
        section: 'organization',
        path: 'patients/organization.json',
        rows: null,
      },
    ]);
  });

  it('writes an empty list as an empty array and still reports it, so an empty record is visible', async () => {
    const { entries, report } = build('clinical', [source('clinical', { entries: [] })]);

    const files = await collect(entries);

    expect(JSON.parse(files.get('clinical/entries.json') ?? '')).toEqual([]);
    expect(report()?.sections[0]).toMatchObject({ section: 'entries', rows: 0 });
  });

  it('keeps dates as ISO text and turns a bigint into text instead of failing', async () => {
    const { entries } = build('administrative', [
      source('billing', { rows: [{ at: new Date('2031-01-02T03:04:05.000Z'), cents: 12n }] }),
    ]);

    const files = await collect(entries);

    expect(JSON.parse(files.get('billing/rows.json') ?? '')).toEqual([
      { at: '2031-01-02T03:04:05.000Z', cents: '12' },
    ]);
  });

  it('removes the secrets of any depth and names the fields it removed', async () => {
    const { entries, report } = build('administrative', [
      source('identity', {
        staff: [
          {
            email: 'a@aillu.test',
            passwordHash: '$argon2id$...',
            security: { totpSecretEnc: 'xx', recoveryCodes: ['1'], kept: 'sí' },
            tokenHash: 'abc',
          },
        ],
      }),
    ]);

    const text = (await collect(entries)).get('identity/staff.json') ?? '';

    expect(JSON.parse(text)).toEqual([{ email: 'a@aillu.test', security: { kept: 'sí' } }]);
    expect(text).not.toMatch(/argon2|totp|recovery|tokenHash/i);
    expect(report()?.redactedKeys.sort()).toEqual([
      'passwordHash',
      'recoveryCodes',
      'tokenHash',
      'totpSecretEnc',
    ]);
  });

  it('leaves alone a field that only looks like a secret by a piece of its name', async () => {
    const { entries, report } = build('administrative', [
      source('documents', { documents: [{ tokenKind: 'x', contentHash: 'h', sha256: 's' }] }),
    ]);

    const text = (await collect(entries)).get('documents/documents.json') ?? '';

    expect(JSON.parse(text)).toEqual([{ tokenKind: 'x', contentHash: 'h', sha256: 's' }]);
    expect(report()?.redactedKeys).toEqual([]);
  });

  it('refuses a clinical field in the administrative part, at any depth, and delivers nothing after it', async () => {
    for (const value of [
      { notes: [{ id: 'n1', addenda: [] }] },
      { patients: [{ id: 'p1', visit: { content: 'dolor' } }] },
      { anamnesis: [] },
    ]) {
      const { entries } = build('administrative', [source('patients', value)]);

      await expect(collect(entries), JSON.stringify(value)).rejects.toBeInstanceOf(
        ClinicalKeyInAdministrativePartError,
      );
    }
  });

  it('accepts the same fields in a clinical part', async () => {
    const { entries } = build('clinical', [
      source('clinical', { entries: [{ content: { reasonForConsultation: 'Control' } }] }),
    ]);

    const files = await collect(entries);

    expect(JSON.parse(files.get('clinical/entries.json') ?? '')).toEqual([
      { content: { reasonForConsultation: 'Control' } },
    ]);
  });

  it('does not take a generic name for a clinical one: contentType is not content, a waitlist entry is not a record', async () => {
    const { entries } = build('administrative', [
      source('documents', { documents: [{ id: 'd1', contentType: 'application/pdf' }] }),
      source('waitlist', { entries: [{ id: 'w1', status: 'waiting' }] }),
    ]);

    const files = await collect(entries);

    expect(files.has('documents/documents.json')).toBe(true);
    expect(JSON.parse(files.get('waitlist/entries.json') ?? '')).toEqual([
      { id: 'w1', status: 'waiting' },
    ]);
  });

  it('never reads a list ahead of what it has written: a list too big for memory streams through', async () => {
    let pulled = 0;
    let written = 0;
    let furthestAhead = 0;
    async function* rows() {
      for (let index = 0; index < 3000; index += 1) {
        await Promise.resolve();
        pulled += 1;
        furthestAhead = Math.max(furthestAhead, pulled - written);
        yield { index, filler: 'x'.repeat(2000) };
      }
    }
    const { entries, report } = build(
      'administrative',
      [source('messages', { messages: rows() })],
      {
        onRow: () => {
          written += 1;
        },
      },
    );

    const files = await collect(entries);

    expect(report()?.sections[0]).toMatchObject({ section: 'messages', rows: 3000 });
    expect(JSON.parse(files.get('messages/messages.json') ?? '')).toHaveLength(3000);
    // Pulling the next row waits for the write of the one before: one in flight at most.
    expect(furthestAhead).toBeLessThanOrEqual(2);
    expect(written).toBe(3000);
  });

  it('adds the files a section points at, checks their checksum and reports what is missing or altered', async () => {
    const stored = new Map<string, string>([
      ['t/x/documents/a', 'contenido A'],
      ['t/x/documents/b', 'contenido B alterado'],
    ]);
    const readAttachment: ReadAttachment = (objectKey) => {
      const body = stored.get(objectKey);
      return Promise.resolve(
        body === undefined ? null : { stream: Readable.from([Buffer.from(body)]) },
      );
    };
    const { entries, report } = build(
      'administrative',
      [
        source('documents', {
          documents: [
            {
              id: 'a',
              name: 'Orden médica.pdf',
              objectKey: 't/x/documents/a',
              sha256: sha('contenido A'),
            },
            {
              id: 'b',
              name: '../../etc/passwd',
              objectKey: 't/x/documents/b',
              sha256: sha('contenido B'),
            },
            { id: 'c', name: 'perdido.pdf', objectKey: 't/x/documents/c', sha256: sha('nada') },
          ],
        }),
      ],
      { readAttachment },
    );

    const files = await collect(entries);

    expect(files.get('documents/files/a-Orden médica.pdf')).toBe('contenido A');
    // A name that tries to climb out keeps only its last piece: it is never trusted as a path.
    expect(files.get('documents/files/b-passwd')).toBe('contenido B alterado');
    expect(report()?.attachments).toEqual([
      { path: 'documents/files/a-Orden médica.pdf', status: 'included' },
      { path: 'documents/files/b-passwd', status: 'checksum_mismatch' },
      { path: 'documents/files/c-perdido.pdf', status: 'missing' },
    ]);
  });

  it('adds a file once when two rows point at the same object', async () => {
    let reads = 0;
    const readAttachment: ReadAttachment = () => {
      reads += 1;
      return Promise.resolve({ stream: Readable.from([Buffer.from('igual')]) });
    };
    const { entries, report } = build(
      'administrative',
      [
        source('documents', {
          documents: [
            { id: 'a', name: 'uno.pdf', objectKey: 't/x/o', sha256: sha('igual') },
            { id: 'b', name: 'dos.pdf', objectKey: 't/x/o', sha256: sha('igual') },
          ],
        }),
      ],
      { readAttachment },
    );

    await collect(entries);

    expect(reads).toBe(1);
    expect(report()?.attachments).toHaveLength(1);
  });

  it('removes what it spooled to disk, also when a contributor fails', async () => {
    const failing: PackageSource = {
      name: 'billing',
      run: async (sink) => {
        await sink({ rows: [{ id: 1 }] });
        throw new Error('database went away');
      },
    };
    const { entries } = build('administrative', [
      source('patients', { patients: [{ id: 'p' }] }),
      failing,
    ]);

    await expect(collect(entries)).rejects.toThrow('database went away');

    expect(await readdir(workDir)).toEqual([]);
  });

  it('puts the trailer last, with the report of everything before it', async () => {
    const { entries } = build('administrative', [
      source('one', { a: [1] }),
      source('two', { b: [2, 3] }),
    ]);

    const names = [...(await collect(entries)).keys()];

    expect(names.at(-1)).toBe('manifest.json');
    expect(names.slice(0, -1)).toEqual(['one/a.json', 'two/b.json']);
  });
});
