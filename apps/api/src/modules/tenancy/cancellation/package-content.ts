import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import type { ExportKind } from '../application/export-registry.js';

import { ClinicalKeyInAdministrativePartError, isClinicalKey, isSecretKey } from './redaction.js';
import type { ZipEntry } from './zip.js';

/**
 * The files of a package of the cancellation export, made from what the contributors of the modules
 * return. Three rules shape it:
 *
 * 1. **A database transaction is never held while the package is written.** A contributor runs inside
 *    the transaction `source.run` opens and hands its result to `sink`, which spools it to a file on
 *    local disk before the transaction closes; everything that follows (zipping, fetching the
 *    attached files from the bucket, uploading) happens with no transaction open.
 * 2. **Memory does not grow with the size of a table.** A section that is a list, or any (async)
 *    iterable of rows, is written row by row and waits for each write before pulling the next row,
 *    and the attached files are streamed from the bucket into the zip. A contributor that returns a
 *    whole array has already loaded it; one that returns an async generator never does.
 * 3. **A package never carries what it must not.** Secrets are dropped by field name (and reported),
 *    and a clinical field in an administrative part fails the build (see `redaction.ts`).
 */

export type ReadAttachment = (objectKey: string) => Promise<{ stream: Readable } | null>;

export interface PackageSource {
  /** The module the part belongs to; its folder in the zip. */
  name: string;
  /**
   * Opens the transaction the contributor needs, runs it and gives its result to `sink` BEFORE the
   * transaction closes (a result that is a generator reads from the transaction while it is
   * consumed). Resolves when the transaction is over.
   */
  run(sink: (value: unknown) => Promise<void>): Promise<void>;
}

export interface SectionReport {
  contributor: string;
  section: string;
  path: string;
  /** The number of rows of a list; null for a section that is a single value. */
  rows: number | null;
}

export type AttachmentStatus = 'included' | 'missing' | 'checksum_mismatch';

export interface AttachmentReport {
  path: string;
  status: AttachmentStatus;
}

export interface PackageReport {
  sections: SectionReport[];
  attachments: AttachmentReport[];
  /** The names of the secret fields that were dropped. A contributor that emits one has a defect. */
  redactedKeys: string[];
}

export interface PackageBuildInput {
  kind: ExportKind;
  sources: readonly PackageSource[];
  /** A directory for the spool. A folder of its own is made inside it and removed at the end. */
  workDir: string;
  modifiedAt: Date;
  readAttachment: ReadAttachment;
  /** Entries that close the package (the manifest, the PDF), made from the report of everything. */
  trailer(report: PackageReport): Promise<readonly ZipEntry[]>;
  /** Called after each row of a list is written. */
  onRow?: (contributor: string, section: string, rows: number) => void;
}

interface AttachmentRef {
  id: string;
  name: string;
  objectKey: string;
  sha256: string;
}

interface Spooled {
  report: SectionReport;
  file: string;
}

/** A segment of a path made of what a person cannot turn into a path. */
function safeSegment(text: string, fallback: string): string {
  const cleaned = text.replaceAll(/[^\p{L}\p{N}._-]+/gu, '_').replaceAll(/^[._]+|[._]+$/g, '');
  return cleaned === '' ? fallback : cleaned.slice(0, 80);
}

