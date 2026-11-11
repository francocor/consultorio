import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';

import type { LocalArchiveStoreConfig } from './index.js';

/**
 * The legal erasure of an archived object (tenancy, "Retention archive after cancellation": a
 * legally required erasure, a court order for example, MAY be performed by a specifically privileged
 * role through a documented, audited procedure). It is the ONE way out of the archive and it is not
 * part of the `ArchiveStore` port the application uses: it needs the credential of the
 * `legal-erasure` identity (`policies.ts`), the only one that may delete a version and bypass a
 * governance retention, and it only exists in the command `pnpm archive:legal-erase`.
 *
 * It removes EVERY version under the key (a versioned bucket keeps them) so that the object is
 * really gone, and it refuses to run without the legal reference, which the command records in the
 * platform trail (`archive.erased`). The decision to erase is a person's; this only carries it out.
 */

export interface ErasableObject {
  key: string;
  /** How many versions of it the bucket holds. */
  versions: number;
}

export interface LegalErasure {
  /** The objects under a prefix, with how many versions each has. Reads no content. */
  list(prefix: string): Promise<ErasableObject[]>;
  /** Removes every version of the object. `reference` is the legal basis (an order, a file number). */
  erase(
    key: string,
    input: { reference: string },
  ): Promise<{ status: 'erased'; versions: number } | { status: 'unknown' }>;
  close(): void;
}

export function createLegalErasure(config: LocalArchiveStoreConfig): LegalErasure {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: config.credentials,
  });
  const Bucket = config.bucket;

  return {
    close() {
      client.destroy();
    },
    async list(prefix) {
      const counts = new Map<string, number>();
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      do {
        const page = await client.send(
          new ListObjectVersionsCommand({
            Bucket,
            Prefix: prefix,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
          }),
        );
        for (const entry of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
          if (entry.Key) counts.set(entry.Key, (counts.get(entry.Key) ?? 0) + 1);
        }
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (keyMarker !== undefined);
      return [...counts.entries()]
        .map(([key, versions]) => ({ key, versions }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async erase(key, input) {
      if (input.reference.trim() === '') {
        throw new Error('The legal erasure needs the legal reference that orders it');
      }
      const listed = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix: key }));
      const versions = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].filter(
        (entry) => entry.Key === key && entry.VersionId !== undefined,
      );
      if (versions.length === 0) return { status: 'unknown' };
      for (const version of versions) {
        await client.send(
          new DeleteObjectCommand({
            Bucket,
            Key: key,
            VersionId: version.VersionId,
            // Governance mode: the retention is lifted by this identity and no other.
            BypassGovernanceRetention: true,
          }),
        );
      }
      return { status: 'erased', versions: versions.length };
    },
  };
}
