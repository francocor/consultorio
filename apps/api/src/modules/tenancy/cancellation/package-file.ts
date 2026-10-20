import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { RequestContext, WithTenant } from '../../../platform/db/tenant-context.js';
import { StorageKeyError, type ObjectStorage } from '../../../platform/storage/object-storage.js';
import type { ExportKind, ExportRegistry } from '../application/export-registry.js';

import {
  packageEntries,
  type PackageReport,
  type PackageSource,
  type ReadAttachment,
} from './package-content.js';
import { summaryEntries } from './summary.js';
import { zipStream } from './zip.js';

/**
 * Writes one package (the administrative one, or the clinical one of a professional) to a zip FILE in
 * a scratch folder, and tells its size and checksum. The cancellation export uploads that file to the
 * organization's bucket; the retention archive encrypts it into the write-once store. Both get the
 * same bytes from the same contributors, with the same rules: secrets dropped, no clinical field in
 * the administrative part, attached files checked against their checksum, and no database
 * transaction open while the file is written.
 */

export interface PackageFileDeps {
  /** Every module's contributor. */
  exports: ExportRegistry;
  /** Opens the short transactions: one per contributor. */
  withTenant: WithTenant;
  /** Where the attached files of the organization are. */
  storage: ObjectStorage;
}

export interface PackageFileInput {
  tenantId: string;
  kind: ExportKind;
  /** The professional a clinical package is for. */
  professionalId?: string | undefined;
  /** The context the contributors run in: the organization alone, or acting as the professional. */
  context: RequestContext;
  organizationName: string;
  professionalName: string | null;
  now: Date;
  /** A folder that exists and that the caller removes. */
  scratch: string;
  /** The name of the file in `scratch`. */
  fileName?: string;
}

export interface PackageFile {
  path: string;
  sizeBytes: number;
  sha256: string;
  entryCount: number;
  report: PackageReport;
}

export async function writePackageFile(
  deps: PackageFileDeps,
  input: PackageFileInput,
): Promise<PackageFile> {
  const sources: PackageSource[] = deps.exports.list(input.kind).map((contributor) => ({
    name: contributor.name,
    run: (sink) =>
      deps.withTenant(input.context, async (tx) => {
        await sink(
          await contributor.contribute({
            tx,
            tenantId: input.tenantId,
            ...(input.professionalId ? { professionalId: input.professionalId } : {}),
          }),
        );
      }),
  }));
  const readAttachment: ReadAttachment = async (objectKey) => {
    try {
      const found = await deps.storage.get(input.tenantId, objectKey);
      return found ? { stream: found.stream } : null;
    } catch (error) {
      // A key outside the organization's prefix is refused by the storage: it is not a file of ours.
      if (error instanceof StorageKeyError) return null;
      throw error;
    }
  };

  const path = join(input.scratch, input.fileName ?? 'package.zip');
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let entryCount = 0;
  let closing: PackageReport = { sections: [], attachments: [], redactedKeys: [] };
  const entries = packageEntries({
    kind: input.kind,
    sources,
    workDir: input.scratch,
    modifiedAt: input.now,
    readAttachment,
    trailer: (report) => {
      closing = report;
      return summaryEntries({
        kind: input.kind,
        organizationName: input.organizationName,
        generatedAt: input.now,
        professionalName: input.professionalName,
        report,
      });
    },
  });
  async function* counted() {
    for await (const entry of entries) {
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
    createWriteStream(path),
  );
  return { path, sizeBytes, sha256: hash.digest('hex'), entryCount, report: closing };
}
