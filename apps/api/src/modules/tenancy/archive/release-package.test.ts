import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { zipStream, type ZipEntry } from '../cancellation/zip.js';

import type { ArchiveManifest } from './manifest.js';
import { buildPatientPackage, findPatientId, findProfessionalPart } from './release-package.js';
import { listZip } from './zip-read.js';

// Real zips on disk: slower than a unit test when the machine is busy with the rest of the suite.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const AT = new Date('2031-05-31T18:00:00.000Z');
const ANA = '0190a000-0000-7000-8000-0000000000a1';
const BRUNO = '0190a000-0000-7000-8000-0000000000b2';
let folder: string;
let admin: string;
let clinicalOne: string;
let clinicalTwo: string;

const json = (rows: unknown[]) =>
  Buffer.from(
    rows.length === 0
      ? '[]\n'
      : `[\n  ${rows.map((row) => JSON.stringify(row)).join(',\n  ')}\n]\n`,
  );

/** Every entry of a zip as a Buffer, read with the reader the release uses. */
async function readZip(path: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const entry of await listZip(path)) {
    const chunks: Buffer[] = [];
    for await (const chunk of entry.open() as AsyncIterable<Buffer>) chunks.push(chunk);
    out.set(entry.name, Buffer.concat(chunks));
  }
  return out;
}

async function write(name: string, entries: ZipEntry[]): Promise<string> {
  const path = join(folder, name);
  await pipeline(zipStream(entries), createWriteStream(path));
  return path;
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'release-package-test-'));
  admin = await write('admin.zip', [
    {
      name: 'patients/patients.json',
      modifiedAt: AT,
      body: json([
        { id: ANA, familyName: 'Ríos', documentType: 'dni', document: '20.111.222' },
        { id: BRUNO, familyName: 'Soto', documentType: 'dni', document: '30999888' },
      ]),
    },
    {
      name: 'scheduling/appointments.json',
      modifiedAt: AT,
      body: json([
        { id: 'a1', patientId: ANA, startsAt: '2031-01-01T10:00:00Z' },
        { id: 'a2', patientId: BRUNO, startsAt: '2031-01-02T10:00:00Z' },
      ]),
    },
    {
      name: 'tenancy/organization.json',
      modifiedAt: AT,
      body: Buffer.from('{\n  "slug": "aillu"\n}\n'),
    },
    { name: 'manifiesto.json', modifiedAt: AT, body: Buffer.from('{}') },
  ]);
  clinicalOne = await write('clinical-one.zip', [
    {
      name: 'clinical/entries.json',
      modifiedAt: AT,
      body: json([
        { noteId: 'n1', patientId: ANA, content: { reasonForConsultation: 'Lumbalgia de Ana' } },
        { noteId: 'n2', patientId: BRUNO, content: { reasonForConsultation: 'Cefalea de Bruno' } },
      ]),
    },
    {
      name: 'documents/documents.json',
      modifiedAt: AT,
      body: json([
        {
          id: 'd1',
          patientId: ANA,
          name: 'Orden.pdf',
          objectKey: 't/x/d1',
          sha256: 'a'.repeat(64),
        },
        {
          id: 'd2',
          patientId: BRUNO,
          name: 'Otra.pdf',
          objectKey: 't/x/d2',
          sha256: 'b'.repeat(64),
        },
      ]),
    },
    { name: 'documents/files/d1-Orden.pdf', modifiedAt: AT, body: Buffer.from('PDF de Ana') },
    { name: 'documents/files/d2-Otra.pdf', modifiedAt: AT, body: Buffer.from('PDF de Bruno') },
  ]);
  clinicalTwo = await write('clinical-two.zip', [
    {
      name: 'clinical/entries.json',
      modifiedAt: AT,
      body: json([
        // The same note appears in the package of a second professional who treats the patient.
        { noteId: 'n1', patientId: ANA, content: { reasonForConsultation: 'Lumbalgia de Ana' } },
        { noteId: 'n3', patientId: ANA, content: { reasonForConsultation: 'Control de Ana' } },
      ]),
    },
  ]);
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('finding who asks in the archive', () => {
  it('finds a patient by document, ignoring dots and spaces and the case of the type', async () => {
    expect(await findPatientId(admin, { documentType: 'DNI', document: '20111222' })).toBe(ANA);
    expect(await findPatientId(admin, { documentType: 'dni', document: '30 999 888' })).toBe(BRUNO);
  });

  it('finds nobody for a document that is not in the archive, or a type that does not match', async () => {
    expect(await findPatientId(admin, { documentType: 'dni', document: '1' })).toBeNull();
    expect(
      await findPatientId(admin, { documentType: 'pasaporte', document: '20111222' }),
    ).toBeNull();
  });

  it('finds the part of a professional by registration, from the manifest alone', () => {
    const manifest = {
      parts: [
        {
          part: 'administrative',
          kind: 'administrative',
          professionalId: null,
          professional: null,
        },
        {
          part: 'clinical-p1',
          kind: 'clinical',
          professionalId: '0190a000-0000-7000-8000-0000000000c1',
          professional: {
            matriculaJurisdiction: 'AR-B',
            matricula: '700123',
            matriculaStatus: 'verified',
          },
        },
        {
          part: 'clinical-p2',
          kind: 'clinical',
          professionalId: '0190a000-0000-7000-8000-0000000000c2',
          professional: {
            matriculaJurisdiction: 'AR-B',
            matricula: '700124',
            matriculaStatus: 'unverified',
          },
        },
      ],
    } as unknown as ArchiveManifest;

    expect(
      findProfessionalPart(manifest, { jurisdiction: 'ar-b', matricula: '700 123' })?.part,
    ).toBe('clinical-p1');
    expect(
      findProfessionalPart(manifest, { jurisdiction: 'AR-B', matricula: '700124' })?.part,
    ).toBe('clinical-p2');
    expect(
      findProfessionalPart(manifest, { jurisdiction: 'AR-C', matricula: '700123' }),
    ).toBeNull();
    expect(findProfessionalPart(manifest, { jurisdiction: 'AR-B', matricula: '999' })).toBeNull();
  });
});