/** The last piece of a file name that may hold a path, with spaces and accents kept. */
function safeFileName(text: string): string {
  const last = text.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replaceAll(/[\u0000-\u001f\u007f<>:"|?*]+/g, '_').replaceAll(/^\.+/g, '');
  const trimmed = cleaned.trim().slice(0, 120);
  return trimmed === '' ? 'archivo' : trimmed;
}

/** Where an attached file goes in the zip of its module (`documents/files/<id>-<name>`). */
export function attachmentPath(contributor: string, id: string, name: string): string {
  return `${safeSegment(contributor, 'modulo')}/files/${safeSegment(id, 'archivo')}-${safeFileName(name)}`;
}

/** The folder of a module in the zip, and the file of one of its sections. */
export function sectionPath(contributor: string, section: string): string {
  return `${safeSegment(contributor, 'modulo')}/${safeSegment(section, 'seccion')}.json`;
}

function isRowSource(value: unknown): value is Iterable<unknown> | AsyncIterable<unknown> {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return false;
  return Array.isArray(value) || Symbol.asyncIterator in value || Symbol.iterator in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function writeText(stream: WriteStream, text: string): Promise<void> {
  if (!stream.write(text)) await once(stream, 'drain');
}

async function closeStream(stream: WriteStream): Promise<void> {
  const closed = once(stream, 'close');
  stream.end();
  await closed;
}

/** The state one package keeps while it is spooled: what was redacted, and the guard of its kind. */
class Serializer {
  readonly redacted = new Set<string>();

  constructor(
    private readonly kind: ExportKind,
    private readonly contributor: string,
  ) {}

  guard(key: string): void {
    if (this.kind === 'administrative' && isClinicalKey(key)) {
      throw new ClinicalKeyInAdministrativePartError(this.contributor, key);
    }
  }

  json(value: unknown, indent?: number): string {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const state = this;
    const text = JSON.stringify(
      value,
      function (this: Record<string, unknown>, key: string, current: unknown) {
        if (key === '') return current;
        if (isSecretKey(key)) {
          state.redacted.add(key);
          return undefined;
        }
        state.guard(key);
        const raw = this[key];
        if (raw instanceof Uint8Array) return Buffer.from(raw).toString('base64');
        if (typeof current === 'bigint') return current.toString();
        return current;
      },
      indent,
    ) as string | undefined;
    return text ?? 'null';
  }
}

async function spoolSection(
  serializer: Serializer,
  file: string,
  value: unknown,
  onRow: (rows: number) => void,
  attachments: AttachmentRef[],
): Promise<number | null> {
  const stream = createWriteStream(file);
  try {
    if (!isRowSource(value)) {
      await writeText(stream, `${serializer.json(value, 2)}\n`);
      return null;
    }
    await writeText(stream, '[');
    let rows = 0;
    for await (const row of value) {
      const text = serializer.json(row);
      await writeText(stream, `${rows === 0 ? '\n  ' : ',\n  '}${text}`);
      rows += 1;
      collectAttachment(row, attachments);
      onRow(rows);
    }
    await writeText(stream, rows === 0 ? ']\n' : '\n]\n');
    return rows;
  } finally {
    await closeStream(stream);
  }
}

function collectAttachment(row: unknown, into: AttachmentRef[]): void {
  if (!isPlainObject(row)) return;
  const { objectKey, sha256 } = row;
  if (typeof objectKey !== 'string' || objectKey === '' || typeof sha256 !== 'string') return;
  const id = row['id'];
  const name = row['name'] ?? row['originalName'] ?? row['fileName'];
  into.push({
    id: typeof id === 'string' || typeof id === 'number' ? String(id) : String(into.length + 1),
    name: typeof name === 'string' ? name : 'archivo',
    objectKey,
    sha256,
  });
}

/** An iterable of the bytes of an attached file that hashes what passes and tells the result. */
async function* checked(
  stream: Readable,
  expected: string,
  done: (status: AttachmentStatus) => void,
): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256');
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    yield chunk;
  }
  done(hash.digest('hex') === expected.toLowerCase() ? 'included' : 'checksum_mismatch');
}

/**
 * The entries of one package, in order: for each source its sections and then the files they point
 * at, and last the trailer. The entries are produced lazily as the zip pulls them, so a source is run
 * (and its spool written) only when its turn comes and the spool of the one before is already gone.
 */
export async function* packageEntries(input: PackageBuildInput): AsyncGenerator<ZipEntry> {
  const folder = await mkdtemp(join(input.workDir, 'pkg-'));
  const report: PackageReport = { sections: [], attachments: [], redactedKeys: [] };
  const redacted = new Set<string>();
  let sequence = 0;

  try {
    for (const source of input.sources) {
      const serializer = new Serializer(input.kind, source.name);
      const contributor = safeSegment(source.name, 'modulo');
      const spooled: Spooled[] = [];
      const attachments: AttachmentRef[] = [];

      await source.run(async (value) => {
        const sections: [string, unknown][] = isPlainObject(value)
          ? Object.entries(value)
          : [['data', value]];
        for (const [section, sectionValue] of sections) {
          serializer.guard(section);
          if (isSecretKey(section)) {
            serializer.redacted.add(section);
            continue;
          }
          sequence += 1;
          const file = join(folder, `${String(sequence)}.json`);
          const rows = await spoolSection(
            serializer,
            file,
            sectionValue,
            (count) => input.onRow?.(source.name, section, count),
            attachments,
          );
          spooled.push({
            file,
            report: {
              contributor: source.name,
              section,
              path: `${contributor}/${safeSegment(section, 'seccion')}.json`,
              rows,
            },
          });
        }
      });
      for (const key of serializer.redacted) redacted.add(key);

      for (const section of spooled) {
        report.sections.push(section.report);
        yield {
          name: section.report.path,
          modifiedAt: input.modifiedAt,
          body: createReadStream(section.file),
        };
        await rm(section.file, { force: true });
      }

      const seenObjects = new Set<string>();
      const seenPaths = new Set<string>();
      for (const attachment of attachments) {
        if (seenObjects.has(attachment.objectKey)) continue;
        seenObjects.add(attachment.objectKey);
        const base = attachmentPath(source.name, attachment.id, attachment.name);
        let path = base;
        for (let copy = 2; seenPaths.has(path); copy += 1) path = `${base}-${String(copy)}`;
        seenPaths.add(path);

        const found = await input.readAttachment(attachment.objectKey);
        if (!found) {
          report.attachments.push({ path, status: 'missing' });
          continue;
        }
        const entry: AttachmentReport = { path, status: 'included' };
        report.attachments.push(entry);
        yield {
          name: path,
          modifiedAt: input.modifiedAt,
          body: checked(found.stream, attachment.sha256, (status) => {
            entry.status = status;
          }),
        };
      }
    }

    report.redactedKeys = [...redacted];
    for (const entry of await input.trailer(report)) yield entry;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
