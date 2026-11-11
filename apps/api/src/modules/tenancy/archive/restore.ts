import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { openObject } from './archive-crypto.js';
import type { ArchiveManifest, ManifestPart } from './manifest.js';
import type { ArchiveStore } from './ports.js';

/**
 * Puts the packages of an archive back together (a test restore, and the first step of a release): for
 * each part, its objects are read in order, checked against the manifest, decrypted with the PRIVATE
 * key of the organization and written to a file, and the file must be the package the manifest
 * describes, byte for byte. It needs the private key, so it runs only where the key of the releaser
 * is: the releaser process, its tests and the restore drill. The API and the worker never import it.
 */

export class RestoreError extends Error {
  constructor(
    readonly code: 'missing' | 'corrupted' | 'unavailable' | 'mismatch',
    readonly part: string,
  ) {
    super(`The archive part "${part}" could not be restored (${code}).`);
    this.name = 'RestoreError';
  }
}

export interface RestoredPart {
  part: string;
  kind: ManifestPart['kind'];
  professionalId: string | null;
  /** The restored package (a zip), in the scratch folder. */
  path: string;
}

const STORE_TIMEOUT_MS = 120_000;

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

export async function restoreParts(input: {
  store: ArchiveStore;
  manifest: ArchiveManifest;
  privateKey: Buffer;
  /** An existing folder the packages are written to. */
  outDir: string;
  /** Restores only the parts this accepts (a release asks for the clinical part of a professional). */
  select?: (part: ManifestPart) => boolean;
}): Promise<RestoredPart[]> {
  const restored: RestoredPart[] = [];
  for (const part of input.manifest.parts) {
    if (input.select && !input.select(part)) continue;
    const path = join(input.outDir, `${part.part}.zip`);
    const file = await open(path, 'w');
    try {
      for (const object of part.objects) {
        const got = await input.store.get(object.name, AbortSignal.timeout(STORE_TIMEOUT_MS));
        if (got.status === 'retryable') throw new RestoreError('unavailable', part.part);
        if (got.status === 'unknown') throw new RestoreError('missing', part.part);
        const sealedSha = createHash('sha256').update(got.body).digest('hex');
        if (sealedSha !== object.sealedSha256 || got.body.byteLength !== object.sealedBytes) {
          throw new RestoreError('corrupted', part.part);
        }
        let plain: Buffer;
        try {
          plain = openObject(Buffer.from(got.body), input.privateKey, {
            tenantId: input.manifest.tenantId,
            name: object.name,
            keyVersion: input.manifest.keyVersion,
          });
        } catch {
          throw new RestoreError('corrupted', part.part);
        }
        if (plain.length !== object.plainBytes) throw new RestoreError('corrupted', part.part);
        await file.write(plain);
      }
    } finally {
      await file.close();
    }
    if ((await sha256OfFile(path)) !== part.zipSha256)
      throw new RestoreError('mismatch', part.part);
    restored.push({ part: part.part, kind: part.kind, professionalId: part.professionalId, path });
  }
  return restored;
}
