import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { attachmentPath, type PackageReport } from '../cancellation/package-content.js';
import { summaryEntries } from '../cancellation/summary.js';
import { zipStream, type ZipEntry } from '../cancellation/zip.js';

import type { ArchiveManifest, ManifestPart } from './manifest.js';
import { listZip, readJsonRows, type ZipFileEntry } from './zip-read.js';

/**
 * What a release hands over (tenancy, "Tenant cancellation export": released to the patient themselves,
 * or to a verified professional). Made from packages the releaser restored from the archive:
 *
 * - **a professional** receives their own clinical package as it was archived: the records of their
 *   patients, which they would have had from the export;
 * - **a patient** receives their own rows and nothing of anyone else's: from the administrative
 *   package (their demographics, their appointments and charges) and from every clinical package (their
 *   entries, anamnesis, documents, prescriptions and consents), with the files that belong to them. A
 *   note two professionals share is put once.
 *
 * Finding the requester in the archive is done here and only on the restored files: the operator never
 * takes part in it.
 */

const ADMINISTRATIVE_PATIENTS = 'patients/patients.json';

/** `20.111.222`, `20 111 222` and `20111222` are one document. */
const normalizeDocument = (value: string) => value.replaceAll(/[\s.\-/]/g, '').toLowerCase();
const normalizeText = (value: string) => value.replaceAll(/\s+/g, '').toLowerCase();

function entryNamed(entries: ZipFileEntry[], name: string): ZipFileEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

/** The id of the patient the document belongs to, in the administrative package; null when none. */
export async function findPatientId(
  adminZip: string,
  scope: { documentType: string; document: string },
): Promise<string | null> {
  const patients = entryNamed(await listZip(adminZip), ADMINISTRATIVE_PATIENTS);
  if (!patients) return null;
  const wantedType = scope.documentType.toLowerCase();
  const wantedDocument = normalizeDocument(scope.document);
  for await (const row of readJsonRows(patients.open())) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    if (
      typeof record['id'] === 'string' &&
      typeof record['documentType'] === 'string' &&
      typeof record['document'] === 'string' &&
      record['documentType'].toLowerCase() === wantedType &&
      normalizeDocument(record['document']) === wantedDocument
    ) {
      return record['id'];
    }
  }
  return null;
}

/** The part of the archive that holds the records of the professional with that registration. */
export function findProfessionalPart(
  manifest: Pick<ArchiveManifest, 'parts'>,
  scope: { jurisdiction: string; matricula: string },
): ManifestPart | null {
  return (
    manifest.parts.find(
      (part) =>
        part.kind === 'clinical' &&
        part.professional !== null &&
        part.professional.matriculaJurisdiction !== null &&
        part.professional.matricula !== null &&
        normalizeText(part.professional.matriculaJurisdiction) ===
          normalizeText(scope.jurisdiction) &&
        normalizeText(part.professional.matricula) === normalizeText(scope.matricula),
    ) ?? null
  );
}

export interface BuiltPackage {
  path: string;
  sizeBytes: number;
  sha256: string;
  entryCount: number;
}

interface SourceFile {
  zip: ZipFileEntry[];
  entry: string;
}

function belongsTo(patientId: string, entryName: string, row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const record = row as Record<string, unknown>;
  return (
    record['patientId'] === patientId ||
    // The patients section names its rows by `id`.
    (entryName === ADMINISTRATIVE_PATIENTS && record['id'] === patientId)
  );
}

export async function buildPatientPackage(input: {
  adminZip: string;
  clinicalZips: readonly string[];
  patientId: string;
  organizationName: string;
  now: Date;
  /** An existing folder; the package is written in it. */
  scratch: string;
}): Promise<BuiltPackage> {
  // section path -> the rows of the patient, each once
  const sections = new Map<string, Map<string, unknown>>();
  const files = new Map<string, SourceFile>();

  for (const path of [input.adminZip, ...input.clinicalZips]) {
    const entries = await listZip(path);
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      if (!entry.name.endsWith('.json') || entry.name === 'manifiesto.json') continue;
      for await (const row of readJsonRows(entry.open())) {
        if (!belongsTo(input.patientId, entry.name, row)) continue;
        const kept = sections.get(entry.name) ?? new Map<string, unknown>();
        kept.set(JSON.stringify(row), row);
        sections.set(entry.name, kept);

        // A row that points at a file of the package brings the file with it.
        const record = row as Record<string, unknown>;
        if (
          typeof record['objectKey'] === 'string' &&
          typeof record['sha256'] === 'string' &&
          (typeof record['id'] === 'string' || typeof record['id'] === 'number')
        ) {
          const contributor = entry.name.split('/')[0] ?? '';
          const name = typeof record['name'] === 'string' ? record['name'] : 'archivo';
          const found = attachmentPath(contributor, String(record['id']), name);
          if (names.has(found) && !files.has(found))
            files.set(found, { zip: entries, entry: found });
        }
      }
    }
  }

  const report: PackageReport = { sections: [], attachments: [], redactedKeys: [] };
  const target = join(input.scratch, 'release.zip');
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let entryCount = 0;

  async function* entries(): AsyncGenerator<ZipEntry> {
    for (const [name, rows] of [...sections.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const [contributor = '', ...rest] = name.split('/');
      const section = (rest.join('/') || name).replace(/\.json$/, '');
      const path = `registros/${name}`;
      report.sections.push({ contributor, section, path, rows: rows.size });
      yield {
        name: path,
        modifiedAt: input.now,
        body: Buffer.from(`[\n  ${[...rows.keys()].join(',\n  ')}\n]\n`),
      };
    }
    for (const [name, source] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const path = `registros/${name}`;
      const found = source.zip.find((entry) => entry.name === source.entry);
      if (!found) continue;
      report.attachments.push({ path, status: 'included' });
      yield { name: path, modifiedAt: input.now, body: found.open() };
    }
    for (const closing of await summaryEntries({
      kind: 'clinical',
      organizationName: input.organizationName,
      generatedAt: input.now,
      report,
    })) {
      yield closing;
    }
  }

  async function* counted(): AsyncGenerator<ZipEntry> {
    for await (const entry of entries()) {
      entryCount += 1;
      yield entry;
    }
  }

  await pipeline(
    zipStream(counted()),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    }),
    createWriteStream(target),
  );
  return { path: target, sizeBytes, sha256: hash.digest('hex'), entryCount };
}