describe('the package of a patient', () => {
  async function build() {
    const scratch = await mkdtemp(join(folder, 'build-'));
    const made = await buildPatientPackage({
      adminZip: admin,
      clinicalZips: [clinicalOne, clinicalTwo],
      patientId: ANA,
      organizationName: 'Centro Médico Aillu',
      now: AT,
      scratch,
    });
    return { made, files: await readZip(made.path) };
  }

  it("holds the rows of the patient and no one else's, from the administrative and clinical parts", async () => {
    const { files } = await build();
    const text = (name: string) => files.get(name)?.toString('utf8') ?? '';

    expect(JSON.parse(text('registros/patients/patients.json'))).toEqual([
      { id: ANA, familyName: 'Ríos', documentType: 'dni', document: '20.111.222' },
    ]);
    expect(JSON.parse(text('registros/scheduling/appointments.json'))).toEqual([
      { id: 'a1', patientId: ANA, startsAt: '2031-01-01T10:00:00Z' },
    ]);
    const everything = [...files.entries()]
      .filter(([name]) => !name.endsWith('.pdf'))
      .map(([, data]) => data.toString('utf8'))
      .join('\n');
    expect(everything).toContain('Lumbalgia de Ana');
    expect(everything).toContain('Control de Ana');
    expect(everything).not.toContain('Bruno');
    expect(everything).not.toContain(BRUNO);
    expect(everything).not.toContain('Soto');
  });

  it('puts a note that two packages share once, and leaves out a section that is one value', async () => {
    const { files } = await build();

    const entries = JSON.parse(
      files.get('registros/clinical/entries.json')?.toString('utf8') ?? '[]',
    ) as { noteId: string }[];
    expect(entries.map((entry) => entry.noteId).sort()).toEqual(['n1', 'n3']);
    expect(files.has('registros/tenancy/organization.json')).toBe(false);
  });

  it('brings the files of the patient and not the files of anyone else', async () => {
    const { files } = await build();

    expect(files.get('registros/documents/files/d1-Orden.pdf')?.toString('utf8')).toBe(
      'PDF de Ana',
    );
    expect([...files.keys()].some((name) => name.includes('d2-'))).toBe(false);
  });

  it('closes with a summary and a manifest that count what it holds', async () => {
    const { files, made } = await build();

    const manifest = JSON.parse(files.get('manifiesto.json')?.toString('utf8') ?? '{}') as {
      kind: string;
      sections: { path: string; rows: number }[];
      attachments: { path: string; status: string }[];
    };
    expect(manifest.kind).toBe('clinical');
    expect(manifest.sections.find((section) => section.path.endsWith('entries.json'))?.rows).toBe(
      2,
    );
    expect(manifest.attachments).toEqual([
      { path: 'registros/documents/files/d1-Orden.pdf', status: 'included' },
    ]);
    expect(files.get('resumen.pdf')?.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(made.sizeBytes).toBeGreaterThan(0);
    expect(made.sha256).toBe(
      createHash('sha256')
        .update(await readFile(made.path))
        .digest('hex'),
    );
  });

  it('is an empty-handed package, not a failure, for a patient with nothing in the clinical parts', async () => {
    const scratch = await mkdtemp(join(folder, 'build-'));
    const made = await buildPatientPackage({
      adminZip: admin,
      clinicalZips: [clinicalTwo],
      patientId: BRUNO,
      organizationName: 'Centro Médico Aillu',
      now: AT,
      scratch,
    });
    const files = await readZip(made.path);

    expect(
      JSON.parse(files.get('registros/patients/patients.json')?.toString('utf8') ?? '[]'),
    ).toHaveLength(1);
    expect(files.has('registros/clinical/entries.json')).toBe(false);
  });
});
